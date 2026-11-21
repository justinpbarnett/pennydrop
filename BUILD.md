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

## Contracts

### Lesson stream

`GET /api/lessons/{id}` returns `{id, lesson, steps, done}`.
`GET /api/lessons/{id}/events` streams Server Sent Events: `lesson`, `step`, `done` with stats, and `error`.
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
  duration?(op): number,
  during?(before, after, op, progress, ctx): Drawable[],
}
```

`init` and `apply` throw a `LabError` with a message the writer can act on.

## Work board

| Task | Owner | State |
|---|---|---|
| Player core, four Themes, array Lab, bubble sort Lesson, validate, catalog and frames tools | Sonnet agent | running |
| Server core: config, gateway, JEV, store, TTS seam with Kokoro, intake, tracer, API, CLI | Sonnet agent | running |

## Evidence log

Commands that prove each condition, with the output that proved it, are added here as each milestone closes.
