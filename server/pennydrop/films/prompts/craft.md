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

A Film is watched, not read.
Every line shows something happen: people act it out on a stage, forces move on a map, or a mechanism runs on a Lab.
A card of text is the exception, kept for the few words a viewer must read.

- Show the people a line is about doing what the narration says, on a stage. Walk them on, hand over the command, have them salute, plead, fall or flee, fire the guns, let the crowd cheer or run.
- Show where things happened and how forces moved on a map: a journey drawn place by place, armies marching, battles bursting where they meet.
- Run every mechanism on a Lab.
- Act an abstract idea instead of printing it. Power lent is an orb handed from the person who lends it to the one who borrows it. A fall from favor is a person dimmed or vanishing. A rise is a climb up a ranks staircase.
- A card is only for what no picture carries: a term the Film turns on (keyword), a written line the viewer must read whole (quote), a number that must be seen (counter), where a comparison holds and where it breaks (compare), the steps of a procedure (tracker), dates in order (timeline), and the closing question (question). At most one line in four adds a card, and the closing question card does not count.

The catalog at the end of this document is the exact list of pieces, Labs, their fields and their ops.
Use only what the catalog lists.

### Acting a scene

- Use one stage for each place. A stage stays in the world, so a later line acts on it again by its id without adding it again. Add a new stage when the story moves to a new place.
- Cast only the people a line needs: a few people and at most two crowds. The protagonist has "tone": "lead" and a label, and every person the narration names has a label.
- A person waits offstage ("at": "off left" or "off right") and enters on the cue that brings them in, or stands on stage from the start when the line opens on them.
- Give a person one op on a cue. To walk somewhere and end in a pose, give the "walk" its "pose", and do not also cue a "pose" on the same word.
- Every op on a stage runs in real time. While one person walks, the others act on their own cues, but that person's next op waits for the walk to end. A walk across the whole stage takes about five seconds, so cue the walker's next op that far into the narration, or walk a shorter way.
- Block the stage so every person reads. People stand clear of each other, crowds stand clear of each other, and nobody stands in front of a gun's muzzle or in its line of fire. The stage refuses blocking that breaks this and says what to change.
- A "say" bubble holds only words the source pack records that person saying, at most sixteen words. Never invent dialogue.
- A caption names the place and year, such as "Toulon, 1793".

### Showing it on a map

- Use one map for each theater of events, and keep its "region" tight around its places so their names have room. A map refuses a layout with no room and says which place to leave out.
- List every place the map will name, in the order the story reaches them.
- A journey uses "go". Armies use "march" and "clash". A map stays in the world, so a later line can move its armies again.
- Move a force only where the story says it went, on the word that says so. A plan, a request or a report is not a march: act it on a stage. An army never marches back the way it came unless a battle drove it.

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
- Use "fit" for a stage, a map, a Lab or a card that must be read, and "close" for one short word.
- The plan check refuses any move that ends with text under 26 pixels high on screen, so a "wide" move is only for a short word, a number or a question card that stays large; never use it as an overview of small text.
- An object sits fully inside the frame when the move ends, with margin on every side.
- The previous section's objects must not peek in at the edge of the frame when the camera arrives. Place the new object far enough from the older ones, in the direction of the route, that only the object the camera is on is in the frame.
