import dataclasses
import json
import operator
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from trace_events import (
    CallEvent, CompareEvent, Counters, GetEvent, LineEvent, PrintEvent, ReturnEvent, SetEvent, SwapEvent,
)

USER_FILE = "<user>"
MAX_LIST_ITEMS = 64
MAX_TEXT = 200
MAX_STDOUT = 10000


class TraceDeadline(BaseException):
    pass


class Recorder:
    def __init__(self, max_events, deadline):
        self.events = []
        self.counters = Counters()
        self.truncated = False
        self.max_events = max_events
        self.deadline = deadline
        self.pending_set = None
        self.last_probe = None

    def emit(self, event):
        self.flush_pending_set()
        self._append(event)

    def _append(self, event):
        if len(self.events) >= self.max_events:
            self.truncated = True
        else:
            self.events.append(event)

    def flush_pending_set(self):
        if self.pending_set is not None:
            index, value, _origin = self.pending_set
            self.pending_set = None
            self.counters.writes += 1
            self._append(SetEvent(index, value))

    def record_set(self, index, value, origin):
        pending = self.pending_set
        if pending is not None and origin == pending[0] and pending[2] == index:
            self.pending_set = None
            self.counters.swaps += 1
            self.counters.writes += 2
            self._append(SwapEvent(pending[0], index))
            return
        self.flush_pending_set()
        if origin is not None and origin != index:
            self.pending_set = (index, value, origin)
        else:
            self.counters.writes += 1
            self._append(SetEvent(index, value))

    def record_compare(self, i, j, operator_symbol, result):
        probe = i if j is None else None
        repeated = probe is not None and probe == self.last_probe
        self.last_probe = probe
        if not repeated:
            self.counters.comparisons += 1
        self.emit(CompareEvent(i, j, operator_symbol, result, counted=not repeated))

    def check_deadline(self):
        if time.monotonic() > self.deadline:
            raise TraceDeadline()


recorder = None


def unwrap(value):
    return value.value if isinstance(value, Cell) else value


class Cell:
    def __init__(self, value, owner, index):
        self.value = value
        self.owner = owner
        self.index = index

    def _compare(self, other, operator_symbol, function):
        result = function(self.value, unwrap(other))
        other_index = other.index if isinstance(other, Cell) else None
        recorder.record_compare(self.index, other_index, operator_symbol, bool(result))
        return result

    def __lt__(self, other): return self._compare(other, "<", operator.lt)
    def __le__(self, other): return self._compare(other, "<=", operator.le)
    def __gt__(self, other): return self._compare(other, ">", operator.gt)
    def __ge__(self, other): return self._compare(other, ">=", operator.ge)
    def __eq__(self, other): return self._compare(other, "==", operator.eq)
    def __ne__(self, other): return self._compare(other, "!=", operator.ne)
    def __hash__(self): return hash(self.value)
    def __bool__(self): return bool(self.value)
    def __repr__(self): return repr(self.value)
    def __str__(self): return str(self.value)
    def __int__(self): return int(self.value)
    def __float__(self): return float(self.value)
    def __index__(self): return operator.index(self.value)
    def __neg__(self): return -self.value
    def __abs__(self): return abs(self.value)
    def __round__(self, digits=None): return round(self.value, digits)
    def __format__(self, spec): return format(self.value, spec)


def _install_arithmetic():
    for name in ("add", "sub", "mul", "truediv", "floordiv", "mod", "pow"):
        function = getattr(operator, name)
        setattr(Cell, f"__{name}__", lambda self, other, f=function: f(self.value, unwrap(other)))
        setattr(Cell, f"__r{name}__", lambda self, other, f=function: f(unwrap(other), self.value))


_install_arithmetic()


class TracedList(list):
    def __getitem__(self, index):
        if isinstance(index, slice):
            positions = range(*index.indices(len(self)))
            return [Cell(list.__getitem__(self, position), self, position) for position in positions]
        position = index if index >= 0 else index + len(self)
        recorder.emit(GetEvent(position))
        return Cell(list.__getitem__(self, position), self, position)

    def __setitem__(self, index, value):
        if isinstance(index, slice):
            recorder.counters.writes += len(range(*index.indices(len(self))))
            list.__setitem__(self, index, [unwrap(item) for item in value])
            return
        position = index if index >= 0 else index + len(self)
        origin = value.index if isinstance(value, Cell) and value.owner is self else None
        raw = unwrap(value)
        list.__setitem__(self, position, raw)
        recorder.record_set(position, snapshot(raw), origin)


def snapshot(value, depth=0):
    value = unwrap(value)
    if value is None or isinstance(value, (bool, int)):
        return value
    if isinstance(value, float):
        return value if value == value and abs(value) != float("inf") else str(value)
    if isinstance(value, str):
        return value[:MAX_TEXT]
    if depth < 3 and isinstance(value, (list, tuple, set, frozenset)):
        return [snapshot(item, depth + 1) for item in list(value)[:MAX_LIST_ITEMS]]
    if depth < 3 and isinstance(value, dict):
        return {str(key)[:MAX_TEXT]: snapshot(item, depth + 1) for key, item in list(value.items())[:MAX_LIST_ITEMS]}
    return repr(value)[:MAX_TEXT]


def user_stack(frame):
    names = []
    while frame is not None and frame.f_code.co_filename == USER_FILE and frame.f_code.co_name != "<module>":
        names.append(frame.f_code.co_name)
        frame = frame.f_back
    return list(reversed(names))


def trace_calls(frame, event, argument):
    if frame.f_code.co_filename != USER_FILE or frame.f_code.co_name == "<module>":
        return None
    recorder.check_deadline()
    recorder.emit(CallEvent(frame.f_code.co_name, frame.f_lineno, {k: snapshot(v) for k, v in frame.f_locals.items()}))
    return trace_lines


def trace_lines(frame, event, argument):
    recorder.check_deadline()
    if event == "line":
        recorder.emit(LineEvent(frame.f_lineno, {k: snapshot(v) for k, v in frame.f_locals.items()}, user_stack(frame)))
    elif event == "return":
        recorder.emit(ReturnEvent(frame.f_code.co_name, frame.f_lineno, snapshot(argument)))
    return trace_lines


class PrintCapture:
    def __init__(self):
        self.text = ""
        self._line = ""

    def write(self, text):
        self.text = (self.text + text)[:MAX_STDOUT]
        self._line += text
        while "\n" in self._line:
            line, self._line = self._line.split("\n", 1)
            recorder.emit(PrintEvent(line))
        return len(text)

    def flush(self):
        if self._line:
            recorder.emit(PrintEvent(self._line))
            self._line = ""


def build_arguments(raw):
    if isinstance(raw, dict):
        return [], {key: TracedList(value) if isinstance(value, list) else value for key, value in raw.items()}
    return [TracedList(raw) if isinstance(raw, list) else raw], {}


def main():
    global recorder
    request = json.loads(sys.stdin.read())
    real_stdout = sys.stdout
    recorder = Recorder(request["max_events"], time.monotonic() + request["deadline_seconds"])
    capture = PrintCapture()
    args, kwargs = build_arguments(request["arguments"])
    result = None
    error = None
    sys.stdout = capture
    try:
        namespace = {"__name__": "__traced__"}
        exec(compile(request["source"], USER_FILE, "exec"), namespace)
        if request["entry"] not in namespace:
            raise NameError(f"the source defines no function named '{request['entry']}'")
        sys.settrace(trace_calls)
        try:
            result = namespace[request["entry"]](*args, **kwargs)
        finally:
            sys.settrace(None)
    except TraceDeadline:
        error = "the run exceeded its time limit"
    except Exception as exception:
        error = f"{type(exception).__name__}: {exception}"
    finally:
        sys.stdout = real_stdout
    capture.flush()
    recorder.flush_pending_set()
    finals = snapshot(args if args else kwargs)
    output = {
        "events": [dataclasses.asdict(event) for event in recorder.events],
        "counters": dataclasses.asdict(recorder.counters),
        "result": snapshot(result),
        "finals": finals,
        "stdout": capture.text,
        "truncated": recorder.truncated,
        "error": error,
    }
    sys.stdout.write(json.dumps(output))


main()
