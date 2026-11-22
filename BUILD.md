# Pennydrop build state

The build session reads this file first and resumes from it.
Terms follow `CONTEXT.md`.
The goal and the design live outside the repo, in the workshop initiative `pennydrop-2026-11-15`.

## Done conditions

| # | Condition | State |
|---|---|---|
| M1 | Player, format and Themes: bubble sort, page table walk and Pythagoras play, seek deterministically, switch live between four Themes, tailnet link pushed | open |
| M2 | Writer, classification, validator, TTS: ten typed or spoken Asks, first Step about 4 s, done about 15 s, seconds and cost logged, JEV classifies | open |
| M3 | Tracer, code stepper, array, graph and tree, scheduler, address translation, threads and locks, each in a generated Lesson | open |
| M4 | Kids mode on the iPad home screen over the tailnet: voice in and out, nothing to read, the first kids Profile, content check, lesson log, picture explainer, numbers and shapes, physics | open |
| M5 | The Mint mints and promotes nine Labs, a CS 6200 Course, Challenge answers in the review queue | open |
| M6 | Two pilot Films to MP4 at about -14 LUFS with fact check log and Cue offset check, voice A/B minute, TTS by config, ElevenLabs adapter | open |
| 7 | Judging pass over a frame from every Lab and frames and audio from both Films, with fixes | open |

## Environment

- Mac: Apple M4 Max, 38 GB, about 29 GB disk free at start, so keep model downloads lean.
- Tailnet host `macbook.tail7a3807.ts.net`.
  Port 443 already serves another app, so Pennydrop is served with `tailscale serve --bg --https=8443 http://127.0.0.1:8740`.
  The CLI is `/Applications/Tailscale.localized/Tailscale.app/Contents/MacOS/Tailscale`.
- The tailnet holds the Mac and an iPhone, and no iPad yet.
- Server port 8740, Vite dev port 5173 with a proxy to 8740.
- `claude -p` measured at 1.5 s to first token for Haiku 5.5 and 1.6 s total for a short Sonnet 5.5 answer.
  `--bare` is never used, because it skips subscription OAuth.
- `codex exec -m gpt-6.2-astra` answers a short prompt in about 5 s.
- JEV is `typesafe/jev-1.14` on OpenRouter at `POST https://openrouter.ai/api/v1/systemone` with body `{model, state, questions}`.
  Question types are `choice` (with `criteria`), `score`, and `noul` (a yes or no probability).
  One call took 0.2 s and cost $0.000015.
  The key is `OPENROUTER_API_KEY` in the gitignored `.env`.
- whisper-cli model: `~/.cache/whisper-cpp/ggml-large-v3-turbo-q5_0.bin`.
- Playwright Chromium is cached in `~/Library/Caches/ms-playwright`.
- `ELEVENLABS_API_KEY` is in `.env` on the free plan, so keep ElevenLabs use to short checks and ask before a long render.

## Decisions

- One repo, two halves.
  `server/pennydrop` is the Python package (FastAPI, uv, Python 3.12) with `pyproject.toml` and `config.toml` at the repo root, run as `uv run pd ...`.
  `player/` is the TypeScript and Vite app, built with pnpm.
- `data/` (gitignored) holds the SQLite store, Profiles, the TTS cache, lesson logs, minted Labs, Film renders and course material.
- Hand written Lessons live in `lessons/*.jsonl`.
- Lab ids: `array`, `graph`, `code`, `address`, `scheduler`, `threads`, `shapes`, `physics`, `picture`.
  Minted Lab ids: `hash`, `memory`, `sequence`, `bits`, `plot`, `map`, `words`, `music`, `circuit`.
- Theme ids: `pattern`, `film`, `kids`, `plain`.
- Each Lab is one TypeScript module whose state logic and layout are pure and DOM free, so the browser player, the bun validator and the Film renderer all run the same code.
  The Lab registry finds Labs by glob, so adding a Lab touches no shared file.
- Writer tools are Step directives (`trace`, `simulate`, `math`, `images`, `locate`) that the server expands into Scene objects and operations before a Step reaches the player.
  This keeps the writer to one streamed call with no tool round trips.
- The validator checks schema in Python, then replays the Step through the real Lab code in a long lived `bun player/tools/validate.ts` process.
- A Step's `scene` sets or replaces the objects it names (`null` removes one) and the rest persist.
  Its `do` operations then fire on their Cues.
  The Scene after the Step is the result.
- The player renders a frame as a pure function of the timeline value: Lab state at a segment start and end, drawables by stable id, interpolation by eased progress, theme roles resolved to colors last.
- Subagents do not commit.
  The build session reviews each result, commits it as the repo's noreply identity, and pushes.
- The open local voice is Qwen3-TTS 1.7B CustomVoice (8-bit MLX build, Apache-2.0, speaker "Ryan"), provider `qwen3`.
  Kokoro stays the default, and `[tts] provider` swaps them.
  Chatterbox (MIT) cut off long text and was slower.
  VoxCPM2 (Apache-2.0) drifted in voice and level between sentences.
  Voxtral TTS was ruled out by its non commercial license.
  None of the open models gives word timings, so `align.py` aligns whisper's words to the text.
  No one listens before a choice, so `pd voice ab` judges by time, word error rate against the text, loudness and true peak.
- Loudness has one home, `server/pennydrop/loudness.py`: a two pass `loudnorm` to -14 LUFS and -1.5 dBTP.
- The writer stays on the subscription route.
  Haiku 5.5 thinks adaptively through `claude -p`, and no flag or environment variable turns it off.
  The writer's system prompt says the task needs no extended thinking, which stopped it on 5 of 6 probe runs, and the hedge covers the rest.

## Code standard

Justin asked on 2026-11-21 that the build follow the improve-codebase skill as the reference for good code.
Every agent brief points at `~/dev/ai/skills/improve-codebase/references/smell-guide.md` and `workflow.md`.
- Deep modules behind small interfaces, checked with the deletion test, and no forwarding layers or speculative extension points.
- One home for each piece of knowledge, and a dependency direction that points down: format and contracts, then state, then layout and drawing, then the app; config and store, then gateway, TTS, intake and tracer, then API and CLI.
- Per kind behavior lives with the kind (a Lab, a route adapter, a TTS provider), never in switch statements spread across files.
- Typed records cross module boundaries, and errors carry messages a person or a model can act on.

Each milestone closes only after this gate:

```
SKILL=~/dev/ai/skills/improve-codebase
$SKILL/.venv/bin/python $SKILL/scripts/improve_codebase.py scan --root "$PWD" --summary --format json
```

Then a fresh read only reviewer checks the milestone's code on the three axes (smells and standards, architecture, contracts), and every finding is fixed before the milestone is marked done.
The scanner's ledger lives in `.improve-codebase/`, which the scanner keeps out of git through the local exclude file.

## Contracts

### Lesson stream

`POST /api/asks` takes JSON `{text, profile_id?, from?: {lesson_id, step}}`, or multipart with an `audio` file plus the same fields (`from` as a JSON string).
It answers `{lesson_id, transcript}` as soon as the Lesson id exists, before any writing.
`GET /api/lessons/{id}` returns `{id, lesson, steps, done, error}`. `done` is `false` while the Lesson is still being written.
`GET /api/lessons` lists Lessons and hides bench Lessons (`source='bench'`) and Lessons asked from a kid Profile. `GET /api/lessons?profile=<id>` lists that Profile's Lessons.
`GET /api/profiles/{id}/log` returns each ask with `content_check`: empty for an adult Ask, then `passed`, `redone: step N, M` or `refused: ask a grown up` for a kid Ask.
`GET /api/lessons/{id}/events` replays what is stored, then streams new events until the Lesson ends: `lesson` (`{id, lesson}`), `step`, `done` with stats, and `error` (`{message}`).
`done` carries `seconds`, `first_step_seconds`, `steps`, `tier`, `labs`, `cost_usd`, `timings` (named marks in seconds from the Ask), `transcription_seconds` and `repairs`.
A follow up Lesson (`from` set) has `lesson.start_scene`, the validator's Scene state at the `from` Step. The player starts its Timeline from it.
Each Step the player receives is the Step JSON plus `voice: {url, duration, words: [{word, start, end}]}`.
Without `voice` the player estimates timings from the words of `say`.

### Directives

A directive is a field of a Step that the server runs before the Step is validated.
Each directive is one module in `server/pennydrop/asks/directives/`, found by scanning the package, and the module name is the directive name.
A new directive touches no shared file. Modules and packages whose name starts with `_` are skipped.
A directive module exports:

```python
GUIDE: str
async def expand(step: dict, spec: Any, tools: DirectiveTools) -> dict
```

`GUIDE` is the Markdown the writer reads, added to its system prompt.
`expand` receives the Step with its own directive field already removed, plus that field's raw value as `spec`, and returns the expanded Step.
It validates `spec` with `parse_spec(Model, spec, "name")`, fills text and Challenge answers with `fill_values(step, {"name": value})`, and raises `DirectiveError("<name> directive: <what to change>")` so the writer is told how to repair.
`DirectiveTools` (`directives/_support.py`) holds the server's shared tools, today `tracer`.
Add a field there when a new directive needs a new tool, and construct it in `asks/__init__.py`.
`images` and `locate` are modules `images.py` and `locate.py` in the same package. `simulate` is a package, `directives/simulate/`, described below.

The `trace` directive is a package, `directives/trace/`.
It runs the tracer once, finds the one object in the Step's own `scene` whose `lab` has a target module, and hands the trace to that target.
A target is one module `directives/trace/<lab id>.py`, found by scanning, and the module name is the Lab id.
A target module exports:

```python
GUIDE: str
def apply(step: dict, object_id: str, run: TracedRun) -> dict
```

`GUIDE` says what the Step must set for this Lab, and is added to the trace guide.
`apply` returns the Step with the Lab's own ops appended to `do` and any scene changes (counters, for example), and raises `DirectiveError` when the object does not match the traced input.
`TracedRun` (`directives/_support.py`) holds `trace`, the traced `input` and the traced `source`.
The trace directive counts the ops `apply` added, rejects more than 40, and fills `{trace.comparisons}`, `{trace.swaps}` and `{trace.writes}`.
`Trace` is `pennydrop.tracer.Trace`: `events` of type compare, swap, set, line, get, call, return and print, plus `counters`, `result`, `finals`, `stdout`, `truncated` and `error`.
Targets today:

- `array.py`: compares, swaps and writes on cells. The Step sets the array with `values` equal to the input.
- `code.py`: the `code` Lab. The Step sets `{"lab":"code"}`, and the target fills `source`, `language` and `vars`, then writes `call`, `line`, `set`, `return` and `print` from the run. A `set` is written wherever a local differs from the last known value of the top frame.
- `graph.py`: the `graph` Lab. Input is `{"graph": {node: [neighbors]}, "start": node}` or `{"tree": {node: [left, right]}, "root": node}`. The target fills `nodes`, `edges`, `root`, `directed`, `layout` and `frontier`, and turns each call of a function named `visit`, `push` or `pop` in the traced code into the op of that name. The library has `breadth_first_search`, `depth_first_search`, `tree_preorder`, `tree_inorder` and `tree_postorder`, which call those markers.

The `simulate` directive is a package, `directives/simulate/`, for Labs whose numbers are computed by plain code and need no sandbox.
A target is one module `directives/simulate/<lab id>.py`, found by scanning, and the module name is the Lab id.
A target module exports:

```python
GUIDE: str
class Spec(BaseModel)   # extra="forbid", with an optional `on: str | None` for the object id
def simulate(spec: Spec) -> Simulation
```

`Simulation(object_id, scene, operations, values)` is in `directives/_support.py`.
The directive sets the scene object (merged over one the Step already has), appends `operations` to `do` with `on` added, rejects more than 40, and fills `{simulate.<name>}` in text and `"answer": "simulate.<name>"` from `values`.
Targets: `scheduler.py` (fcfs, sjf, round robin with a quantum, arrivals), `threads.py` (a shared `count++` with or without one lock, interleaved or not) and `address.py` (multi level page table walk, optional TLB, page fault from `freeFrames`).

### Lab module

```ts
export const lab: LabDef<Spec, State> = {
  id, title,
  reading: "required" | "optional",
  catalog: { summary, spec, example: [/* Step lines */] },
  ops: { name: { doc, seconds, apply, during?, sound?, trueTime? } },
  prepare?(): Promise<void>,
  init(spec, objectId): State,
  size(state): { w, h },
  draw(state, ctx): Drawable[],
}
```

A LabDef has one ops table.
The catalog, routing, duration and unknown-op message are derived from it.
`init` and `apply` throw a `LabError` with a message the writer can act on.
`seconds` can be a function of the op and the state before it, so a long run can take longer.
A Lab that needs assets declares `prepare()`, and `prepareStepAssets` calls it for playback and validation alike.
A trueTime op is a simulation that runs in real seconds.
The timeline never cuts or squeezes it, later entries wait for it, and exits pre-roll to end on their Cue.
`segmentProgress` and `trueProgress` in `timeline.ts` are the one place segment time becomes progress, and every renderer, the Film included, uses them.
`DRAWABLE_KINDS` in `render.ts` is the painter's table, and `Painted` is derived from `Drawable`.
The code listing is shared through `codeListing` and `languageField` in `highlight.ts`.
Roles `series1` to `series6` give each item in a set its own color in every Theme.

### Reading

The Lesson header has `reading` (boolean, default true).
The server sets it to false for a kid Profile, and the writer never sets it.
The player's Scene builder passes it to every Lab as the spec field `reading` when it calls `init`, so a Lab with `spec.reading === false` sizes and draws with no words, numbers or units.
A Lab declares `reading` as "required" or "optional": `createObject` rejects a required Lab in a Lesson with reading false, and an optional Lab honors it.
The validator rejects `text`, `code` and `math` objects in such a Lesson, and the frame painter drops any text, code or math drawable as the last guarantee.
The validator's stdin request takes `reading` as well, so the server can check a kid Lesson one Step at a time.

### Minted Lab runtime

The Mint writes a Lab in `data/mint/<id>/src/labs/<id>.ts` and accepts it only when `bun player/tools/mint-check.ts data/mint/<id>` and the visual judge both pass.
An accepted Lab lives in `data/minted-labs/<id>.ts` with its example Lesson `data/minted-labs/<id>-example.jsonl` until the build session promotes it.
`bun player/tools/mint-build.ts <lab.ts> <out.js>` bundles a minted Lab to `data/minted-labs/dist/<id>.js`, and the vite glob never sees `data/`.
The bundler rewrites the Lab's `../lab` and `../text-metrics` imports to the player's own modules through `globalThis.__pennydropShared`, so `LabError` and the registry stay one instance.
Any other relative import in a minted Lab fails the build, and npm packages resolve from `data/node_modules`.
`player/tools/load.ts`, and so the validator, the catalog and the frame tool, registers every built module in `PENNYDROP_MINTED_DIR` (default `data/minted-labs/dist`) after the repo Labs, and skips an id that already exists.
The server lists built modules at `GET /api/minted-labs` as `[{id, url}]` and serves each at `GET /api/minted-labs/<id>.js`.
The live player and the frame page fetch that list at startup and register each module before the first draw (`player/src/minted.ts`).
The catalog marks a minted Lab "(minted, not yet promoted)", and its entry carries `minted: true`.
A Lab that wants sound exports `sound(op, state)` beside `lab` and loads Tone.js with a dynamic import inside it, so only the live player makes sound.
`pd mint promote <id>` copies the Lab to `player/src/labs/` and its example Lesson to `lessons/`, copies assets only when `assets/LICENSE` names an allowed license, and deletes the minted copy.
After promotion the build session reviews the Lab, adds any npm package it names to `player/package.json`, and commits.
Lesson writers ask for a missing Lab through `store.file_lab_request(ask, lab_hint)`, and `pd mint --request N` mints it.

### Film

A Film is a high production educational film that renders offline to an MP4.
Five rules hold it: the model writes intent and code draws, compute never narrates, Scenes diff by object id and objects never jump, narration drives the clock, and every op fires on its Cue word.
A Film file is JSONL.
The first line is `{"film": {title, theme, thread?, lead?, tail?, start?, opening?}}`.
`theme` names a Theme that carries the sound kit and the narrator voice.
`lead` and `tail` are seconds of picture before the first word and after the last, defaulting to 2 and 3.
`start` is a Scene spec map shown before line 1, and `opening` is `{go, view?, elevation?}` for the first camera pose.
Every other line is `{line, say, scene?, do?, camera?, sound?, voice?}`.
`line`, `say`, `scene`, `do` and `voice` mean what they mean in a Lesson Step, and Film time is Timeline time plus `lead`.
`camera` is a list of `{cue, go, view?, elevation?, seconds?}`, and each move starts on the word its `cue` matches.
The camera never rolls and never swings sideways: it dollies and tilts, and each shot is framed on the measured ink of its object so the content sits centred with even margins.
Dust drifts defocused behind the content and keeps off its ink.
`sound` is a list of `{cue, tone, gain?}`, and the tone is one of `hit`, `chime`, `tick`, `rise` or `swell`.
A `cue` is a word or phrase from `say`, matched in order.
The `at` field of a scene object is `{relation: id}` with the relations `right of`, `left of`, `above`, `below`, `behind`, `in front of` and `next`, and the world layout places each object on a plane in 3D.
The pieces are `keyword`, `quote`, `counter`, `tracker` and `question`, and Labs draw on their own planes unchanged.
The film page `player/film.html` draws a pure function of (film, time, Theme) through `window.film` with `load`, `seek` and `regions`.
`bun player/tools/film.ts render` draws 1920x1080 frames at 30 fps in parallel headless pages, pipes them to ffmpeg as H.264 yuv420p, writes `<out>.manifest.json`, and reports frames per second.
`pd film render <film> [--out]` voices each line through the TTS seam, builds a seeded sound kit and a bed ducked under speech, normalizes to -14 LUFS with true peak at most -1.5 dBTP through a limiter with a 0.3 dB margin, and muxes into the MP4.
Rendered media goes under the gitignored `data/films/<thread>/`.
`pd film check <mp4>` reports loudness, true peak, and for every Cue the offset in ms between the heard word and the op start, with max and mean against the 33 ms bar, plus the delay until pixels change in the op's region.
It ends with the four measures the design asks of each pilot: render minutes by stage (voice, draw, mix, written into the render manifest), tokens by stage and review minutes (read from `data/films/<thread>/measures.json`, which the session that wrote the Film fills in), and fact check catches (the rows of `data/films/<thread>/fact-check.md` whose verdict is `corrected` or `removed`).
`bun player/tools/film.ts plan` prints the estimated duration, `audit` prints the camera table with tilt, margins and the smallest text in pixels at 1080p per shot (keep it at 24 or more), and `stills` writes a frame per shot; a Film runs about 0.74 of its plan estimate.

## Work board

| Task | Owner | State |
|---|---|---|
| Player core, four Themes, array Lab, bubble sort Lesson, validate, catalog and frames tools | Sonnet agent | done, `267932f` |
| Server core: config, gateway, JEV, store, TTS seam with Kokoro, intake, tracer, API, CLI | Sonnet agent | done, `ec669f0` |
| Player fixes and polish, the Ask UI with mic, streaming Steps and follow-ups, the kids PWA and lesson log | player core agent | done, `d1eaaea` and `0b36d8e` |
| M2 Ask pipeline (server): catalog, JEV classify, streamed writer, directives, validator with redo, TTS per Step, live events, timing and cost, `pd ask`, `pd bench` | M2 agent | committed through `4163faf`; uncommitted: `asks/{coaching,mending,stage}.py`, voice gate, writer hedge at 2.0 s, a one sentence Step 1, mechanical repairs for crowded stages, ops on missing objects and fuzzy Cues, the lines only trace tier keeping call and variables; bench 23: first Step 1.94 to 4.68 s (p50 3.13 s), two Asks over 15 s done; since then a warm spare `claude -p` in the gateway (first token p50 1.12 s cold to 0.39 s), up to three verdict driven mends, retired objects restored, in-flight sends settled, a Challenge answer said in the narration dropped, placeholder coaching; running: the hash collisions first Step split, the four remaining repair causes, a trace that opens on its result (heap Lesson `9fdb8a97bc25`), spares dying with the server; two benches wait for load under 12 |
| Picture Lab server half: `images` and `locate` directives, `/media` cache, prefetch on classify, `vision_choose` | images agent | uncommitted, commits with M2; running: picture search off Step 1's critical path (whale first Step 7.7 s), a smaller `vision_choose` |
| Stage ink model against the browser's real boxes, `typeset` failing loudly on transforms it cannot compose, shapes `size()` as the true drawn extent, the 41 shapes and pythagoras `mint-check --builtin` findings | shapes agent | built and measured (text ink within 0.3 px of the browser, `typeset` equal to `getBBox()`, 0 shapes findings); running: three review fixes, then the commit |
| `whisper-server` outlives every stopped `pd serve` (16 orphans at 600 MB each, killed); tie its life to the server however it dies, and look for other children that leak | shapes agent | running after the review fixes |
| Stream every Lesson, voice Steps ahead, mark the Challenge answer, hold three caption lines | build session | done, `4ed8a98` |
| A Step that moves objects on stage and brings new ones in fades the new ones in over the still moving ones (P3L5 `766860908218` at 24.5 s); the moves lead the Cue the way exits do | transition agent | running |
| CS 6200 Course quality: the latest Lesson per topic against the current validator; P1L2 `6ab8669d14dd` and P3L1 `8179373d7fa1` crowded (made before the crowded check), P2L3 `e2ed2cc0f8a2` never shows the shared counter, P3L5 `766860908218` never shows a device or an interrupt | build session | redo those four with `pd course pregen cs6200 --topics ... --redo` after the M2 commit |
| Math with stretched delimiters, the typesetter path transforms | build session | done, `f0aec33` and `0afd43b` |
| `address`, `shapes`, `code`, `graph`, `scheduler`, `threads` Labs with their Lessons | Sonnet agents | done, `8e51db5`, `8fcb470`, `14c8338`, `fe03ae5`, `a93f995`, `4cc3bcf` |
| Layout by ink, replaced objects fade, exits before arrivals, frames cache, each Lab sized to its stage, 20 px text floor | shapes and refactor agents | done, `bb36c8c`, `c22867d`, `b74a8e4`, `0fad63f` |
| Contract refactor: reading per kind, one ops table per Lab, one segment progress, the review fixes of `b9114ad` | refactor agent | done, `cd61ea1`, `33d33b5`, `e684394` to `9afbde5` |
| M4 `physics` and `picture` Labs | Sonnet agents | done; the picture Lab's real photos `60ecb69` |
| Profiles and the lesson log | Sonnet agent | done, `1140ed2` |
| M5 Mint: codex through the gateway, checks and visual judge, minted Labs at runtime, Lab requests, promotion | Mint agent | runtime and `pd mint` done, `f56b00e` and `4a863f0`; re-mint from a failed attempt and real coastlines, `77988c6`; the judge confirms each finding on a second look and carries earlier rounds (`dc0cdcf`); an install refusal is a repair finding (`e88581c`); all nine Labs minted and promoted: plot, memory, bits, words, sequence, map, circuit, music, hash; the judge now checks continuous fills and a layout that does not shift, and a seeded run keeps its history when killed; final checks pass (`tsc`, `mint-check --builtin` 0 findings, `frames --check` on every example Lesson); music needs the `tone` dependency in `player/package.json`; open: the live player does not call a Lab's `sound()` hook yet |
| M6 Films: format, renderer, sound kit, mix, `pd film render` and `pd film check`, both pilots | Film agent | done: both pilots rendered at -14.10 LUFS (page table walk 7:57, Napoleon 8:46), Cue offsets 5 ms, Kokoro and Qwen3 minute compared; Film slice waits for the build session's commit |
| M6 open local voice: `qwen3` provider, `pd voice ab`; ElevenLabs adapter | voice and M2 agents | done, `a4a6183` (Kokoro RTF 0.114, Qwen3 RTF 0.394, both WER 0) |
| Next: M1 close (Chrome check, tailnet push), M3 Lessons regenerated after M2, M4 kids end to end, M5 Course pregen and review queue in Chrome, the judging pass | build session | waiting on the slices above |

### Server facts for later work

- Measured by `uv run pd gateway ping`: Haiku 1.5 s, Sonnet 1.2 s, Fable 0.9 s, Opus 2 to 5 s, codex 3 to 4 s, JEV 0.3 to 0.5 s.
- Kokoro: 7 s cold load, then about 0.26 s for a short sentence on the warm server, and 0.39 s for a cache hit.
- `pd transcribe` takes about 1.5 s, mostly whisper model load per spawn.
- A bare `claude -p` call carries about 3.9k input tokens of Claude Code context, 3.1k of it cached.
  Pass `system` on every call so the default Claude Code prompt is replaced.
- A codex call carries about 19k input tokens of its own context.
- JEV wire format: `questions` is an object keyed by name, score `criteria` is a list of anchor strings, answers come back keyed by name.
- `.venv` adds 952 MB, torch is 566 MB of it.
- The player posts Challenge answers with the server's names `{profile_id, lesson_id, step, prompt, answer, correct}`.
- Open: Store methods for courses, topics, films, lesson_log, lab_requests and minted_labs come with M4, M5 and M6.

## Evidence log

Commands that prove each condition, with the output that proved it, are added here as each milestone closes.
