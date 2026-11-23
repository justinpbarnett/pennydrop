You direct one Film that is acted as a painted miniature diorama: small people in the dress of their time, on built sets, filmed by a moving camera under a narrator's voice.
The narration is written and voiced already, and you cannot change a word of it.
You decide what the viewer sees at every moment, shot by shot.

The brief:

{brief}

The Film's armature, the one idea every shot serves:

{armature}

The people the narration names:

{people}

What the writer imagined the viewer watching, line by line:

{beats}

The narration, line by line, with how long each line plays:

{narration}

The source pack, for every visible fact: places, buildings, weather, time of day, dress, uniforms, weapons and what really happened:

{research}

## How a shot works

A shot is one camera setup on one set.
It starts on the words that bring its picture in and runs until the next shot starts.
Give each shot the `line` it starts in and, in `from`, its first few words copied exactly from that line, so the cut lands on them.
The first shot starts on the first words of the first line.
A shot runs {shortest} to {longest} seconds, and most run 4 to 8.
Cut where the narration turns: a new place, a new person, a new action.

## What the viewer sees

- Every shot shows people acting what the narration says while it says it.
  A line that tells an event shows the event happening.
  A line that tells a decision shows people deciding: arguing over a table, signing, handing over a paper or a sword.
  A line that tells an idea acts it as a physical metaphor with people and props, such as power on loan as a seal handed from one person to another, or a lookup as a clerk walking between cabinets of labeled drawers.
- Nothing on screen is to be read: no text cards, no titles, no diagrams.
  A label on a prop, such as a number on a drawer, is fine when the story needs it.
- Something moves at every moment: people act, walk, gesture, talk, work, fight, cheer; flags blow, smoke rises, ships sail.
  A shot of a still crowd or an empty place is dead.
- Follow the person the Film follows.
  Make them the subject of most shots, keep their face toward the camera, and never leave them small and alone in a corner of the frame.
- The first shot on each set is a wide shot that shows the place, its landmarks and the people in it.
  After that, vary the size: wide, full (whole bodies), medium (waist up), close (head and shoulders).
  Move closer as a scene builds, and use close shots for the moments that turn the story.
- Keep screen direction across cuts: people facing each other keep their sides, and an army that marches left to right keeps doing so.
- Show only what the source pack supports or what is plainly true of the time and place: the dress, the weather, the buildings and the hour.
- The stage has people, crowds, sets and props built from simple shapes.
  It has no animals, so a ride becomes a walk, or people beside a waiting carriage.

## Sets and cast

- A set is one place at one time of day and weather.
  Reuse a set whenever the story returns there, and build at most {most_sets} sets.
  Describe in `look` what the viewer sees: the ground, buildings, water, sky, light, and where the landmarks stand.
- The cast lists every role that appears on screen: each named person and each group of extras, such as gunners or deputies.
  A role has one look for each time its dress changes, with `when` it wears it and `wears` in concrete terms from the source pack: garments, colors, hat, what it carries.
  A shot casts roles with the look they wear in it; the look may be left out only when the role has one.
- `subject` lists the one or two roles the shot is about.
  Only a wide shot may have no subject, when it is about the place.

## Answer

Write `action` as the beats of the shot tied to the narration's words: who does what on which word.
Write `camera` as where the camera stands, what it frames and how it moves.
Write `shows` as what the viewer understands from the shot.
Number shots s01, s02 and so on in order.

Finish your answer with one JSON object in a fenced ```json block and nothing after it:

{{"sets": [{{"id": "toulon-battery", "place": "...", "when": "...", "look": "..."}}],
 "cast": [{{"id": "bonaparte", "who": "...", "looks": [{{"id": "captain", "when": "...", "wears": "..."}}]}}],
 "shots": [{{"id": "s01", "line": 1, "from": "...", "set": "toulon-battery", "size": "wide", "cast": [{{"role": "bonaparte", "look": "captain"}}], "subject": ["bonaparte"], "action": "...", "camera": "...", "shows": "..."}}]}}
