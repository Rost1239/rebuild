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
9. Pain rules read ALL sessions incl. post-BJJ (fullHistoryFor) — the
   eligibility filter is progression-only, never safety.

## Conventions

- Loads in kg, rounded to 2.5 (0.5 for small increments). Dates are ISO strings.
- Engine functions are pure or mutate the passed state object explicitly — no module-level
  mutable state.
- Tests: build state per-test, inject `today`, one behavioural assertion cluster per test.
- Keep clarity over cleverness. Explicit null handling everywhere (`load: null` is
  meaningful — bodyweight movements).
- index.html's script is an ES module: inline on*= handlers resolve against
  window, so anything they reference must be window.*-exposed
  (test/ui-handlers.test.js enforces this).

## Task backlog

Done (2026-07-05/06) — detail in git history:

1. Coverage — engine.js 100% stmts / 99.6% branch (`npm run test:coverage`);
   the only uncovered branch is the dead `|| []` fallback in validateProposal.
2. fast-check property tests — parseSets/bestE1RM never throw (caught and fixed
   a real crash on non-string `sets` input); e1RM monotonic in reps and load.
3. Invariant audit — three fixes: painState reads ALL sessions (fullHistoryFor),
   override_load validates against LIB, pl-tri def matched to its LIB name.
   Plus the ladder-escalation symptom gate (see Coach proposals above).
6. PWA + GitHub Pages — live at https://rost1239.github.io/rebuild/; push to
   main deploys via .github/workflows/deploy.yml (tests gate the deploy).
   Regenerate icons with `node scripts/make-icons.mjs`.

Remaining, by trigger rather than priority:

4. ui.js extraction (hygiene, safe anytime) — the inline-handler/module-scope
   hazard is fenced by test/ui-handlers.test.js.
5. Coach layer over HTTP — superseded (2026-07-08) by a claude.ai Project as
   the review layer: COPY PAYLOAD — PROJECT sends raw JSON (no embedded
   prompt), payload carries last_review + last_proposals with outcomes,
   PASTE RESPONSE accepts a whole prose+JSON reply (extractJSON in
   src/draft.js takes the last fenced block). A serverless proxy would now
   only buy speed at the cost of longitudinal memory — probably never worth
   it. If ever built: key as env var, do NOT hardcode.
7. IndexedDB migration — only if localStorage 5MB ever threatens (it won't soon).
8. ESD module content — dormant until a comp date is set; template library
   behind esdPhase(), full prescriptions currently live in UI copy.

## Commands

- `npm test` — run suite once. `npm run test:watch` — watch mode.
- `npm run test:coverage` — coverage report (engine.js is the target).
- `npm run dev` — vite dev server (localhost:5173).
- `python analytics/analyze.py data/sample-state.json` — analytics over an export.
