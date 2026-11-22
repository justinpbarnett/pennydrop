from __future__ import annotations

import math
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .._support import DirectiveError, Simulation

GUIDE = "\n".join([
    '`{"lab": "address", "bits": 16, "fields": {"L1": 4, "L2": 4}, "offsetBits": 8, "entryBytes": 2, "tables": {"T0": {"base": "0x1000", "entries": {"3": "T1"}}, "T1": {"base": "0x2000", "entries": {"10": "0x2B"}}}, "tlb": {"slots": 2, "entries": []}, "freeFrames": ["0x30"], "addresses": ["0x3A5C"]}` translates each virtual address in `addresses` (1 to 3) through the page tables.',
    "The fields are the page table index fields from the top level down, `offsetBits` is the offset below them, and fields plus offset add up to `bits`. Upper level entries name the next table and last level entries are frame numbers. An index that is not listed is invalid, and a last level miss is filled from `freeFrames` in order.",
    "Omit `tlb` for no TLB. Each access plays split, TLB lookup, one walk per level or a hit, a fault when the last entry is invalid, the physical address, and a TLB fill after a miss.",
    "A simulation plays its whole run in the Step that carries it. To teach in stages, give each Step its own start: for a TLB, one address with an empty `tlb` shows the miss, the walk and the fill; the next Step carries the same address with the page and frame now in `tlb.entries`, which shows the hit. Never repeat one simulation in two Steps.",
    "Values for access number k from 1: `virtual_k_hex`, `page_k`, `offset_k`, `offset_k_hex`, `index_k_<field>` such as `index_1_L1`, `entry_k_<field>_hex` (where that entry sits in memory), `frame_k`, `frame_k_hex`, `physical_k`, `physical_k_hex`, and `tlb_k` (hit or miss).",
])


class Table(BaseModel):
    model_config = ConfigDict(extra="forbid")

    base: int | str
    entries: dict[str, int | str] = {}


class TlbEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    page: int | str
    frame: int | str


class Tlb(BaseModel):
    model_config = ConfigDict(extra="forbid")

    slots: int = Field(ge=1, le=8)
    entries: list[TlbEntry] = []


class Spec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    bits: int = Field(ge=8, le=32)
    fields: dict[str, int]
    offsetBits: int = Field(ge=1)
    entryBytes: int = Field(default=4, ge=1)
    root: str | None = None
    tables: dict[str, Table]
    tlb: Tlb | None = None
    freeFrames: list[int | str] = []
    addresses: list[int | str] = Field(min_length=1, max_length=3)
    on: str | None = None


def simulate(spec: Spec) -> Simulation:
    if sum(spec.fields.values()) + spec.offsetBits != spec.bits:
        raise DirectiveError(f"simulate directive: fields {list(spec.fields.values())} plus offsetBits {spec.offsetBits} must add up to bits {spec.bits}")
    machine = _Machine(spec)
    operations: list[dict[str, Any]] = []
    values: dict[str, int | float | str] = {}
    for number, address in enumerate(spec.addresses, start=1):
        operations.extend(machine.access(number, _number(address), values))
    return Simulation("mmu", machine.scene(), operations, values)


class _Machine:
    def __init__(self, spec: Spec):
        self._spec = spec
        self._tables = {name: {int(index): _number(entry) if level == len(spec.fields) - 1 else entry for index, entry in table.entries.items()} for name, table in spec.tables.items() for level in [_level(spec, name)]}
        self._bases = {name: _number(table.base) for name, table in spec.tables.items()}
        self._root = spec.root or next(iter(spec.tables))
        self._tlb = {_number(entry.page): _number(entry.frame) for entry in spec.tlb.entries} if spec.tlb else {}
        self._free = [_number(frame) for frame in spec.freeFrames]
        self._address_digits = math.ceil(spec.bits / 4)
        self._frame_digits = math.ceil((spec.bits - spec.offsetBits) / 4)

    def scene(self) -> dict[str, Any]:
        spec = self._spec
        scene = spec.model_dump(exclude={"addresses", "on", "tlb", "freeFrames", "root"})
        scene.update({"lab": "address", "address": spec.addresses[0], **({"tlb": spec.tlb.model_dump()} if spec.tlb else {}), "freeFrames": spec.freeFrames})
        if spec.root:
            scene["root"] = spec.root
        return scene

    def access(self, number: int, address: int, values: dict[str, int | float | str]) -> list[dict[str, Any]]:
        spec = self._spec
        offset = address & (2 ** spec.offsetBits - 1)
        page = address >> spec.offsetBits
        operations: list[dict[str, Any]] = [{"op": "split", **({"address": _hex(address, self._address_digits)} if number > 1 else {})}]
        indexes = self._indexes(page)
        values.update({f"virtual_{number}_hex": _hex(address, self._address_digits), f"page_{number}": page, f"offset_{number}": offset, f"offset_{number}_hex": _hex(offset, math.ceil(spec.offsetBits / 4))})
        values.update({f"index_{number}_{name}": index for name, index in zip(spec.fields, indexes)})
        hit = spec.tlb is not None and page in self._tlb
        if spec.tlb:
            operations.append({"op": "tlb"})
            values[f"tlb_{number}"] = "hit" if hit else "miss"
        frame = self._tlb[page] if hit else self._walk(number, indexes, values, operations)
        physical = frame * 2 ** spec.offsetBits + offset
        operations.append({"op": "physical"})
        values.update({f"frame_{number}": frame, f"frame_{number}_hex": _hex(frame, self._frame_digits), f"physical_{number}": physical, f"physical_{number}_hex": _hex(physical, self._address_digits)})
        if spec.tlb and not hit:
            if len(self._tlb) >= spec.tlb.slots:
                del self._tlb[next(iter(self._tlb))]
            self._tlb[page] = frame
            operations.append({"op": "fill"})
        return operations

    def _indexes(self, page: int) -> list[int]:
        remaining = sum(self._spec.fields.values())
        indexes = []
        for bits in self._spec.fields.values():
            remaining -= bits
            indexes.append((page >> remaining) & (2 ** bits - 1))
        return indexes

    def _walk(self, number: int, indexes: list[int], values: dict[str, int | float | str], operations: list[dict[str, Any]]) -> int:
        table = self._root
        for level, (name, index) in enumerate(zip(self._spec.fields, indexes)):
            operations.append({"op": "walk"})
            values[f"entry_{number}_{name}_hex"] = _hex(self._bases[table] + index * self._spec.entryBytes, math.ceil(self._spec.bits / 4))
            entry = self._tables[table].get(index)
            last = level == len(self._spec.fields) - 1
            if entry is None:
                if not last:
                    raise DirectiveError(f"simulate directive: the {name} entry {index} of table {table} is not listed, and only a last level entry can fault; use an address whose upper level entries exist")
                if not self._free:
                    raise DirectiveError("simulate directive: a page fault needs a free frame; add more to freeFrames")
                entry = self._tables[table][index] = self._free.pop(0)
                operations.append({"op": "fault"})
            if last:
                return int(entry)
            if entry not in self._tables:
                raise DirectiveError(f"simulate directive: table {table} entry {index} names {entry!r}, which is not in tables")
            table = str(entry)
        raise DirectiveError("simulate directive: fields must name at least one level")


def _level(spec: Spec, table: str) -> int:
    level = 0
    names = [spec.root or next(iter(spec.tables))]
    while names:
        if table in names:
            return level
        names = [str(entry) for name in names for entry in spec.tables[name].entries.values() if isinstance(entry, str) and entry in spec.tables]
        level += 1
    raise DirectiveError(f"simulate directive: table {table} cannot be reached from the root table")


def _number(value: int | str) -> int:
    return value if isinstance(value, int) else int(value, 0)


def _hex(value: int, digits: int) -> str:
    return f"0x{value:0{digits}X}"
