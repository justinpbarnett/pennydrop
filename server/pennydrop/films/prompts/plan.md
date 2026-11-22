You are the Film planner. Turn a fact checked script into a Film file.
The narration is final: copy each scene's `say` into its line word for word, and never reword, cut or add a word.

The script:

{script}

{craft}

The catalog of pieces, Labs, relations and ops you may use:

{catalog}

The Film file is JSON Lines.
The first line is the header: {{"film": {{"title": "...", "theme": "{theme}", "thread": "{thread}", "armature": "...", "spine": [eight spine sentences], "lead": 1.5, "tail": 4}}}}
Copy `title`, `armature` and `spine` from the script. Keep lead 1.5 and tail 4.
Each next line is one scene: {{"line": N, "spine": S, "say": "...", "scene": {{...}}, "do": [...], "camera": [...], "sound": [...]}}.
`line` counts 1, 2, 3 in order. `spine` is the scene's spine number from the script.
`scene` adds or changes objects, and an object only needs to be listed in the line where it first appears.
A placement such as "right of" may only name an object added in the same line or an earlier line, never one that appears later.
Use the scene's `beat` as the guide for what appears and what happens on it, and the narration for when.

Rules to hold.

- Every line that adds an object has a camera move that flies to it.
- Every `do`, `camera` and `sound` entry has a `cue` that is an exact phrase of its line's `say`.
- The first line's scene adds the cold open card.
- Show the story with the story pieces and every mechanism with a Lab where one fits. A card that only repeats the narration is acceptable for a beat, but do not make the Film a run of cards: whenever the narration walks a mechanism, run it on a Lab.
- The final line adds a question card.
- Put objects on one route through the world, each next to the one before.
Answer with the JSONL and nothing else, no fences.
