#!/usr/bin/env node
"use strict";

const fs = require("fs/promises");
const path = require("path");

const MUSCLES = ["muscle1", "muscle2", "muscle3", "muscle4"];
const COLORS = ["#4f7cff", "#38b2ac", "#f59e0b", "#ef4444"];

function parseArgs(argv) {
  const args = {
    input: "./test",
    output: "./analysis_output",
    offset: 0,
    autoOffset: false
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--input" && argv[i + 1]) {
      args.input = argv[i + 1];
      i += 1;
    } else if (a === "--output" && argv[i + 1]) {
      args.output = argv[i + 1];
      i += 1;
    } else if (a === "--offset" && argv[i + 1]) {
      args.offset = Number(argv[i + 1]);
      i += 1;
    } else if (a === "--auto-offset") {
      args.autoOffset = true;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  if (!Number.isFinite(args.offset)) args.offset = 0;
  return args;
}

function printHelp() {
  console.log(
    [
      "使い方:",
      '  node "export_analysis_cli.js" --input "./test" --output "./analysis_output" [--offset 0] [--auto-offset]',
      "",
      "オプション:",
      "  --input       入力フォルダ（再帰的にCSV探索）",
      "  --output      出力フォルダ",
      "  --offset      EMG時刻オフセット[秒]（既定0）",
      "  --auto-offset 同期タップからオフセット自動推定（先頭セッション基準）"
    ].join("\n")
  );
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuote = !inQuote;
      }
    } else if (ch === "," && !inQuote) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map((h) => h.trim().replace(/^"|"$/g, ""));
  return lines.slice(1).map((line) => {
    const cols = parseCsvLine(line);
    const row = {};
    headers.forEach((h, i) => {
      row[h] = (cols[i] ?? "").trim().replace(/^"|"$/g, "");
    });
    return row;
  });
}

function toNumber(v, fallback = NaN) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function mean(arr) {
  if (!arr.length) return NaN;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function percentile(arr, p) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function movingAverage(arr, win) {
  const out = new Array(arr.length).fill(0);
  const w = Math.max(1, Math.floor(win));
  let sum = 0;
  for (let i = 0; i < arr.length; i += 1) {
    sum += arr[i];
    if (i >= w) sum -= arr[i - w];
    out[i] = sum / Math.min(i + 1, w);
  }
  return out;
}

function rollingRms(arr, win) {
  const out = new Array(arr.length).fill(0);
  const w = Math.max(1, Math.floor(win));
  let sq = 0;
  for (let i = 0; i < arr.length; i += 1) {
    sq += arr[i] * arr[i];
    if (i >= w) sq -= arr[i - w] * arr[i - w];
    out[i] = Math.sqrt(sq / Math.min(i + 1, w));
  }
  return out;
}

function hhmmssToSec(s) {
  const p = String(s).split(":").map((x) => Number(x));
  if (p.length !== 3 || p.some((x) => Number.isNaN(x))) return NaN;
  return p[0] * 3600 + p[1] * 60 + p[2];
}

function inferParticipantId(name) {
  const base = path.basename(name);
  const m = base.match(/([A-Za-z]+[0-9]+)/);
  return m ? m[1] : base.replace(/\.[^.]+$/, "");
}

async function listCsvFilesRecursively(rootDir) {
  const out = [];
  async function walk(dir) {
    const ents = await fs.readdir(dir, { withFileTypes: true });
    for (const ent of ents) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith(".csv")) {
        out.push(full);
      }
    }
  }
  await walk(rootDir);
  return out;
}

async function readCsvFile(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  const rows = parseCsv(text);
  return { filePath, rows };
}

function detectFileRole(rec) {
  const lower = rec.filePath.toLowerCase();
  if (lower.includes("wacom_summary")) return "summary";
  if (lower.includes("wacom_raw")) return "raw";
  if (rec.rows[0] && Object.keys(rec.rows[0]).some((k) => k.includes("チャンネル 1"))) return "emg";
  return "unknown";
}

function getMvcIntervals(rawRows, offsetSec) {
  const events = rawRows
    .filter((r) => r.phase === "mvc" && (r.event_type === "mvc_start" || r.event_type === "mvc_end"))
    .map((r) => ({ type: r.event_type, t: toNumber(r.timestamp_ms, NaN) / 1000 + offsetSec }))
    .filter((e) => Number.isFinite(e.t))
    .sort((a, b) => a.t - b.t);
  const intervals = [];
  let s = null;
  for (const e of events) {
    if (e.type === "mvc_start") s = e.t;
    else if (e.type === "mvc_end" && s != null && e.t > s) {
      intervals.push([s, e.t]);
      s = null;
    }
  }
  return intervals;
}

function preprocessEmg(emgRows, rawRows, offsetSec) {
  const times = [];
  const avg = [[], [], [], []];
  const max = [[], [], [], []];
  for (const r of emgRows) {
    const t = hhmmssToSec(r[""]);
    if (!Number.isFinite(t)) continue;
    times.push(t);
    for (let i = 1; i <= 4; i += 1) {
      avg[i - 1].push(toNumber(r[`チャンネル ${i} 平均 (V)`], NaN));
      max[i - 1].push(toNumber(r[`チャンネル ${i} 最大 (V)`], NaN));
    }
  }

  const mvcIntervals = getMvcIntervals(rawRows, offsetSec);
  const channels = [];
  for (let ch = 0; ch < 4; ch += 1) {
    const signal = max[ch].map((m, i) => m - avg[ch][i]);
    const p01 = percentile(signal, 0.01);
    const p99 = percentile(signal, 0.99);
    const winsor = signal.map((x) => clamp(x, p01, p99));
    const trend = movingAverage(winsor, 15);
    const high = winsor.map((x, i) => x - trend[i]);
    const rect = high.map((x) => Math.abs(x));
    const smooth = movingAverage(rect, 3);
    const rms = rollingRms(smooth, 5);

    let mvcRef = -Infinity;
    for (const [s, e] of mvcIntervals) {
      let localMax = -Infinity;
      for (let i = 0; i < times.length; i += 1) {
        if (times[i] >= s && times[i] <= e) localMax = Math.max(localMax, rms[i]);
      }
      mvcRef = Math.max(mvcRef, localMax);
    }
    if (!Number.isFinite(mvcRef) || mvcRef <= 0) mvcRef = percentile(rms, 0.95);
    if (!Number.isFinite(mvcRef) || mvcRef <= 0) mvcRef = 1e-6;

    const percentMvc = rms.map((x) => clamp((x / mvcRef) * 100, 0, 400));
    channels.push({ rms, percentMvc, mvcRef });
  }
  return { times, channels };
}

function nearestIndex(times, tSec) {
  const idx = Math.round(tSec);
  return clamp(idx, 0, times.length - 1);
}

function getTapTimes(rawRows) {
  return rawRows
    .filter((r) => r.sync_role && r.sync_role.includes("sync_tap") && r.event_type === "pointerdown")
    .map((r) => toNumber(r.timestamp_ms, NaN) / 1000)
    .filter((x) => Number.isFinite(x));
}

function combinedActivityAt(processed, tSec) {
  const idx = nearestIndex(processed.times, tSec);
  let s = 0;
  for (let i = 0; i < 4; i += 1) s += processed.channels[i].percentMvc[idx];
  return s / 4;
}

function estimateOffset(emgRows, rawRows) {
  const base = preprocessEmg(emgRows, rawRows, 0);
  const taps = getTapTimes(rawRows);
  if (taps.length < 5) return 0;
  let bestOffset = 0;
  let bestScore = -Infinity;
  for (let off = -30; off <= 30; off += 0.5) {
    let sum = 0;
    let n = 0;
    for (const t of taps) {
      const q = t + off;
      if (q >= 0 && q <= base.times[base.times.length - 1]) {
        sum += combinedActivityAt(base, q);
        n += 1;
      }
    }
    if (n > 0) {
      const score = sum / n;
      if (score > bestScore) {
        bestScore = score;
        bestOffset = off;
      }
    }
  }
  return Number(bestOffset.toFixed(1));
}

function analyzeTrials(summaryRows, processed, offsetSec) {
  const trials = [];
  for (const r of summaryRows) {
    const angle = toNumber(r.target_angle_deg, NaN);
    const startMs = toNumber(r.emg_window_start_candidate_ms, NaN);
    const endMs = toNumber(r.emg_window_end_candidate_ms, NaN);
    if (![angle, startMs, endMs].every(Number.isFinite)) continue;
    const s = startMs / 1000 + offsetSec;
    const e = endMs / 1000 + offsetSec;
    if (e <= s) continue;
    const idx = [];
    for (let i = 0; i < processed.times.length; i += 1) {
      const t = processed.times[i];
      if (t >= s && t <= e) idx.push(i);
    }
    if (!idx.length) continue;
    const muscleMeans = processed.channels.map((c) => mean(idx.map((j) => c.percentMvc[j])));
    const total = muscleMeans.reduce((a, b) => a + b, 0);
    const ratio = muscleMeans.map((m) => (total > 0 ? m / total : 0));
    trials.push({
      participantId: r.participant_id || "",
      sessionId: r.session_id || "",
      trialGlobal: toNumber(r.trial_global_index, NaN),
      angle,
      muscleMeans,
      ratio
    });
  }
  return trials;
}

function groupByAngle(trials) {
  const map = new Map();
  for (const t of trials) {
    if (!map.has(t.angle)) map.set(t.angle, []);
    map.get(t.angle).push(t);
  }
  const angles = [...map.keys()].sort((a, b) => a - b);
  return angles.map((angle) => {
    const rows = map.get(angle);
    const meanMuscle = [0, 0, 0, 0];
    const meanRatio = [0, 0, 0, 0];
    for (const r of rows) {
      for (let i = 0; i < 4; i += 1) {
        meanMuscle[i] += r.muscleMeans[i];
        meanRatio[i] += r.ratio[i];
      }
    }
    for (let i = 0; i < 4; i += 1) {
      meanMuscle[i] /= rows.length;
      meanRatio[i] /= rows.length;
    }
    return { angle, n: rows.length, meanMuscle, meanRatio };
  });
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}

function fitNonNegativeLinearMix(y, vertical, horizontal) {
  const vv = dot(vertical, vertical);
  const hh = dot(horizontal, horizontal);
  const vh = dot(vertical, horizontal);
  const vy = dot(vertical, y);
  const hy = dot(horizontal, y);
  const det = vv * hh - vh * vh;
  let n = 0;
  let m = 0;
  if (Math.abs(det) > 1e-10) {
    n = (vy * hh - hy * vh) / det;
    m = (hy * vv - vy * vh) / det;
  }
  const candidates = [
    [n, m],
    [Math.max(0, n), Math.max(0, m)],
    [0, hh > 0 ? hy / hh : 0],
    [vv > 0 ? vy / vv : 0, 0],
    [0, 0]
  ];
  let best = { n: 0, m: 0, sse: Infinity };
  for (const [cn, cm] of candidates) {
    const nn = Math.max(0, cn);
    const mm = Math.max(0, cm);
    const pred = y.map((_, i) => nn * vertical[i] + mm * horizontal[i]);
    const sse = y.reduce((acc, yi, i) => acc + (yi - pred[i]) ** 2, 0);
    if (sse < best.sse) best = { n: nn, m: mm, sse, pred };
  }
  const yMean = mean(y);
  const sst = y.reduce((acc, yi) => acc + (yi - yMean) ** 2, 0);
  return {
    n: best.n,
    m: best.m,
    rmse: Math.sqrt(best.sse / Math.max(y.length, 1)),
    r2: sst > 0 ? 1 - best.sse / sst : NaN
  };
}

function baseAnglesFor(angle) {
  const a = ((angle % 360) + 360) % 360;
  if (a > 0 && a < 90) return { vertical: 90, horizontal: 0 };
  if (a > 90 && a < 180) return { vertical: 90, horizontal: 180 };
  if (a > 180 && a < 270) return { vertical: 270, horizontal: 180 };
  if (a > 270 && a < 360) return { vertical: 270, horizontal: 0 };
  return null;
}

function analyzeDiagonalComposition(byAngle, trials) {
  const map = new Map(byAngle.map((r) => [r.angle, r]));
  const rows = [];
  for (const angle of byAngle.map((r) => r.angle).filter((a) => ![0, 90, 180, 270].includes(a))) {
    const b = baseAnglesFor(angle);
    if (!b) continue;
    const v = map.get(b.vertical);
    const h = map.get(b.horizontal);
    const t = map.get(angle);
    if (!v || !h || !t) continue;
    const fit = fitNonNegativeLinearMix(t.meanMuscle, v.meanMuscle, h.meanMuscle);
    const trialFits = trials.filter((x) => x.angle === angle).map((x) => fitNonNegativeLinearMix(x.muscleMeans, v.meanMuscle, h.meanMuscle));
    const interpretation = fit.r2 >= 0.8 ? "explainable" : fit.r2 >= 0.5 ? "partly_explainable" : "independent_like";
    rows.push({
      angle,
      verticalBase: b.vertical,
      horizontalBase: b.horizontal,
      n: fit.n,
      m: fit.m,
      r2: fit.r2,
      rmse: fit.rmse,
      meanTrialR2: mean(trialFits.map((x) => x.r2).filter(Number.isFinite)),
      interpretation
    });
  }
  return {
    rows,
    avgR2: mean(rows.map((r) => r.r2).filter(Number.isFinite)),
    explainableCount: rows.filter((r) => r.r2 >= 0.8).length,
    independentCount: rows.filter((r) => r.r2 < 0.5).length
  };
}

function oneWayAnova(values, groups) {
  const n = values.length;
  const grand = mean(values);
  const byGroup = new Map();
  for (let i = 0; i < n; i += 1) {
    if (!byGroup.has(groups[i])) byGroup.set(groups[i], []);
    byGroup.get(groups[i]).push(values[i]);
  }
  const k = byGroup.size;
  let ssBetween = 0;
  let ssWithin = 0;
  byGroup.forEach((arr) => {
    const m = mean(arr);
    ssBetween += arr.length * (m - grand) ** 2;
    arr.forEach((x) => {
      ssWithin += (x - m) ** 2;
    });
  });
  const df1 = k - 1;
  const df2 = n - k;
  const msBetween = ssBetween / Math.max(df1, 1);
  const msWithin = ssWithin / Math.max(df2, 1);
  const f = msWithin > 0 ? msBetween / msWithin : NaN;
  const eta2 = (ssBetween + ssWithin) > 0 ? ssBetween / (ssBetween + ssWithin) : NaN;
  return { f, eta2 };
}

function permutationPValue(values, groups, obsF, nPerm = 500) {
  const g = [...groups];
  let count = 0;
  for (let p = 0; p < nPerm; p += 1) {
    for (let i = g.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [g[i], g[j]] = [g[j], g[i]];
    }
    const f = oneWayAnova(values, g).f;
    if (Number.isFinite(f) && f >= obsF) count += 1;
  }
  return (count + 1) / (nPerm + 1);
}

function computeStatsRows(trials) {
  const groups = trials.map((t) => t.angle);
  const rows = [];
  for (let i = 0; i < 4; i += 1) {
    const vals = trials.map((t) => t.muscleMeans[i]);
    const a = oneWayAnova(vals, groups);
    const p = permutationPValue(vals, groups, a.f, 500);
    rows.push({ muscle: MUSCLES[i], f: a.f, eta2: a.eta2, p });
  }
  return rows;
}

function computeSyncQuality(processed, rawRows, offsetSec) {
  const taps = getTapTimes(rawRows).map((t) => t + offsetSec);
  const all = processed.times.map((t) => combinedActivityAt(processed, t));
  const tapVals = taps
    .filter((t) => t >= 0 && t <= processed.times[processed.times.length - 1])
    .map((t) => combinedActivityAt(processed, t));
  const mAll = mean(all);
  const sdAll = Math.sqrt(mean(all.map((x) => (x - mAll) ** 2)));
  const mTap = mean(tapVals);
  return { z: sdAll > 0 ? (mTap - mAll) / sdAll : NaN, tapCount: tapVals.length };
}

function analyzeDataset(dataset, offsetSec) {
  const processed = preprocessEmg(dataset.emgRows, dataset.rawRows, offsetSec);
  const trials = analyzeTrials(dataset.summaryRows, processed, offsetSec).map((t) => ({
    ...t,
    participantId: dataset.participantId,
    sessionId: dataset.sessionId
  }));
  return {
    participantId: dataset.participantId,
    sessionId: dataset.sessionId,
    processed,
    trials,
    sync: computeSyncQuality(processed, dataset.rawRows, offsetSec)
  };
}

function aggregate(datasetResults, offsetSec, analysisMs) {
  const trials = datasetResults.flatMap((d) => d.trials);
  const byAngle = groupByAngle(trials);
  const diagonalModel = analyzeDiagonalComposition(byAngle, trials);
  const overallMeans = [0, 0, 0, 0];
  for (const t of trials) for (let i = 0; i < 4; i += 1) overallMeans[i] += t.muscleMeans[i];
  for (let i = 0; i < 4; i += 1) overallMeans[i] /= Math.max(trials.length, 1);
  const statsRows = computeStatsRows(trials);
  const participantCount = new Set(datasetResults.map((d) => d.participantId)).size;
  return {
    trials,
    byAngle,
    diagonalModel,
    overallMeans,
    statsRows,
    participantCount,
    sessionCount: datasetResults.length,
    syncMeanZ: mean(datasetResults.map((d) => d.sync.z).filter(Number.isFinite)),
    syncTapCount: datasetResults.reduce((a, d) => a + d.sync.tapCount, 0),
    offsetSec,
    analysisMs
  };
}

function toCsv(rows, headers) {
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const out = [headers.map(esc).join(",")];
  rows.forEach((r) => out.push(headers.map((h) => esc(r[h])).join(",")));
  return out.join("\n");
}

function renderAngleStackedSvg(byAngle) {
  const w = Math.max(1000, byAngle.length * 34 + 100);
  const h = 300;
  const pad = { l: 50, r: 20, t: 20, b: 50 };
  const plotH = h - pad.t - pad.b;
  const barW = 20;
  const gap = 12;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`;
  s += `<rect x="${pad.l}" y="${pad.t}" width="${w - pad.l - pad.r}" height="${plotH}" fill="#fff" stroke="#dbe2f3"/>`;
  byAngle.forEach((r, i) => {
    const x0 = pad.l + i * (barW + gap) + 8;
    let yTop = pad.t + plotH;
    r.meanRatio.forEach((ratio, m) => {
      const bh = ratio * plotH;
      yTop -= bh;
      s += `<rect x="${x0}" y="${yTop.toFixed(1)}" width="${barW}" height="${bh.toFixed(1)}" fill="${COLORS[m]}"/>`;
    });
    s += `<text x="${x0 + barW / 2}" y="${h - 25}" text-anchor="middle" font-size="10">${r.angle}</text>`;
  });
  s += `<text x="${w / 2}" y="${h - 5}" text-anchor="middle" font-size="12">angle deg</text>`;
  s += "</svg>";
  return s;
}

function renderOverallBarSvg(overallMeans) {
  const w = 620;
  const h = 180;
  const maxV = Math.max(...overallMeans, 1);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`;
  overallMeans.forEach((v, i) => {
    const y = 20 + i * 35;
    const bw = (v / maxV) * 420;
    s += `<text x="10" y="${y + 13}" font-size="12">${MUSCLES[i]}</text>`;
    s += `<rect x="130" y="${y}" width="430" height="16" fill="#e8edf7"/>`;
    s += `<rect x="130" y="${y}" width="${bw.toFixed(1)}" height="16" fill="${COLORS[i]}"/>`;
    s += `<text x="570" y="${y + 13}" text-anchor="end" font-size="12">${v.toFixed(2)} %MVC</text>`;
  });
  s += "</svg>";
  return s;
}

async function writeOutputs(outputDir, agg) {
  await fs.mkdir(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");

  const trialRows = agg.trials.map((t) => ({
    participant_id: t.participantId,
    session_id: t.sessionId,
    trial_global: t.trialGlobal,
    angle_deg: t.angle,
    muscle1_pctmvc: t.muscleMeans[0].toFixed(6),
    muscle2_pctmvc: t.muscleMeans[1].toFixed(6),
    muscle3_pctmvc: t.muscleMeans[2].toFixed(6),
    muscle4_pctmvc: t.muscleMeans[3].toFixed(6)
  }));
  const trialCsv = toCsv(trialRows, [
    "participant_id",
    "session_id",
    "trial_global",
    "angle_deg",
    "muscle1_pctmvc",
    "muscle2_pctmvc",
    "muscle3_pctmvc",
    "muscle4_pctmvc"
  ]);
  const trialPath = path.join(outputDir, `analysis_trial_level_${stamp}.csv`);
  await fs.writeFile(trialPath, trialCsv, "utf8");

  const byAngleRows = agg.byAngle.map((r) => ({
    angle_deg: r.angle,
    n_trials: r.n,
    muscle1_pctmvc: r.meanMuscle[0].toFixed(6),
    muscle2_pctmvc: r.meanMuscle[1].toFixed(6),
    muscle3_pctmvc: r.meanMuscle[2].toFixed(6),
    muscle4_pctmvc: r.meanMuscle[3].toFixed(6),
    ratio1: r.meanRatio[0].toFixed(6),
    ratio2: r.meanRatio[1].toFixed(6),
    ratio3: r.meanRatio[2].toFixed(6),
    ratio4: r.meanRatio[3].toFixed(6)
  }));
  const byAngleCsv = toCsv(byAngleRows, [
    "angle_deg",
    "n_trials",
    "muscle1_pctmvc",
    "muscle2_pctmvc",
    "muscle3_pctmvc",
    "muscle4_pctmvc",
    "ratio1",
    "ratio2",
    "ratio3",
    "ratio4"
  ]);
  const byAnglePath = path.join(outputDir, `analysis_by_angle_${stamp}.csv`);
  await fs.writeFile(byAnglePath, byAngleCsv, "utf8");

  const diagRows = agg.diagonalModel.rows.map((r) => ({
    angle_deg: r.angle,
    vertical_base_deg: r.verticalBase,
    horizontal_base_deg: r.horizontalBase,
    n_vertical_weight: r.n.toFixed(6),
    m_horizontal_weight: r.m.toFixed(6),
    r2: r.r2.toFixed(6),
    rmse: r.rmse.toFixed(6),
    mean_trial_r2: Number.isFinite(r.meanTrialR2) ? r.meanTrialR2.toFixed(6) : "",
    interpretation: r.interpretation
  }));
  const diagCsv = toCsv(diagRows, [
    "angle_deg",
    "vertical_base_deg",
    "horizontal_base_deg",
    "n_vertical_weight",
    "m_horizontal_weight",
    "r2",
    "rmse",
    "mean_trial_r2",
    "interpretation"
  ]);
  const diagPath = path.join(outputDir, `analysis_diagonal_model_${stamp}.csv`);
  await fs.writeFile(diagPath, diagCsv, "utf8");

  const statRows = agg.statsRows.map((r) => ({
    muscle: r.muscle,
    f_value: r.f.toFixed(6),
    eta2: r.eta2.toFixed(6),
    permutation_p: r.p.toFixed(6)
  }));
  const statCsv = toCsv(statRows, ["muscle", "f_value", "eta2", "permutation_p"]);
  const statPath = path.join(outputDir, `analysis_stats_${stamp}.csv`);
  await fs.writeFile(statPath, statCsv, "utf8");

  const summary = {
    generated_at: new Date().toISOString(),
    participant_count: agg.participantCount,
    session_count: agg.sessionCount,
    trial_count: agg.trials.length,
    offset_sec: agg.offsetSec,
    analysis_ms: agg.analysisMs,
    sync_mean_z: agg.syncMeanZ,
    sync_tap_count: agg.syncTapCount,
    diagonal_model: {
      avg_r2: agg.diagonalModel.avgR2,
      explainable_count: agg.diagonalModel.explainableCount,
      independent_count: agg.diagonalModel.independentCount
    }
  };
  const summaryPath = path.join(outputDir, `analysis_summary_${stamp}.json`);
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");

  const angleSvgPath = path.join(outputDir, `analysis_angle_stacked_${stamp}.svg`);
  await fs.writeFile(angleSvgPath, renderAngleStackedSvg(agg.byAngle), "utf8");
  const overallSvgPath = path.join(outputDir, `analysis_overall_bars_${stamp}.svg`);
  await fs.writeFile(overallSvgPath, renderOverallBarSvg(agg.overallMeans), "utf8");

  return [trialPath, byAnglePath, diagPath, statPath, summaryPath, angleSvgPath, overallSvgPath];
}

function buildDatasets(records) {
  const emgRecords = records.filter((r) => r.role === "emg");
  const summaryRecords = records.filter((r) => r.role === "summary");
  const rawRecords = records.filter((r) => r.role === "raw");

  const rawBySession = new Map();
  rawRecords.forEach((r) => {
    const sid = r.rows[0]?.session_id;
    if (sid) rawBySession.set(sid, r.rows);
  });

  const emgByPid = new Map();
  emgRecords.forEach((r) => {
    emgByPid.set(inferParticipantId(r.filePath), r.rows);
  });

  const datasets = [];
  summaryRecords.forEach((s) => {
    const sid = s.rows[0]?.session_id;
    const pid = s.rows[0]?.participant_id || inferParticipantId(s.filePath);
    const rawRows = rawBySession.get(sid);
    if (!sid || !rawRows) return;
    let emgRows = emgByPid.get(pid);
    if (!emgRows && emgByPid.size === 1) emgRows = [...emgByPid.values()][0];
    if (!emgRows) return;
    datasets.push({
      participantId: pid,
      sessionId: sid,
      emgRows,
      summaryRows: s.rows,
      rawRows
    });
  });
  return datasets;
}

async function main() {
  const args = parseArgs(process.argv);
  const inputDir = path.resolve(args.input);
  const outputDir = path.resolve(args.output);
  const t0 = Date.now();

  const files = await listCsvFilesRecursively(inputDir);
  if (!files.length) {
    throw new Error(`CSVが見つかりません: ${inputDir}`);
  }
  const loaded = await Promise.all(files.map(readCsvFile));
  const records = loaded.map((r) => ({ ...r, role: detectFileRole(r) })).filter((r) => r.role !== "unknown");
  const datasets = buildDatasets(records);
  if (!datasets.length) {
    throw new Error("有効なデータセット（EMG + summary + raw）が作れませんでした。");
  }

  let offsetSec = args.offset;
  if (args.autoOffset) {
    offsetSec = estimateOffset(datasets[0].emgRows, datasets[0].rawRows);
  }

  const sessionResults = datasets.map((d) => analyzeDataset(d, offsetSec));
  const agg = aggregate(sessionResults, offsetSec, Date.now() - t0);
  const written = await writeOutputs(outputDir, agg);

  console.log("解析完了");
  console.log(`入力: ${inputDir}`);
  console.log(`出力: ${outputDir}`);
  console.log(`参加者: ${agg.participantCount}, セッション: ${agg.sessionCount}, 試行: ${agg.trials.length}`);
  console.log(`オフセット[s]: ${offsetSec}`);
  console.log("出力ファイル:");
  written.forEach((p) => console.log(`- ${p}`));
}

main().catch((err) => {
  console.error(`エラー: ${err.message}`);
  process.exit(1);
});
