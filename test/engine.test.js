/**
 * Engine test suite. Conventions for agents:
 *  - Every test builds its own state via newState() + helpers below. No shared mutable fixtures.
 *  - Time is always injected via `today` — never rely on the wall clock.
 *  - Each INVARIANT in engine.js must map to at least one test. Add here, don't fork files
 *    until a describe block exceeds ~200 lines.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import * as E from "../src/engine.js";

const TODAY = "2026-07-05";

/* ---------- fixture helpers ---------- */
function sess({ date, day = "push", flag = "fresh", entries = [], mins = 60, srpe = 6, bw = null }) {
  return { id: "s" + date + day + flag, date, day, flag, mins, srpe, bw, entries };
}
function entry({ ex, load = null, sets = "", amrap = null, rpe = null, pain = null, note = "" }) {
  return { ex, load, sets, amrap, rpe, pain, note };
}
const benchSlot = E.SLOTS.push.find(s => s.id === "pu-bench");
const lmpSlot = E.SLOTS.push.find(s => s.id === "pu-lmp");      // ladder: ohp
const squatSlot = E.SLOTS.lower.find(s => s.id === "lo-squat");  // ladder: squat
const buSlot = E.SLOTS.push.find(s => s.id === "pu-bu");        // regressTo
const latSlot = E.SLOTS.push.find(s => s.id === "pu-lat");      // dbl 12-15
const primerSlot = E.SLOTS.push.find(s => s.id === "pu-prime");  // model: primer, no inc
const carrySlot = E.SLOTS.lower.find(s => s.id === "lo-carry");  // model: iso
const pullupSlot = E.SLOTS.pull.find(s => s.id === "pl-pullup"); // gate, often bodyweight

/* ---------- utils ---------- */
describe("parseSets", () => {
  it("parses NxM", () => expect(E.parseSets("4x4")).toEqual({ n: 4, reps: 4 }));
  it("parses with /side and ×", () => expect(E.parseSets("3×8/side")).toEqual({ n: 3, reps: 8 }));
  it("returns null on garbage", () => expect(E.parseSets("amrap-ish")).toBeNull());
  it("returns null on empty/undefined", () => {
    expect(E.parseSets("")).toBeNull();
    expect(E.parseSets(undefined)).toBeNull();
  });
});

describe("e1RM", () => {
  it("Epley+RIR: 100x5@RPE8 → effective 7 reps", () => {
    expect(E.e1rm(100, 5, 8)).toBeCloseTo(100 * (1 + 7 / 30));
  });
  it("bestE1RM prefers AMRAP over top-set parse", () => {
    const e = entry({ ex: "Bench press", load: 100, sets: "4x4", amrap: 8, rpe: 9 });
    expect(E.bestE1RM(e)).toBeCloseTo(E.e1rm(100, 8, 9));
  });
  it("bestE1RM null without load", () => {
    expect(E.bestE1RM(entry({ ex: "x" }))).toBeNull();
  });
  it("AMRAP defaults RPE to 9 when unset", () => {
    const e = entry({ ex: "x", load: 100, amrap: 6 });
    expect(E.bestE1RM(e)).toBeCloseTo(E.e1rm(100, 6, 9));
  });
});

/* ---------- eligibility: THE core invariant ---------- */
describe("progression eligibility", () => {
  it("POST-BJJ sessions never appear in history", () => {
    const S = E.newState();
    S.sessions = [
      sess({ date: "2026-07-01", flag: "fresh", entries: [entry({ ex: "Bench press", load: 80, sets: "4x4", rpe: 7 })] }),
      sess({ date: "2026-07-03", flag: "bjj", entries: [entry({ ex: "Bench press", load: 70, sets: "4x4", rpe: 8 })] })
    ];
    const h = E.historyFor(S, "Bench press", 5);
    expect(h.length).toBe(1);
    expect(h[0].e.load).toBe(80);
  });
  it("PRE-BJJ sessions count fully", () => {
    const S = E.newState();
    S.sessions = [sess({ date: "2026-07-01", flag: "pre", entries: [entry({ ex: "Bench press", load: 80, sets: "4x4", rpe: 6.5 })] })];
    expect(E.recommend(S, benchSlot, TODAY).cls).toBe("cleared");
  });
});

describe("reclassify", () => {
  it("flips FRESH → PRE when a roll shares the date", () => {
    const S = E.newState();
    S.sessions = [sess({ date: "2026-07-04", flag: "fresh" })];
    S.bjj = [{ id: "b1", date: "2026-07-04", mins: 60, srpe: 7, note: "" }];
    expect(E.reclassify(S)).toBe(true);
    expect(S.sessions[0].flag).toBe("pre");
  });
  it("never touches POST-BJJ", () => {
    const S = E.newState();
    S.sessions = [sess({ date: "2026-07-04", flag: "bjj" })];
    S.bjj = [{ id: "b1", date: "2026-07-04", mins: 60, srpe: 7, note: "" }];
    expect(E.reclassify(S)).toBe(false);
    expect(S.sessions[0].flag).toBe("bjj");
  });
});

/* ---------- gate model ---------- */
describe("gate recommendation", () => {
  function withBench(rpe, load = 80) {
    const S = E.newState();
    S.sessions = [sess({ date: "2026-07-01", entries: [entry({ ex: "Bench press", load, sets: "4x4", rpe })] })];
    return S;
  }
  it("RPE ≤7 → cleared, +inc", () => {
    const r = E.recommend(withBench(7), benchSlot, TODAY);
    expect(r.cls).toBe("cleared");
    expect(r.txt).toContain("82.5");
  });
  it("RPE 7.5-8 → hold", () => expect(E.recommend(withBench(8), benchSlot, TODAY).cls).toBe("hold"));
  it("RPE >8 → breach", () => expect(E.recommend(withBench(8.5), benchSlot, TODAY).cls).toBe("breach"));
  it("no history → none", () => expect(E.recommend(E.newState(), benchSlot, TODAY).cls).toBe("none"));
});

/* ---------- double progression ---------- */
describe("double progression", () => {
  it("top of range at ≤8 → add load", () => {
    const S = E.newState();
    S.sessions = [sess({ date: "2026-07-01", entries: [entry({ ex: "Cable lateral raise (behind-back)", load: 10, sets: "5x15", rpe: 8 })] })];
    expect(E.recommend(S, latSlot, TODAY).cls).toBe("cleared");
  });
  it("below range top → add reps", () => {
    const S = E.newState();
    S.sessions = [sess({ date: "2026-07-01", entries: [entry({ ex: "Cable lateral raise (behind-back)", load: 10, sets: "5x13", rpe: 7 })] })];
    const r = E.recommend(S, latSlot, TODAY);
    expect(r.cls).toBe("hold");
    expect(r.txt).toContain("15");
  });
});

/* ---------- stall + waves ---------- */
describe("stall and waves", () => {
  function stalledState() {
    const S = E.newState();
    S.sessions = [
      sess({ date: "2026-06-21", entries: [entry({ ex: "Bench press", load: 90, sets: "4x4", rpe: 7 })] }),
      sess({ date: "2026-06-28", entries: [entry({ ex: "Bench press", load: 90, sets: "4x4", rpe: 7.5 })] }),
      sess({ date: "2026-07-04", entries: [entry({ ex: "Bench press", load: 90, sets: "4x4", rpe: 8 })] })
    ];
    return S;
  }
  it("detects same-load rising-RPE across 3 sessions", () => {
    expect(E.stallDetected(stalledState(), benchSlot)).toBe(true);
  });
  it("no stall when load changed", () => {
    const S = stalledState();
    S.sessions[2].entries[0].load = 92.5;
    expect(E.stallDetected(S, benchSlot)).toBe(false);
  });
  it("startWave computes TM = 0.9 × e1RM rounded 2.5", () => {
    const S = stalledState();
    const w = E.startWave(S, benchSlot);
    const expected = E.rnd(E.e1rm(90, 4, 8) * 0.9, 2.5);
    expect(w.tm).toBe(expected);
    expect(w.wk).toBe(1);
  });
  it("wave prescriptions: 80/85/90/65 of TM", () => {
    expect(E.waveRx({ wk: 1 }).pct).toBe(0.80);
    expect(E.waveRx({ wk: 2 }).pct).toBe(0.85);
    expect(E.waveRx({ wk: 3 }).pct).toBe(0.90);
    expect(E.waveRx({ wk: 4 }).pct).toBe(0.65);
  });
  it("advanceWaves cycles wk4 → wk1 with TM bump; skips on POST-BJJ", () => {
    const S = E.newState();
    S.waves["pu-bench"] = { active: true, tm: 100, wk: 4 };
    E.advanceWaves(S, "push", "bjj", TODAY);
    expect(S.waves["pu-bench"].wk).toBe(4); // post-bjj: untouched
    E.advanceWaves(S, "push", "fresh", TODAY);
    expect(S.waves["pu-bench"].wk).toBe(1);
    expect(S.waves["pu-bench"].tm).toBe(105); // +2×inc(2.5)
  });
  it("advanceWaves paused during deload", () => {
    const S = E.newState();
    S.waves["pu-bench"] = { active: true, tm: 100, wk: 2 };
    E.startDeload(S, TODAY);
    E.advanceWaves(S, "push", "fresh", TODAY);
    expect(S.waves["pu-bench"].wk).toBe(2);
  });
});

/* ---------- pain rules ---------- */
describe("pain rules", () => {
  it("PAIN(3) once = hard stop", () => {
    const S = E.newState();
    S.sessions = [sess({ date: "2026-07-04", entries: [entry({ ex: "Bottoms-up KB press", load: 8, sets: "3x8", rpe: 7, pain: 3 })] })];
    expect(E.painState(S, buSlot).level).toBe("stop");
  });
  it("TIGHT(2) twice running = regress", () => {
    const S = E.newState();
    S.sessions = [
      sess({ date: "2026-06-28", entries: [entry({ ex: "Bottoms-up KB press", load: 8, sets: "3x8", rpe: 7, pain: 2 })] }),
      sess({ date: "2026-07-04", entries: [entry({ ex: "Bottoms-up KB press", load: 8, sets: "3x8", rpe: 7, pain: 2 })] })
    ];
    expect(E.painState(S, buSlot).level).toBe("regress");
  });
  it("TIGHT(2) once = no action", () => {
    const S = E.newState();
    S.sessions = [sess({ date: "2026-07-04", entries: [entry({ ex: "Bottoms-up KB press", load: 8, sets: "3x8", rpe: 7, pain: 2 })] })];
    expect(E.painState(S, buSlot)).toBeNull();
  });
});

/* ---------- ladders ---------- */
describe("ladders", () => {
  it("blocked before minWeek", () => {
    const S = E.newState();
    S.sessions = [sess({ date: TODAY, day: "lower", entries: [entry({ ex: "Box squat", load: 70, sets: "6x4", rpe: 7 })] })];
    const st = E.ladderStatus(S, squatSlot, TODAY); // week 1
    expect(st.eligible).toBe(false);
  });
  it("eligible at week threshold when symptom-clean", () => {
    const S = E.newState();
    S.sessions = [sess({ date: "2026-05-31", day: "lower", entries: [entry({ ex: "Box squat", load: 70, sets: "6x4", rpe: 7, pain: 0 })] })];
    // 2026-05-31 → 2026-07-05 is 5 weeks in
    const st = E.ladderStatus(S, squatSlot, TODAY);
    expect(st.eligible).toBe(true);
    expect(st.next).toBe("Zercher to box");
  });
  it("pain ≥2 in 14d blocks advancement", () => {
    const S = E.newState();
    S.sessions = [
      sess({ date: "2026-05-31", day: "lower", entries: [entry({ ex: "Box squat", load: 70, sets: "6x4", rpe: 7 })] }),
      sess({ date: "2026-07-01", day: "lower", entries: [entry({ ex: "Box squat", load: 80, sets: "6x4", rpe: 7, pain: 2 })] })
    ];
    const st = E.ladderStatus(S, squatSlot, TODAY);
    expect(st.eligible).toBe(false);
    expect(st.blocked).toBe("pain");
  });
  it("advanceLadder sets sub and kills wave", () => {
    const S = E.newState();
    S.sessions = [sess({ date: "2026-05-31", day: "lower", entries: [entry({ ex: "Box squat", load: 70, sets: "6x4", rpe: 7 })] })];
    S.waves["lo-squat"] = { active: true, tm: 100, wk: 2 };
    const next = E.advanceLadder(S, squatSlot, TODAY);
    expect(next).toBe("Zercher to box");
    expect(S.subs["lo-squat"]).toBe("Zercher to box");
    expect(S.waves["lo-squat"]).toBeUndefined();
  });
});

/* ---------- overrides ---------- */
describe("coach overrides", () => {
  it("override outranks everything, cleared on log", () => {
    const S = E.newState();
    S.sessions = [sess({ date: "2026-07-01", entries: [entry({ ex: "Bench press", load: 80, sets: "4x4", rpe: 7 })] })];
    S.overrides["Bench press"] = { load: 77.5, reason: "test" };
    expect(E.recommend(S, benchSlot, TODAY).txt).toContain("77.5");
    E.clearOverridesFor(S, [{ ex: "Bench press" }]);
    expect(E.recommend(S, benchSlot, TODAY).cls).toBe("cleared");
  });
});

/* ---------- proposals ---------- */
describe("proposal validation and application", () => {
  it("rejects sub outside slot role", () => {
    const S = E.newState();
    expect(E.validateProposal(S, { type: "set_sub", slot_id: "pu-bench", exercise: "Zercher squat" })).toBeTruthy();
  });
  it("accepts and applies valid sub, killing wave", () => {
    const S = E.newState();
    S.waves["pu-bench"] = { active: true, tm: 100, wk: 1 };
    const err = E.applyProposal(S, { type: "set_sub", slot_id: "pu-bench", exercise: "Floor press" }, TODAY);
    expect(err).toBeNull();
    expect(S.subs["pu-bench"]).toBe("Floor press");
    expect(S.waves["pu-bench"]).toBeUndefined();
  });
  it("rejects unknown type", () => {
    expect(E.validateProposal(E.newState(), { type: "yolo" })).toBeTruthy();
  });
});

/* ---------- load model ---------- */
describe("ACWR", () => {
  it("uniform load → ACWR 1.0", () => {
    const S = E.newState();
    for (let i = 0; i < 28; i++) S.bjj.push({ id: "b" + i, date: E.daysAgo(i, TODAY), mins: 60, srpe: 6, note: "" });
    expect(E.bjjACWR(S, TODAY)).toBeCloseTo(1.0);
  });
  it("acute spike → ACWR > 1.4", () => {
    const S = E.newState();
    for (let i = 7; i < 28; i++) S.bjj.push({ id: "b" + i, date: E.daysAgo(i, TODAY), mins: 30, srpe: 4, note: "" });
    for (let i = 0; i < 7; i++) S.bjj.push({ id: "a" + i, date: E.daysAgo(i, TODAY), mins: 90, srpe: 9, note: "" });
    expect(E.bjjACWR(S, TODAY)).toBeGreaterThan(1.4);
  });
  it("no history → null", () => expect(E.bjjACWR(E.newState(), TODAY)).toBeNull());
});

describe("tonnage", () => {
  it("/side doubles parsed volume", () => {
    const S = E.newState();
    S.sessions = [sess({ date: TODAY, entries: [entry({ ex: "x", load: 10, sets: "3x8/side" })] })];
    expect(E.weekTonnage(S, TODAY)).toBe(10 * 3 * 8 * 2);
  });
});

/* ---------- deload ---------- */
describe("deload trigger", () => {
  it("needs 2 of 3 conditions", () => {
    const S = E.newState();
    // Uniform 28d background load so ACWR ≈ 1 and doesn't fire as a side effect.
    // (Sparse history mechanically inflates ACWR — documented small-sample artifact.)
    for (let i = 0; i < 28; i++) S.bjj.push({ id: "bg" + i, date: E.daysAgo(i, TODAY), mins: 60, srpe: 6, note: "" });
    // condition: pain in last 7d — one condition only → no fire
    S.sessions = [
      sess({ date: E.daysAgo(1, TODAY), entries: [entry({ ex: "Bench press", load: 90, sets: "4x4", rpe: 8, pain: 2 })] }),
      sess({ date: E.daysAgo(8, TODAY), entries: [entry({ ex: "Bench press", load: 90, sets: "4x4", rpe: 7.5 })] })
    ];
    expect(E.combinedACWR(S, TODAY)).toBeLessThan(1.4);
    expect(E.deloadSignal(S, TODAY).fire).toBe(false);
    // add second drifting lift → drift condition (≥2 lifts) + pain = 2 conditions → fire
    S.sessions[0].entries.push(entry({ ex: "RDL", load: 100, sets: "4x5", rpe: 8 }));
    S.sessions[1].entries.push(entry({ ex: "RDL", load: 100, sets: "4x5", rpe: 7 }));
    expect(E.rpeDriftCount(S)).toBe(2);
    expect(E.deloadSignal(S, TODAY).fire).toBe(true);
  });
  it("sparse history inflates ACWR (documented artifact — agents: candidate for a min-history guard)", () => {
    const S = E.newState();
    S.sessions = [sess({ date: E.daysAgo(1, TODAY), entries: [entry({ ex: "Bench press", load: 80, sets: "4x4", rpe: 7 })] })];
    expect(E.combinedACWR(S, TODAY)).toBeGreaterThan(1.4);
  });
  it("deload recommendation ≈ 60% of last load", () => {
    const S = E.newState();
    S.sessions = [sess({ date: "2026-07-01", entries: [entry({ ex: "Bench press", load: 80, sets: "4x4", rpe: 7 })] })];
    E.startDeload(S, TODAY);
    const r = E.recommend(S, benchSlot, TODAY);
    expect(r.txt).toContain(String(E.rnd(80 * 0.6, 2.5)));
  });
});

/* ---------- ESD phases ---------- */
describe("ESD phase planner", () => {
  function withComp(weeksOut) {
    const S = E.newState();
    S.comp = E.daysAgo(-7 * weeksOut, TODAY); // future date
    return S;
  }
  it("maps weeks-out to phases", () => {
    expect(E.esdPhase(withComp(16), TODAY).name).toBe("AEROBIC BASE");
    expect(E.esdPhase(withComp(10), TODAY).name).toBe("ALACTIC BLOCK");
    expect(E.esdPhase(withComp(5), TODAY).name).toBe("LACTIC CAPACITY BLOCK");
    expect(E.esdPhase(withComp(2), TODAY).name).toBe("TAPER");
  });
  it("null without comp date", () => expect(E.esdPhase(E.newState(), TODAY)).toBeNull());
  it("comp week and comp passed", () => {
    const S = E.newState();
    S.comp = TODAY;
    expect(E.esdPhase(S, TODAY).name).toBe("COMP WEEK");
    S.comp = E.daysAgo(8, TODAY);
    expect(E.esdPhase(S, TODAY).name).toBe("COMP PASSED");
  });
});

/* ---------- utils: zone / todayISO ---------- */
describe("zone", () => {
  it("maps RPE to zones with null-safe default", () => {
    expect(E.zone(null)).toBe("n");
    expect(E.zone("")).toBe("n");
    expect(E.zone(7)).toBe("c");
    expect(E.zone(8)).toBe("h");
    expect(E.zone(8.5)).toBe("b");
  });
});

describe("todayISO", () => {
  it("returns an ISO date string", () => {
    expect(E.todayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

/* ---------- bestE1RM edge cases ---------- */
describe("bestE1RM edges", () => {
  it("null when sets unparseable and no AMRAP", () => {
    expect(E.bestE1RM(entry({ ex: "x", load: 100, sets: "heavy triples" }))).toBeNull();
  });
  it("null when sets parse but RPE missing", () => {
    expect(E.bestE1RM(entry({ ex: "x", load: 100, sets: "4x4" }))).toBeNull();
  });
  it("hostile ToPrimitive objects (JSON {\"toString\":\"\"}) → null, never throw", () => {
    // found by fast-check seed -1138755548; real JSON can express this object
    const hostile = JSON.parse('{"toString":""}');
    expect(E.parseSets(hostile)).toBeNull();
    expect(E.bestE1RM({ ex: "x", load: hostile, sets: "4x4", rpe: 7 })).toBeNull();
    expect(E.bestE1RM({ ex: "x", load: 100, sets: hostile, amrap: hostile, rpe: hostile })).toBeNull();
  });
  it("non-positive AMRAP is ignored — top-set parse wins", () => {
    expect(E.bestE1RM(entry({ ex: "x", load: 100, sets: "4x4", amrap: -1, rpe: 7 }))).toBeCloseTo(E.e1rm(100, 4, 7));
  });
});

/* ---------- historyFor entry filtering ---------- */
describe("historyFor entry filtering", () => {
  it("includes pain-only entries (no load, no RPE)", () => {
    const S = E.newState();
    S.sessions = [sess({ date: "2026-07-01", entries: [entry({ ex: "Bench press", pain: 3 })] })];
    const h = E.historyFor(S, "Bench press", 3);
    expect(h.length).toBe(1);
    expect(h[0].e.pain).toBe(3);
  });
  it("includes RPE-only entries (bodyweight movement)", () => {
    const S = E.newState();
    S.sessions = [sess({ date: "2026-07-01", day: "lower", entries: [entry({ ex: "Nordic curl", sets: "3x8", rpe: 8 })] })];
    expect(E.historyFor(S, "Nordic curl", 3).length).toBe(1);
  });
  it("skips note-only entries, falls through to older session", () => {
    const S = E.newState();
    S.sessions = [
      sess({ date: "2026-07-01", entries: [entry({ ex: "Bench press", load: 80, sets: "4x4", rpe: 7 })] }),
      sess({ date: "2026-07-03", entries: [entry({ ex: "Bench press", note: "skipped — no rack" })] })
    ];
    const h = E.historyFor(S, "Bench press", 3);
    expect(h.length).toBe(1);
    expect(h[0].date).toBe("2026-07-01");
  });
});

/* ---------- firstDate / weekNum ---------- */
describe("firstDate / weekNum", () => {
  it("firstDate falls back to today on empty state", () => {
    expect(E.firstDate(E.newState(), TODAY)).toBe(TODAY);
  });
  it("weekNum defaults d to today when null", () => {
    const S = E.newState();
    S.sessions = [sess({ date: E.daysAgo(10, TODAY) })];
    expect(E.weekNum(S, null, TODAY)).toBe(2);
  });
});

/* ---------- pain edges ---------- */
describe("pain edges", () => {
  it("no history → null", () => {
    expect(E.painState(E.newState(), buSlot)).toBeNull();
  });
  it("TIGHT now but previous pain unlogged → no action", () => {
    const S = E.newState();
    S.sessions = [
      sess({ date: "2026-06-28", entries: [entry({ ex: "Bottoms-up KB press", load: 8, sets: "3x8", rpe: 7 })] }),
      sess({ date: "2026-07-04", entries: [entry({ ex: "Bottoms-up KB press", load: 8, sets: "3x8", rpe: 7, pain: 2 })] })
    ];
    expect(E.painState(S, buSlot)).toBeNull();
  });
});

/* ---------- ladder edges ---------- */
describe("ladder edges", () => {
  it("non-ladder slot → null", () => {
    expect(E.ladderStatus(E.newState(), benchSlot, TODAY)).toBeNull();
  });
  it("off-ladder substitution → null", () => {
    const S = E.newState();
    S.subs["lo-squat"] = "Belt squat";
    expect(E.ladderStatus(S, squatSlot, TODAY)).toBeNull();
  });
  it("top rung → null", () => {
    const S = E.newState();
    S.subs["lo-squat"] = "Zercher squat";
    expect(E.ladderStatus(S, squatSlot, TODAY)).toBeNull();
  });
  it("advanceLadder refuses when ineligible; sub and wave untouched", () => {
    const S = E.newState();
    S.sessions = [sess({ date: TODAY, day: "lower", entries: [entry({ ex: "Box squat", load: 70, sets: "6x4", rpe: 7 })] })];
    S.waves["lo-squat"] = { active: true, tm: 100, wk: 2 };
    expect(E.advanceLadder(S, squatSlot, TODAY)).toBeNull(); // week 1 < minWeek 5
    expect(S.subs["lo-squat"]).toBeUndefined();
    expect(S.waves["lo-squat"]).toBeDefined();
  });
});

/* ---------- stall edges ---------- */
describe("stall edges", () => {
  it("no stall with fewer than 3 eligible sessions", () => {
    const S = E.newState();
    S.sessions = [
      sess({ date: "2026-06-28", entries: [entry({ ex: "Bench press", load: 90, sets: "4x4", rpe: 7 })] }),
      sess({ date: "2026-07-04", entries: [entry({ ex: "Bench press", load: 90, sets: "4x4", rpe: 8 })] })
    ];
    expect(E.stallDetected(S, benchSlot)).toBe(false);
  });
  it("no stall when an RPE is missing", () => {
    const S = E.newState();
    S.sessions = [
      sess({ date: "2026-06-21", entries: [entry({ ex: "Bench press", load: 90, sets: "4x4", rpe: 7 })] }),
      sess({ date: "2026-06-28", entries: [entry({ ex: "Bench press", load: 90, sets: "4x4" })] }),
      sess({ date: "2026-07-04", entries: [entry({ ex: "Bench press", load: 90, sets: "4x4", rpe: 8 })] })
    ];
    expect(E.stallDetected(S, benchSlot)).toBe(false);
  });
});

/* ---------- wave edges ---------- */
describe("wave edges", () => {
  it("waveRx falls back to deload rx on out-of-range weeks", () => {
    expect(E.waveRx({ wk: 5 })).toEqual({ sets: "3x3 deload", pct: 0.65 });
    expect(E.waveRx({ wk: 0 })).toEqual({ sets: "3x3 deload", pct: 0.65 });
    expect(E.waveRx({})).toEqual({ sets: "3x3 deload", pct: 0.65 });
  });
  it("startWave null without history", () => {
    expect(E.startWave(E.newState(), benchSlot)).toBeNull();
  });
  it("startWave falls back to load×1.1 when e1RM unavailable", () => {
    const S = E.newState();
    S.sessions = [sess({ date: "2026-07-01", entries: [entry({ ex: "Bench press", load: 100, sets: "heavy work" })] })];
    // no AMRAP, unparseable sets → est = 100×1.1 = 110 → tm = rnd(99, 2.5) = 100
    expect(E.startWave(S, benchSlot).tm).toBe(100);
  });
  it("startWave falls back to 60kg base when load is null", () => {
    const S = E.newState();
    S.sessions = [sess({ date: "2026-07-01", entries: [entry({ ex: "Bench press", rpe: 8 })] })];
    // est = 60×1.1 = 66 → tm = rnd(59.4, 2.5) = 60
    expect(E.startWave(S, benchSlot).tm).toBe(60);
  });
  it("advanceWaves ignores inactive wave state", () => {
    const S = E.newState();
    S.waves["pu-bench"] = { active: false, tm: 100, wk: 2 };
    E.advanceWaves(S, "push", "fresh", TODAY);
    expect(S.waves["pu-bench"].wk).toBe(2);
  });
  it("advanceWaves TM bump defaults inc to 2.5 when slot lacks inc", () => {
    const S = E.newState();
    S.waves["pu-prime"] = { active: true, tm: 50, wk: 4 };
    E.advanceWaves(S, "push", "fresh", TODAY);
    expect(S.waves["pu-prime"].wk).toBe(1);
    expect(S.waves["pu-prime"].tm).toBe(55); // +2×2.5 default
  });
});

/* ---------- recommend: wave / deload / model variants ---------- */
describe("recommend variants", () => {
  it("active wave rx from TM percentage", () => {
    const S = E.newState();
    S.waves["pu-bench"] = { active: true, tm: 100, wk: 1 };
    const r = E.recommend(S, benchSlot, TODAY);
    expect(r.cls).toBe("wave");
    expect(r.txt).toContain("5x5 @ 80kg");
  });
  it("wave week 4 renders as DL", () => {
    const S = E.newState();
    S.waves["pu-bench"] = { active: true, tm: 100, wk: 4 };
    expect(E.recommend(S, benchSlot, TODAY).txt).toContain("WKDL");
  });
  it("inactive wave falls through to gate logic", () => {
    const S = E.newState();
    S.waves["pu-bench"] = { active: false, tm: 100, wk: 1 };
    S.sessions = [sess({ date: "2026-07-01", entries: [entry({ ex: "Bench press", load: 80, sets: "4x4", rpe: 7 })] })];
    expect(E.recommend(S, benchSlot, TODAY).cls).toBe("cleared");
  });
  it("override without reason labels generic override", () => {
    const S = E.newState();
    S.overrides["Bench press"] = { load: 70 };
    expect(E.recommend(S, benchSlot, TODAY).txt).toContain("override");
  });
  it("deload with no history or no load → generic light prescription", () => {
    const S1 = E.newState();
    E.startDeload(S1, TODAY);
    expect(E.recommend(S1, benchSlot, TODAY).txt).toContain("DELOAD — light");
    const S2 = E.newState();
    S2.sessions = [sess({ date: "2026-07-01", entries: [entry({ ex: "Bench press", pain: 1 })] })];
    E.startDeload(S2, TODAY);
    expect(E.recommend(S2, benchSlot, TODAY).txt).toContain("DELOAD — light");
  });
  it("deload skips primer slots", () => {
    const S = E.newState();
    E.startDeload(S, TODAY);
    expect(E.recommend(S, primerSlot, TODAY).cls).toBe("none");
  });
  it("primer with history → speed work, load static", () => {
    const S = E.newState();
    S.sessions = [sess({ date: "2026-07-01", entries: [entry({ ex: "Landmine rotational punch", load: 20, sets: "3x3", rpe: 6 })] })];
    expect(E.recommend(S, primerSlot, TODAY).txt).toContain("SPEED WORK");
  });
  it("iso shows last load, or dash when bodyweight", () => {
    const S = E.newState();
    S.sessions = [sess({ date: "2026-07-01", day: "lower", entries: [entry({ ex: "Suitcase carry", load: 24, rpe: 6 })] })];
    expect(E.recommend(S, carrySlot, TODAY).txt).toContain("24kg");
    S.sessions = [sess({ date: "2026-07-02", day: "lower", entries: [entry({ ex: "Suitcase carry", rpe: 6 })] })];
    expect(E.recommend(S, carrySlot, TODAY).txt).toContain("—");
  });
  it("load logged without RPE → prompt", () => {
    const S = E.newState();
    S.sessions = [sess({ date: "2026-07-01", entries: [entry({ ex: "Bench press", load: 80, sets: "4x4", pain: 0 })] })];
    expect(E.recommend(S, benchSlot, TODAY).txt).toBe("NO RPE LOGGED");
  });
  it("gate cleared at bodyweight shows +inc", () => {
    const S = E.newState();
    S.sessions = [sess({ date: "2026-07-01", day: "pull", entries: [entry({ ex: "Weighted pull-up (neutral)", sets: "5x5", rpe: 6.5 })] })];
    const r = E.recommend(S, pullupSlot, TODAY);
    expect(r.cls).toBe("cleared");
    expect(r.txt).toContain("+2.5");
  });
  it("double progression RPE >8.5 → breach", () => {
    const S = E.newState();
    S.sessions = [sess({ date: "2026-07-01", entries: [entry({ ex: "Cable lateral raise (behind-back)", load: 10, sets: "5x12", rpe: 9 })] })];
    expect(E.recommend(S, latSlot, TODAY).cls).toBe("breach");
  });
});

/* ---------- load model edges ---------- */
describe("load model edges", () => {
  it("legacy gym sessions imputed 60min @ sRPE6", () => {
    const S = E.newState();
    S.sessions = [sess({ date: TODAY, mins: null, srpe: null })];
    expect(E.loadByDay(S)[TODAY]).toBe(360);
  });
  it("gym and BJJ on the same date sum", () => {
    const S = E.newState();
    S.sessions = [sess({ date: TODAY, mins: 45, srpe: 7 })];
    S.bjj = [{ id: "b1", date: TODAY, mins: 60, srpe: 8, note: "" }];
    expect(E.loadByDay(S)[TODAY]).toBe(45 * 7 + 60 * 8);
  });
});

/* ---------- tonnage edges ---------- */
describe("tonnage edges", () => {
  it("unparseable sets and bodyweight entries contribute zero", () => {
    const S = E.newState();
    S.sessions = [sess({
      date: TODAY, entries: [
        entry({ ex: "a", load: 100, sets: "amrap ladder" }), // unparseable → 0
        entry({ ex: "b", sets: "3x8" }),                     // load null → 0
        entry({ ex: "c", load: 50, sets: "2x10" })           // 1000
      ]
    })];
    expect(E.weekTonnage(S, TODAY)).toBe(1000);
  });
  it("sessions outside the window are excluded", () => {
    const S = E.newState();
    S.sessions = [
      sess({ date: "2026-06-01", entries: [entry({ ex: "a", load: 100, sets: "5x5" })] }),
      sess({ date: "2026-07-04", entries: [entry({ ex: "a", load: 100, sets: "2x2" })] }),
      sess({ date: "2026-07-20", entries: [entry({ ex: "a", load: 100, sets: "5x5" })] })
    ];
    expect(E.tonnageBetween(S, "2026-07-01", "2026-07-10")).toBe(400);
  });
});

/* ---------- deload signal edges ---------- */
describe("deload signal edges", () => {
  it("pain older than 7d or below 2 doesn't count", () => {
    const S = E.newState();
    S.sessions = [
      sess({ date: E.daysAgo(10, TODAY), entries: [entry({ ex: "x", load: 10, sets: "3x8", rpe: 7, pain: 3 })] }),
      sess({ date: E.daysAgo(1, TODAY), entries: [entry({ ex: "x", load: 10, sets: "3x8", rpe: 7, pain: 1 })] })
    ];
    expect(E.recentPain(S, TODAY)).toBe(false);
  });
  it("empty state → no signal, no reasons", () => {
    const sig = E.deloadSignal(E.newState(), TODAY);
    expect(sig.fire).toBe(false);
    expect(sig.reasons).toEqual([]);
  });
  it("fires on ACWR spike + recent pain", () => {
    const S = E.newState();
    for (let i = 7; i < 28; i++) S.bjj.push({ id: "b" + i, date: E.daysAgo(i, TODAY), mins: 30, srpe: 4, note: "" });
    for (let i = 0; i < 7; i++) S.bjj.push({ id: "a" + i, date: E.daysAgo(i, TODAY), mins: 90, srpe: 9, note: "" });
    S.sessions = [sess({ date: E.daysAgo(1, TODAY), entries: [entry({ ex: "x", load: 10, sets: "3x8", rpe: 7, pain: 2 })] })];
    const sig = E.deloadSignal(S, TODAY);
    expect(sig.fire).toBe(true);
    expect(sig.reasons.some(r => r.includes("ACWR"))).toBe(true);
  });
  it("isDeload false once window expires", () => {
    const S = E.newState();
    S.deload = { until: E.daysAgo(1, TODAY) };
    expect(E.isDeload(S, TODAY)).toBe(false);
  });
  it("startDeload sets a 7-day window", () => {
    const S = E.newState();
    expect(E.startDeload(S, TODAY).until).toBe("2026-07-12");
    expect(E.isDeload(S, TODAY)).toBe(true);
  });
});

/* ---------- proposal validation matrix ---------- */
describe("proposal validation matrix", () => {
  it("slotById null on unknown id", () => expect(E.slotById("nope")).toBeNull());
  it("set_sub: unknown slot", () => {
    expect(E.validateProposal(E.newState(), { type: "set_sub", slot_id: "nope", exercise: "Floor press" })).toBe("unknown slot");
  });
  it("start_wave: unknown slot / missing tm / valid", () => {
    const S = E.newState();
    expect(E.validateProposal(S, { type: "start_wave", slot_id: "nope", tm: 100 })).toBe("unknown slot");
    expect(E.validateProposal(S, { type: "start_wave", slot_id: "pu-bench" })).toBe("missing tm");
    expect(E.validateProposal(S, { type: "start_wave", slot_id: "pu-bench", tm: 100 })).toBeNull();
  });
  it("exit_wave: unknown slot / valid", () => {
    expect(E.validateProposal(E.newState(), { type: "exit_wave", slot_id: "nope" })).toBe("unknown slot");
    expect(E.validateProposal(E.newState(), { type: "exit_wave", slot_id: "pu-bench" })).toBeNull();
  });
  it("advance_ladder: non-ladder or unknown slot / top rung / valid", () => {
    const S = E.newState();
    expect(E.validateProposal(S, { type: "advance_ladder", slot_id: "pu-bench" })).toBe("not a ladder slot");
    expect(E.validateProposal(S, { type: "advance_ladder", slot_id: "nope" })).toBe("not a ladder slot");
    expect(E.validateProposal(S, { type: "advance_ladder", slot_id: "pu-lmp" })).toBeNull();
    S.subs["lo-squat"] = "Zercher squat";
    expect(E.validateProposal(S, { type: "advance_ladder", slot_id: "lo-squat" })).toBe("no next rung");
  });
  it("start_deload always valid; override_load needs exercise + numeric load", () => {
    expect(E.validateProposal(E.newState(), { type: "start_deload" })).toBeNull();
    expect(E.validateProposal(E.newState(), { type: "override_load", load: 70 })).toBe("missing exercise/load");
    expect(E.validateProposal(E.newState(), { type: "override_load", exercise: "Bench press", load: "70" })).toBe("missing exercise/load");
    expect(E.validateProposal(E.newState(), { type: "override_load", exercise: "Bench press", load: 70 })).toBeNull();
  });
});

/* ---------- applyProposal per type ---------- */
describe("applyProposal per type", () => {
  it("invalid proposal → error, state untouched", () => {
    const S = E.newState();
    expect(E.applyProposal(S, { type: "set_sub", slot_id: "nope", exercise: "Floor press" }, TODAY)).toBe("unknown slot");
    expect(S.subs).toEqual({});
  });
  it("start_wave rounds TM to 2.5", () => {
    const S = E.newState();
    expect(E.applyProposal(S, { type: "start_wave", slot_id: "pu-bench", tm: 101.3 }, TODAY)).toBeNull();
    expect(S.waves["pu-bench"]).toEqual({ active: true, tm: 102.5, wk: 1 });
  });
  it("exit_wave removes wave state", () => {
    const S = E.newState();
    S.waves["pu-bench"] = { active: true, tm: 100, wk: 2 };
    expect(E.applyProposal(S, { type: "exit_wave", slot_id: "pu-bench" }, TODAY)).toBeNull();
    expect(S.waves["pu-bench"]).toBeUndefined();
  });
  it("advance_ladder subs next rung and kills wave", () => {
    const S = E.newState();
    S.waves["lo-squat"] = { active: true, tm: 100, wk: 3 };
    expect(E.applyProposal(S, { type: "advance_ladder", slot_id: "lo-squat" }, TODAY)).toBeNull();
    expect(S.subs["lo-squat"]).toBe("Zercher to box");
    expect(S.waves["lo-squat"]).toBeUndefined();
  });
  it("start_deload opens 7-day window from today", () => {
    const S = E.newState();
    expect(E.applyProposal(S, { type: "start_deload" }, TODAY)).toBeNull();
    expect(S.deload.until).toBe("2026-07-12");
  });
  it("override_load stores load with defaulted reason", () => {
    const S = E.newState();
    E.applyProposal(S, { type: "override_load", exercise: "Bench press", load: 77.5 }, TODAY);
    expect(S.overrides["Bench press"]).toEqual({ load: 77.5, reason: "" });
    E.applyProposal(S, { type: "override_load", exercise: "RDL", load: 100, reason: "form reset" }, TODAY);
    expect(S.overrides["RDL"].reason).toBe("form reset");
  });
});

/* ---------- invariant audit (backlog item 3) ----------
 * Pain is a SAFETY rule: it must see every session, including post-BJJ.
 * The eligibility filter (invariant 1) applies to progression only. */
describe("invariant audit: pain rules see post-BJJ sessions", () => {
  it("PAIN(3) logged post-BJJ still hard-stops the next session", () => {
    const S = E.newState();
    S.sessions = [
      sess({ date: "2026-07-01", flag: "fresh", entries: [entry({ ex: "Bench press", load: 80, sets: "4x4", rpe: 7, pain: 0 })] }),
      sess({ date: "2026-07-03", flag: "bjj", entries: [entry({ ex: "Bench press", pain: 3 })] })
    ];
    const ps = E.painState(S, benchSlot);
    expect(ps).not.toBeNull();
    expect(ps.level).toBe("stop");
  });
  it("TIGHT twice running counts across a post-BJJ session", () => {
    const S = E.newState();
    S.sessions = [
      sess({ date: "2026-06-28", flag: "bjj", entries: [entry({ ex: "Bottoms-up KB press", rpe: 7, pain: 2 })] }),
      sess({ date: "2026-07-04", flag: "fresh", entries: [entry({ ex: "Bottoms-up KB press", load: 8, sets: "3x8", rpe: 7, pain: 2 })] })
    ];
    const ps = E.painState(S, buSlot);
    expect(ps).not.toBeNull();
    expect(ps.level).toBe("regress");
  });
  it("clean eligible session after post-BJJ pain clears the stop", () => {
    const S = E.newState();
    S.sessions = [
      sess({ date: "2026-07-01", flag: "bjj", entries: [entry({ ex: "Bench press", pain: 3 })] }),
      sess({ date: "2026-07-03", flag: "fresh", entries: [entry({ ex: "Bench press", load: 70, sets: "4x4", rpe: 6, pain: 0 })] })
    ];
    expect(E.painState(S, benchSlot)).toBeNull();
  });
  it("progression history still excludes post-BJJ (invariant 1 unchanged)", () => {
    const S = E.newState();
    S.sessions = [
      sess({ date: "2026-07-01", flag: "fresh", entries: [entry({ ex: "Bench press", load: 80, sets: "4x4", rpe: 7 })] }),
      sess({ date: "2026-07-03", flag: "bjj", entries: [entry({ ex: "Bench press", load: 60, sets: "3x8", rpe: 9 })] })
    ];
    expect(E.historyFor(S, "Bench press", 5).length).toBe(1);
    expect(E.recommend(S, benchSlot, TODAY).cls).toBe("cleared");
  });
});

describe("invariant audit: slot table ↔ LIB consistency", () => {
  it("every slot default is in its role's library list", () => {
    for (const day of Object.keys(E.SLOTS)) for (const slot of E.SLOTS[day]) {
      const names = (E.LIB[slot.role] || []).map(o => o.n);
      expect(names, `slot ${slot.id} def "${slot.def}" missing from LIB.${slot.role}`).toContain(slot.def);
    }
  });
  it("every ladder rung and regressTo target is in the library", () => {
    for (const key of Object.keys(E.LADDERS)) {
      const L = E.LADDERS[key];
      const { slot } = E.slotById(L.slot);
      const names = E.LIB[slot.role].map(o => o.n);
      for (const rung of L.rungs) expect(names, `ladder ${key} rung "${rung}"`).toContain(rung);
    }
    for (const day of Object.keys(E.SLOTS)) for (const slot of E.SLOTS[day]) {
      if (slot.regressTo)
        expect(E.LIB[slot.role].map(o => o.n), `slot ${slot.id} regressTo "${slot.regressTo}"`).toContain(slot.regressTo);
    }
  });
});

describe("invariant audit: banned movements (invariant 8)", () => {
  // L glenohumeral irritation + old ACJ sprain — see CLAUDE.md injury constraints.
  const BANNED = [
    /\bdips?\b/i, /wide[- ]?grip/i, /behind[- ]?(the[- ])?neck/i, /upright row/i,
    /bulgarian/i, /\bcalf\b/i, /front (raise|delt)/i, /deep[- ]?stretch/i
  ];
  it("never appear in LIB", () => {
    for (const role of Object.keys(E.LIB)) for (const o of E.LIB[role]) {
      for (const rx of BANNED) expect(o.n, `LIB.${role} "${o.n}" matches banned ${rx}`).not.toMatch(rx);
    }
  });
  it("never pass set_sub validation", () => {
    expect(E.validateProposal(E.newState(), { type: "set_sub", slot_id: "pu-bench", exercise: "Dips" })).toBeTruthy();
    expect(E.validateProposal(E.newState(), { type: "set_sub", slot_id: "pu-bench", exercise: "Wide-grip bench" })).toBeTruthy();
  });
  it("never pass override_load validation", () => {
    expect(E.validateProposal(E.newState(), { type: "override_load", exercise: "Dips", load: 40 })).toBeTruthy();
    expect(E.validateProposal(E.newState(), { type: "override_load", exercise: "Bulgarian split squat", load: 30 })).toBeTruthy();
    expect(E.validateProposal(E.newState(), { type: "override_load", exercise: "Bench press", load: 80 })).toBeNull();
  });
});

/* ---------- coach gate: ladder escalation requires symptom-clean ----------
 * Week-threshold bypass is allowed (calendar is discretionary); the 14-day
 * symptom gate is not (symptoms are not). Applies to advance_ladder and to
 * set_sub moves UP the same ladder. */
describe("proposal ladder escalation gate", () => {
  function painfulSquat(painDaysAgo) {
    const S = E.newState();
    S.sessions = [
      sess({ date: E.daysAgo(40, TODAY), day: "lower", entries: [entry({ ex: "Box squat", load: 60, sets: "6x4", rpe: 7 })] }),
      sess({ date: E.daysAgo(painDaysAgo, TODAY), day: "lower", entries: [entry({ ex: "Box squat", load: 70, sets: "6x4", rpe: 7, pain: 2 })] })
    ];
    return S;
  }
  it("advance_ladder rejected when current exercise had pain ≥2 within 14d", () => {
    expect(E.validateProposal(painfulSquat(5), { type: "advance_ladder", slot_id: "lo-squat" }, TODAY)).toBe("not 14d symptom-clean");
  });
  it("advance_ladder allowed again once pain ages past 14d", () => {
    expect(E.validateProposal(painfulSquat(20), { type: "advance_ladder", slot_id: "lo-squat" }, TODAY)).toBeNull();
  });
  it("week threshold stays coach-bypassable (clean week-1 advance applies)", () => {
    const S = E.newState();
    S.sessions = [sess({ date: E.daysAgo(2, TODAY), day: "lower", entries: [entry({ ex: "Box squat", load: 60, sets: "6x4", rpe: 7 })] })];
    expect(E.ladderStatus(S, squatSlot, TODAY).eligible).toBe(false); // engine's own gate blocks on week
    expect(E.applyProposal(S, { type: "advance_ladder", slot_id: "lo-squat" }, TODAY)).toBeNull();
    expect(S.subs["lo-squat"]).toBe("Zercher to box");
  });
  it("pain logged post-BJJ blocks escalation too", () => {
    const S = E.newState();
    S.sessions = [sess({ date: E.daysAgo(3, TODAY), day: "lower", flag: "bjj", entries: [entry({ ex: "Box squat", pain: 2 })] })];
    expect(E.validateProposal(S, { type: "advance_ladder", slot_id: "lo-squat" }, TODAY)).toBe("not 14d symptom-clean");
  });
  it("set_sub to a higher rung rejected under pain; clean is fine", () => {
    expect(E.validateProposal(painfulSquat(5), { type: "set_sub", slot_id: "lo-squat", exercise: "Zercher to box" }, TODAY)).toBe("not 14d symptom-clean");
    expect(E.validateProposal(painfulSquat(20), { type: "set_sub", slot_id: "lo-squat", exercise: "Zercher to box" }, TODAY)).toBeNull();
  });
  it("set_sub down-rung stays allowed under pain (that IS the regression play)", () => {
    const S = E.newState();
    S.subs["lo-squat"] = "Zercher to box";
    S.sessions = [sess({ date: E.daysAgo(3, TODAY), day: "lower", entries: [entry({ ex: "Zercher to box", load: 60, sets: "6x4", rpe: 8, pain: 2 })] })];
    expect(E.validateProposal(S, { type: "set_sub", slot_id: "lo-squat", exercise: "Box squat" }, TODAY)).toBeNull();
  });
  it("off-ladder moves are not escalations (no rung ordering exists)", () => {
    // painful Box squat → Belt squat: lateral escape to zero spinal load, allowed
    expect(E.validateProposal(painfulSquat(5), { type: "set_sub", slot_id: "lo-squat", exercise: "Belt squat" }, TODAY)).toBeNull();
    // from an off-ladder sub, rung targets have no "higher" relation — coach + human confirm decide
    const S = E.newState();
    S.subs["lo-squat"] = "Belt squat";
    S.sessions = [sess({ date: E.daysAgo(3, TODAY), day: "lower", entries: [entry({ ex: "Belt squat", load: 100, sets: "4x8", rpe: 7, pain: 2 })] })];
    expect(E.validateProposal(S, { type: "set_sub", slot_id: "lo-squat", exercise: "Zercher squat" }, TODAY)).toBeNull();
  });
});

/* ---------- property-based tests (backlog item 2) ----------
 * Sets strings and entry fields arrive from stored/imported JSON — the parse
 * layer must never throw, whatever lands in it. e1RM must be monotonic in
 * reps and load or progression comparisons are meaningless. */
describe("property: parseSets", () => {
  it("never throws on arbitrary junk; result is null or a sane shape", () => {
    fc.assert(fc.property(
      fc.oneof(fc.string(), fc.constantFrom(null, undefined), fc.anything()),
      s => {
        const r = E.parseSets(s);
        return r === null || (typeof r.n === "number" && typeof r.reps === "number" && r.n >= 0 && r.reps >= 0);
      }
    ));
  });
  it("round-trips generated NxM in any tolerated spelling", () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 99 }), fc.integer({ min: 0, max: 99 }),
      fc.constantFrom("x", "X", "×"),
      fc.constantFrom("", " ", "  "),
      fc.constantFrom("", "/side", " /side · primer"),
      (n, reps, sep, sp, suffix) => {
        const r = E.parseSets(`${n}${sp}${sep}${sp}${reps}${suffix}`);
        return r !== null && r.n === n && r.reps === reps;
      }
    ));
  });
});

describe("property: bestE1RM", () => {
  const junkEntry = fc.record({
    ex: fc.string(),
    load: fc.oneof(fc.constant(null), fc.double({ min: -1e6, max: 1e6, noNaN: true }), fc.anything()),
    sets: fc.oneof(fc.string(), fc.anything()),
    amrap: fc.oneof(fc.constant(null), fc.integer({ min: -100, max: 100 }), fc.anything()),
    rpe: fc.oneof(fc.constant(null), fc.constantFrom(...E.RPE_VALUES), fc.anything()),
    pain: fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 3 }))
  });
  it("never throws on garbage entries; returns null or a number", () => {
    fc.assert(fc.property(junkEntry, e => {
      const v = E.bestE1RM(e);
      return v === null || typeof v === "number";
    }));
  });
  it("monotonic in AMRAP reps", () => {
    fc.assert(fc.property(
      fc.double({ min: 20, max: 300, noNaN: true }),
      fc.integer({ min: 1, max: 20 }),
      fc.integer({ min: 1, max: 10 }),
      fc.constantFrom(...E.RPE_VALUES),
      (load, reps, bump, rpe) => {
        const lo = E.bestE1RM({ ex: "x", load, sets: "", amrap: reps, rpe, pain: null });
        const hi = E.bestE1RM({ ex: "x", load, sets: "", amrap: reps + bump, rpe, pain: null });
        return hi > lo;
      }
    ));
  });
});

describe("property: e1rm monotonicity", () => {
  it("strictly increasing in load", () => {
    fc.assert(fc.property(
      fc.double({ min: 1, max: 500, noNaN: true }),
      fc.double({ min: 0.5, max: 100, noNaN: true }),
      fc.integer({ min: 0, max: 30 }),
      fc.constantFrom(...E.RPE_VALUES),
      (load, delta, reps, rpe) => E.e1rm(load + delta, reps, rpe) > E.e1rm(load, reps, rpe)
    ));
  });
  it("strictly increasing in reps", () => {
    fc.assert(fc.property(
      fc.double({ min: 1, max: 500, noNaN: true }),
      fc.integer({ min: 0, max: 30 }),
      fc.integer({ min: 1, max: 15 }),
      fc.constantFrom(...E.RPE_VALUES),
      (load, reps, bump, rpe) => E.e1rm(load, reps + bump, rpe) > E.e1rm(load, reps, rpe)
    ));
  });
});

/* ---------- e1rmSeries ---------- */
describe("e1rmSeries", () => {
  it("ascending order, skips post-BJJ and null-e1RM entries, caps at maxN", () => {
    const S = E.newState();
    S.sessions = [
      sess({ date: "2026-06-01", entries: [entry({ ex: "Bench press", load: 80, sets: "4x4", rpe: 7 })] }),
      sess({ date: "2026-06-08", flag: "bjj", entries: [entry({ ex: "Bench press", load: 100, sets: "4x4", rpe: 7 })] }),
      sess({ date: "2026-06-15", entries: [entry({ ex: "Bench press", load: 85, pain: 1 })] }), // no e1RM
      sess({ date: "2026-06-22", entries: [entry({ ex: "Bench press", load: 85, sets: "4x4", rpe: 7.5 })] }),
      sess({ date: "2026-06-29", entries: [entry({ ex: "Bench press", load: 87.5, sets: "4x4", rpe: 8 })] })
    ];
    const series = E.e1rmSeries(S, "Bench press");
    expect(series.length).toBe(3);
    expect(series[0]).toBeCloseTo(E.e1rm(80, 4, 7));
    expect(series[2]).toBeCloseTo(E.e1rm(87.5, 4, 8));
    expect(E.e1rmSeries(S, "Bench press", 2).length).toBe(2);
  });
});
