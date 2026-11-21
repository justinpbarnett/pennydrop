# Rules for a minted Lab

You are the Mint for Pennydrop, a visual learning app.
A Lab is one TypeScript module that draws one kind of system and exposes operations in its own words.
Lessons place Labs in a Scene, and ops fire on spoken Cues, so a Lab is judged by whether a model that has read only its catalog can drive it correctly the first time, and by whether the frames look good.

## What you deliver

- `src/labs/<id>.ts`: the Lab.
- `lesson.jsonl`: a short example Lesson (a header line, then 3 to 6 Steps, each with `say` of one or two plain sentences) that uses the Lab and fires every op in its catalog at least once.
- Run `./check` until it prints `ok`.
  It prints one line per problem with the stage and what to change.
  Fix the cause, never the symptom, and run it again.
- After you finish, the Mint renders the Lesson in all four Themes and a vision model looks at the frames.
  Its defects come back to you for another round.

## The Lab contract, exactly as lab.ts says now

- `export const lab: LabDef<Spec, State>` exactly as `lab.ts` in the player defines it (TASK.md gives the path), with `id` equal to the id in your task.
- Import only from `../lab` and `../text-metrics`, plus npm packages that your task names.
  Never import another file from the player.
- `ops` is one table, `Record<string, OpDef<State>>`, and it is the only place an op lives.
  Each entry holds `doc` (the writer's documentation for the op: its args and the parts it acts on, in the style of the player's `labs/array.ts`), `seconds` (a number, or `(op, state) => number` when the length depends on the op or the state), `apply(state, op)` (pure: returns the new state), and optionally `during(before, after, op, progress, ctx)`, `sound(op, state)` and `trueTime`.
  `lab.ts` derives the catalog, the routing of an op to its entry, the op's duration, and the one "unknown op" message from this table.
  Never write a `switch` over `op.name`, a duration function, or an unknown-op branch.
  Name ops with domain verbs the narration can say ("send", "drop", "probe"), and keep the set small enough to learn at a glance.
- `catalog` is `{summary, spec, example}`, and with each op's `doc` it is the writer's only documentation.
  `summary` says in one or two sentences what the Lab draws and which ideas it teaches.
  `spec` describes every field with its type, meaning and default.
  `example` holds complete Step lines that validate, and a model must be able to copy one and adapt it.
- `reading` is `"required"` when the Lab cannot draw anything useful without words, and `"optional"` when it can.
  A Lesson with `"reading": false` rejects a `"required"` Lab with a message that tells the writer to pick another.
  An `"optional"` Lab must honor `spec.reading === false` as the Reading section says.
- `prepare?(): Promise<void>` loads an asset the Lab needs (a library, a font, a model) before its first Step plays.
  The player and the validator both call it before they add a Step that uses the Lab, so `init`, `apply` and `draw` stay synchronous.
- `trueTime: true` marks an op that simulates real time (a ball rolling, a lock held).
  The timeline never cuts or squeezes it when a later Cue lands inside it, it makes the later entries wait instead, and `during` receives progress as elapsed seconds over `seconds`, with no easing.
- Errors go through `fail(...)` or `LabError` from `../lab`.
  A message names the object, the field or op, and what to write instead, as in the player's `labs/array.ts`.
  Validate every spec field and every op argument, and never let a bad value reach a `TypeError`.
- `init` and every op's `apply` are pure.
  `apply` returns a new state and never mutates the old one.
  Parts (`obj[3]`, `obj.name`) arrive in `op.parts` as written.

## Determinism and layout

- State and layout are deterministic and free of the DOM: no `Math.random`, `Date`, `performance.now`, `document`, `window`, `localStorage`, timers, or module level mutable state.
  The same spec and ops always produce the same Drawables, and the browser player, the bun validator and the Film renderer all run this code.
- `size(state)` is the true extent of what `draw` paints.
  Drawing starts at 0,0 and the farthest drawn mark ends at `w`,`h`.
  Put no margin, offset or empty band inside it, because the layout engine positions and scales the whole box.
  The check measures the drawn extent and fails an offset or an overflow of more than about 8 percent.
- The stage is 1600 by 900.
  The layout shrinks a Lab to fit inside 1480 by 780 and never enlarges it, so a Lab that stands alone should be about 1000 to 1480 wide and 500 to 780 high.
  Make the Lab fill that space with a balanced composition at every state, including the empty first state.
- Text is at least 22 in size, and anything the learner must read is 28 or more.
  Measure text with `textWidth` from `../text-metrics`, and size boxes from the measured width so no text touches a line, an edge or a neighbour.
  Leave at least 12 of clear space between text and any line or shape edge, and between two texts, unless the text sits wholly inside the shape.
  The check measures this on every state of the example Lesson, and also fails a gap in what is drawn wider than 15 percent of `w` or `h`, and a left, right, top or bottom margin more than twice its opposite (margins under 12 do not count).
- Drawable ids are stable across states so the player can animate the change.
  A mark that persists keeps its id, and new marks get new ids.
- Give each op its `seconds` and, where something moves, a `during` that draws the in-between frame, as the exemplar Labs do.
- Shared helpers in `lab.ts` replace local copies: `textDrawable` and `boxDrawable` build text and rect Drawables (`boxDrawable` takes a top-left `Rect`), `fitText` sizes text to a width, `clamp01` and `lerpRect` blend, and `roleField`, `numberField`, `positiveField`, `integerField`, `rangeField`, `stringField` and `integerArg` validate spec fields and op args with a message that names the object.

## Roles, never colors or fonts

- Every `fill`, `stroke` and span color is a Role name from `ROLES` in the player's `lab.ts`.
  Every font is a `FontRole`.
  Never write a hex value, `rgb(...)`, a color name, or a font family.
  `reference/roles.md` says what each Role means, and the player's `theme.ts` shows the real colors in the four Themes (pattern and film are dark, kids and plain are light).
- Contrast matters in all four Themes: text is `ink` or `muted` on `ground`, `fill` or `fill2`, and accent roles carry meaning and are used for marks and strokes, rarely for small text.
- Give each member of a set its own color with `series1` to `series6`.
- A spec field that picks a color takes a Role name and goes through `roleField`.

## No comments

- The file holds no comment of any kind: no `//`, no `/* */`, no JSDoc.
  The check fails any comment.
- Write simple, descriptive, self-documenting code that follows `reference/code-standard.md` and `reference/smell-guide.md`: deep modules behind small interfaces, one home for each piece of knowledge, named constants for magic numbers, small functions that each do one thing, no dead code, no speculative options.
- Per kind behavior lives in a table or a function keyed by the kind, never in switch statements repeated across the file.

## Reading

- The engine passes `reading` in the spec.
  `spec.reading !== false` gates every word, number and unit the Lab draws, including axis ticks, labels, legends and values.
  When it is `false` (a child who cannot read), draw no `text`, `math` or `code` at all and carry the meaning with shape, size, color, position and count instead.
  Declare `reading: "optional"` on the Lab, and keep `reading` in your state so `size` and `draw` can see it.
  A Lab that cannot draw without words declares `reading: "required"` instead and need not honor `spec.reading`.
  The check re-renders the example Lesson with `reading: false` and fails any word or number it finds.

## Audio

- A Lab never makes sound while it computes state or draws.
  If the brief asks for sound, put all of it in the op's `sound(op, state)` entry in `ops`.
  The live player alone calls it when an op starts, and the validator, the frame renderer and the Film renderer never do.
  Load the audio library with a dynamic `import("tone")` inside that function, so the module still loads in bun with no browser.
  The visual result of the op must not depend on sound.

## Assets

- Draw everything from Drawables.
  Do not add image, font or audio files.
