/** Draft-helper suite. The prefill contract is data-integrity critical:
 *  prefills are display-only, never measurements, never post-BJJ-sourced. */
import { describe, it, expect } from "vitest";
import * as E from "../src/engine.js";
import { prefillFor, displayField, stepValue, filledEntry, withRecTarget } from "../src/draft.js";

const TODAY = "2026-07-06";
function sess({ date, flag = "fresh", entries = [] }) {
  return { id: "s" + date + flag, date, day: "push", flag, mins: 60, srpe: 6, bw: null, entries };
}

describe("prefillFor", () => {
  it("takes load+sets from the last eligible session only", () => {
    const S = E.newState();
    S.sessions = [
      sess({ date: "2026-07-01", entries: [{ ex: "Bench press", load: 80, sets: "4x4", amrap: null, rpe: 7, pain: 0, note: "" }] }),
      sess({ date: "2026-07-04", flag: "bjj", entries: [{ ex: "Bench press", load: 60, sets: "3x8", amrap: null, rpe: 8, pain: null, note: "" }] })
    ];
    expect(prefillFor(S, "Bench press")).toEqual({ load: 80, sets: "4x4" });
  });
  it("never carries RPE or pain", () => {
    const S = E.newState();
    S.sessions = [sess({ date: "2026-07-01", entries: [{ ex: "RDL", load: 100, sets: "4x5", amrap: null, rpe: 8, pain: 2, note: "hm" }] })];
    const p = prefillFor(S, "RDL");
    expect(p).toEqual({ load: 100, sets: "4x5" });
    expect("rpe" in p).toBe(false);
    expect("pain" in p).toBe(false);
  });
  it("empty without history; null load (bodyweight) passes through as null", () => {
    expect(prefillFor(E.newState(), "Bench press")).toEqual({});
    const S = E.newState();
    S.sessions = [sess({ date: "2026-07-01", entries: [{ ex: "Nordic curl", load: null, sets: "3x8", amrap: null, rpe: 7, pain: 0, note: "" }] })];
    expect(prefillFor(S, "Nordic curl")).toEqual({ load: null, sets: "3x8" });
  });
});

describe("displayField", () => {
  const pre = { load: 80, sets: "4x4" };
  it("untouched + prefill → ghost value", () => {
    expect(displayField({}, pre, "load")).toEqual({ val: 80, pre: true });
    expect(displayField({}, pre, "sets")).toEqual({ val: "4x4", pre: true });
  });
  it("user-cleared (null) shows empty, not ghost", () => {
    expect(displayField({ load: null }, pre, "load")).toEqual({ val: "", pre: false });
  });
  it("user value wins over prefill", () => {
    expect(displayField({ load: 82.5 }, pre, "load")).toEqual({ val: 82.5, pre: false });
  });
  it("no prefill available → empty, no ghost", () => {
    expect(displayField({}, {}, "load")).toEqual({ val: "", pre: false });
    expect(displayField({}, { load: null, sets: "" }, "sets")).toEqual({ val: "", pre: false });
  });
});

describe("stepValue", () => {
  it("steps by slot increment and rounds to 0.5", () => {
    expect(stepValue(80, 2.5)).toBe(82.5);
    expect(stepValue(81.3, 2.5)).toBe(84);   // 83.8 → nearest 0.5
    expect(stepValue("80", 5)).toBe(85);      // input strings tolerated
  });
  it("clamps at zero and treats empty as zero", () => {
    expect(stepValue(1, -2.5)).toBe(0);
    expect(stepValue("", 5)).toBe(5);
    expect(stepValue(undefined, 2.5)).toBe(2.5);
  });
});

describe("filledEntry", () => {
  it("any real value counts; empty and cleared-null do not", () => {
    expect(filledEntry({})).toBe(false);
    expect(filledEntry({ load: null, sets: "" })).toBe(false); // user-cleared
    expect(filledEntry({ load: 80 })).toBe(true);
    expect(filledEntry({ sets: "4x4" })).toBe(true);
    expect(filledEntry({ rpe: 7 })).toBe(true);
    expect(filledEntry({ pain: 0 })).toBe(true);  // CLEAN is a logged claim
    expect(filledEntry({ amrap: 8 })).toBe(true);
    expect(filledEntry({ note: "x" })).toBe(true);
  });
});

describe("withRecTarget", () => {
  const pre = { load: 80, sets: "4x4" };
  it("cleared → ghost load becomes last + inc, flagged target", () => {
    expect(withRecTarget(pre, "cleared", 2.5)).toEqual({ load: 82.5, sets: "4x4", target: true });
    expect(withRecTarget({ load: 81.3, sets: "" }, "cleared", 2.5).load).toBe(84); // rnd 0.5, matches rec chip
  });
  it("non-cleared classes pass through untouched", () => {
    for (const cls of ["hold", "breach", "wave", "none"])
      expect(withRecTarget(pre, cls, 2.5)).toBe(pre);
  });
  it("no load history or no inc → untouched (bodyweight, primer/iso slots)", () => {
    expect(withRecTarget({ load: null, sets: "3x8" }, "cleared", 2.5)).toEqual({ load: null, sets: "3x8" });
    expect(withRecTarget(pre, "cleared", undefined)).toBe(pre);
  });
});
