/**
 * UI draft helpers — pure, testable. Prefill display + stepper math for
 * index.html. No DOM access here; training rules stay in engine.js.
 *
 * Prefill contract (data-integrity critical):
 *  - Only load + sets are ever prefilled. RPE and pain are the day's
 *    measurements — prefilling them would fabricate data.
 *  - A prefill is display-only until the user touches the card; untouched
 *    cards must never reach S.sessions. index.html enforces that by keeping
 *    prefills out of draft.entries until first interaction (materialize).
 *  - In a draft entry, `undefined` means untouched (show ghost); `null`
 *    means the user cleared the field (show empty). Explicit-null convention.
 */
import { historyFor, rnd } from "./engine.js";

/** {load, sets} from the last eligible session of ex, for prefilling inputs.
 *  Empty object when there is no history. */
export function prefillFor(S, ex) {
  const h = historyFor(S, ex, 1);
  if (!h.length) return {};
  return { load: h[0].e.load ?? null, sets: h[0].e.sets || "" };
}

/** Display value + ghost flag for one field of an input block. */
export function displayField(d, pre, f) {
  if (d[f] !== undefined) return { val: d[f] ?? "", pre: false };
  const v = pre[f];
  const empty = v == null || v === "";
  return { val: empty ? "" : v, pre: !empty };
}

/** Stepper math: clamp ≥0, round to 0.5 per load conventions. */
export function stepValue(cur, delta) {
  return Math.max(0, rnd((parseFloat(cur) || 0) + delta, 0.5));
}

/** The one predicate deciding whether a draft entry is "filled" — shared by
 *  saveSession and the save-bar counter so they can never disagree. */
export function filledEntry(d) {
  return d.load != null || !!d.sets || d.rpe != null || d.pain != null || d.amrap != null || !!d.note;
}

/** On CLEARED days the ghost load becomes the engine's target (last + inc,
 *  rounded 0.5 — same math as the rec chip) and is flagged `target` so the
 *  UI labels it · TARGET, never · LAST. Any other rec class passes through. */
export function withRecTarget(pre, recCls, inc) {
  if (recCls !== "cleared" || pre.load == null || !inc) return pre;
  return { ...pre, load: rnd(pre.load + inc, 0.5), target: true };
}

/** Pull the coach-review JSON out of a pasted reply. Accepts a whole
 *  prose-plus-JSON message: last fenced code block wins (the coach contract
 *  says the JSON block comes last), else the first-{-to-last-} span, else
 *  the raw text (upstream JSON.parse reports failure). */
export function extractJSON(raw) {
  const fences = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  if (fences.length) return fences[fences.length - 1][1].trim();
  const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
  return a >= 0 && b > a ? raw.slice(a, b + 1) : raw;
}
