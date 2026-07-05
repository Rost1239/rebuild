"""
REBUILD analytics — pandas pipeline over an exported state JSON.

Usage:
    python analytics/analyze.py data/sample-state.json
    python analytics/analyze.py path/to/export.json --plots

Outputs a console report (e1RM by lift, weekly tonnage, unified sRPE load + ACWR,
pain incidence) and, with --plots, PNG figures to analytics/out/.

Designed to be %run-able from a notebook: after running, the frames live in
`entries`, `daily_load`, `acwr` for further slicing.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd

SETS_RE = re.compile(r"(\d+)\s*[x×X]\s*(\d+)")


# ---------------------------------------------------------------- loading

def load_state(path: str | Path) -> dict:
    """Load exported state JSON. Accepts v1 (bare sessions array) or full state."""
    raw = json.loads(Path(path).read_text())
    if isinstance(raw, list):  # v1 export: sessions only
        raw = {"sessions": raw, "bjj": []}
    raw.setdefault("sessions", [])
    raw.setdefault("bjj", [])
    return raw


def parse_sets(s: str | None) -> tuple[float, float]:
    """Return (n_sets, reps) parsed from 'NxM' free text; (nan, nan) if unparseable."""
    if not s:
        return (np.nan, np.nan)
    m = SETS_RE.search(s)
    return (float(m.group(1)), float(m.group(2))) if m else (np.nan, np.nan)


def e1rm(load: float, reps: float, rpe: float) -> float:
    """Epley with RIR adjustment. NaN-safe: any missing input -> NaN."""
    if any(pd.isna(v) for v in (load, reps, rpe)):
        return np.nan
    return load * (1 + (reps + (10 - rpe)) / 30)


# ---------------------------------------------------------------- frames

def entries_frame(state: dict) -> pd.DataFrame:
    """
    One row per (session, exercise) with parsed volume and e1RM.
    Columns: date, day, flag, ex, load, sets_n, reps, amrap, rpe, pain,
             tonnage, e1rm, eligible.
    """
    rows = []
    for s in state["sessions"]:
        for e in s.get("entries", []):
            n, reps = parse_sets(e.get("sets"))
            per_side = 2.0 if re.search(r"side", e.get("sets") or "", re.I) else 1.0
            load = e.get("load")
            load = np.nan if load is None else float(load)
            rpe = e.get("rpe")
            rpe = np.nan if rpe is None else float(rpe)
            amrap = e.get("amrap")
            amrap = np.nan if amrap is None else float(amrap)
            # AMRAP-based e1RM wins; AMRAP without RPE assumes RPE 9 (engine parity)
            est = e1rm(load, amrap, rpe if not pd.isna(rpe) else 9.0) if not pd.isna(amrap) \
                else e1rm(load, reps, rpe)
            rows.append({
                "date": s["date"], "day": s.get("day"), "flag": s.get("flag", "fresh"),
                "ex": e["ex"], "load": load, "sets_n": n, "reps": reps,
                "amrap": amrap, "rpe": rpe,
                "pain": np.nan if e.get("pain") is None else float(e["pain"]),
                "tonnage": (load * n * reps * per_side) if not any(pd.isna(v) for v in (load, n, reps)) else 0.0,
                "e1rm": est,
            })
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df["date"] = pd.to_datetime(df["date"])
    df["eligible"] = df["flag"] != "bjj"  # POST-BJJ never counts toward progression
    assert df["date"].notna().all(), "unparseable session dates in export"
    return df.sort_values("date").reset_index(drop=True)


def daily_load_frame(state: dict) -> pd.DataFrame:
    """
    Daily unified sRPE load (gym + BJJ), reindexed to a continuous date range.
    Legacy gym sessions missing mins/srpe are imputed 60min @ sRPE6 (engine parity).
    """
    rows = []
    for s in state["sessions"]:
        rows.append({"date": s["date"], "src": "gym",
                     "load": (s.get("mins") or 60) * (s.get("srpe") or 6)})
    for b in state["bjj"]:
        rows.append({"date": b["date"], "src": "bjj",
                     "load": float(b["mins"]) * float(b["srpe"])})
    df = pd.DataFrame(rows)
    if df.empty:
        return pd.DataFrame(columns=["gym", "bjj", "total"])
    df["date"] = pd.to_datetime(df["date"])
    piv = df.pivot_table(index="date", columns="src", values="load", aggfunc="sum").fillna(0.0)
    idx = pd.date_range(piv.index.min(), piv.index.max(), freq="D")
    piv = piv.reindex(idx, fill_value=0.0)
    for c in ("gym", "bjj"):
        if c not in piv.columns:
            piv[c] = 0.0
    piv["total"] = piv["gym"] + piv["bjj"]
    return piv


def acwr_series(daily: pd.DataFrame, col: str = "total") -> pd.Series:
    """Rolling 7d mean / rolling 28d mean. NaN until 28d of history exists."""
    acute = daily[col].rolling(7, min_periods=7).mean()
    chronic = daily[col].rolling(28, min_periods=28).mean()
    return (acute / chronic).rename("acwr")


# ---------------------------------------------------------------- report

def report(state: dict) -> tuple[pd.DataFrame, pd.DataFrame, pd.Series]:
    entries = entries_frame(state)
    daily = daily_load_frame(state)
    acwr = acwr_series(daily) if not daily.empty else pd.Series(dtype=float)

    print("=" * 62)
    print("REBUILD — analytics report")
    print("=" * 62)

    if entries.empty:
        print("No gym entries in export.")
        return entries, daily, acwr

    print(f"\nSessions: {entries['date'].nunique()}  |  "
          f"span {entries['date'].min().date()} → {entries['date'].max().date()}")

    # e1RM by lift (eligible sessions only)
    el = entries[entries["eligible"] & entries["e1rm"].notna()]
    if not el.empty:
        print("\n-- e1RM by lift (progression-eligible sessions) --")
        g = el.groupby("ex")["e1rm"]
        tbl = pd.DataFrame({
            "n": g.count().astype(int),
            "first": g.first().round(1),
            "last": g.last().round(1),
        })
        tbl["delta"] = (tbl["last"] - tbl["first"]).round(1)
        print(tbl.sort_values("last", ascending=False).to_string())

    # weekly tonnage
    wt = entries.set_index("date")["tonnage"].resample("W").sum()
    if not wt.empty:
        print("\n-- weekly tonnage (kg) --")
        print(wt.round(0).astype(int).to_string())

    # pain incidence
    pain = entries[entries["pain"] >= 2]
    print(f"\n-- pain events (score ≥2): {len(pain)} --")
    if not pain.empty:
        print(pain[["date", "ex", "pain", "rpe"]].to_string(index=False))

    # unified load + ACWR
    if not daily.empty:
        print("\n-- unified sRPE load, last 14 days --")
        print(daily.tail(14).round(0).astype(int).to_string())
        latest = acwr.dropna()
        print(f"\nACWR (7d/28d): {latest.iloc[-1]:.2f}" if not latest.empty
              else "\nACWR: insufficient history (<28d)")

    return entries, daily, acwr


def make_plots(entries: pd.DataFrame, daily: pd.DataFrame, acwr: pd.Series, outdir: Path) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    outdir.mkdir(parents=True, exist_ok=True)

    el = entries[entries["eligible"] & entries["e1rm"].notna()]
    if not el.empty:
        fig, ax = plt.subplots(figsize=(9, 5))
        for ex, g in el.groupby("ex"):
            if len(g) >= 2:
                ax.plot(g["date"], g["e1rm"], marker="o", ms=3, lw=1.2, label=ex)
        ax.set_title("e1RM by lift (eligible sessions)")
        ax.set_ylabel("kg")
        ax.legend(fontsize=7, loc="upper left")
        fig.autofmt_xdate()
        fig.tight_layout()
        fig.savefig(outdir / "e1rm.png", dpi=150)
        plt.close(fig)

    if not daily.empty:
        fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(9, 6), sharex=True)
        ax1.bar(daily.index, daily["gym"], label="gym", width=0.8)
        ax1.bar(daily.index, daily["bjj"], bottom=daily["gym"], label="bjj", width=0.8)
        ax1.set_title("Daily sRPE load (gym + BJJ)")
        ax1.legend(fontsize=8)
        ax2.plot(acwr.index, acwr.values, lw=1.2)
        ax2.axhline(1.4, color="r", ls="--", lw=0.8, label="deload threshold 1.4")
        ax2.set_title("Combined ACWR (7d/28d)")
        ax2.legend(fontsize=8)
        fig.autofmt_xdate()
        fig.tight_layout()
        fig.savefig(outdir / "load_acwr.png", dpi=150)
        plt.close(fig)

    print(f"\nPlots written to {outdir}/")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Analytics over a REBUILD state export")
    ap.add_argument("path", help="path to exported JSON")
    ap.add_argument("--plots", action="store_true", help="write PNG figures to analytics/out/")
    args = ap.parse_args()

    state = load_state(args.path)
    entries, daily_load, acwr = report(state)
    if args.plots:
        make_plots(entries, daily_load, acwr, Path(__file__).parent / "out")
