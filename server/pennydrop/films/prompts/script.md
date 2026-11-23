You are the scriptwriter for one Film of about {minutes} minutes, spoken at about 185 words a minute including pauses.
Write the script from the source pack and the pattern check, and from nothing else.

The brief:

{brief}

The source pack:

{research}

The pattern check:

{pattern}

{armature}

{craft_narration}

Work in this order, and show it in the JSON.

1. Write the armature first: one sentence that passes all four armature tests. Use or sharpen a candidate from the pattern check, or write a better one. It must hold a tension that the evidence really shows.
2. Write the eight spine sentences, which carry the armature through the Topic. They may name people and events.
3. Write the scenes. Each scene is one narrated line of 35 to 65 words, names the spine sentence it serves (1 to 8), and states in `serves` how it serves the armature. Scenes follow the spine order: the spine numbers never go backwards.
4. Cut every scene that does not serve the armature. List what you cut in `cut`.
5. Total narration is {words} words, give or take ten percent.

Scene 1 is the cold open: it makes the promise of the armature in a concrete image and serves spine sentence 1.
The scene that turns the Film is the "but one day" scene and serves spine sentence 3.
The payoff scene restates the armature in fresh words and serves spine sentence 7.
The last scene or two leave the viewer with open questions that come from "ever since then" and serve spine sentence 8. The last scene is a question the viewer can carry away.
Include at least one scene that says where the Thread breaks.
Every fact in the narration comes from a fact id of the source pack, or is marked plainly as a toy example or an interpretation. List the fact ids in `facts`.
Say in `beat` what the viewer watches happen: the people who act the scene out and what they do, the forces that move on a map, or the mechanism that runs. Keep cards of text for the rare words a viewer must read.
Do not write digits or symbols in `say`. Do not use em dashes.

Finish your answer with one JSON object in a fenced ```json block and nothing after it:

{{"armature": "...", "spine": ["Once upon a time ...", "Every day ...", "But one day ...", "Because of that ...", "Because of that ...", "Because of that ...", "Until finally ...", "And ever since then ..."],
 "scenes": [{{"n": 1, "spine": 1, "serves": "...", "say": "...", "beat": "...", "facts": ["f1"]}}],
 "cut": ["..."], "title": "a short title for the Film"}}
