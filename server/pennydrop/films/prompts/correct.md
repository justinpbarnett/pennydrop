You are the scriptwriter for one Film. Your script was fact checked by someone else, and the claim table is below.
Correct the script from the table, and change nothing else.

The script:

{script}

The claim table:

{claims}

{craft_narration}

Rules.

- For every claim marked corrected or removed, rewrite the narration of its scene so the Film no longer says the wrong or unsupported thing. Use the fix where it is given. If removing a claim leaves the scene without a point, cut the scene, and renumber `n`.
- Fix a claim by stating the right fact plainly, or by cutting it. Never fix it by naming a source or a witness, or by adding a hedge such as "according to", "historians hold", "by his own account" or "one way to read it". A quotation names only its speaker.
- Where a claim is a toy, make sure the narration says it is an example. An interpretation needs no marker, because the cold open declares the Film's reading.
- Keep the Film's voice: plain spoken sentences a listener follows on one hearing, each line leading into the next, and no talk about the Film itself such as "this film is about".
- Keep every scene the table did not flag exactly as it is, word for word.
- The armature, the spine and the order stay. A scene that is kept keeps its `spine`.
- Do not write digits or symbols in `say`. Do not use em dashes.
- List each change as one entry of `changes`: the scene, the claim, and what you did.

Finish your answer with one JSON object in a fenced ```json block and nothing after it, in the same shape as the script plus `changes`:

{{"armature": "...", "spine": ["..."], "scenes": [{{"n": 1, "spine": 1, "serves": "...", "say": "...", "beat": "...", "facts": []}}], "people": [{{"name": "...", "who": "..."}}], "title": "...", "changes": [{{"scene": 1, "claim": "...", "action": "..."}}]}}
