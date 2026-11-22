## Film craft

A Film is one continuous shot through one world.
The camera flies between Set pieces that sit in a single space, and it never cuts.
Narration is the spine of the Film, and everything on screen is timed to a word of it.

### Narration

- Each line is one spoken beat of 35 to 65 words, in plain spoken sentences a smart fifteen year old follows on one hearing.
- Write numbers the way a person says them: "seventeen sixty nine", "sixty five thousand five hundred thirty six", "hex three A five C", "four megabytes". Never write digits or symbols in narration.
- Names are written as they are normally spelled, with accents. The voice reads them through a pronunciation table, and the check lists any name it still mishears.
- Spell the way an American does: harbor, center, color, not harbour, centre, colour. The voice is American and the check compares against what it said.
- No em dashes. Use commas and full stops.
- Every claim is something a source in the source pack supports, or it is plainly marked as a toy example or as an interpretation ("the way to read this is").
- A quotation of a person is only ever one that the source pack traces to their own work, their correspondence or a contemporary memoir. Never quote anyone from a popular saying.

### Set pieces

Each line may add objects to the Scene, and each line's camera move flies to one of them.
Use the story pieces for the story and the Labs for anything with a mechanism that can run.

Story pieces: keyword (the cold open or a term the Film turns on), quote, counter, tracker (the steps of a procedure), compare (held against broke), timeline, map, figure, question (the closing card).
Labs run a real mechanism: a Lab object has a state and ops that change it, and an op happens on a word of the narration.

The catalog at the end of this document is the exact list of pieces, Labs, their fields and their ops.
Use only what the catalog lists.

### Placement

A Film draws objects, not connector lines: never use the "connect" op or an "edge" object.

Objects sit in one world, placed relative to an earlier object with "at": {"right of": "id"}, "below", "above", "left of", "behind", "in front of".
Name every object with a short unique id.
Objects are never removed: an object stays in the world after its line. A Lab op named "remove" removes a node inside that Lab and needs a "node" argument, so never use it to take an object away.
Lay the Film out as one readable route: a new object goes next to the object the camera is leaving, so each flight is a short, steady move.
Never place an object so that a flight must cross the whole world, and never stack a new card directly beside text that stays on screen at a size too small to read.

### Cues

- Every `do` op, every camera move and every sound accent has a `cue`: a short exact phrase copied from the line's narration (case and punctuation as written). The op happens on that word.
- A counter's `count` op is cued on the word that says the number, and the counter is added in the Scene of the line whose narration says it. A counter never sits on its dash for more than ten seconds. When its number is said late in a line, do not put the counter in the line's Scene: bring it in with a `create` op (`"op": "create", "on": ["id"], "spec": {...piece spec with its \"at\"}`) cued on the few words just before the number, and count it on the number word itself.
- A line can have one to three camera moves, each cued on a phrase, `"go"` an object id, `"view"` one of wide, fit, close, `"elevation"` a few degrees of tilt (between -4 and 4), `"seconds"` between 2.5 and 4.
- Every line carries one sound accent: `{"cue": "...", "tone": "chime"}` where tone is one of hit, chime, tick, rise, swell.
- Every cue phrase must be findable in the narration, and where a phrase would repeat inside a line, choose one that is unique within the line.

### Camera discipline

- The first camera move of a line flies to the object that the line introduces, or to the one the narration is about.
- Use "fit" for a card or a Lab that must be read, and "close" for one short word.
- The plan check refuses any move that ends with text under 26 pixels high on screen, so a "wide" move is only for a short word, a number or a question card that stays large; never use it as an overview of small text.
- A card sits fully inside the frame when the move ends, with margin on every side.
- The previous section's cards must not peek in at the edge of the frame when the camera arrives. Place the new object far enough from the older ones, in the direction of the route, that only the object the camera is on is in the frame.
