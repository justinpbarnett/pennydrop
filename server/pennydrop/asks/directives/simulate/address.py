from __future__ import annotations

import json
import math
import re
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .._support import DirectiveError, Simulation

GUIDE = "\n".join([
    '`{"lab": "address", "bits": 16, "fields": {"L1": 4, "L2": 4}, "offsetBits": 8, "entryBytes": 2, "tables": {"T0": {"base": "0x1000", "entries": {"3": "T1"}}, "T1": {"base": "0x2000", "entries": {"10": "0x2B"}}}, "tlb": {"slots": 2, "entries": []}, "freeFrames": ["0x30"], "addresses": ["0x3A5C"]}` translates each virtual address in `addresses` (1 to 3) through the page tables.',
    "The fields are the page table index fields from the top level down, `offsetBits` is the offset below them, and fields plus offset add up to `bits`. Upper level entries name the next table and last level entries are frame numbers. An index that is not listed is invalid, and a last level miss is filled from `freeFrames` in order.",
    "Omit `tlb` for no TLB. Each access plays split, TLB lookup, one walk per level or a TLB hit, the OS loading the page into a free frame when the last entry is invalid, the physical address, and a TLB fill after a miss.",
    'To show a page fault, give an address whose last level entry is not listed. With the tables above, `"addresses": ["0x3B10"]` faults, because index 11 of T1 is missing, and the OS fills that entry with `0x30` from `freeFrames`. `"addresses": ["0x3A5C", "0x3B10"]` is a normal walk for access 1 and a page fault for access 2.',
    'To tell the run in stages, give `until` a stop. Access k has a stop after each thing it shows, in this order: `"k split"` splits the address into its fields; `"k tlb"` looks the page up in the TLB, when there is one; `"k L1"`, `"k L2"` and so on, one per field, read that level\'s entry on a TLB miss, so the last one ends on the frame, or on the invalid entry of a page fault; `"k load"` has the OS load the page into a free frame and fill the entry, only when access k faults; and the number k forms the physical address and fills the TLB after a miss. `"until": 0` draws the address and the tables before access 1 starts. `"k walk"` is the same stop as the last level, and on an access that faults, so is `"k fault"`.',
    'A later Step carries the same simulation with a later stop, or no `until` for the rest of the run, and plays only the new part on the same Lab. Give each Step the stop of what its narration describes: a Step about the split stops at `"k split"`, a Step about the invalid entry stops at `"k fault"`, and a Step about the OS filling the entry stops at `"k load"`.',
    'A page fault told one beat per Step, with `"addresses": ["0x3B10"]` and no TLB: `"1 split"`, then `"1 L1"`, then `"1 fault"` where the walk finds the invalid entry, then `"1 load"`, then no `until` for the physical address. Fewer Steps can skip stops, such as `"1 fault"`, `"1 load"` and no `until`.',
    'For a TLB hit after a miss, run two addresses on the same page with an empty `tlb`, such as `"addresses": ["0x3A5C", "0x3A10"]`: access 1 misses, walks both levels and fills the TLB, and access 2 hits. Put both addresses in the simulation from the first Step that simulates, so every later Step continues the same run. With `"until": 1` in one Step and no `until` in the next, the miss and the hit get a Step each.',
    "Values for access number k from 1: `virtual_k_hex`, `page_k`, `offset_k`, `offset_k_hex` and `index_k_<field>` such as `index_1_L1` from `\"k split\"`; `tlb_k` (hit or miss) from `\"k tlb\"`; `entry_k_<field>_hex` (where that entry sits in memory) from `\"k <field>\"`; `frame_k` and `frame_k_hex` from the last level, or from `\"k tlb\"` on a hit, or from `\"k load\"` when access k faults; and `physical_k` and `physical_k_hex` from k. A value can be used only in a Step whose `until` has reached its stop.",
])

FAULT_CLAIM = re.compile(r"\b(?:page[- ])?fault(?:s|ed)?\b", re.IGNORECASE)
TLB_HIT_CLAIM = re.compile(r"\btlb[- ]hits?\b|\bhit (?:in|on) the tlb\b", re.IGNORECASE)
TLB_MISS_CLAIM = re.compile(r"\btlb[- ]miss(?:es)?\b|\bmiss(?:ed)? (?:in|on) the tlb\b", re.IGNORECASE)
SAYS_IT_HAPPENS_NOW = re.compile(r"\b(?:here|just|now|watch|notice|see|this (?:is|was|time|access|lookup))\b", re.IGNORECASE)
NOT_A_PLAIN_CLAIM = re.compile(r"\b(?:no|not|never|without|if|when|whenever|unless|would|could|can|might|may|will|going to|about to|next|later|instead|or|what|why|how|whether|avoid\w*|prevent\w*|skip\w*|save\w*)\b|n't|\?", re.IGNORECASE)
SENTENCE_END = re.compile(r"(?<=[.!?])\s+")


VALUE_NAME = re.compile(r"(virtual|page|offset|index|tlb|entry|frame|physical)_(\d+)(?:_(.+?))??(_hex)?")
VALUE_WORDS = {
    "virtual": "virtual address",
    "page": "virtual page number",
    "offset": "offset",
    "index": "index into the {field} table",
    "tlb": "TLB lookup",
    "entry": "memory address where its {field} page table entry sits, not what the entry holds",
    "frame": "frame number",
    "physical": "physical address",
}


def describe_value(name: str) -> str | None:
    found = VALUE_NAME.fullmatch(name)
    if not found:
        return None
    kind, number, field, hexadecimal = found.groups()
    words = VALUE_WORDS[kind].format(field=field)
    return f"access {number} {words}{' in hex' if hexadecimal and kind in ('offset', 'frame', 'physical') else ''}"


def _claimed_in(say: str, claim: re.Pattern[str]) -> bool:
    return any(claim.search(sentence) and SAYS_IT_HAPPENS_NOW.search(sentence) and not NOT_A_PLAIN_CLAIM.search(sentence) for sentence in SENTENCE_END.split(say))


def _tlb_lookups(played: list[str]) -> set[str]:
    return {"miss" if after == "walk" else "hit" for operation, after in zip(played, [*played[1:], ""]) if operation == "tlb"}


def _fault_shown(played: list[str]) -> bool:
    return "fault" in played or (played[-1:] == ["walk"])


def contradictions(name: str, say: str, played: list[str]) -> list[str]:
    lookups = _tlb_lookups(played)
    errors: list[str] = []
    if not _fault_shown(played) and _claimed_in(say, FAULT_CLAIM):
        errors.append(f"the narration says a page fault happens, but the simulation on {name} shows no page fault, because every page it translated was already mapped; reword the narration to match, or give the simulation an address whose last level entry is missing")
    if lookups and "hit" not in lookups and _claimed_in(say, TLB_HIT_CLAIM):
        errors.append(f"the narration says a TLB hit, but every TLB lookup in the simulation on {name} was a miss; reword the narration to a TLB miss, or put the page in the TLB entries of a new run")
    if lookups and "miss" not in lookups and _claimed_in(say, TLB_MISS_CLAIM):
        errors.append(f"the narration says a TLB miss, but every TLB lookup in the simulation on {name} was a hit; reword the narration to a TLB hit, or leave the page out of the TLB entries")
    return errors



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
    until: int | str | None = None
    on: str | None = None


UNTIL = re.compile(r"(\d+)(?:\s+(.+))?")
SPLIT, TLB, LOAD = "split", "tlb", "load"
WALK, FAULT = "walk", "fault"
Stop = str | None


def simulate(spec: Spec) -> Simulation:
    if sum(spec.fields.values()) + spec.offsetBits != spec.bits:
        raise DirectiveError(f"simulate directive: fields {list(spec.fields.values())} plus offsetBits {spec.offsetBits} must add up to bits {spec.bits}")
    taken = [name for name in spec.fields if name.lower() in {SPLIT, TLB, LOAD, WALK, FAULT}]
    if taken:
        raise DirectiveError(f'simulate directive: a field cannot be named "{taken[0]}", because that word names another stop of "until"; name the fields L1, L2 and so on')
    machine = _Machine(spec)
    timeline: list[tuple[int, dict[str, Any]]] = []
    values: dict[str, int | float | str] = {}
    known_at: dict[str, int] = {}
    stops: dict[int, str] = {}
    accesses: list[dict[Stop, int]] = []
    for number, address in enumerate(spec.addresses, start=1):
        moments: dict[Stop, int] = {}
        learned: dict[str, tuple[Stop, int | float | str]] = {}
        for stop, operation in machine.access(number, _number(address), learned):
            if stop not in moments:
                moments[stop] = len(stops) + 1
                stops[moments[stop]] = str(number) if stop is None else json.dumps(f"{number} {stop}")
            timeline.append((moments[stop], operation))
        values |= {name: value for name, (_, value) in learned.items()}
        known_at |= {name: moments[stop] for name, (stop, _) in learned.items()}
        accesses.append(moments)
    return Simulation("mmu", machine.scene(), timeline, values, known_at, until=_reach(spec, accesses), stops=stops)


def _reach(spec: Spec, accesses: list[dict[Stop, int]]) -> int | None:
    if spec.until is None:
        return None
    found = UNTIL.fullmatch(str(spec.until).strip())
    first = _listed(1, accesses[0])
    if not found:
        raise DirectiveError(f'simulate directive: "until" {json.dumps(spec.until)} is not a stop; write an access number, or an access number and a stop inside it, such as {first}')
    number, written = int(found[1]), found[2]
    count = len(accesses)
    if number == 0 and written is None:
        return 0
    if not 1 <= number <= count:
        raise DirectiveError(f'simulate directive: "until" names access {number}, and the run has {count} access{"" if count == 1 else "es"}; "until" counts accesses, and the stops of access {count} are {_listed(count, accesses[-1])}')
    moments = accesses[number - 1]
    walked = [stop for stop in moments if stop in spec.fields]
    named = {**{str(stop).lower(): moment for stop, moment in moments.items() if stop is not None}, **({WALK: moments[walked[-1]]} if walked else {}), **({FAULT: moments[walked[-1]]} if LOAD in moments else {})}
    if written is None:
        return moments[None]
    if written.strip().lower() in named:
        return named[written.strip().lower()]
    raise DirectiveError(f'simulate directive: access {number} has no stop {json.dumps(written)}{_why_missing(number, written.strip().lower(), accesses, spec)}; its stops are {_listed(number, moments)}')


def _why_missing(number: int, written: str, accesses: list[dict[Stop, int]], spec: Spec) -> str:
    if written in {FAULT, LOAD}:
        faulting = [str(other) for other, moments in enumerate(accesses, start=1) if LOAD in moments]
        if faulting:
            return f", because only access {' and '.join(faulting)} of this run faults"
        return ", because no access of this run faults; to show a page fault, give an address whose last level entry is missing"
    if written == WALK or written in {name.lower() for name in spec.fields}:
        return f", because access {number} hits the TLB and walks no table"
    if written == TLB:
        return ", because this run has no TLB; give the simulation a \"tlb\", such as {\"slots\": 2, \"entries\": []}, in every Step that carries it"
    if written == "fill":
        return f', because access {number} fills the TLB at stop {number}, where it forms the physical address'
    return ""


def _listed(number: int, moments: dict[Stop, int]) -> str:
    named = [json.dumps(f"{number} {stop}") for stop in moments if stop is not None]
    return ", ".join(named) + f" and {number}"


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
        scene = spec.model_dump(exclude={"addresses", "until", "on", "tlb", "freeFrames", "root"})
        scene.update({"lab": "address", "address": spec.addresses[0], **({"tlb": spec.tlb.model_dump()} if spec.tlb else {}), "freeFrames": spec.freeFrames})
        if spec.root:
            scene["root"] = spec.root
        return scene

    def access(self, number: int, address: int, learned: dict[str, tuple[Stop, int | float | str]]) -> list[tuple[Stop, dict[str, Any]]]:
        spec = self._spec
        offset = address & (2 ** spec.offsetBits - 1)
        page = address >> spec.offsetBits
        operations: list[tuple[Stop, dict[str, Any]]] = [(SPLIT, {"op": "split", **({"address": _hex(address, self._address_digits)} if number > 1 else {})})]
        indexes = self._indexes(page)
        learned |= {f"virtual_{number}_hex": (SPLIT, _hex(address, self._address_digits)), f"page_{number}": (SPLIT, page), f"offset_{number}": (SPLIT, offset), f"offset_{number}_hex": (SPLIT, _hex(offset, math.ceil(spec.offsetBits / 4)))}
        learned |= {f"index_{number}_{name}": (SPLIT, index) for name, index in zip(spec.fields, indexes)}
        hit = spec.tlb is not None and page in self._tlb
        if spec.tlb:
            operations.append((TLB, {"op": "tlb"}))
            learned[f"tlb_{number}"] = (TLB, "hit" if hit else "miss")
        frame, frame_known = (self._tlb[page], TLB) if hit else self._walk(number, indexes, learned, operations)
        physical = frame * 2 ** spec.offsetBits + offset
        operations.append((None, {"op": "physical"}))
        learned |= {f"frame_{number}": (frame_known, frame), f"frame_{number}_hex": (frame_known, _hex(frame, self._frame_digits)), f"physical_{number}": (None, physical), f"physical_{number}_hex": (None, _hex(physical, self._address_digits))}
        if spec.tlb and not hit:
            if len(self._tlb) >= spec.tlb.slots:
                del self._tlb[next(iter(self._tlb))]
            self._tlb[page] = frame
            operations.append((None, {"op": "fill"}))
        return operations

    def _indexes(self, page: int) -> list[int]:
        remaining = sum(self._spec.fields.values())
        indexes = []
        for bits in self._spec.fields.values():
            remaining -= bits
            indexes.append((page >> remaining) & (2 ** bits - 1))
        return indexes

    def _walk(self, number: int, indexes: list[int], learned: dict[str, tuple[Stop, int | float | str]], operations: list[tuple[Stop, dict[str, Any]]]) -> tuple[int, Stop]:
        table = self._root
        for level, (name, index) in enumerate(zip(self._spec.fields, indexes)):
            operations.append((name, {"op": "walk"}))
            learned[f"entry_{number}_{name}_hex"] = (name, _hex(self._bases[table] + index * self._spec.entryBytes, math.ceil(self._spec.bits / 4)))
            entry = self._tables[table].get(index)
            last = level == len(self._spec.fields) - 1
            if entry is None:
                if not last:
                    raise DirectiveError(f"simulate directive: the {name} entry {index} of table {table} is not listed, and only a last level entry can fault; use an address whose upper level entries exist")
                if not self._free:
                    raise DirectiveError("simulate directive: a page fault needs a free frame; add more to freeFrames")
                entry = self._tables[table][index] = self._free.pop(0)
                operations.append((LOAD, {"op": "fault"}))
                return int(entry), LOAD
            if last:
                return int(entry), name
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
