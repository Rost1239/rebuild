/**
 * REBUILD engine — pure decision logic. No DOM, no storage, no fetch.
 * Every time-dependent function takes `today` (ISO date string) as an
 * injectable parameter so tests are deterministic.
 *
 * State object shape (S):
 * {
 *   sessions: [{id, date, day, flag: 'fresh'|'pre'|'bjj', mins, srpe, bw,
 *               entries: [{ex, load, sets, amrap, rpe, pain, note}]}],
 *   bjj:      [{id, date, mins, srpe, note}],
 *   subs:     {slotId: exerciseName},
 *   waves:    {slotId: {active, tm, wk}},
 *   deload:   {until: ISO} | null,
 *   overrides:{exerciseName: {load, reason}},   // one-session coach overrides
 *   proposals:[{type, slot_id, exercise, load, tm, reason, state}],
 *   comp:     ISO | null,
 *   lastReview: {date, text} | null
 * }
 *
 * INVARIANTS (agents: see CLAUDE.md — every one of these must have test coverage):
 *  - POST-BJJ ('bjj') sessions NEVER count toward progression.
 *  - PRE-BJJ ('pre') sessions count fully.
 *  - Pain rules outrank ladder prompts and stall detection.
 *  - Pain rules read ALL sessions incl. post-BJJ (fullHistoryFor) — the
 *    eligibility filter is progression-only, never safety.
 *  - Substituting an exercise kills any wave state on that slot.
 *  - Coach load overrides apply to exactly one logged session of that exercise.
 *  - reclassify() only flips 'fresh' → 'pre'; it never touches 'bjj' or manual 'pre'.
 */

/* ================= CONSTANTS ================= */

export const LIB = {
  primer_rot: [
    { n: "Landmine rotational punch", d: "hip-driven diagonal punch, bar speed" },
    { n: "Med ball rotational scoop toss", d: "hip rotation, lateral throw" },
    { n: "Med ball side slam", d: "pivot + slam beside lead foot" },
    { n: "Band rotational punch", d: "max intent, zero space" }],
  horizontal_press: [
    { n: "Bench press", d: "moderate grip" },
    { n: "DB bench (limited ROM)", d: "stop 2in above chest" },
    { n: "Floor press", d: "hard ROM cap, elbow-friendly" },
    { n: "Machine chest press", d: "fixed path" }],
  overhead_press: [
    { n: "Half-kneeling landmine press", d: "scapular plane — ladder rung 1" },
    { n: "Seated DB press (neutral)", d: "ladder rung 2 (~wk5)" },
    { n: "Standing barbell OHP", d: "ladder rung 3 (~wk9, asymptomatic only)" },
    { n: "Standing landmine press", d: "between rungs 1 and 2" }],
  lateral_delt: [
    { n: "Cable lateral raise (behind-back)", d: "peak mid-range tension" },
    { n: "Lean-away cable lateral", d: "if column blocks behind-back" },
    { n: "DB lateral raise", d: "scaption plane" },
    { n: "Machine lateral raise", d: "" }],
  cuff_press: [
    { n: "Bottoms-up KB press", d: "contralateral knee" },
    { n: "Bottoms-up KB hold/carry", d: "regression when ACJ flares" },
    { n: "Tall-kneeling BU KB press", d: "symmetric base" }],
  triceps: [
    { n: "OH cable triceps extension", d: "long head" },
    { n: "Cable pushdown", d: "" },
    { n: "OH DB extension (supported)", d: "" }],
  rear_chain_delt: [
    { n: "Face pull (seated)", d: "split + rotate at end" },
    { n: "Reverse pec deck", d: "" },
    { n: "Cross-body cable rear delt", d: "" }],
  lower_trap: [
    { n: "Trap-3 raise", d: "prone Y, light" },
    { n: "Cable Y-raise", d: "" },
    { n: "Prone incline Y", d: "" }],
  squat: [
    { n: "Box squat", d: "ladder rung 1" },
    { n: "Zercher to box", d: "ladder rung 2 (~wk5)" },
    { n: "Zercher squat", d: "ladder rung 3 (~wk9)" },
    { n: "SSB box squat", d: "if elbows complain" },
    { n: "Belt squat", d: "zero spinal load" }],
  hinge_heavy: [
    { n: "Trap bar / block pull", d: "mid-shin" },
    { n: "Rack pull", d: "below knee" },
    { n: "Conventional block pull", d: "" }],
  hinge_rdl: [
    { n: "RDL", d: "" },
    { n: "DB RDL", d: "" },
    { n: "45° back extension (loaded)", d: "" }],
  glute: [
    { n: "Hip thrust", d: "" },
    { n: "Machine hip thrust", d: "" },
    { n: "Cable pull-through", d: "" }],
  ham_curl: [
    { n: "Nordic curl", d: "" },
    { n: "Seated leg curl", d: "" },
    { n: "Lying leg curl", d: "" },
    { n: "Slider leg curl", d: "" }],
  carry: [
    { n: "Suitcase carry", d: "+1 set weak-QL side, same load" },
    { n: "Farmer carry", d: "bilateral" },
    { n: "Front rack carry", d: "clinch-specific" }],
  frontal_core: [
    { n: "Copenhagen plank", d: "" },
    { n: "Pallof press", d: "" },
    { n: "Side plank (loaded)", d: "" },
    { n: "Half-kneeling chop", d: "" }],
  vert_pull: [
    { n: "Weighted pull-up (neutral)", d: "" },
    { n: "Lat pulldown (neutral)", d: "" },
    { n: "Single-arm lat pulldown", d: "" }],
  horiz_pull: [
    { n: "Chest-supported row", d: "" },
    { n: "Seated cable row", d: "" },
    { n: "Single-arm DB row", d: "" }],
  biceps: [
    { n: "Incline DB curl", d: "" },
    { n: "Cable curl", d: "" },
    { n: "EZ bar curl", d: "" }],
  biceps_neutral: [
    { n: "Hammer curl", d: "gi grip carryover" },
    { n: "Cross-body hammer", d: "" },
    { n: "Rope cable hammer", d: "" }]
};

export const LADDERS = {
  squat: { slot: "lo-squat", rungs: ["Box squat", "Zercher to box", "Zercher squat"], minWeek: [1, 5, 9] },
  ohp: { slot: "pu-lmp", rungs: ["Half-kneeling landmine press", "Seated DB press (neutral)", "Standing barbell OHP"], minWeek: [1, 5, 9] }
};

export const SLOTS = {
  push: [
    { id: "pu-prime", role: "primer_rot", def: "Landmine rotational punch", t: "3×3/side · primer · bar speed", model: "primer" },
    { id: "pu-bench", role: "horizontal_press", def: "Bench press", t: "4×3-4", model: "gate", inc: 2.5 },
    { id: "pu-lmp", role: "overhead_press", def: "Half-kneeling landmine press", t: "4×5-6/side · wk1-2 acclim 3×8", model: "gate", inc: 2.5, ladder: "ohp" },
    { id: "pu-lat", role: "lateral_delt", def: "Cable lateral raise (behind-back)", t: "5×12-15", model: "dbl", lo: 12, hi: 15, inc: 2.5 },
    { id: "pu-bu", role: "cuff_press", def: "Bottoms-up KB press", t: "3×6-8/side", model: "dbl", lo: 6, hi: 8, inc: 2, regressTo: "Bottoms-up KB hold/carry" },
    { id: "pu-tri", role: "triceps", def: "OH cable triceps extension", t: "4×10-12", model: "dbl", lo: 10, hi: 12, inc: 2.5 },
    { id: "pu-fp", role: "rear_chain_delt", def: "Face pull (seated)", t: "3×15", model: "dbl", lo: 12, hi: 15, inc: 2.5 }
  ],
  lower: [
    { id: "lo-prime", role: "primer_rot", def: "Med ball rotational scoop toss", t: "3×3/side · primer", model: "primer" },
    { id: "lo-squat", role: "squat", def: "Box squat", t: "6×3-4", model: "gate", inc: 5, ladder: "squat" },
    { id: "lo-hinge", role: "hinge_heavy", def: "Trap bar / block pull", t: "4×4 · mid-shin", model: "gate", inc: 5 },
    { id: "lo-thrust", role: "glute", def: "Hip thrust", t: "4×6-8", model: "dbl", lo: 6, hi: 8, inc: 5 },
    { id: "lo-ham", role: "ham_curl", def: "Nordic curl", t: "3×6-10", model: "dbl", lo: 6, hi: 10, inc: 2.5 },
    { id: "lo-carry", role: "carry", def: "Suitcase carry", t: "3/side +1 weak-QL side", model: "iso" },
    { id: "lo-cph", role: "frontal_core", def: "Copenhagen plank", t: "2×/side", model: "iso" }
  ],
  pull: [
    { id: "pl-prime", role: "primer_rot", def: "Med ball side slam", t: "3×3/side · primer", model: "primer" },
    { id: "pl-pullup", role: "vert_pull", def: "Weighted pull-up (neutral)", t: "5×4-5", model: "gate", inc: 2.5 },
    { id: "pl-row", role: "horiz_pull", def: "Chest-supported row", t: "4×6-8", model: "dbl", lo: 6, hi: 8, inc: 2.5 },
    { id: "pl-rdl", role: "hinge_rdl", def: "RDL", t: "4×5-6", model: "gate", inc: 5 },
    { id: "pl-rpd", role: "rear_chain_delt", def: "Reverse pec deck", t: "4×12-15", model: "dbl", lo: 12, hi: 15, inc: 2.5 },
    { id: "pl-t3", role: "lower_trap", def: "Trap-3 raise", t: "2×10-12", model: "iso" },
    { id: "pl-tri", role: "triceps", def: "OH cable triceps extension", t: "3×10-12", model: "dbl", lo: 10, hi: 12, inc: 2.5 },
    { id: "pl-curl", role: "biceps", def: "Incline DB curl", t: "3×8-12", model: "dbl", lo: 8, hi: 12, inc: 2 },
    { id: "pl-ham", role: "biceps_neutral", def: "Hammer curl", t: "2×10-12", model: "dbl", lo: 10, hi: 12, inc: 2 }
  ]
};

export const DAY_LABEL = { push: "PUSH", lower: "LOWER", pull: "PULL" };
export const RPE_VALUES = [5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10];
export const PAIN_LABELS = ["CLEAN", "NOISE", "TIGHT", "PAIN"];
export const FLAG_LABELS = { fresh: "FRESH", pre: "PRE-BJJ", bjj: "POST-BJJ" };

/* ================= UTILS ================= */

export function todayISO() { return new Date().toISOString().slice(0, 10); }
export function zone(r) { if (r == null || r === "") return "n"; return r <= 7 ? "c" : (r <= 8 ? "h" : "b"); }
export function rnd(x, step) { return Math.round(x / step) * step; }

/** Parse "NxM" from free text; tolerates ×, spaces, trailing "/side". Null if unparseable.
 *  Strings only — any other type parses to null, never throws. (String() coercion is
 *  NOT safe here: JSON like {"toString":""} throws on ToPrimitive.) */
export function parseSets(s) {
  const m = (typeof s === "string" ? s : "").match(/(\d+)\s*[x×X]\s*(\d+)/);
  return m ? { n: +m[1], reps: +m[2] } : null;
}

/** Epley with RIR adjustment: effective reps = reps + (10 - RPE). */
export function e1rm(load, reps, rpe) { return load * (1 + (reps + (10 - rpe)) / 30); }

/** e1RM for a logged entry. AMRAP takes precedence over top-set parse; RPE defaults to 9 for AMRAP.
 *  Non-numeric load/amrap/rpe (imported-state garbage) degrade to null — never throw. */
export function bestE1RM(e) {
  const load = typeof e.load === "number" ? e.load : null;
  if (load == null) return null;
  const amrap = typeof e.amrap === "number" && e.amrap > 0 ? e.amrap : null;
  const rpe = typeof e.rpe === "number" ? e.rpe : null;
  if (amrap) return e1rm(load, amrap, rpe ?? 9);
  const p = parseSets(e.sets);
  if (p && rpe != null) return e1rm(load, p.reps, rpe);
  return null;
}

export function daysAgo(n, today = todayISO()) {
  return new Date(new Date(today) - n * 864e5).toISOString().slice(0, 10);
}

export function newState() {
  return { sessions: [], bjj: [], subs: {}, waves: {}, deload: null, overrides: {}, proposals: [], comp: null, lastReview: null };
}

/* ================= STATE HELPERS ================= */

export function curEx(S, slot) { return S.subs[slot.id] || slot.def; }

/** Progression-eligible sessions: FRESH or PRE-BJJ. POST-BJJ is excluded — always. */
export function eligibleSessions(S) {
  return S.sessions.filter(s => s.flag !== "bjj").sort((a, b) => b.date.localeCompare(a.date));
}

/** Last n eligible entries for an exercise, newest first. Progression decisions only. */
export function historyFor(S, ex, n) {
  const out = [];
  for (const s of eligibleSessions(S)) {
    const e = s.entries.find(x => x.ex === ex && (x.load != null || x.rpe != null || x.pain != null));
    if (e) { out.push({ date: s.date, e }); if (out.length >= n) break; }
  }
  return out;
}

/** Last n entries for an exercise across ALL sessions (any flag), newest first.
 *  Safety rules (pain) use this — the eligibility filter is progression-only. */
export function fullHistoryFor(S, ex, n) {
  const out = [];
  const all = S.sessions.slice().sort((a, b) => b.date.localeCompare(a.date));
  for (const s of all) {
    const e = s.entries.find(x => x.ex === ex && (x.load != null || x.rpe != null || x.pain != null));
    if (e) { out.push({ date: s.date, e }); if (out.length >= n) break; }
  }
  return out;
}

export function firstDate(S, today = todayISO()) {
  if (!S.sessions.length) return today;
  return S.sessions.map(s => s.date).sort()[0];
}

export function weekNum(S, d, today = todayISO()) {
  return Math.max(1, Math.floor((new Date(d || today) - new Date(firstDate(S, today))) / (7 * 864e5)) + 1);
}

export function isDeload(S, today = todayISO()) { return !!(S.deload && today <= S.deload.until); }

/** Flip FRESH gym sessions to PRE-BJJ when a roll exists on the same date. Returns true if anything changed. */
export function reclassify(S) {
  const bjjDates = new Set(S.bjj.map(b => b.date));
  let changed = false;
  for (const s of S.sessions) {
    if (s.flag === "fresh" && bjjDates.has(s.date)) { s.flag = "pre"; changed = true; }
  }
  return changed;
}

/* ================= PAIN RULES ================= */

/** Pain gate for a slot. PAIN(3) once = hard stop; TIGHT+(≥2) twice running = regression. Null if clean.
 *  Reads ALL sessions including post-BJJ — pain is pain regardless of when it was logged. */
export function painState(S, slot) {
  const h = fullHistoryFor(S, curEx(S, slot), 2);
  if (!h.length) return null;
  const latest = h[0].e.pain;
  if (latest === 3) return { level: "stop", txt: "PAIN logged last session — regress or drop the movement. Pain is the hard stop." };
  if (latest === 2 && h.length > 1 && h[1].e.pain != null && h[1].e.pain >= 2)
    return { level: "regress", txt: "TIGHT/PAIN two sessions running — regression proposed." };
  return null;
}

/** True if no pain ≥2 logged for this exercise within the window. */
export function painCleanFor(S, ex, days, today = todayISO()) {
  const cutoff = daysAgo(days, today);
  for (const s of S.sessions) {
    if (s.date < cutoff) continue;
    const e = s.entries.find(x => x.ex === ex);
    if (e && e.pain != null && e.pain >= 2) return false;
  }
  return true;
}

/* ================= LADDERS ================= */

/** Ladder advancement status. Eligible requires week threshold AND 14d symptom-clean. */
export function ladderStatus(S, slot, today = todayISO()) {
  if (!slot.ladder) return null;
  const L = LADDERS[slot.ladder];
  const ex = curEx(S, slot);
  const rung = L.rungs.indexOf(ex);
  if (rung < 0 || rung >= L.rungs.length - 1) return null; // off-ladder sub or at top
  const next = L.rungs[rung + 1];
  const wk = weekNum(S, today, today);
  if (wk < L.minWeek[rung + 1]) return { eligible: false, next, wk: L.minWeek[rung + 1] };
  if (!painCleanFor(S, ex, 14, today)) return { eligible: false, next, blocked: "pain" };
  return { eligible: true, next };
}

/** Advance ladder: sets sub, kills wave state. Returns new exercise or null. */
export function advanceLadder(S, slot, today = todayISO()) {
  const st = ladderStatus(S, slot, today);
  if (!st || !st.eligible) return null;
  S.subs[slot.id] = st.next;
  delete S.waves[slot.id];
  return st.next;
}

/* ================= STALL / WAVES ================= */

/** Same load, strictly rising RPE across last 3 eligible entries. */
export function stallDetected(S, slot) {
  const h = historyFor(S, curEx(S, slot), 3);
  if (h.length < 3) return false;
  const [a, b, c] = h;
  if (a.e.load == null || a.e.load !== b.e.load || b.e.load !== c.e.load) return false;
  if (a.e.rpe == null || b.e.rpe == null || c.e.rpe == null) return false;
  return a.e.rpe > b.e.rpe && b.e.rpe > c.e.rpe;
}

export function waveRx(w) {
  if (w.wk === 1) return { sets: "5x5", pct: .80 };
  if (w.wk === 2) return { sets: "5x4", pct: .85 };
  if (w.wk === 3) return { sets: "6x3", pct: .90 };
  return { sets: "3x3 deload", pct: .65 };
}

/** Initialise wave state from latest eligible entry. TM = 90% of best e1RM, rounded 2.5. */
export function startWave(S, slot) {
  const h = historyFor(S, curEx(S, slot), 1);
  if (!h.length) return null;
  const est = bestE1RM(h[0].e) || ((h[0].e.load || 60) * 1.1);
  S.waves[slot.id] = { active: true, tm: rnd(est * 0.9, 2.5), wk: 1 };
  return S.waves[slot.id];
}

/** Advance wave weeks for a day after a progression-eligible session. wk4 → wk1 + TM bump. Paused during deload. */
export function advanceWaves(S, day, flag, today = todayISO()) {
  if (flag === "bjj" || isDeload(S, today)) return;
  for (const slot of SLOTS[day]) {
    const w = S.waves[slot.id];
    if (w && w.active) {
      w.wk++;
      if (w.wk > 4) { w.wk = 1; w.tm = rnd(w.tm + (slot.inc || 2.5) * 2, 2.5); }
    }
  }
}

/* ================= RECOMMENDATION ================= */

/**
 * Priority order: coach override > deload > active wave > model logic.
 * Returns {cls, txt} where cls ∈ {cleared, hold, breach, wave, none}.
 */
export function recommend(S, slot, today = todayISO()) {
  const ex = curEx(S, slot);
  const h = historyFor(S, ex, 1);
  const ov = S.overrides[ex];
  if (ov) return { cls: "wave", txt: `COACH → ${ov.load}kg (${ov.reason || "override"})` };
  if (isDeload(S, today) && slot.model !== "primer") {
    if (!h.length || h[0].e.load == null) return { cls: "wave", txt: "DELOAD — light, sets -⅓, RPE ≤6" };
    return { cls: "wave", txt: `DELOAD — ${rnd(h[0].e.load * 0.6, 2.5)}kg, sets -⅓, RPE ≤6` };
  }
  const w = S.waves[slot.id];
  if (w && w.active) {
    const rx = waveRx(w);
    return { cls: "wave", txt: `WAVE WK${w.wk === 4 ? "DL" : w.wk} — ${rx.sets} @ ${rnd(w.tm * rx.pct, 2.5)}kg (TM ${w.tm})` };
  }
  if (!h.length) return { cls: "none", txt: "NO DATA — SET BASELINE" };
  const { load, rpe } = h[0].e;
  if (slot.model === "primer") return { cls: "none", txt: "SPEED WORK — LOAD STATIC" };
  if (slot.model === "iso") return { cls: "none", txt: `LAST: ${load != null ? load + "kg" : "—"}` };
  if (rpe == null) return { cls: "none", txt: "NO RPE LOGGED" };
  if (slot.model === "gate") {
    if (rpe <= 7) return { cls: "cleared", txt: `CLEARED → ${load != null ? rnd(load + slot.inc, 0.5) + "kg" : "+" + slot.inc}` };
    if (rpe <= 8) return { cls: "hold", txt: `HOLD ${load}kg` };
    return { cls: "breach", txt: `BREACH — HOLD ${load}kg, NO GRIND` };
  }
  const p = parseSets(h[0].e.sets);
  if (p && p.reps >= slot.hi && rpe <= 8) return { cls: "cleared", txt: `TOP OF RANGE → +${slot.inc}kg` };
  if (rpe > 8.5) return { cls: "breach", txt: `TOO HEAVY — HOLD/DROP` };
  return { cls: "hold", txt: `ADD REPS → ${slot.hi}` };
}

/* ================= UNIFIED LOAD MODEL ================= */

/** Daily sRPE load: Σ mins×srpe across gym + BJJ. Legacy gym sessions imputed 60min @ sRPE6. */
export function loadByDay(S) {
  const m = {};
  for (const b of S.bjj) m[b.date] = (m[b.date] || 0) + b.mins * b.srpe;
  for (const s of S.sessions) {
    const mins = s.mins || 60, srpe = s.srpe || 6;
    m[s.date] = (m[s.date] || 0) + mins * srpe;
  }
  return m;
}

export function acwrFrom(m, today = todayISO()) {
  const now = new Date(today); let a = 0, c = 0, any = false;
  for (let i = 0; i < 28; i++) {
    const d = new Date(now - i * 864e5).toISOString().slice(0, 10);
    const v = m[d] || 0; if (v > 0) any = true;
    if (i < 7) a += v; c += v;
  }
  if (!any || c === 0) return null;
  return (a / 7) / (c / 28);
}

export function combinedACWR(S, today = todayISO()) { return acwrFrom(loadByDay(S), today); }
export function bjjACWR(S, today = todayISO()) {
  const m = {}; for (const b of S.bjj) m[b.date] = (m[b.date] || 0) + b.mins * b.srpe;
  return acwrFrom(m, today);
}

/** Tonnage between dates inclusive. "/side" doubles the parsed volume. */
export function tonnageBetween(S, start, end) {
  let t = 0;
  for (const s of S.sessions) {
    if (s.date < start || s.date > end) continue;
    for (const e of s.entries) {
      const p = parseSets(e.sets);
      if (p && e.load != null) t += e.load * p.n * p.reps * (/side/i.test(e.sets) ? 2 : 1);
    }
  }
  return Math.round(t);
}

export function weekTonnage(S, today = todayISO()) { return tonnageBetween(S, daysAgo(7, today), today); }

/* ================= DELOAD TRIGGER ================= */

/** Count of gate lifts with same load + rising RPE across last 2 eligible entries. */
export function rpeDriftCount(S) {
  let n = 0;
  for (const day of Object.keys(SLOTS)) for (const slot of SLOTS[day]) {
    if (slot.model !== "gate") continue;
    const h = historyFor(S, curEx(S, slot), 2);
    if (h.length === 2 && h[0].e.load != null && h[0].e.load === h[1].e.load
      && h[0].e.rpe != null && h[1].e.rpe != null && h[0].e.rpe > h[1].e.rpe) n++;
  }
  return n;
}

export function recentPain(S, today = todayISO()) {
  const cutoff = daysAgo(7, today);
  for (const s of S.sessions) {
    if (s.date < cutoff) continue;
    for (const e of s.entries) if (e.pain != null && e.pain >= 2) return true;
  }
  return false;
}

/** Composite deload trigger: fires on ≥2 of {ACWR>1.4, ≥2 lifts drifting, pain≥2 in 7d}. */
export function deloadSignal(S, today = todayISO()) {
  const reasons = [];
  const r = combinedACWR(S, today);
  if (r != null && r > 1.4) reasons.push("combined ACWR " + r.toFixed(2));
  const d = rpeDriftCount(S);
  if (d >= 2) reasons.push(d + " lifts with rising RPE at same load");
  if (recentPain(S, today)) reasons.push("pain/tightness ≥2 in last 7d");
  return { fire: reasons.length >= 2, reasons };
}

export function startDeload(S, today = todayISO()) {
  S.deload = { until: new Date(new Date(today).getTime() + 7 * 864e5).toISOString().slice(0, 10) };
  return S.deload;
}

/* ================= ESD PHASE PLANNER ================= */

export function esdPhase(S, today = todayISO()) {
  if (!S.comp) return null;
  const wksOut = Math.ceil((new Date(S.comp) - new Date(today)) / (7 * 864e5));
  if (wksOut < 0) return { name: "COMP PASSED", wksOut };
  if (wksOut === 0) return { name: "COMP WEEK", wksOut };
  if (wksOut <= 2) return { name: "TAPER", wksOut };
  if (wksOut <= 6) return { name: "LACTIC CAPACITY BLOCK", wksOut };
  if (wksOut <= 12) return { name: "ALACTIC BLOCK", wksOut };
  return { name: "AEROBIC BASE", wksOut };
}

/* ================= COACH PROPOSALS ================= */

export function slotById(id) {
  for (const d of Object.keys(SLOTS)) { const s = SLOTS[d].find(x => x.id === id); if (s) return { slot: s, day: d }; }
  return null;
}

/** Returns null if valid, else a reason string.
 *  Ladder escalation (advance_ladder, or set_sub UP the same ladder) requires
 *  14-day symptom-clean on the current exercise. The week threshold is NOT
 *  checked here — calendar is coach-discretionary, symptoms are not. */
export function validateProposal(S, p, today = todayISO()) {
  if (p.type === "set_sub") {
    const f = slotById(p.slot_id); if (!f) return "unknown slot";
    const ok = (LIB[f.slot.role] || []).some(o => o.n === p.exercise);
    if (!ok) return "exercise not in slot role";
    if (f.slot.ladder) {
      const L = LADDERS[f.slot.ladder];
      const cur = curEx(S, f.slot);
      const from = L.rungs.indexOf(cur), to = L.rungs.indexOf(p.exercise);
      if (from >= 0 && to > from && !painCleanFor(S, cur, 14, today)) return "not 14d symptom-clean";
    }
    return null;
  }
  if (p.type === "start_wave") { if (!slotById(p.slot_id)) return "unknown slot"; if (typeof p.tm !== "number") return "missing tm"; return null; }
  if (p.type === "exit_wave") { return slotById(p.slot_id) ? null : "unknown slot"; }
  if (p.type === "advance_ladder") {
    const f = slotById(p.slot_id); if (!f || !f.slot.ladder) return "not a ladder slot";
    const L = LADDERS[f.slot.ladder]; const cur = curEx(S, f.slot); const r = L.rungs.indexOf(cur);
    if (!(r >= 0 && r < L.rungs.length - 1)) return "no next rung";
    return painCleanFor(S, cur, 14, today) ? null : "not 14d symptom-clean";
  }
  if (p.type === "start_deload") return null;
  if (p.type === "override_load") {
    if (!p.exercise || typeof p.load !== "number") return "missing exercise/load";
    const inLib = Object.values(LIB).some(list => list.some(o => o.n === p.exercise));
    return inLib ? null : "exercise not in library";
  }
  return "unknown type";
}

/** Apply a validated proposal to state. Returns error string or null on success. */
export function applyProposal(S, p, today = todayISO()) {
  const err = validateProposal(S, p, today);
  if (err) return err;
  if (p.type === "set_sub") { S.subs[p.slot_id] = p.exercise; delete S.waves[p.slot_id]; }
  else if (p.type === "start_wave") S.waves[p.slot_id] = { active: true, tm: rnd(p.tm, 2.5), wk: 1 };
  else if (p.type === "exit_wave") delete S.waves[p.slot_id];
  else if (p.type === "advance_ladder") {
    const f = slotById(p.slot_id); const L = LADDERS[f.slot.ladder];
    S.subs[p.slot_id] = L.rungs[L.rungs.indexOf(curEx(S, f.slot)) + 1];
    delete S.waves[p.slot_id];
  }
  else if (p.type === "start_deload") startDeload(S, today);
  else if (p.type === "override_load") S.overrides[p.exercise] = { load: p.load, reason: p.reason || "" };
  return null;
}

/** Clear one-session coach overrides for exercises just logged. Call on session save. */
export function clearOverridesFor(S, entries) {
  for (const e of entries) delete S.overrides[e.ex];
}

/* ================= ANALYTICS HELPERS ================= */

export function e1rmSeries(S, ex, maxN = 12) {
  const out = [];
  const asc = eligibleSessions(S).slice().reverse();
  for (const s of asc) {
    const e = s.entries.find(x => x.ex === ex);
    if (e) { const v = bestE1RM(e); if (v != null) out.push(v); }
  }
  return out.slice(-maxN);
}
