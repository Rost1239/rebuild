/**
 * Engine test suite. Conventions for agents:
 *  - Every test builds its own state via newState() + helpers below. No shared mutable fixtures.
 *  - Time is always injected via `today` — never rely on the wall clock.
 *  - Each INVARIANT in engine.js must map to at least one test. Add here, don't fork files
 *    until a describe block exceeds ~200 lines.
 */
import { describe, it, expect } from "vitest";
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
});
