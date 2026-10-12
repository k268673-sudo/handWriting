#!/usr/bin/env python3
"""Synchronize Wacom tablet timestamps with EMG timestamps.

Input layout is expected to be the 20260629 dataset:

  ch1_ECR/
    tablet_data/*_wacom_raw_*.csv
    tablet_data/*_wacom_summary_*.csv
    EMG_data/*.csv

The script detects EMG peaks caused by sync taps, matches them to Wacom
sync-tap pointerdown times, estimates an affine time mapping,

  emg_time_sec = slope * wacom_time_sec + intercept_sec

and writes diagnostic PNGs plus CSV files for later analysis.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
from dataclasses import dataclass
from pathlib import Path


SYNC_DIR_NAME = "00_tablet_emg_sync"
RESULTS_DIR_NAME = "results"
PRE_SEC = 0.200
POST_SEC = 0.200
DEFAULT_IGNORE_STARTUP_SEC = 15.0

os.environ.setdefault(
    "MPLCONFIGDIR",
    str(Path(__file__).resolve().parent / RESULTS_DIR_NAME / "matplotlib_cache"),
)

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
import numpy as np
from scipy.signal import find_peaks


MVC_BY_SESSION = {
    "ch1_ECR": "dorsiflexion",
    "ch2_FCR": "palmar_flexion",
    "ch3_ECU": "dorsiflexion",
    "ch4_FCU": "palmar_flexion",
}


@dataclass
class SessionFiles:
    session_dir: Path
    name: str
    raw_csv: Path
    summary_csv: Path
    settings_json: Path
    emg_csv: Path


@dataclass
class SyncModel:
    name: str
    slope: float
    intercept: float
    source: str
    details: dict


def parse_args() -> argparse.Namespace:
    here = Path(__file__).resolve()
    default_root = here.parents[1]
    default_out = here.parent / RESULTS_DIR_NAME
    parser = argparse.ArgumentParser(
        description="Synchronize Wacom tablet data to EMG time using sync taps."
    )
    parser.add_argument("--root", type=Path, default=default_root, help="Dataset root directory")
    parser.add_argument("--output", type=Path, default=default_out, help="Output directory")
    parser.add_argument("--match-tolerance-sec", type=float, default=0.350)
    parser.add_argument("--min-matches", type=int, default=8)
    parser.add_argument(
        "--ignore-startup-sec",
        type=float,
        default=DEFAULT_IGNORE_STARTUP_SEC,
        help="Do not treat the initial EMG startup/noise period as an MVC alignment target.",
    )
    return parser.parse_args()


def read_csv_dicts(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def write_csv(path: Path, rows: list[dict], fieldnames: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def json_safe(value):
    if isinstance(value, dict):
        return {k: json_safe(v) for k, v in value.items()}
    if isinstance(value, list):
        return [json_safe(v) for v in value]
    if isinstance(value, tuple):
        return [json_safe(v) for v in value]
    if isinstance(value, (np.floating, np.integer)):
        return value.item()
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    return value


def to_float(value: str | float | int | None, default: float = math.nan) -> float:
    try:
        if value is None or value == "":
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def parse_hhmmss_to_sec(value: str) -> float:
    try:
        hh, mm, ss = value.strip().strip('"').split(":")
        return int(hh) * 3600 + int(mm) * 60 + float(ss)
    except Exception:
        return math.nan


def moving_average_centered(x: np.ndarray, window: int) -> np.ndarray:
    window = max(1, int(window))
    kernel = np.ones(window, dtype=float) / window
    return np.convolve(x, kernel, mode="same")


def discover_sessions(root: Path) -> list[SessionFiles]:
    sessions: list[SessionFiles] = []
    for session_dir in sorted(root.glob("ch*_*")):
        if not session_dir.is_dir():
            continue
        tablet_dir = session_dir / "tablet_data"
        emg_dir = session_dir / "EMG_data"
        if not tablet_dir.exists() or not emg_dir.exists():
            continue
        raw = sorted(tablet_dir.glob("*wacom_raw*.csv"))
        summary = sorted(tablet_dir.glob("*wacom_summary*.csv"))
        settings = sorted(tablet_dir.glob("*wacom_settings*.json"))
        emg = sorted(emg_dir.glob("*.csv"))
        if not (raw and summary and settings and emg):
            print(f"[skip] missing files in {session_dir}")
            continue
        sessions.append(
            SessionFiles(
                session_dir=session_dir,
                name=session_dir.name,
                raw_csv=raw[0],
                summary_csv=summary[0],
                settings_json=settings[0],
                emg_csv=emg[0],
            )
        )
    return sessions


def read_emg(path: Path) -> tuple[np.ndarray, np.ndarray, dict[str, str]]:
    rows = read_csv_dicts(path)
    if not rows:
        raise ValueError(f"EMG file has no rows: {path}")
    columns = list(rows[0].keys())
    time_col = columns[0]
    avg_col = next((c for c in columns if "平均" in c), None)
    min_col = next((c for c in columns if "最小" in c), None)
    max_col = next((c for c in columns if "最大" in c), None)
    if min_col is None or max_col is None:
        raise ValueError(f"Could not find EMG min/max columns in {path}")

    times = np.array([parse_hhmmss_to_sec(r[time_col]) for r in rows], dtype=float)
    emg_avg = np.array([to_float(r[avg_col]) for r in rows], dtype=float) if avg_col else np.full(len(rows), np.nan)
    emg_min = np.array([to_float(r[min_col]) for r in rows], dtype=float)
    emg_max = np.array([to_float(r[max_col]) for r in rows], dtype=float)
    valid = np.isfinite(times) & np.isfinite(emg_min) & np.isfinite(emg_max)
    times = times[valid]
    emg_avg = emg_avg[valid]
    range_activity = np.abs(emg_max[valid] - emg_min[valid])
    if np.isfinite(emg_avg).any():
        fs = sampling_rate_hz(times)
        slow = moving_average_centered(emg_avg, round(0.500 * fs))
        avg_activity = np.abs(emg_avg - slow)
        # Robustly scale both components before combining them. Sync taps can
        # appear as either a widened min/max band or a sharp average-voltage
        # deflection depending on the PicoLog export.
        range_scale = max(float(np.percentile(range_activity, 95)), 1e-9)
        avg_scale = max(float(np.percentile(avg_activity, 95)), 1e-9)
        activity = range_activity / range_scale + avg_activity / avg_scale
    else:
        activity = range_activity
    meta = {
        "time_col": time_col,
        "avg_col": avg_col or "",
        "min_col": min_col,
        "max_col": max_col,
    }
    return times, activity, meta


def sampling_rate_hz(times: np.ndarray) -> float:
    if len(times) < 3:
        return 1000.0
    diffs = np.diff(times[: min(len(times), 20000)])
    diffs = diffs[np.isfinite(diffs) & (diffs > 0)]
    if len(diffs) == 0:
        return 1000.0
    return 1.0 / float(np.median(diffs))


def read_wacom_taps(raw_rows: list[dict[str, str]]) -> list[dict]:
    taps: list[dict] = []
    for idx, row in enumerate(raw_rows, start=2):
        sync_role = row.get("sync_role", "")
        if not sync_role.endswith("sync_tap"):
            continue
        if row.get("event_type") != "pointerdown":
            continue
        t_ms = to_float(row.get("timestamp_ms"))
        if not math.isfinite(t_ms):
            continue
        taps.append(
            {
                "raw_line": idx,
                "wacom_time_sec": t_ms / 1000.0,
                "wacom_timestamp_ms": t_ms,
                "phase": row.get("phase", ""),
                "sync_role": sync_role,
                "trial_global_index": row.get("trial_global_index", ""),
                "tap_index": row.get("tap_index", ""),
                "wacom_pressure": row.get("pressure", ""),
                "wacom_x_mm": row.get("x_mm", ""),
                "wacom_y_mm": row.get("y_mm", ""),
            }
        )
    return sorted(taps, key=lambda r: r["wacom_time_sec"])


def detect_emg_peaks(times: np.ndarray, activity: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    fs = sampling_rate_hz(times)
    smoothed = moving_average_centered(activity, round(0.020 * fs))
    baseline = float(np.percentile(smoothed, 50))
    high = float(np.percentile(smoothed, 98.5))
    prom = max((high - baseline) * 0.08, float(np.std(smoothed)) * 0.60, 1e-9)
    distance = max(1, int(round(0.250 * fs)))
    peaks, props = find_peaks(smoothed, distance=distance, prominence=prom)

    if len(peaks) < 20:
        prom = max((high - baseline) * 0.03, float(np.std(smoothed)) * 0.35, 1e-9)
        peaks, props = find_peaks(smoothed, distance=distance, prominence=prom)

    return peaks, smoothed


def score_offset(
    wacom_times: np.ndarray,
    peak_times: np.ndarray,
    peak_values: np.ndarray,
    offset: float,
    tolerance: float,
) -> tuple[int, float, float]:
    matched_errors = []
    matched_values = []
    for wt in wacom_times:
        pred = wt + offset
        pos = int(np.searchsorted(peak_times, pred))
        candidates = []
        if pos > 0:
            candidates.append(pos - 1)
        if pos < len(peak_times):
            candidates.append(pos)
        best_j = None
        best_err = float("inf")
        for j in candidates:
            err = abs(peak_times[j] - pred)
            if err < best_err:
                best_err = err
                best_j = j
        if best_j is not None and best_err <= tolerance:
            matched_errors.append(best_err)
            matched_values.append(peak_values[best_j])
    if not matched_errors:
        return 0, float("inf"), 0.0
    return len(matched_errors), float(np.median(matched_errors)), float(np.sum(matched_values))


def estimate_initial_offset(
    wacom_times: np.ndarray,
    peak_times: np.ndarray,
    peak_values: np.ndarray,
    tolerance: float,
    offset_min: float,
    offset_max: float,
) -> float:
    if len(wacom_times) == 0 or len(peak_times) == 0:
        raise ValueError("Cannot estimate offset without Wacom taps and EMG peaks")

    candidate_peak_idx = np.argsort(peak_values)[-min(len(peak_values), 400) :]
    offsets = []
    sample_wacom = wacom_times
    if len(sample_wacom) > 60:
        sample_wacom = np.concatenate([sample_wacom[:15], sample_wacom[15:: max(1, len(sample_wacom) // 30)], sample_wacom[-15:]])
    for peak_idx in candidate_peak_idx:
        for wt in sample_wacom:
            off = float(peak_times[peak_idx] - wt)
            if offset_min <= off <= offset_max:
                offsets.append(off)

    best = None
    for off in offsets:
        score = score_offset(wacom_times, peak_times, peak_values, off, tolerance)
        # Prefer many matches, but keep the whole sync sequence inside the EMG
        # recording. This prevents a repeated tap pattern late in Wacom time from
        # being incorrectly mapped onto early EMG peaks.
        item = (score[0], -score[1], score[2], -abs(off), off)
        if best is None or item > best:
            best = item
    if best is None:
        raise ValueError("No offset candidate could be scored")
    return float(best[4])


def wacom_timestamp_range(raw_rows: list[dict[str, str]], phase: str | None = None) -> tuple[float, float] | None:
    vals = []
    for row in raw_rows:
        if phase is not None and row.get("phase") != phase:
            continue
        t = to_float(row.get("timestamp_ms"))
        if math.isfinite(t):
            vals.append(t / 1000.0)
    if not vals:
        return None
    return min(vals), max(vals)


def offset_bounds_from_recording(raw_rows: list[dict[str, str]], emg_start_sec: float, emg_end_sec: float, ignore_startup_sec: float) -> tuple[float, float]:
    """Constrain offset so labeled Wacom periods remain inside the EMG recording.

    MVC is explicitly labeled in the Wacom raw file and was recorded during the
    EMG session. A candidate that maps MVC before EMG time zero is therefore an
    invalid synchronization, even if it happens to match some later peaks.
    """
    all_range = wacom_timestamp_range(raw_rows)
    mvc_range = wacom_timestamp_range(raw_rows, phase="mvc")
    if all_range is None:
        return -float("inf"), float("inf")

    low = emg_start_sec - all_range[0] - 2.0
    high = emg_end_sec - all_range[1] + 2.0
    if mvc_range is not None:
        low = max(low, emg_start_sec - mvc_range[0] - 0.050)
        high = min(high, emg_end_sec - mvc_range[1] + 0.050)
        # The first seconds of PicoLog export can contain startup/contact noise.
        # Do not allow the labeled first MVC window to be mapped onto that
        # startup artifact.
        low = max(low, emg_start_sec + ignore_startup_sec - mvc_range[0])
    return low, high


def mvc_events_from_raw(raw_rows: list[dict[str, str]]) -> list[dict]:
    starts: dict[str, dict] = {}
    events: list[dict] = []
    for row in raw_rows:
        if row.get("phase") != "mvc":
            continue
        direction = row.get("mvc_direction", "")
        event = row.get("event_type", "")
        if event == "mvc_start":
            starts[direction] = row
        elif event == "mvc_end" and direction in starts:
            start_row = starts.pop(direction)
            s = to_float(start_row.get("timestamp_ms")) / 1000.0
            e = to_float(row.get("timestamp_ms")) / 1000.0
            if math.isfinite(s) and math.isfinite(e) and e > s:
                events.append({"mvc_direction": direction, "wacom_start_sec": s, "wacom_end_sec": e})
    return events


def interval_mean(times: np.ndarray, values: np.ndarray, start: float, end: float) -> float:
    if end <= start:
        return math.nan
    i0 = int(np.searchsorted(times, start, side="left"))
    i1 = int(np.searchsorted(times, end, side="right"))
    if i1 <= i0:
        return math.nan
    return float(np.nanmean(values[i0:i1]))


def evaluate_mvc_alignment(
    raw_rows: list[dict[str, str]],
    times: np.ndarray,
    activity_smooth: np.ndarray,
    slope: float,
    intercept: float,
) -> dict:
    mvc_events = mvc_events_from_raw(raw_rows)
    if not mvc_events:
        return {"mvc_score": 0.0, "mvc_mean_activity": math.nan, "mvc_contrast": math.nan, "mvc_windows_in_recording": 0}

    baseline = float(np.percentile(activity_smooth, 50))
    scale = max(float(np.percentile(activity_smooth, 95)) - baseline, 1e-9)
    window_means = []
    contrast_vals = []
    in_recording = 0
    for ev in mvc_events:
        s = slope * ev["wacom_start_sec"] + intercept
        e = slope * ev["wacom_end_sec"] + intercept
        if s < float(times[0]) or e > float(times[-1]) or e <= s:
            continue
        in_recording += 1
        mean_inside = interval_mean(times, activity_smooth, s, e)
        before = interval_mean(times, activity_smooth, max(float(times[0]), s - 4.0), max(float(times[0]), s - 0.5))
        after = interval_mean(times, activity_smooth, min(float(times[-1]), e + 0.5), min(float(times[-1]), e + 4.0))
        shoulder = np.nanmean([before, after])
        if math.isfinite(mean_inside):
            window_means.append(mean_inside)
            if math.isfinite(shoulder):
                contrast_vals.append(mean_inside - shoulder)

    if not window_means:
        return {"mvc_score": 0.0, "mvc_mean_activity": math.nan, "mvc_contrast": math.nan, "mvc_windows_in_recording": 0}
    mean_activity = float(np.mean(window_means))
    contrast = float(np.nanmean(contrast_vals)) if contrast_vals else 0.0
    score = max(0.0, (mean_activity - baseline) / scale) + 0.5 * max(0.0, contrast / scale)
    # All four MVC windows should be inside the EMG recording for this dataset.
    score *= in_recording / max(1, len(mvc_events))
    return {
        "mvc_score": float(score),
        "mvc_mean_activity": mean_activity,
        "mvc_contrast": contrast,
        "mvc_windows_in_recording": in_recording,
        "mvc_total_windows": len(mvc_events),
    }


def estimate_mvc_offset_model(
    raw_rows: list[dict[str, str]],
    times: np.ndarray,
    activity_smooth: np.ndarray,
    offset_min: float,
    offset_max: float,
) -> SyncModel | None:
    mvc_events = mvc_events_from_raw(raw_rows)
    if not mvc_events or not math.isfinite(offset_min) or not math.isfinite(offset_max) or offset_max <= offset_min:
        return None

    # 50 ms is enough for the coarse offset search because final windows are
    # hundreds to thousands of samples wide and this step only selects the
    # correct global alignment basin.
    step = 0.050
    offsets = np.arange(offset_min, offset_max + step / 2, step)
    best = None
    for off in offsets:
        ev = evaluate_mvc_alignment(raw_rows, times, activity_smooth, 1.0, float(off))
        score = ev["mvc_score"]
        item = (score, ev.get("mvc_windows_in_recording", 0), -abs(float(off)), float(off), ev)
        if best is None or item > best:
            best = item
    if best is None:
        return None
    off = best[3]
    ev = best[4]
    ev["grid_step_sec"] = step
    return SyncModel("mvc_window_search", 1.0, off, "mvc", ev)


def evaluate_tap_alignment(
    taps: list[dict],
    peak_times: np.ndarray,
    peak_values: np.ndarray,
    slope: float,
    intercept: float,
    tolerance: float,
) -> tuple[list[dict], dict]:
    matches = match_taps(taps, peak_times, peak_values, slope, intercept, tolerance)
    matched = [m for m in matches if m["matched"]]
    residuals = np.array([float(m["match_residual_sec"]) for m in matched], dtype=float)
    by_role: dict[str, int] = {}
    total_by_role: dict[str, int] = {}
    for m in matches:
        role = m.get("sync_role", "")
        total_by_role[role] = total_by_role.get(role, 0) + 1
        if m["matched"]:
            by_role[role] = by_role.get(role, 0) + 1
    metrics = {
        "matched_taps": len(matched),
        "total_wacom_sync_taps": len(matches),
        "residual_rms_ms": float(np.sqrt(np.mean(residuals**2)) * 1000.0) if len(residuals) else math.nan,
        "residual_max_abs_ms": float(np.max(np.abs(residuals)) * 1000.0) if len(residuals) else math.nan,
        "start_sync_matched": by_role.get("start_sync_tap", 0),
        "start_sync_total": total_by_role.get("start_sync_tap", 0),
        "end_sync_matched": by_role.get("end_sync_tap", 0),
        "end_sync_total": total_by_role.get("end_sync_tap", 0),
        "pre_trial_sync_matched": by_role.get("pre_trial_sync_tap", 0),
        "pre_trial_sync_total": total_by_role.get("pre_trial_sync_tap", 0),
    }
    return matches, metrics


def build_candidate_models(
    raw_rows: list[dict[str, str]],
    taps: list[dict],
    times: np.ndarray,
    activity_smooth: np.ndarray,
    peak_times: np.ndarray,
    peak_values: np.ndarray,
    tolerance: float,
    offset_min: float,
    offset_max: float,
) -> list[SyncModel]:
    models: list[SyncModel] = []
    wacom_times = np.array([float(t["wacom_time_sec"]) for t in taps], dtype=float)

    mvc_model = estimate_mvc_offset_model(raw_rows, times, activity_smooth, offset_min, offset_max)
    if mvc_model is not None:
        models.append(mvc_model)

    anchor = estimate_from_start_end_triplets(taps, peak_times, peak_values, tolerance)
    if anchor is not None:
        slope, intercept, anchor_meta = anchor
        if offset_min <= intercept <= offset_max:
            models.append(SyncModel("start_end_triplets", slope, intercept, "start_end_taps", anchor_meta))

    if len(wacom_times) and len(peak_times):
        try:
            offset = estimate_initial_offset(wacom_times, peak_times, peak_values, tolerance, offset_min, offset_max)
            models.append(SyncModel("tap_offset_search", 1.0, offset, "all_sync_taps", {}))
        except ValueError:
            pass

    # Add small refinements around MVC and tap candidates using visible taps,
    # but only accept them as candidates. The final selector can reject them if
    # they hurt MVC/anchor consistency.
    refined: list[SyncModel] = []
    for model in models:
        matches, tap_metrics = evaluate_tap_alignment(taps, peak_times, peak_values, model.slope, model.intercept, tolerance)
        if tap_metrics["matched_taps"] >= 12:
            slope2, intercept2, _ = robust_fit(matches, model.slope, model.intercept)
            if offset_min <= intercept2 <= offset_max:
                refined.append(SyncModel(model.name + "_tap_refined", slope2, intercept2, model.source + "+tap_refine", {}))
    models.extend(refined)

    # Deduplicate near-identical models.
    unique: list[SyncModel] = []
    seen: set[tuple[int, int]] = set()
    for model in models:
        key = (round(model.slope * 1_000_000), round(model.intercept * 1000))
        if key not in seen:
            seen.add(key)
            unique.append(model)
    return unique


def score_candidate_model(
    model: SyncModel,
    raw_rows: list[dict[str, str]],
    taps: list[dict],
    times: np.ndarray,
    activity_smooth: np.ndarray,
    peak_times: np.ndarray,
    peak_values: np.ndarray,
    tolerance: float,
) -> tuple[dict, list[dict]]:
    matches, tap_metrics = evaluate_tap_alignment(taps, peak_times, peak_values, model.slope, model.intercept, tolerance)
    mvc_metrics = evaluate_mvc_alignment(raw_rows, times, activity_smooth, model.slope, model.intercept)
    start_ratio = tap_metrics["start_sync_matched"] / max(1, tap_metrics["start_sync_total"])
    end_ratio = tap_metrics["end_sync_matched"] / max(1, tap_metrics["end_sync_total"])
    pre_ratio = tap_metrics["pre_trial_sync_matched"] / max(1, tap_metrics["pre_trial_sync_total"])
    tap_ratio = tap_metrics["matched_taps"] / max(1, tap_metrics["total_wacom_sync_taps"])
    residual_penalty = 0.0
    if math.isfinite(tap_metrics["residual_rms_ms"]):
        residual_penalty = min(1.0, tap_metrics["residual_rms_ms"] / 350.0)
    mvc_complete = mvc_metrics.get("mvc_windows_in_recording", 0) / max(1, mvc_metrics.get("mvc_total_windows", 1))
    combined = (
        0.40 * min(3.0, mvc_metrics["mvc_score"]) / 3.0
        + 0.20 * mvc_complete
        + 0.20 * ((start_ratio + end_ratio) / 2.0)
        + 0.15 * pre_ratio
        + 0.05 * tap_ratio
        - 0.08 * residual_penalty
    )
    if tap_metrics["matched_taps"] == 0:
        combined -= 0.05
    # Prefer plausible clock drift. Browser and PicoLog should not diverge much
    # over this recording.
    if not (0.995 <= model.slope <= 1.005):
        combined -= 0.25
    row = {
        "candidate_name": model.name,
        "candidate_source": model.source,
        "slope": model.slope,
        "intercept_sec": model.intercept,
        "combined_score": combined,
        **tap_metrics,
        **mvc_metrics,
    }
    return row, matches


def match_taps(
    taps: list[dict],
    peak_times: np.ndarray,
    peak_values: np.ndarray,
    slope: float,
    intercept: float,
    tolerance: float,
) -> list[dict]:
    matches: list[dict] = []
    used: set[int] = set()
    for tap_no, tap in enumerate(taps, start=1):
        wt = float(tap["wacom_time_sec"])
        pred = slope * wt + intercept
        pos = int(np.searchsorted(peak_times, pred))
        candidates = []
        for j in range(max(0, pos - 3), min(len(peak_times), pos + 4)):
            if j not in used:
                candidates.append(j)
        best_j = None
        best_abs_err = float("inf")
        for j in candidates:
            err = abs(float(peak_times[j]) - pred)
            if err < best_abs_err:
                best_abs_err = err
                best_j = j
        matched = best_j is not None and best_abs_err <= tolerance
        if matched:
            used.add(best_j)
            emg_time = float(peak_times[best_j])
            residual = emg_time - pred
            peak_value = float(peak_values[best_j])
        else:
            emg_time = math.nan
            residual = math.nan
            peak_value = math.nan
        row = dict(tap)
        row.update(
            {
                "tap_sequence": tap_no,
                "predicted_emg_time_sec": pred,
                "matched_emg_time_sec": emg_time,
                "match_residual_sec": residual,
                "abs_residual_sec": abs(residual) if math.isfinite(residual) else math.nan,
                "matched_emg_activity": peak_value,
                "matched": int(matched),
            }
        )
        matches.append(row)
    return matches


def robust_fit(matches: list[dict], fallback_slope: float, fallback_intercept: float) -> tuple[float, float, list[dict]]:
    usable = [
        m
        for m in matches
        if m["matched"] and math.isfinite(float(m["matched_emg_time_sec"]))
    ]
    if len(usable) < 2:
        return fallback_slope, fallback_intercept, matches

    x = np.array([float(m["wacom_time_sec"]) for m in usable])
    y = np.array([float(m["matched_emg_time_sec"]) for m in usable])
    slope, intercept = np.polyfit(x, y, 1)
    residual = y - (slope * x + intercept)
    med = float(np.median(residual))
    mad = float(np.median(np.abs(residual - med)))
    cutoff = max(0.150, 4.0 * 1.4826 * mad)
    keep = np.abs(residual - med) <= cutoff
    if keep.sum() >= 2 and keep.sum() < len(keep):
        slope, intercept = np.polyfit(x[keep], y[keep], 1)
    return float(slope), float(intercept), matches


def group_taps(taps: list[dict], sync_role: str) -> list[dict]:
    return [t for t in taps if t.get("sync_role") == sync_role]


def find_triplet_candidates(
    peak_times: np.ndarray,
    peak_values: np.ndarray,
    target_intervals: tuple[float, float],
    tolerance: float,
) -> list[dict]:
    """Find EMG peak triplets whose two intervals match a Wacom 3-tap group."""
    if len(peak_times) < 3:
        return []
    candidates: list[dict] = []
    d1, d2 = target_intervals
    for i, t0 in enumerate(peak_times):
        target1 = t0 + d1
        pos1 = int(np.searchsorted(peak_times, target1))
        js = range(max(i + 1, pos1 - 2), min(len(peak_times), pos1 + 3))
        for j in js:
            err1 = abs(float(peak_times[j] - peak_times[i]) - d1)
            if err1 > tolerance:
                continue
            target2 = float(peak_times[j]) + d2
            pos2 = int(np.searchsorted(peak_times, target2))
            ks = range(max(j + 1, pos2 - 2), min(len(peak_times), pos2 + 3))
            for k in ks:
                err2 = abs(float(peak_times[k] - peak_times[j]) - d2)
                if err2 > tolerance:
                    continue
                vals = [float(peak_values[i]), float(peak_values[j]), float(peak_values[k])]
                candidates.append(
                    {
                        "idx": (i, j, k),
                        "times": np.array([peak_times[i], peak_times[j], peak_times[k]], dtype=float),
                        "activity_sum": float(sum(vals)),
                        "interval_error": float(err1 + err2),
                    }
                )
    candidates.sort(key=lambda c: (-c["activity_sum"], c["interval_error"]))
    return candidates[:200]


def estimate_from_start_end_triplets(
    taps: list[dict],
    peak_times: np.ndarray,
    peak_values: np.ndarray,
    tolerance: float,
) -> tuple[float, float, dict] | None:
    start = group_taps(taps, "start_sync_tap")
    end = group_taps(taps, "end_sync_tap")
    if len(start) < 3 or len(end) < 3:
        return None

    start_w = np.array([float(t["wacom_time_sec"]) for t in start[:3]], dtype=float)
    end_w = np.array([float(t["wacom_time_sec"]) for t in end[-3:]], dtype=float)
    start_intervals = (float(start_w[1] - start_w[0]), float(start_w[2] - start_w[1]))
    end_intervals = (float(end_w[1] - end_w[0]), float(end_w[2] - end_w[1]))

    start_candidates = find_triplet_candidates(peak_times, peak_values, start_intervals, tolerance)
    end_candidates = find_triplet_candidates(peak_times, peak_values, end_intervals, tolerance)
    if not start_candidates or not end_candidates:
        return None

    w_anchor = np.concatenate([start_w, end_w])
    best = None
    for sc in start_candidates:
        for ec in end_candidates:
            if float(ec["times"][0]) <= float(sc["times"][-1]):
                continue
            e_anchor = np.concatenate([sc["times"], ec["times"]])
            slope, intercept = np.polyfit(w_anchor, e_anchor, 1)
            if not (0.990 <= slope <= 1.010):
                continue
            residual = e_anchor - (slope * w_anchor + intercept)
            rms = float(np.sqrt(np.mean(residual**2)))
            max_abs = float(np.max(np.abs(residual)))
            if max_abs > max(0.500, tolerance * 1.5):
                continue
            span_error = abs((float(ec["times"].mean()) - float(sc["times"].mean())) - (float(end_w.mean()) - float(start_w.mean())))
            score = (
                -rms,
                -span_error,
                sc["activity_sum"] + ec["activity_sum"],
                -sc["interval_error"] - ec["interval_error"],
            )
            if best is None or score > best[0]:
                best = (
                    score,
                    float(slope),
                    float(intercept),
                    {
                        "anchor_rms_sec": rms,
                        "anchor_max_abs_sec": max_abs,
                        "start_emg_times": sc["times"].tolist(),
                        "end_emg_times": ec["times"].tolist(),
                    },
                )
    if best is None:
        return None
    return best[1], best[2], best[3]


def transform_time(value_ms: str, slope: float, intercept: float) -> float:
    value = to_float(value_ms)
    if not math.isfinite(value):
        return math.nan
    return slope * (value / 1000.0) + intercept


def build_trial_windows(
    session: SessionFiles,
    summary_rows: list[dict[str, str]],
    settings: dict,
    slope: float,
    intercept: float,
) -> list[dict]:
    out: list[dict] = []
    mvc_direction = MVC_BY_SESSION.get(session.name, "")
    for row in summary_rows:
        if row.get("success_flag") != "1":
            continue
        touch = transform_time(row.get("touch_start_time_ms", ""), slope, intercept)
        movement_onset = transform_time(row.get("movement_onset_time_ms", ""), slope, intercept)
        goal_arrival = transform_time(row.get("goal_arrival_time_ms", ""), slope, intercept)
        movement_offset = transform_time(row.get("movement_offset_time_ms", ""), slope, intercept)
        up = transform_time(row.get("last_pointerup_time_ms", ""), slope, intercept)
        pre_start = touch - PRE_SEC if math.isfinite(touch) else math.nan
        post_end = up + POST_SEC if math.isfinite(up) else math.nan
        movement_pre_start = movement_onset - PRE_SEC if math.isfinite(movement_onset) else math.nan
        movement_post_end = movement_offset + POST_SEC if math.isfinite(movement_offset) else math.nan
        out.append(
            {
                "session_dir": session.name,
                "session_id": settings.get("session_id", ""),
                "participant_id": settings.get("participant_id", ""),
                "emg_csv": str(session.emg_csv),
                "summary_csv": str(session.summary_csv),
                "mvc_direction_for_percent_mvc": mvc_direction,
                "trial_global_index": row.get("trial_global_index", ""),
                "block_index": row.get("block_index", ""),
                "trial_index": row.get("trial_index", ""),
                "repetition_index": row.get("repetition_index", ""),
                "target_angle_deg": row.get("target_angle_deg", ""),
                "actual_angle_deg": row.get("actual_angle_deg", ""),
                "angle_error_deg": row.get("angle_error_deg", ""),
                "actual_duration_ms": row.get("actual_duration_ms", ""),
                "wacom_touch_start_ms": row.get("touch_start_time_ms", ""),
                "wacom_movement_onset_ms": row.get("movement_onset_time_ms", ""),
                "wacom_goal_arrival_ms": row.get("goal_arrival_time_ms", ""),
                "wacom_movement_offset_ms": row.get("movement_offset_time_ms", ""),
                "wacom_last_pointerup_ms": row.get("last_pointerup_time_ms", ""),
                "emg_pre_start_sec": pre_start,
                "emg_touch_start_sec": touch,
                "emg_movement_onset_sec": movement_onset,
                "emg_goal_arrival_sec": goal_arrival,
                "emg_movement_offset_sec": movement_offset,
                "emg_last_pointerup_sec": up,
                "emg_post_end_sec": post_end,
                "emg_move_start_sec": movement_onset if math.isfinite(movement_onset) else touch,
                "emg_move_end_sec": movement_offset if math.isfinite(movement_offset) else up,
                "emg_window_start_sec": pre_start,
                "emg_window_end_sec": post_end,
                "emg_touch_window_start_sec": pre_start,
                "emg_touch_window_end_sec": post_end,
                "emg_movement_window_start_sec": movement_pre_start,
                "emg_movement_window_end_sec": movement_post_end,
                "movement_offset_method": row.get("movement_offset_method", ""),
                "kinematic_duration_ms": row.get("kinematic_duration_ms", ""),
                "start_delay_ms": row.get("start_delay_ms", ""),
                "dwell_after_movement_ms": row.get("dwell_after_movement_ms", ""),
                "estimated_pointer_rate_hz": row.get("estimated_pointer_rate_hz", ""),
                "median_pointer_interval_ms": row.get("median_pointer_interval_ms", ""),
                "p95_pointer_interval_ms": row.get("p95_pointer_interval_ms", ""),
                "max_pointer_interval_ms": row.get("max_pointer_interval_ms", ""),
                "median_event_processing_delay_ms": row.get("median_event_processing_delay_ms", ""),
                "p95_event_processing_delay_ms": row.get("p95_event_processing_delay_ms", ""),
                "coalesced_event_ratio": row.get("coalesced_event_ratio", ""),
                "sync_slope": slope,
                "sync_intercept_sec": intercept,
            }
        )
    return out


def build_mvc_windows(
    session: SessionFiles,
    raw_rows: list[dict[str, str]],
    settings: dict,
    slope: float,
    intercept: float,
    emg_start_sec: float,
    emg_end_sec: float,
) -> list[dict]:
    starts: dict[str, dict] = {}
    rows: list[dict] = []
    for row in raw_rows:
        if row.get("phase") != "mvc":
            continue
        direction = row.get("mvc_direction", "")
        event = row.get("event_type", "")
        if event == "mvc_start":
            starts[direction] = row
        elif event == "mvc_end" and direction in starts:
            start_row = starts.pop(direction)
            start_emg = transform_time(start_row.get("timestamp_ms", ""), slope, intercept)
            end_emg = transform_time(row.get("timestamp_ms", ""), slope, intercept)
            in_emg = (
                math.isfinite(start_emg)
                and math.isfinite(end_emg)
                and start_emg >= emg_start_sec
                and end_emg <= emg_end_sec
            )
            direction_matches = direction == MVC_BY_SESSION.get(session.name, "")
            rows.append(
                {
                    "session_dir": session.name,
                    "session_id": settings.get("session_id", ""),
                    "participant_id": settings.get("participant_id", ""),
                    "emg_csv": str(session.emg_csv),
                    "mvc_direction": direction,
                    "direction_matches_percent_mvc_rule": int(direction_matches),
                    "mvc_window_in_emg_recording": int(in_emg),
                    "usable_for_percent_mvc": int(direction_matches and in_emg),
                    "wacom_mvc_start_ms": start_row.get("timestamp_ms", ""),
                    "wacom_mvc_end_ms": row.get("timestamp_ms", ""),
                    "emg_mvc_start_sec": start_emg,
                    "emg_mvc_end_sec": end_emg,
                    "emg_recording_start_sec": emg_start_sec,
                    "emg_recording_end_sec": emg_end_sec,
                    "sync_slope": slope,
                    "sync_intercept_sec": intercept,
                }
            )
    return rows


def build_baseline_windows(
    session: SessionFiles,
    raw_rows: list[dict[str, str]],
    settings: dict,
    slope: float,
    intercept: float,
    emg_start_sec: float,
    emg_end_sec: float,
) -> list[dict]:
    """Convert the saved Wacom baseline analysis intervals to EMG time."""
    intervals = settings.get("recorded_baseline_intervals", [])
    if not isinstance(intervals, list):
        intervals = []

    # raw CSV markers are a fallback for data whose settings JSON was separated
    # from the matching recording.
    if not intervals:
        grouped: dict[tuple[str, str], dict[str, dict[str, str]]] = {}
        for row in raw_rows:
            if row.get("phase") != "baseline":
                continue
            event = row.get("event_type", "")
            key = (row.get("baseline_id", ""), row.get("baseline_type", ""))
            markers = grouped.setdefault(key, {})
            if event in {"baseline_analysis_start", "baseline_analysis_end"}:
                markers[event] = row
            elif row.get("baseline_stage") == "start_boundary" and event == "pointerup":
                markers["start_boundary"] = row
            elif row.get("baseline_stage") == "end_boundary" and event == "pointerdown":
                markers["end_boundary"] = row
        for (baseline_id, baseline_type), markers in grouped.items():
            start = markers.get("baseline_analysis_start")
            end = markers.get("baseline_analysis_end")
            if not start or not end:
                continue
            intervals.append(
                {
                    "baseline_id": baseline_id,
                    "baseline_type": baseline_type,
                    "analysis_start_time_ms": start.get("timestamp_ms", ""),
                    "analysis_start_epoch_ms": start.get("epoch_ms", ""),
                    "analysis_end_time_ms": end.get("timestamp_ms", ""),
                    "analysis_end_epoch_ms": end.get("epoch_ms", ""),
                    "start_tap_pointerup_time_ms": markers.get("start_boundary", {}).get("timestamp_ms", ""),
                    "end_tap_pointerdown_time_ms": markers.get("end_boundary", {}).get("timestamp_ms", ""),
                    "target_duration_ms": start.get("baseline_target_duration_ms", ""),
                    "guard_ms": start.get("baseline_guard_ms", ""),
                    "unexpected_contact_count": end.get("baseline_unexpected_contact_count", ""),
                    "valid": end.get("baseline_valid", "") == "1",
                }
            )

    rows: list[dict] = []
    for interval in intervals:
        start_ms = to_float(interval.get("analysis_start_time_ms"))
        end_ms = to_float(interval.get("analysis_end_time_ms"))
        start_boundary_ms = to_float(interval.get("start_tap_pointerup_time_ms"))
        end_boundary_ms = to_float(interval.get("end_tap_pointerdown_time_ms"))
        recorded_duration_ms = interval.get("recorded_duration_ms", "")
        if recorded_duration_ms == "" and math.isfinite(start_boundary_ms) and math.isfinite(end_boundary_ms):
            recorded_duration_ms = end_boundary_ms - start_boundary_ms
        start_boundary_emg = transform_time(interval.get("start_tap_pointerup_time_ms", ""), slope, intercept)
        end_boundary_emg = transform_time(interval.get("end_tap_pointerdown_time_ms", ""), slope, intercept)
        start_emg = transform_time(interval.get("analysis_start_time_ms", ""), slope, intercept)
        end_emg = transform_time(interval.get("analysis_end_time_ms", ""), slope, intercept)
        in_emg = (
            math.isfinite(start_emg)
            and math.isfinite(end_emg)
            and start_emg >= emg_start_sec
            and end_emg <= emg_end_sec
            and end_emg > start_emg
        )
        valid_value = interval.get("valid", False)
        valid = valid_value is True or str(valid_value).lower() in {"1", "true", "yes"}
        duration_sec = (end_ms - start_ms) / 1000.0 if math.isfinite(start_ms) and math.isfinite(end_ms) else math.nan
        rows.append(
            {
                "session_dir": session.name,
                "session_id": settings.get("session_id", ""),
                "participant_id": settings.get("participant_id", ""),
                "emg_csv": str(session.emg_csv),
                "baseline_id": interval.get("baseline_id", ""),
                "baseline_type": interval.get("baseline_type", ""),
                "baseline_label": interval.get("baseline_label", ""),
                "baseline_valid": int(valid),
                "unexpected_contact_count": interval.get("unexpected_contact_count", ""),
                "target_duration_ms": interval.get("target_duration_ms", ""),
                "guard_ms": interval.get("guard_ms", ""),
                "recorded_duration_ms": recorded_duration_ms,
                "wacom_start_tap_pointerup_ms": interval.get("start_tap_pointerup_time_ms", ""),
                "wacom_end_tap_pointerdown_ms": interval.get("end_tap_pointerdown_time_ms", ""),
                "emg_start_tap_pointerup_sec": start_boundary_emg,
                "emg_end_tap_pointerdown_sec": end_boundary_emg,
                "wacom_analysis_start_ms": interval.get("analysis_start_time_ms", ""),
                "wacom_analysis_end_ms": interval.get("analysis_end_time_ms", ""),
                "wacom_analysis_start_epoch_ms": interval.get("analysis_start_epoch_ms", ""),
                "wacom_analysis_end_epoch_ms": interval.get("analysis_end_epoch_ms", ""),
                "emg_analysis_start_sec": start_emg,
                "emg_analysis_end_sec": end_emg,
                "analysis_duration_sec": duration_sec,
                "baseline_window_in_emg_recording": int(in_emg),
                "usable_baseline_window": int(valid and in_emg),
                "emg_recording_start_sec": emg_start_sec,
                "emg_recording_end_sec": emg_end_sec,
                "sync_slope": slope,
                "sync_intercept_sec": intercept,
            }
        )
    return rows


def make_diagnostic_plot(
    session: SessionFiles,
    times: np.ndarray,
    activity_smooth: np.ndarray,
    peak_times: np.ndarray,
    peak_values: np.ndarray,
    matches: list[dict],
    mvc_windows: list[dict],
    slope: float,
    intercept: float,
    out_path: Path,
) -> None:
    fig, axes = plt.subplots(3, 1, figsize=(14, 9), constrained_layout=True)
    ds = max(1, len(times) // 8000)
    axes[0].plot(times[::ds], activity_smooth[::ds], color="#444444", lw=0.8, label="EMG sync activity (smoothed)")
    matched_times = np.array([float(m["matched_emg_time_sec"]) for m in matches if m["matched"]], dtype=float)
    predicted = np.array([slope * float(m["wacom_time_sec"]) + intercept for m in matches], dtype=float)
    for t in predicted:
        axes[0].axvline(t, color="#2563eb", alpha=0.18, lw=0.8)
    for t in matched_times:
        axes[0].axvline(t, color="#dc2626", alpha=0.45, lw=0.8)
    mvc_colors = {
        "palmar_flexion": "#f59e0b",
        "dorsiflexion": "#10b981",
        "radial_deviation": "#3b82f6",
        "ulnar_deviation": "#8b5cf6",
    }
    for win in mvc_windows:
        if int(win.get("mvc_window_in_emg_recording", 0)) != 1:
            continue
        s = float(win["emg_mvc_start_sec"])
        e = float(win["emg_mvc_end_sec"])
        color = mvc_colors.get(win["mvc_direction"], "#64748b")
        axes[0].axvspan(s, e, color=color, alpha=0.16)
    axes[0].set_title(f"{session.name}: EMG activity and synchronized tap markers")
    axes[0].set_xlabel("EMG time (sec)")
    axes[0].set_ylabel("activity (V)")
    axes[0].legend(loc="upper right")

    residuals = np.array([float(m["match_residual_sec"]) * 1000 for m in matches if m["matched"]], dtype=float)
    seq = np.array([int(m["tap_sequence"]) for m in matches if m["matched"]], dtype=int)
    axes[1].axhline(0, color="#222222", lw=0.8)
    axes[1].scatter(seq, residuals, s=18, color="#7c3aed")
    axes[1].set_title("Matched tap residuals")
    axes[1].set_xlabel("Wacom sync tap sequence")
    axes[1].set_ylabel("EMG peak - predicted (ms)")

    visible_mvc = [w for w in mvc_windows if int(w.get("mvc_window_in_emg_recording", 0)) == 1]
    if visible_mvc:
        start = min(float(w["emg_mvc_start_sec"]) for w in visible_mvc) - 4.0
        end = max(float(w["emg_mvc_end_sec"]) for w in visible_mvc) + 4.0
        mask = (times >= start) & (times <= end)
        if np.any(mask):
            axes[2].plot(times[mask], activity_smooth[mask], color="#334155", lw=0.9)
        ymax = float(np.nanmax(activity_smooth[mask])) if np.any(mask) else 1.0
        for win in visible_mvc:
            s = float(win["emg_mvc_start_sec"])
            e = float(win["emg_mvc_end_sec"])
            direction = win["mvc_direction"]
            color = mvc_colors.get(direction, "#64748b")
            axes[2].axvspan(s, e, color=color, alpha=0.22, label=direction)
            axes[2].text((s + e) / 2, ymax * 0.92, direction.replace("_", "\n"), ha="center", va="top", fontsize=8)
        axes[2].set_title("Zoomed MVC windows after synchronization")
        axes[2].set_xlabel("EMG time (sec)")
        axes[2].set_ylabel("activity (V)")
        handles, labels = axes[2].get_legend_handles_labels()
        unique = dict(zip(labels, handles))
        axes[2].legend(unique.values(), unique.keys(), loc="upper right", fontsize=8)
    else:
        axes[2].text(0.5, 0.5, "No MVC window inside EMG recording", transform=axes[2].transAxes, ha="center", va="center")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out_path, dpi=160)
    plt.close(fig)


def process_session(session: SessionFiles, output_dir: Path, tolerance: float, min_matches: int, ignore_startup_sec: float) -> tuple[dict, list[dict], list[dict], list[dict], list[dict], list[dict], dict]:
    print(f"[session] {session.name}")
    raw_rows = read_csv_dicts(session.raw_csv)
    summary_rows = read_csv_dicts(session.summary_csv)
    settings = json.loads(session.settings_json.read_text(encoding="utf-8"))
    taps = read_wacom_taps(raw_rows)
    times, activity, emg_meta = read_emg(session.emg_csv)
    peaks, smoothed = detect_emg_peaks(times, activity)
    peak_times = times[peaks]
    peak_values = smoothed[peaks]
    offset_min, offset_max = offset_bounds_from_recording(raw_rows, float(times[0]), float(times[-1]), ignore_startup_sec)

    models = build_candidate_models(
        raw_rows,
        taps,
        times,
        smoothed,
        peak_times,
        peak_values,
        tolerance,
        offset_min,
        offset_max,
    )
    if not models:
        raise ValueError(f"No synchronization candidates could be generated for {session.name}")

    candidate_rows: list[dict] = []
    candidate_matches: dict[str, list[dict]] = {}
    for model in models:
        row, model_matches = score_candidate_model(
            model, raw_rows, taps, times, smoothed, peak_times, peak_values, tolerance
        )
        row["session_dir"] = session.name
        row["session_id"] = settings.get("session_id", "")
        candidate_rows.append(row)
        candidate_matches[model.name] = model_matches

    selected = max(candidate_rows, key=lambda r: r["combined_score"])
    selected_model = next(m for m in models if m.name == selected["candidate_name"])
    slope = float(selected_model.slope)
    intercept = float(selected_model.intercept)
    sync_method = "weighted_evidence:" + selected_model.name
    matches = candidate_matches[selected_model.name]

    anchor_meta = {}
    if selected_model.name.startswith("start_end_triplets"):
        anchor_meta = selected_model.details

    matched = [m for m in matches if m["matched"]]
    rms_ms = selected["residual_rms_ms"]
    max_abs_ms = selected["residual_max_abs_ms"]
    start_end_residuals = np.array(
        [
            float(m["match_residual_sec"])
            for m in matched
            if m.get("sync_role") in {"start_sync_tap", "end_sync_tap"}
        ],
        dtype=float,
    )
    selected_anchor_rms_ms = (
        float(np.sqrt(np.mean(start_end_residuals**2)) * 1000.0)
        if len(start_end_residuals)
        else math.nan
    )
    selected_anchor_max_abs_ms = (
        float(np.max(np.abs(start_end_residuals)) * 1000.0)
        if len(start_end_residuals)
        else math.nan
    )

    if len(matched) < min_matches:
        print(f"  [warn] only {len(matched)} matched taps; inspect diagnostic PNG carefully")
    print(f"  candidates={len(candidate_rows)} selected={selected_model.name} score={selected['combined_score']:.3f}")
    print(f"  taps={len(taps)} peaks={len(peaks)} matched={len(matched)} method={sync_method} slope={slope:.9f} intercept={intercept:.3f}s rms={rms_ms:.1f}ms")

    trial_windows = build_trial_windows(session, summary_rows, settings, slope, intercept)
    mvc_windows = build_mvc_windows(session, raw_rows, settings, slope, intercept, float(times[0]), float(times[-1]))
    baseline_windows = build_baseline_windows(
        session, raw_rows, settings, slope, intercept, float(times[0]), float(times[-1])
    )

    png_path = output_dir / f"{session.name}_sync_diagnostic.png"
    make_diagnostic_plot(session, times, smoothed, peak_times, peak_values, matches, mvc_windows, slope, intercept, png_path)

    mapping = {
        "session_dir": session.name,
        "session_id": settings.get("session_id", ""),
        "participant_id": settings.get("participant_id", ""),
        "raw_csv": str(session.raw_csv),
        "summary_csv": str(session.summary_csv),
        "settings_json": str(session.settings_json),
        "emg_csv": str(session.emg_csv),
        "emg_time_col": emg_meta["time_col"],
        "emg_min_col": emg_meta["min_col"],
        "emg_max_col": emg_meta["max_col"],
        "emg_recording_start_sec": float(times[0]),
        "emg_recording_end_sec": float(times[-1]),
        "allowed_offset_min_sec": offset_min,
        "allowed_offset_max_sec": offset_max,
        "ignore_startup_sec": ignore_startup_sec,
        "wacom_to_emg_slope": slope,
        "wacom_to_emg_intercept_sec": intercept,
        "sync_method": sync_method,
        "selected_candidate": selected_model.name,
        "selected_candidate_source": selected_model.source,
        "selected_combined_score": selected["combined_score"],
        "anchor_rms_ms": selected_anchor_rms_ms,
        "anchor_max_abs_ms": selected_anchor_max_abs_ms,
        "matched_taps": len(matched),
        "total_wacom_sync_taps": len(taps),
        "detected_emg_peaks": len(peaks),
        "residual_rms_ms": rms_ms,
        "residual_max_abs_ms": max_abs_ms,
        "start_sync_matched": selected["start_sync_matched"],
        "start_sync_total": selected["start_sync_total"],
        "end_sync_matched": selected["end_sync_matched"],
        "end_sync_total": selected["end_sync_total"],
        "pre_trial_sync_matched": selected["pre_trial_sync_matched"],
        "pre_trial_sync_total": selected["pre_trial_sync_total"],
        "mvc_score": selected["mvc_score"],
        "mvc_windows_in_recording": selected["mvc_windows_in_recording"],
        "mvc_total_windows": selected["mvc_total_windows"],
        "diagnostic_png": str(png_path),
    }
    for m in matches:
        m["session_dir"] = session.name
        m["session_id"] = settings.get("session_id", "")

    quality = {
        "session_dir": session.name,
        "session_id": settings.get("session_id", ""),
        "selected_candidate": selected_model.name,
        "selected_method": sync_method,
        "slope": slope,
        "intercept_sec": intercept,
        "offset_bounds_sec": [offset_min, offset_max],
        "ignore_startup_sec": ignore_startup_sec,
        "candidate_count": len(candidate_rows),
        "selected_metrics": {k: selected[k] for k in selected if k not in {"session_dir", "session_id"}},
        "candidates": [{k: row[k] for k in row if k not in {"session_dir", "session_id"}} for row in candidate_rows],
    }
    return mapping, matches, trial_windows, mvc_windows, baseline_windows, candidate_rows, quality


def main() -> None:
    args = parse_args()
    root = args.root.resolve()
    output = args.output.resolve()
    os.environ.setdefault("MPLCONFIGDIR", str(output / "matplotlib_cache"))
    output.mkdir(parents=True, exist_ok=True)

    sessions = discover_sessions(root)
    if not sessions:
        raise SystemExit(f"No sessions found under {root}")

    mappings: list[dict] = []
    all_matches: list[dict] = []
    all_trial_windows: list[dict] = []
    all_mvc_windows: list[dict] = []
    all_baseline_windows: list[dict] = []
    all_candidate_rows: list[dict] = []
    quality_reports: list[dict] = []
    for session in sessions:
        mapping, matches, trial_windows, mvc_windows, baseline_windows, candidate_rows, quality = process_session(
            session, output, args.match_tolerance_sec, args.min_matches, args.ignore_startup_sec
        )
        mappings.append(mapping)
        all_matches.extend(matches)
        all_trial_windows.extend(trial_windows)
        all_mvc_windows.extend(mvc_windows)
        all_baseline_windows.extend(baseline_windows)
        all_candidate_rows.extend(candidate_rows)
        quality_reports.append(quality)

    write_csv(
        output / "tablet_emg_sync_mapping.csv",
        mappings,
        [
            "session_dir",
            "session_id",
            "participant_id",
            "raw_csv",
            "summary_csv",
            "settings_json",
            "emg_csv",
            "emg_time_col",
            "emg_min_col",
            "emg_max_col",
            "emg_recording_start_sec",
            "emg_recording_end_sec",
            "allowed_offset_min_sec",
            "allowed_offset_max_sec",
            "ignore_startup_sec",
            "wacom_to_emg_slope",
            "wacom_to_emg_intercept_sec",
            "sync_method",
            "selected_candidate",
            "selected_candidate_source",
            "selected_combined_score",
            "anchor_rms_ms",
            "anchor_max_abs_ms",
            "matched_taps",
            "total_wacom_sync_taps",
            "detected_emg_peaks",
            "residual_rms_ms",
            "residual_max_abs_ms",
            "start_sync_matched",
            "start_sync_total",
            "end_sync_matched",
            "end_sync_total",
            "pre_trial_sync_matched",
            "pre_trial_sync_total",
            "mvc_score",
            "mvc_windows_in_recording",
            "mvc_total_windows",
            "diagnostic_png",
        ],
    )
    write_csv(
        output / "sync_candidate_models.csv",
        all_candidate_rows,
        [
            "session_dir",
            "session_id",
            "candidate_name",
            "candidate_source",
            "slope",
            "intercept_sec",
            "combined_score",
            "matched_taps",
            "total_wacom_sync_taps",
            "residual_rms_ms",
            "residual_max_abs_ms",
            "start_sync_matched",
            "start_sync_total",
            "end_sync_matched",
            "end_sync_total",
            "pre_trial_sync_matched",
            "pre_trial_sync_total",
            "mvc_score",
            "mvc_mean_activity",
            "mvc_contrast",
            "mvc_windows_in_recording",
            "mvc_total_windows",
        ],
    )
    write_csv(
        output / "tablet_emg_sync_tap_matches.csv",
        all_matches,
        [
            "session_dir",
            "session_id",
            "tap_sequence",
            "raw_line",
            "phase",
            "sync_role",
            "trial_global_index",
            "tap_index",
            "wacom_timestamp_ms",
            "wacom_time_sec",
            "wacom_pressure",
            "wacom_x_mm",
            "wacom_y_mm",
            "predicted_emg_time_sec",
            "matched_emg_time_sec",
            "match_residual_sec",
            "abs_residual_sec",
            "matched_emg_activity",
            "matched",
        ],
    )
    write_csv(
        output / "synced_trial_windows.csv",
        all_trial_windows,
        [
            "session_dir",
            "session_id",
            "participant_id",
            "emg_csv",
            "summary_csv",
            "mvc_direction_for_percent_mvc",
            "trial_global_index",
            "block_index",
            "trial_index",
            "repetition_index",
            "target_angle_deg",
            "actual_angle_deg",
            "angle_error_deg",
            "actual_duration_ms",
            "wacom_touch_start_ms",
            "wacom_movement_onset_ms",
            "wacom_goal_arrival_ms",
            "wacom_movement_offset_ms",
            "wacom_last_pointerup_ms",
            "emg_pre_start_sec",
            "emg_touch_start_sec",
            "emg_movement_onset_sec",
            "emg_goal_arrival_sec",
            "emg_movement_offset_sec",
            "emg_last_pointerup_sec",
            "emg_post_end_sec",
            "emg_move_start_sec",
            "emg_move_end_sec",
            "emg_window_start_sec",
            "emg_window_end_sec",
            "emg_touch_window_start_sec",
            "emg_touch_window_end_sec",
            "emg_movement_window_start_sec",
            "emg_movement_window_end_sec",
            "movement_offset_method",
            "kinematic_duration_ms",
            "start_delay_ms",
            "dwell_after_movement_ms",
            "estimated_pointer_rate_hz",
            "median_pointer_interval_ms",
            "p95_pointer_interval_ms",
            "max_pointer_interval_ms",
            "median_event_processing_delay_ms",
            "p95_event_processing_delay_ms",
            "coalesced_event_ratio",
            "sync_slope",
            "sync_intercept_sec",
        ],
    )
    write_csv(
        output / "synced_mvc_windows.csv",
        all_mvc_windows,
        [
            "session_dir",
            "session_id",
            "participant_id",
            "emg_csv",
            "mvc_direction",
            "direction_matches_percent_mvc_rule",
            "mvc_window_in_emg_recording",
            "usable_for_percent_mvc",
            "wacom_mvc_start_ms",
            "wacom_mvc_end_ms",
            "emg_mvc_start_sec",
            "emg_mvc_end_sec",
            "emg_recording_start_sec",
            "emg_recording_end_sec",
            "sync_slope",
            "sync_intercept_sec",
        ],
    )
    write_csv(
        output / "synced_baseline_windows.csv",
        all_baseline_windows,
        [
            "session_dir",
            "session_id",
            "participant_id",
            "emg_csv",
            "baseline_id",
            "baseline_type",
            "baseline_label",
            "baseline_valid",
            "unexpected_contact_count",
            "target_duration_ms",
            "guard_ms",
            "recorded_duration_ms",
            "wacom_start_tap_pointerup_ms",
            "wacom_end_tap_pointerdown_ms",
            "emg_start_tap_pointerup_sec",
            "emg_end_tap_pointerdown_sec",
            "wacom_analysis_start_ms",
            "wacom_analysis_end_ms",
            "wacom_analysis_start_epoch_ms",
            "wacom_analysis_end_epoch_ms",
            "emg_analysis_start_sec",
            "emg_analysis_end_sec",
            "analysis_duration_sec",
            "baseline_window_in_emg_recording",
            "usable_baseline_window",
            "emg_recording_start_sec",
            "emg_recording_end_sec",
            "sync_slope",
            "sync_intercept_sec",
        ],
    )
    quality_path = output / "sync_quality_report.json"
    quality_path.write_text(
        json.dumps(json_safe({"sessions": quality_reports}), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print("[done]")
    print(f"  {output / 'tablet_emg_sync_mapping.csv'}")
    print(f"  {output / 'sync_candidate_models.csv'}")
    print(f"  {quality_path}")
    print(f"  {output / 'tablet_emg_sync_tap_matches.csv'}")
    print(f"  {output / 'synced_trial_windows.csv'}")
    print(f"  {output / 'synced_mvc_windows.csv'}")
    print(f"  {output / 'synced_baseline_windows.csv'}")


if __name__ == "__main__":
    main()
