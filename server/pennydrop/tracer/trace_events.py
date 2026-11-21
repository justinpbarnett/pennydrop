from dataclasses import dataclass
from typing import Any, Literal


@dataclass
class LineEvent:
    line: int
    locals: dict[str, Any]
    stack: list[str]
    type: Literal["line"] = "line"


@dataclass
class CallEvent:
    function: str
    line: int
    arguments: dict[str, Any]
    type: Literal["call"] = "call"


@dataclass
class ReturnEvent:
    function: str
    line: int
    value: Any
    type: Literal["return"] = "return"


@dataclass
class PrintEvent:
    text: str
    type: Literal["print"] = "print"


@dataclass
class GetEvent:
    index: int
    type: Literal["get"] = "get"


@dataclass
class SetEvent:
    index: int
    value: Any
    type: Literal["set"] = "set"


@dataclass
class CompareEvent:
    i: int | None
    j: int | None
    operator: str
    result: bool
    type: Literal["compare"] = "compare"


@dataclass
class SwapEvent:
    i: int
    j: int
    type: Literal["swap"] = "swap"


@dataclass
class Counters:
    comparisons: int = 0
    swaps: int = 0
    writes: int = 0
