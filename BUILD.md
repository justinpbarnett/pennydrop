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
`GET /api/lessons/{id}/events` replays what is stored, then streams new events until the Lesson ends: `lesson` (`{id, lesson}`), `step`, `done` with stats, and `error` (`{message}`).
`done` carries `seconds`, `first_step_seconds`, `steps`, `tier`, `labs`, `cost_usd`, `timings` (named marks in seconds from the Ask), `transcription_seconds` and `repairs`.
A follow up Lesson (`from` set) has `lesson.start_scene`, the validator's Scene state at the `from` Step. The player starts its Timeline from it.
Each Step the player receives is the Step JSON plus `voice: {url, duration, words: [{word, start, end}]}`.
Without `voice` the player estimates timings from the words of `say`.

### Lab module

```ts
export const lab: LabDef<Spec, State> = {
  id, title,
  catalog: { summary, spec, ops: { name: "args and meaning" }, example: [/* Step lines */] },
  init(spec, objectId): State,
  apply(state, op): State,
  size(state): { w, h },
  draw(state, ctx): Drawable[],
  duration?(op, state): number,
  during?(before, after, op, progress, ctx): Drawable[],
}
```

`init` and `apply` throw a `LabError` with a message the writer can act on.
`duration` gets the state before the op, so a long run can take longer.
Roles `series1` to `series6` give each item in a set its own color in every Theme.

## Work board

| Task | Owner | State |
|---|---|---|
| Player core, four Themes, array Lab, bubble sort Lesson, validate, catalog and frames tools | Sonnet agent | done, `267932f` |
| Server core: config, gateway, JEV, store, TTS seam with Kokoro, intake, tracer, API, CLI | Sonnet agent | done, `ec669f0` |
| Player fixes: stateless validator per contract, `start_scene`, real font metrics, even code panel padding, caption aligned to stage, Challenge card, lazy KaTeX and Shiki, drop the `plot` alias | player core agent | done, `d1eaaea` |
| Player polish: caption highlighter, lining clock numerals, no literal em dash in font metrics, console 404; then the Ask UI with mic, streaming Steps and follow-ups | player core agent | running |
| M2 Ask pipeline (server): catalog, JEV classify, streamed writer, directives, validator with redo, TTS per Step, live events, timing and cost, `pd ask`, `pd bench` | Sonnet agent | running |
| `address` Lab and `lessons/page-table-walk.jsonl` | Sonnet agent | done, `8e51db5` |
| `shapes` Lab and `lessons/pythagoras.jsonl` | Sonnet agent | running |
| M3 player Labs `code`, `graph`, `scheduler`, `threads`, each with scratch Lessons; their server expansion (trace to code and graph, `simulate` for scheduler and threads) follows once M2 lands | four Sonnet agents | `code` done `14c8338`, `scheduler` done; `graph` and `threads` running |
| ElevenLabs adapter: works on the free plan (eleven_v3, 4 s for one line, word timings). Fix: `duration` must come from the audio (3.20 s) not the last word end (2.88 s), and a `pcm` output must be written as a real wav | server agent after M2 | open |
| Next: M1 close (serve, tailnet, Chrome check, push), M4 kids mode | build session | waiting |

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
