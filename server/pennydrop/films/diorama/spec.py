"""Fields that read the writer's JSON.

Every value passes through a field that knows what is allowed.
A field reports each mistake with its JSON path and what would be right, and reading goes on, so one pass finds them all.
The same fields describe themselves for the catalog, so what the engine accepts and what it advertises cannot drift.
"""

import difflib
import re

REQUIRED = object()
IDENTIFIER = re.compile(r"^[a-z][a-z0-9_]*$")


class Reading:
    """One pass over a job: the errors found so far, each said once."""

    def __init__(self):
        self.errors = []

    def fail(self, path, message):
        error = f"{path}: {message}"
        if error not in self.errors:
            self.errors.append(error)


def show(value):
    text = repr(value) if isinstance(value, str) else str(value).replace("True", "true").replace("False", "false").replace("None", "null")
    return text if len(text) <= 60 else text[:57] + "..."


def nearest(name, allowed):
    """What a writer most likely meant by an unknown name."""
    allowed = sorted(allowed)
    close = difflib.get_close_matches(str(name), allowed, n=3, cutoff=0.5)
    if close:
        return "close matches: " + ", ".join(close)
    if len(allowed) <= 30:
        return "allowed: " + ", ".join(allowed)
    return "the catalog lists the allowed names"


class Number:
    def __init__(self, low=None, high=None):
        self.low, self.high = low, high

    def read(self, value, path, reading):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return reading.fail(path, f"expected a number, got {show(value)}")
        if (self.low is not None and value < self.low) or (self.high is not None and value > self.high):
            return reading.fail(path, f"{show(value)} is outside the valid range, {self._range()}")
        return float(value)

    def _range(self):
        if self.low is None:
            return f"at most {self.high:g}"
        if self.high is None:
            return f"at least {self.low:g}"
        return f"{self.low:g} to {self.high:g}"

    def describe(self):
        return "number" if self.low is None and self.high is None else f"number, {self._range()}"


class Whole(Number):
    def read(self, value, path, reading):
        number = super().read(value, path, reading)
        if number is None:
            return None
        if number != int(number):
            return reading.fail(path, f"expected a whole number, got {show(value)}")
        return int(number)

    def describe(self):
        return "whole " + super().describe()


class Text:
    def __init__(self, longest=80):
        self.longest = longest

    def read(self, value, path, reading):
        if not isinstance(value, str):
            return reading.fail(path, f"expected text, got {show(value)}")
        if len(value) > self.longest:
            return reading.fail(path, f"text is {len(value)} characters long; keep it within {self.longest}")
        return value

    def describe(self):
        return "text"


class Flag:
    def read(self, value, path, reading):
        if not isinstance(value, bool):
            return reading.fail(path, f"expected true or false, got {show(value)}")
        return value

    def describe(self):
        return "true or false"


class Choice:
    """One name out of a list, or out of a registry that may still grow while modules load."""

    def __init__(self, options, noun="value"):
        self._options, self.noun = options, noun

    def options(self):
        return list(self._options() if callable(self._options) else self._options)

    def read(self, value, path, reading):
        options = self.options()
        if value in options and isinstance(value, str):
            return value
        return reading.fail(path, f"unknown {self.noun} {show(value)}; {nearest(value, options)}")

    def describe(self):
        options = self.options()
        return "one of: " + ", ".join(options) if len(options) <= 40 else f"one {self.noun} from the catalog"


class Identifier:
    def read(self, value, path, reading):
        if not isinstance(value, str) or not IDENTIFIER.match(value):
            return reading.fail(path, f"{show(value)} is not a valid id; use lowercase letters, digits and underscores, starting with a letter")
        return value

    def describe(self):
        return "id"


class Vector:
    def __init__(self, size, low=None, high=None):
        self.size, self.item = size, Number(low, high)

    def read(self, value, path, reading):
        if not isinstance(value, list) or len(value) != self.size:
            return reading.fail(path, f"expected a list of {self.size} numbers, got {show(value)}")
        items = [self.item.read(item, f"{path}[{index}]", reading) for index, item in enumerate(value)]
        return None if None in items else tuple(items)

    def describe(self):
        return f"list of {self.size} numbers"


class Many:
    def __init__(self, item, least=0, most=None):
        self.item, self.least, self.most = item, least, most

    def read(self, value, path, reading):
        if not isinstance(value, list):
            return reading.fail(path, f"expected a list, got {show(value)}")
        if len(value) < self.least or (self.most is not None and len(value) > self.most):
            wanted = f"at least {self.least}" if self.most is None else f"{self.least} to {self.most}"
            return reading.fail(path, f"the list has {len(value)} items; it takes {wanted}")
        items = [self.item.read(item, f"{path}[{index}]", reading) for index, item in enumerate(value)]
        return None if any(item is None for item in items) else items

    def describe(self):
        return ["list of", self.item.describe()]


class OneOrMany(Many):
    """A list that may be written as its single item."""

    def read(self, value, path, reading):
        if isinstance(value, list):
            return super().read(value, path, reading)
        item = self.item.read(value, path, reading)
        return None if item is None else [item]


class Mapping:
    """An object whose keys are ids the writer chose."""

    def __init__(self, item):
        self.item = item

    def read(self, value, path, reading):
        if not isinstance(value, dict):
            return reading.fail(path, f"expected an object of named entries, got {show(value)}")
        entries = {}
        for key, item in value.items():
            if Identifier().read(key, f"{path}.{key}", reading) is not None:
                entries[key] = self.item.read(item, f"{path}.{key}", reading)
        return entries

    def describe(self):
        return {"<id>": self.item.describe()}


class Record:
    """An object with known keys. A key maps to a field, or to (field, default) when it may be left out."""

    def __init__(self, **keys):
        self.keys = {name: entry if isinstance(entry, tuple) else (entry, REQUIRED) for name, entry in keys.items()}

    def read(self, value, path, reading):
        if not isinstance(value, dict):
            return reading.fail(path, f"expected an object, got {show(value)}")
        return self.read_keys(value, path, reading, self.keys)

    @staticmethod
    def read_keys(value, path, reading, keys):
        record, complete = {}, True
        for key in value:
            if key not in keys:
                reading.fail(f"{path}.{key}", f"unknown key; {nearest(key, keys)}")
                complete = False
        for key, (field, default) in keys.items():
            if key in value:
                record[key] = field.read(value[key], f"{path}.{key}", reading)
                complete = complete and record[key] is not None
            elif default is REQUIRED:
                reading.fail(path, f"the required key '{key}' is missing")
                complete = False
            else:
                record[key] = default
        return record if complete else None

    def describe(self):
        return describe_keys(self.keys)


def describe_keys(keys):
    return {name + ("" if default is not REQUIRED else " (required)"): field.describe() for name, (field, default) in keys.items()}


class Entry:
    def __init__(self, name, about, options, make, facts):
        self.name, self.about, self.make, self.facts = name, about, make, facts
        self.options = {key: entry if isinstance(entry, tuple) else (entry, REQUIRED) for key, entry in options.items()}

    def describe(self):
        described = {"about": self.about}
        if self.options:
            described["options"] = describe_keys(self.options)
        described.update({key: value() if callable(value) else value for key, value in self.facts.items()})
        return described


class Registry:
    """A named vocabulary the code fills as it loads: actions, garments, pieces, effects and so on."""

    def __init__(self, noun):
        self.noun = noun
        self.entries = {}

    def add(self, name, about, options=None, make=None, **facts):
        self.entries[name] = Entry(name, about, options or {}, make, facts)
        return self.entries[name]

    def register(self, about, options=None, name=None, **facts):
        def decorate(function):
            self.add(name or function.__name__, about, options, function, **facts)
            return function

        return decorate

    def names(self):
        return list(self.entries)

    def __getitem__(self, name):
        return self.entries[name]

    def __contains__(self, name):
        return name in self.entries

    def choice(self):
        return Choice(self.names, self.noun)

    def describe(self):
        return {name: entry.describe() for name, entry in self.entries.items()}


class Kinded:
    """An object whose `kind` key (or another naming key) picks a registry entry, which then says which other keys it takes."""

    def __init__(self, registry, naming_key="kind", bare_name=False, **shared):
        self.registry, self.naming_key, self.bare_name = registry, naming_key, bare_name
        self.shared = {name: entry if isinstance(entry, tuple) else (entry, REQUIRED) for name, entry in shared.items()}

    def read(self, value, path, reading):
        if self.bare_name and isinstance(value, str):
            value = {self.naming_key: value}
        if not isinstance(value, dict):
            return reading.fail(path, f"expected an object with a '{self.naming_key}', got {show(value)}")
        if self.naming_key not in value:
            return reading.fail(path, f"the required key '{self.naming_key}' is missing; {nearest('', self.registry.names())}")
        name = self.registry.choice().read(value[self.naming_key], f"{path}.{self.naming_key}", reading)
        if name is None:
            return None
        keys = {self.naming_key: (Text(), REQUIRED), **self.shared, **self.registry[name].options}
        return Record.read_keys(value, path, reading, keys)

    def describe(self):
        described = describe_keys(self.shared)
        described[self.naming_key + " (required)"] = f"one {self.registry.noun} from the catalog, with that {self.registry.noun}'s own options"
        return described
