# REBUILD — training engine

Personal strength-rebuild tracker for a detrained powerlifter (old maxes 140/140/180 @94kg,
now ~83kg) training BJJ 2-3x/wk. Originally built as a claude.ai artifact (see
`reference/rebuild-tracker-v4.html`); this repo is the port to a testable codebase.

## Architecture

- `src/engine.js` — **pure decision logic**. No DOM, no storage, no fetch. All
  time-dependent functions take `today` (ISO string) as an injectable param.
  This is the only file that encodes training rules. UI and analytics consume it.
- `src/storage.js` — localStorage adapter mimicking the artifact's `window.storage`
  API shape (`get/set` returning `{value}`), so UI code ports with minimal diff.
- `index.html` — single-page UI (vanilla JS, ES modules), served by vite.
- `test/engine.test.js` — vitest suite. Fixture helpers at top; every test builds
  its own state; time always injected.
- `analytics/analyze.py` — pandas pipeline over exported state JSON.
- `data/sample-state.json` — realistic seed state for tests and analytics smoke runs.

## Domain rules (do not change without explicit instruction)

Progression, phase 1 (rebuild): frozen-load RPE gate. +2.5kg upper / +5kg lower only
when top-set RPE ≤7 on a progression-eligible day. Weeks 1-2: volume −⅓, RPE 7 cap
(tendon protection after 1yr detrained).

Session flags: `fresh` (no BJJ that day), `pre` (lifted before rolling — counts fully),
`bjj` (lifted after rolling — NEVER counts toward progression).

Stall: same load, strictly rising RPE across 3 eligible sessions → offer wave switch.
Waves: TM = 0.9 × e1RM; wk1 5x5@80%, wk2 5x4@85%, wk3 6x3@90%, wk4 deload 3x3@65%,
then TM +2×inc and repeat. Waves pause during deload, don't advance on post-BJJ days.

Pain scale 0-3 (CLEAN/NOISE/TIGHT/PAIN) per exercise per session:
PAIN(3) once = hard stop + regression. ≥2 twice consecutive = regression proposed.
Pain rules outrank ladder prompts and stall detection.

Ladders (movement progressions with advance criteria = week threshold AND 14-day
symptom-clean): squat Box→Zercher-to-box(wk5)→Zercher(wk9);
overhead Half-kneel-landmine→Seated-DB-neutral(wk5)→Barbell-OHP(wk9).

Injury constraints (user: L glenohumeral irritation + old ACJ sprain): banned everywhere —
dips, wide-grip bench, behind-neck press, deep-stretch DB press, upright rows, Bulgarian
split squats, calf work, front-delt isolation. These must never appear in `LIB`.

Load model: daily sRPE load = Σ mins×sRPE across gym + BJJ. ACWR = 7d avg / 28d avg.
Deload trigger: ≥2 of {combined ACWR>1.4, ≥2 gate lifts RPE-drifting at held load,
any pain ≥2 in last 7d} → 7 days at ~60% load, sets −⅓, RPE ≤6.

Coach proposals (from LLM review): types set_sub | start_wave | exit_wave |
advance_ladder | start_deload | override_load. Every proposal is validated against
the slot table before apply. Overrides are one-session and cleared on log.
Ladder escalation (advance_ladder, or set_sub UP the same ladder) additionally
requires 14-day symptom-clean on the current exercise; the week threshold alone
is coach-bypassable (calendar is discretionary, symptoms are not).

## Invariants — every one must keep test coverage

1. POST-BJJ sessions never enter progression history.
2. reclassify() only flips fresh→pre; never touches bjj or manual pre.
3. Substitution or ladder advance kills wave state on that slot.
4. Pain hard-stop outranks all other card-level prompts.
5. Coach overrides apply to exactly one logged session.
6. AMRAP beats top-set parse for e1RM; AMRAP without RPE assumes RPE 9.
7. Waves never advance on post-BJJ saves or during active deload.
8. Banned movements never appear in LIB or pass proposal validation.

## Conventions

- Loads in kg, rounded to 2.5 (0.5 for small increments). Dates are ISO strings.
- Engine functions are pure or mutate the passed state object explicitly — no module-level
  mutable state.
- Tests: build state per-test, inject `today`, one behavioural assertion cluster per test.
- Keep clarity over cleverness. Explicit null handling everywhere (`load: null` is
  meaningful — bodyweight movements).

## Task backlog (in priority order)

1. `npm test` green, then raise engine.js branch coverage >90% (`vitest --coverage`
   after `npm i -D @vitest/coverage-v8`). Target the untested branches: waveRx edge
   weeks, historyFor with pain-only entries, tonnage with unparseable sets.
2. Property-based tests for parseSets/bestE1RM (fast-check): random garbage never throws,
   e1RM monotonic in reps and load.
3. Audit engine.js against the invariants list; write a failing test for any bug
   before fixing it.
4. Port polish: index.html currently mirrors the artifact — extract render functions
   into src/ui.js modules, keep index.html thin.
5. Coach layer over HTTP: the artifact called api.anthropic.com keyless (claude.ai
   proxies it). Outside claude.ai that needs a key — do NOT hardcode one. Options, in order:
   a Vercel/Cloudflare serverless function holding the key as env var, or keep the
   copy-payload/paste-response flow (already implemented in index.html).
6. PWA: manifest + service worker so the app installs to the phone home screen and
   works offline. Then deploy via GitHub Pages (`npm run build`, publish dist/).
7. IndexedDB migration if localStorage 5MB ceiling ever threatens (it won't soon).
8. ESD module content: session template library behind esdPhase(), currently phase
   names only in engine (full prescriptions live in UI copy).

## Commands

- `npm test` — run suite once. `npm run test:watch` — watch mode.
- `npm run dev` — vite dev server (localhost:5173).
- `python analytics/analyze.py data/sample-state.json` — analytics over an export.
