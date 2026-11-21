from __future__ import annotations

import re

COACHING = (
    (re.compile(r'^(?P<where>.*?)unknown object "(?P<name>[^"]+)"; objects in the Scene: (?P<present>.*)$', re.DOTALL),
     'a "do" entry can only act on an object that is on stage, and "{name}" is not (on stage: {present}); add "{name}" to this Step\'s "scene" with its full spec, or change the entry to an object that is on stage'),
    (re.compile(r"(?P<name>\w+): receive or drop the pending message before send"),
     'the last message on "{name}" is still in flight; put a "receive" or "drop" entry on "{name}" before each new "send", so every send is followed by exactly one receive or drop'),
    (re.compile(r"the Scene has too much on stage"),
     'remove every object this Step no longer talks about by setting it to null in "scene", so that at most three stay on stage'),
    (re.compile(r'cue "(?P<cue>[^"]*)" is not in say'),
     'copy the cue letter for letter from this Step\'s "say" (a word or phrase that really is there), or add "{cue}" to the narration, and order the cues as they are spoken'),
    (re.compile(r"'say' still holds an unresolved placeholder in braces: '[^']*\{(?P<name>[\w.]+)\}"),
     'no directive has computed "{name}" by this Step, so write the narration without the braces and without that number; a trace gives only comparisons, swaps and writes, and its placeholders work only in the Step that carries the trace or after it'),
    (re.compile(r"challenge\.number\.answer"),
     'a number Challenge\'s "answer" is a plain number such as 6; write the form "simulate.name" or "trace.comparisons" only when this Step has that directive, and never put words there'),
    (re.compile(r"trace directive: `?code`? is neither a library algorithm"),
     'write "code" as exactly one of the library names, or as Python source that starts with a top level "def"; the trace directive plays only the array, code and graph Labs, so to play the scheduler, threads or address Lab write a "simulate" directive instead'),
    (re.compile(r"the Step's own scene or the Scene on stage must hold exactly one object of a Lab that can play a trace[^;]*; found 0"),
     'add the object to this Step\'s "scene", an array with "values" equal to the input, a code object, or a graph, and put the "trace" directive on the same Step'),
    (re.compile(r"unexpected keyword argument '(?P<key>\w+)'"),
     'the "input" of a library algorithm uses exactly the keys its help gives, so rename "{key}" to the key shown'),
)


def coached(error: str) -> str:
    for pattern, advice in COACHING:
        found = pattern.search(error)
        if found:
            return f"{error}; to fix it, {advice.format(**{key: value for key, value in found.groupdict().items() if key != 'where'})}"
    return error
