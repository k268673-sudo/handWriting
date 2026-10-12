const COLORS = ["#4f7cff", "#38b2ac", "#f59e0b", "#ef4444"];
const MUSCLES = ["筋1(CH1)", "筋2(CH2)", "筋3(CH3)", "筋4(CH4)"];

const DEFAULT_PATHS = {
  emg: "./test/EMG_data/P01.csv",
  summary: "./test/tablet_data/P01_wacom_summary_20260625_172753.csv",
  raw: "./test/tablet_data/P01_wacom_raw_20260625_172753.csv"
};

const appState = {
  emgRows: [],
  summaryRows: [],
  rawRows: [],
  datasets: [],
  processed: null,
  latestResult: null
};

const el = (id) => document.getElementById(id);

function inferParticipantIdFromName(name) {
  const base = name.split("/").pop() || name;
  const m = base.match(/([A-Za-z]+[0-9]+)/);
  return m ? m[1] : base.replace(/\.[^.]+$/, "");
}

function setStatus(msg, isError = false) {
  const status = el("status");
  status.textContent = msg;
  status.style.color = isError ? "#c0392b" : "#1d2433";
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

function hhmmssToSec(s) {
  const parts = s.split(":").map((x) => Number(x));
  if (parts.length !== 3 || parts.some((x) => Number.isNaN(x))) return NaN;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
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

function percentile(arr, p) {
  if (arr.length === 0) return NaN;
  const a = [...arr].sort((x, y) => x - y);
  const idx = (a.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return a[lo];
  return a[lo] + (a[hi] - a[lo]) * (idx - lo);
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function nearestIndex(times, t) {
  const idx = Math.round(t);
  return clamp(idx, 0, times.length - 1);
}

function getMvcIntervals(rawRows, offsetSec) {
  const events = rawRows
    .filter((r) => r.phase === "mvc" && (r.event_type === "mvc_start" || r.event_type === "mvc_end"))
    .map((r) => ({
      type: r.event_type,
      t: toNumber(r.timestamp_ms, NaN) / 1000 + offsetSec
    }))
    .filter((e) => Number.isFinite(e.t))
    .sort((a, b) => a.t - b.t);

  const intervals = [];
  let curStart = null;
  events.forEach((e) => {
    if (e.type === "mvc_start") {
      curStart = e.t;
    } else if (e.type === "mvc_end" && curStart != null && e.t > curStart) {
      intervals.push([curStart, e.t]);
      curStart = null;
    }
  });
  return intervals;
}

function preprocessEmg(emgRows, rawRows, offsetSec) {
  const times = [];
  const avg = [[], [], [], []];
  const max = [[], [], [], []];

  emgRows.forEach((r) => {
    const t = hhmmssToSec(r[""]);
    if (!Number.isFinite(t)) return;
    times.push(t);
    for (let i = 1; i <= 4; i += 1) {
      avg[i - 1].push(toNumber(r[`チャンネル ${i} 平均 (V)`], NaN));
      max[i - 1].push(toNumber(r[`チャンネル ${i} 最大 (V)`], NaN));
    }
  });

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
    mvcIntervals.forEach(([s, e]) => {
      let localMax = -Infinity;
      for (let i = 0; i < times.length; i += 1) {
        if (times[i] >= s && times[i] <= e) localMax = Math.max(localMax, rms[i]);
      }
      mvcRef = Math.max(mvcRef, localMax);
    });
    if (!Number.isFinite(mvcRef) || mvcRef <= 0) mvcRef = percentile(rms, 0.95);
    if (!Number.isFinite(mvcRef) || mvcRef <= 0) mvcRef = 1e-6;

    const percentMvc = rms.map((x) => clamp((x / mvcRef) * 100, 0, 400));
    channels.push({ raw: signal, rms, percentMvc, mvcRef });
  }

  return { times, channels, mvcIntervals };
}

function getTapTimes(rawRows) {
  return rawRows
    .filter((r) => r.sync_role && r.sync_role.includes("sync_tap") && r.event_type === "pointerdown")
    .map((r) => toNumber(r.timestamp_ms, NaN) / 1000)
    .filter((t) => Number.isFinite(t));
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
    taps.forEach((t) => {
      const q = t / 1000 + off;
      if (q >= 0 && q <= base.times[base.times.length - 1]) {
        sum += combinedActivityAt(base, q);
        n += 1;
      }
    });
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

function mean(arr) {
  if (arr.length === 0) return NaN;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function analyzeTrials(summaryRows, processed, offsetSec) {
  const trials = [];
  summaryRows.forEach((r) => {
    const angle = toNumber(r.target_angle_deg, NaN);
    const startMs = toNumber(r.emg_window_start_candidate_ms, NaN);
    const endMs = toNumber(r.emg_window_end_candidate_ms, NaN);
    if (![angle, startMs, endMs].every(Number.isFinite)) return;
    const s = startMs / 1000 + offsetSec;
    const e = endMs / 1000 + offsetSec;
    if (e <= s) return;

    const idx = [];
    for (let i = 0; i < processed.times.length; i += 1) {
      const t = processed.times[i];
      if (t >= s && t <= e) idx.push(i);
    }
    if (idx.length === 0) return;

    const muscleMeans = processed.channels.map((c) => mean(idx.map((j) => c.percentMvc[j])));
    const total = muscleMeans.reduce((a, b) => a + b, 0);
    const ratio = muscleMeans.map((m) => (total > 0 ? m / total : 0));
    trials.push({
      trialGlobal: toNumber(r.trial_global_index, NaN),
      angle,
      muscleMeans,
      ratio
    });
  });
  return trials;
}

function groupByAngle(trials) {
  const map = new Map();
  trials.forEach((t) => {
    if (!map.has(t.angle)) map.set(t.angle, []);
    map.get(t.angle).push(t);
  });
  const angles = [...map.keys()].sort((a, b) => a - b);
  return angles.map((angle) => {
    const rows = map.get(angle);
    const meanMuscle = [0, 0, 0, 0];
    const meanRatio = [0, 0, 0, 0];
    rows.forEach((r) => {
      for (let i = 0; i < 4; i += 1) {
        meanMuscle[i] += r.muscleMeans[i];
        meanRatio[i] += r.ratio[i];
      }
    });
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

  const candidates = [];
  candidates.push([n, m]);
  candidates.push([Math.max(0, n), Math.max(0, m)]);
  candidates.push([0, hh > 0 ? hy / hh : 0]);
  candidates.push([vv > 0 ? vy / vv : 0, 0]);
  candidates.push([0, 0]);

  let best = { n: 0, m: 0, sse: Infinity, pred: [0, 0, 0, 0] };
  candidates.forEach(([cn, cm]) => {
    const nn = Math.max(0, cn);
    const mm = Math.max(0, cm);
    const pred = y.map((_, i) => nn * vertical[i] + mm * horizontal[i]);
    const sse = y.reduce((acc, yi, i) => acc + (yi - pred[i]) ** 2, 0);
    if (sse < best.sse) best = { n: nn, m: mm, sse, pred };
  });

  const yMean = mean(y);
  const sst = y.reduce((acc, yi) => acc + (yi - yMean) ** 2, 0);
  const rmse = Math.sqrt(best.sse / Math.max(y.length, 1));
  const r2 = sst > 0 ? 1 - best.sse / sst : NaN;
  return { n: best.n, m: best.m, pred: best.pred, rmse, r2 };
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
  const byAngleMap = new Map(byAngle.map((r) => [r.angle, r]));
  const obliqueAngles = byAngle
    .map((r) => r.angle)
    .filter((a) => ![0, 90, 180, 270].includes(a))
    .sort((a, b) => a - b);

  const rows = [];
  obliqueAngles.forEach((angle) => {
    const bases = baseAnglesFor(angle);
    if (!bases) return;
    const vRef = byAngleMap.get(bases.vertical);
    const hRef = byAngleMap.get(bases.horizontal);
    const target = byAngleMap.get(angle);
    if (!vRef || !hRef || !target) return;

    const fit = fitNonNegativeLinearMix(target.meanMuscle, vRef.meanMuscle, hRef.meanMuscle);
    const sameTrials = trials.filter((t) => t.angle === angle);
    const trialFits = sameTrials.map((t) => fitNonNegativeLinearMix(t.muscleMeans, vRef.meanMuscle, hRef.meanMuscle));
    const meanTrialR2 = mean(trialFits.map((f) => f.r2).filter(Number.isFinite));
    const meanTrialN = mean(trialFits.map((f) => f.n).filter(Number.isFinite));
    const meanTrialM = mean(trialFits.map((f) => f.m).filter(Number.isFinite));

    let interpretation = "独立成分が大きい可能性";
    if (fit.r2 >= 0.8) interpretation = "縦横合成でほぼ説明可能";
    else if (fit.r2 >= 0.5) interpretation = "縦横合成で部分的に説明可能";

    rows.push({
      angle,
      verticalBase: bases.vertical,
      horizontalBase: bases.horizontal,
      n: fit.n,
      m: fit.m,
      r2: fit.r2,
      rmse: fit.rmse,
      meanTrialR2,
      meanTrialN,
      meanTrialM,
      interpretation
    });
  });

  const avgR2 = mean(rows.map((r) => r.r2).filter(Number.isFinite));
  const explainableCount = rows.filter((r) => r.r2 >= 0.8).length;
  const independentCount = rows.filter((r) => r.r2 < 0.5).length;
  return { rows, avgR2, explainableCount, independentCount };
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
  return { f, eta2, k, n };
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

function computeSyncQuality(processed, rawRows, offsetSec) {
  const taps = getTapTimes(rawRows).map((t) => t + offsetSec);
  const all = processed.times.map((t) => combinedActivityAt(processed, t));
  const tapVals = taps
    .filter((t) => t >= 0 && t <= processed.times[processed.times.length - 1])
    .map((t) => combinedActivityAt(processed, t));
  const mAll = mean(all);
  const sdAll = Math.sqrt(mean(all.map((x) => (x - mAll) ** 2)));
  const mTap = mean(tapVals);
  const z = sdAll > 0 ? (mTap - mAll) / sdAll : NaN;
  return { z, tapCount: tapVals.length };
}

function computeStatsRows(trials) {
  const groups = trials.map((t) => t.angle);
  const rows = [];
  for (let m = 0; m < 4; m += 1) {
    const vals = trials.map((t) => t.muscleMeans[m]);
    const a = oneWayAnova(vals, groups);
    const p = permutationPValue(vals, groups, a.f, 500);
    rows.push({
      muscle: MUSCLES[m],
      f: a.f,
      eta2: a.eta2,
      p
    });
  }
  return rows;
}

function aggregateResultFromDatasets(datasetResults, totalMs) {
  const allTrials = datasetResults.flatMap((r) =>
    r.trials.map((t) => ({
      ...t,
      sessionId: r.sessionId,
      participantId: r.participantId
    }))
  );
  const byAngle = groupByAngle(allTrials);
  const diagonalModel = analyzeDiagonalComposition(byAngle, allTrials);
  const overallMeans = [0, 0, 0, 0];
  allTrials.forEach((t) => {
    for (let i = 0; i < 4; i += 1) overallMeans[i] += t.muscleMeans[i];
  });
  for (let i = 0; i < 4; i += 1) overallMeans[i] /= Math.max(allTrials.length, 1);

  const participantCount = new Set(datasetResults.map((r) => r.participantId)).size;
  const meanSyncZ = mean(datasetResults.map((r) => r.sync.z).filter(Number.isFinite));
  const totalTap = datasetResults.reduce((acc, r) => acc + r.sync.tapCount, 0);

  return {
    datasetResults,
    sessionCount: datasetResults.length,
    participantCount,
    trials: allTrials,
    byAngle,
    diagonalModel,
    overallMeans,
    statsRows: computeStatsRows(allTrials),
    sync: { z: meanSyncZ, tapCount: totalTap },
    analysisMs: totalMs,
    processed: datasetResults[0]?.processed || { times: [], channels: [] },
    summaryRows: datasetResults[0]?.summaryRows || [],
    offsetSec: datasetResults[0]?.offsetSec || 0
  };
}

function renderSummary(result) {
  const cards = [
    ["参加者数", String(result.participantCount ?? 1)],
    ["セッション数", String(result.sessionCount ?? 1)],
    ["EMGサンプル数", String(result.processed.times.length)],
    ["試行数", String(result.trials.length)],
    ["同期オフセット[s]", result.offsetSec.toFixed(1)],
    ["解析時間[ms]", result.analysisMs.toFixed(1)],
    ["同期品質z", Number.isFinite(result.sync.z) ? result.sync.z.toFixed(2) : "NA"],
    ["同期タップ数", String(result.sync.tapCount)],
    ["最大EMG時刻[s]", result.processed.times[result.processed.times.length - 1].toFixed(1)]
  ];
  el("summary-cards").innerHTML = cards
    .map(([k, v]) => `<div class="metric"><div class="k">${k}</div><div class="v">${v}</div></div>`)
    .join("");
}

function renderOverallBars(result) {
  const means = result.overallMeans;
  const maxV = Math.max(...means, 1);
  const html = means
    .map((v, i) => {
      const w = (v / maxV) * 100;
      return `
        <div class="muscle-bar">
          <div class="label"><span>${MUSCLES[i]}</span><span>${v.toFixed(2)} %MVC</span></div>
          <div class="track"><div class="fill" style="width:${w}%;background:${COLORS[i]}"></div></div>
        </div>
      `;
    })
    .join("");
  el("overall-muscle-bars").innerHTML = html;
}

function renderTimeseries(result) {
  const canvas = el("timeseries-canvas");
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const pad = { l: 50, r: 20, t: 20, b: 28 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const xMax = result.processed.times[result.processed.times.length - 1];
  const yMax = Math.max(100, ...result.processed.channels.flatMap((c) => c.percentMvc));

  function x(t) {
    return pad.l + (t / xMax) * plotW;
  }
  function y(v) {
    return pad.t + (1 - v / yMax) * plotH;
  }

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(pad.l, pad.t, plotW, plotH);
  ctx.strokeStyle = "#dbe2f3";
  ctx.strokeRect(pad.l, pad.t, plotW, plotH);

  result.summaryRows.forEach((r) => {
    const s = toNumber(r.emg_window_start_candidate_ms, NaN) / 1000 + result.offsetSec;
    const e = toNumber(r.emg_window_end_candidate_ms, NaN) / 1000 + result.offsetSec;
    if (!Number.isFinite(s) || !Number.isFinite(e)) return;
    const x1 = x(s);
    const x2 = x(e);
    ctx.fillStyle = "rgba(120,120,120,0.08)";
    ctx.fillRect(x1, pad.t, Math.max(1, x2 - x1), plotH);
  });

  for (let ch = 0; ch < 4; ch += 1) {
    const arr = result.processed.channels[ch].percentMvc;
    ctx.beginPath();
    ctx.strokeStyle = COLORS[ch];
    ctx.lineWidth = 1.8;
    arr.forEach((v, i) => {
      const px = x(result.processed.times[i]);
      const py = y(v);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
  }

  ctx.fillStyle = "#5a647a";
  ctx.font = "12px sans-serif";
  ctx.fillText("0", pad.l - 10, H - 8);
  ctx.fillText(`${Math.round(xMax)}s`, W - 45, H - 8);
  ctx.fillText("0", 8, H - pad.b + 4);
  ctx.fillText(`${Math.round(yMax)}%MVC`, 6, pad.t + 4);
}

function renderStackedByAngle(result) {
  const rows = result.byAngle;
  const w = Math.max(1000, rows.length * 34 + 90);
  const h = 280;
  const pad = { l: 50, r: 20, t: 20, b: 45 };
  const plotH = h - pad.t - pad.b;
  const barW = 20;
  const gap = 12;
  let html = '<div class="legend">';
  for (let i = 0; i < 4; i += 1) {
    html += `<span class="legend-item"><span class="swatch" style="background:${COLORS[i]}"></span>${MUSCLES[i]}</span>`;
  }
  html += "</div>";

  html += `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`;
  html += `<rect x="${pad.l}" y="${pad.t}" width="${w - pad.l - pad.r}" height="${plotH}" fill="#fff" stroke="#dbe2f3"/>`;
  rows.forEach((r, i) => {
    const x0 = pad.l + i * (barW + gap) + 8;
    let yTop = pad.t + plotH;
    r.meanRatio.forEach((ratio, m) => {
      const bh = ratio * plotH;
      yTop -= bh;
      html += `<rect x="${x0}" y="${yTop.toFixed(1)}" width="${barW}" height="${bh.toFixed(1)}" fill="${COLORS[m]}"/>`;
    });
    html += `<text x="${x0 + barW / 2}" y="${h - 20}" text-anchor="middle" font-size="10" fill="#445">${r.angle}</text>`;
  });
  html += `<text x="${w / 2}" y="${h - 4}" text-anchor="middle" font-size="11" fill="#445">課題角度 [deg]</text>`;
  html += "</svg>";
  el("angle-stacked-chart").innerHTML = html;
}

function renderAngleDetail(result) {
  const select = el("angle-select");
  const options = result.byAngle
    .map((r) => `<option value="${r.angle}">${r.angle}° (n=${r.n})</option>`)
    .join("");
  select.innerHTML = options;

  const render = () => {
    const angle = Number(select.value);
    const row = result.byAngle.find((r) => r.angle === angle);
    if (!row) return;
    const maxV = Math.max(...row.meanMuscle, 1);
    el("angle-detail").innerHTML = row.meanMuscle
      .map((v, i) => {
        const ratio = row.meanRatio[i] * 100;
        return `
          <div class="muscle-bar">
            <div class="label">
              <span>${MUSCLES[i]}</span>
              <span>${v.toFixed(2)} %MVC / 比率 ${ratio.toFixed(1)}%</span>
            </div>
            <div class="track"><div class="fill" style="width:${(v / maxV) * 100}%;background:${COLORS[i]}"></div></div>
          </div>
        `;
      })
      .join("");
  };
  select.onchange = render;
  render();
}

function renderStats(result) {
  const rows = result.statsRows || [];
  el("stats-table").innerHTML = `
    <table>
      <thead>
        <tr><th>筋</th><th>F</th><th>η²</th><th>Permutation p</th></tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (r) =>
              `<tr><td>${r.muscle}</td><td>${r.f.toFixed(3)}</td><td>${r.eta2.toFixed(3)}</td><td>${r.p.toFixed(3)}</td></tr>`
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function renderDiagonalModel(result) {
  const model = result.diagonalModel;
  const cards = [
    ["斜線角度数", String(model.rows.length)],
    ["平均R²", Number.isFinite(model.avgR2) ? model.avgR2.toFixed(3) : "NA"],
    ["合成で説明可能(R²>=0.8)", String(model.explainableCount)],
    ["独立傾向(R²<0.5)", String(model.independentCount)]
  ];
  el("diagonal-model-summary").innerHTML = cards
    .map(([k, v]) => `<div class="metric"><div class="k">${k}</div><div class="v">${v}</div></div>`)
    .join("");

  el("diagonal-model-table").innerHTML = `
    <table>
      <thead>
        <tr>
          <th>斜線角度</th>
          <th>縦基準</th>
          <th>横基準</th>
          <th>n (縦重み)</th>
          <th>m (横重み)</th>
          <th>R²</th>
          <th>RMSE</th>
          <th>試行平均R²</th>
          <th>解釈</th>
        </tr>
      </thead>
      <tbody>
        ${model.rows
          .map(
            (r) => `<tr>
              <td>${r.angle}°</td>
              <td>${r.verticalBase}°</td>
              <td>${r.horizontalBase}°</td>
              <td>${r.n.toFixed(3)} (trial:${r.meanTrialN.toFixed(3)})</td>
              <td>${r.m.toFixed(3)} (trial:${r.meanTrialM.toFixed(3)})</td>
              <td>${r.r2.toFixed(3)}</td>
              <td>${r.rmse.toFixed(3)}</td>
              <td>${Number.isFinite(r.meanTrialR2) ? r.meanTrialR2.toFixed(3) : "NA"}</td>
              <td>${r.interpretation}</td>
            </tr>`
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function analyzeDataset(dataset, offsetSec) {
  const processed = preprocessEmg(dataset.emgRows, dataset.rawRows, offsetSec);
  const trials = analyzeTrials(dataset.summaryRows, processed, offsetSec);
  const byAngle = groupByAngle(trials);
  const diagonalModel = analyzeDiagonalComposition(byAngle, trials);
  const overallMeans = [0, 0, 0, 0];
  trials.forEach((t) => {
    for (let i = 0; i < 4; i += 1) overallMeans[i] += t.muscleMeans[i];
  });
  for (let i = 0; i < 4; i += 1) overallMeans[i] /= Math.max(trials.length, 1);
  const sync = computeSyncQuality(processed, dataset.rawRows, offsetSec);
  return {
    participantId: dataset.participantId,
    sessionId: dataset.sessionId,
    offsetSec,
    processed,
    trials,
    byAngle,
    diagonalModel,
    overallMeans,
    sync,
    summaryRows: dataset.summaryRows,
    statsRows: computeStatsRows(trials)
  };
}

function runAnalysis() {
  const offsetSec = toNumber(el("offset-sec").value, 0);
  if (!appState.datasets.length) {
    if (appState.emgRows.length && appState.summaryRows.length && appState.rawRows.length) {
      appState.datasets = [
        {
          participantId: appState.summaryRows[0]?.participant_id || inferParticipantIdFromName("single"),
          sessionId: appState.summaryRows[0]?.session_id || "single_session",
          emgRows: appState.emgRows,
          summaryRows: appState.summaryRows,
          rawRows: appState.rawRows
        }
      ];
    }
  }
  if (!appState.datasets.length) {
    setStatus("先にEMG / summary / raw の3ファイルを読み込んでください。", true);
    return;
  }
  setStatus("解析中...");
  const t0 = performance.now();
  const datasetResults = appState.datasets.map((dataset) => analyzeDataset(dataset, offsetSec));
  const result = aggregateResultFromDatasets(datasetResults, performance.now() - t0);
  appState.processed = result;
  appState.latestResult = result;

  renderSummary(result);
  renderOverallBars(result);
  renderTimeseries(result);
  renderStackedByAngle(result);
  renderAngleDetail(result);
  renderDiagonalModel(result);
  renderStats(result);
  setStatus(
    `解析完了: ${result.analysisMs.toFixed(1)} ms / 参加者 ${result.participantCount}名 / セッション ${result.sessionCount}件 / 試行 ${result.trials.length}件`
  );
}

async function fileToText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

async function buildDatasetsFromFolderFiles(files) {
  const csvFiles = [...files].filter((f) => f.name.toLowerCase().endsWith(".csv"));
  const records = await Promise.all(
    csvFiles.map(async (file) => ({
      file,
      text: await fileToText(file)
    }))
  );

  const emgFiles = [];
  const summaryFiles = [];
  const rawFiles = [];

  records.forEach((rec) => {
    const lower = rec.file.name.toLowerCase();
    if (lower.includes("wacom_summary")) summaryFiles.push(rec);
    else if (lower.includes("wacom_raw")) rawFiles.push(rec);
    else emgFiles.push(rec);
  });

  const emgMap = new Map();
  emgFiles.forEach((rec) => {
    const key = inferParticipantIdFromName(rec.file.name);
    emgMap.set(key, parseCsv(rec.text));
  });

  const rawMapBySession = new Map();
  rawFiles.forEach((rec) => {
    const rows = parseCsv(rec.text);
    const sid = rows[0]?.session_id;
    if (sid) rawMapBySession.set(sid, rows);
  });

  const datasets = [];
  summaryFiles.forEach((rec) => {
    const summaryRows = parseCsv(rec.text);
    const sid = summaryRows[0]?.session_id;
    const pid = summaryRows[0]?.participant_id || inferParticipantIdFromName(rec.file.name);
    if (!sid) return;
    const rawRows = rawMapBySession.get(sid);
    if (!rawRows) return;

    let emgRows = emgMap.get(pid);
    if (!emgRows && emgMap.size === 1) emgRows = [...emgMap.values()][0];
    if (!emgRows || !emgRows.length) return;

    datasets.push({
      participantId: pid,
      sessionId: sid,
      emgRows,
      summaryRows,
      rawRows
    });
  });

  return datasets;
}

async function loadFromInputs() {
  const emgFile = el("emg-file").files[0];
  const sumFile = el("summary-file").files[0];
  const rawFile = el("raw-file").files[0];
  if (!emgFile || !sumFile || !rawFile) return false;
  const [emgText, summaryText, rawText] = await Promise.all([
    fileToText(emgFile),
    fileToText(sumFile),
    fileToText(rawFile)
  ]);
  appState.emgRows = parseCsv(emgText);
  appState.summaryRows = parseCsv(summaryText);
  appState.rawRows = parseCsv(rawText);
  appState.datasets = [
    {
      participantId: appState.summaryRows[0]?.participant_id || inferParticipantIdFromName(sumFile.name),
      sessionId: appState.summaryRows[0]?.session_id || "single_session",
      emgRows: appState.emgRows,
      summaryRows: appState.summaryRows,
      rawRows: appState.rawRows
    }
  ];
  setStatus(`ファイル読込完了: EMG ${appState.emgRows.length}行 / summary ${appState.summaryRows.length}行 / raw ${appState.rawRows.length}行`);
  return true;
}

async function loadDefaults() {
  setStatus("testデータ読込中...");
  try {
    const [emgText, summaryText, rawText] = await Promise.all([
      fetch(DEFAULT_PATHS.emg).then((r) => r.text()),
      fetch(DEFAULT_PATHS.summary).then((r) => r.text()),
      fetch(DEFAULT_PATHS.raw).then((r) => r.text())
    ]);
    appState.emgRows = parseCsv(emgText);
    appState.summaryRows = parseCsv(summaryText);
    appState.rawRows = parseCsv(rawText);
    appState.datasets = [
      {
        participantId: appState.summaryRows[0]?.participant_id || "P01",
        sessionId: appState.summaryRows[0]?.session_id || "default_session",
        emgRows: appState.emgRows,
        summaryRows: appState.summaryRows,
        rawRows: appState.rawRows
      }
    ];
    setStatus(`testデータ読込完了: EMG ${appState.emgRows.length}行 / summary ${appState.summaryRows.length}行 / raw ${appState.rawRows.length}行`);
  } catch (e) {
    setStatus(`testデータの読込に失敗しました: ${e.message}`, true);
  }
}

async function loadFromFolderInput() {
  const files = el("folder-input").files;
  if (!files || !files.length) {
    setStatus("フォルダが選択されていません。", true);
    return false;
  }
  setStatus("フォルダ読込中...");
  try {
    const datasets = await buildDatasetsFromFolderFiles(files);
    if (!datasets.length) {
      setStatus("有効な組み合わせ（EMG + summary + raw）が見つかりませんでした。", true);
      return false;
    }
    appState.datasets = datasets;
    appState.emgRows = datasets[0].emgRows;
    appState.summaryRows = datasets[0].summaryRows;
    appState.rawRows = datasets[0].rawRows;
    const pCount = new Set(datasets.map((d) => d.participantId)).size;
    setStatus(`フォルダ読込完了: 参加者 ${pCount}名 / セッション ${datasets.length}件`);
    return true;
  } catch (e) {
    setStatus(`フォルダ読込エラー: ${e.message}`, true);
    return false;
  }
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function toCsv(rows, headers) {
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(esc).join(",")];
  rows.forEach((r) => {
    lines.push(headers.map((h) => esc(r[h])).join(","));
  });
  return lines.join("\n");
}

function exportResults() {
  const result = appState.latestResult;
  if (!result) {
    setStatus("先に解析を実行してください。", true);
    return;
  }
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");

  const trialRows = result.trials.map((t) => ({
    participant_id: t.participantId || "",
    session_id: t.sessionId || "",
    trial_global: t.trialGlobal,
    angle_deg: t.angle,
    muscle1_pctmvc: t.muscleMeans[0].toFixed(4),
    muscle2_pctmvc: t.muscleMeans[1].toFixed(4),
    muscle3_pctmvc: t.muscleMeans[2].toFixed(4),
    muscle4_pctmvc: t.muscleMeans[3].toFixed(4)
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
  downloadBlob(`analysis_trial_level_${ts}.csv`, new Blob([trialCsv], { type: "text/csv;charset=utf-8" }));

  const angleRows = result.byAngle.map((r) => ({
    angle_deg: r.angle,
    n_trials: r.n,
    muscle1_pctmvc: r.meanMuscle[0].toFixed(4),
    muscle2_pctmvc: r.meanMuscle[1].toFixed(4),
    muscle3_pctmvc: r.meanMuscle[2].toFixed(4),
    muscle4_pctmvc: r.meanMuscle[3].toFixed(4),
    ratio1: r.meanRatio[0].toFixed(4),
    ratio2: r.meanRatio[1].toFixed(4),
    ratio3: r.meanRatio[2].toFixed(4),
    ratio4: r.meanRatio[3].toFixed(4)
  }));
  const angleCsv = toCsv(angleRows, [
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
  downloadBlob(`analysis_by_angle_${ts}.csv`, new Blob([angleCsv], { type: "text/csv;charset=utf-8" }));

  const diagRows = result.diagonalModel.rows.map((r) => ({
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
  downloadBlob(`analysis_diagonal_model_${ts}.csv`, new Blob([diagCsv], { type: "text/csv;charset=utf-8" }));

  const statsRows = (result.statsRows || []).map((r) => ({
    muscle: r.muscle,
    f_value: r.f.toFixed(6),
    eta2: r.eta2.toFixed(6),
    permutation_p: r.p.toFixed(6)
  }));
  const statsCsv = toCsv(statsRows, ["muscle", "f_value", "eta2", "permutation_p"]);
  downloadBlob(`analysis_stats_${ts}.csv`, new Blob([statsCsv], { type: "text/csv;charset=utf-8" }));

  const summaryJson = {
    generated_at: new Date().toISOString(),
    participants: result.participantCount,
    sessions: result.sessionCount,
    trials: result.trials.length,
    offset_sec: result.offsetSec,
    analysis_ms: result.analysisMs,
    sync_quality_z: result.sync.z,
    diagonal_model: {
      avg_r2: result.diagonalModel.avgR2,
      explainable_count: result.diagonalModel.explainableCount,
      independent_count: result.diagonalModel.independentCount
    }
  };
  downloadBlob(`analysis_summary_${ts}.json`, new Blob([JSON.stringify(summaryJson, null, 2)], { type: "application/json" }));

  const svgEl = el("angle-stacked-chart").querySelector("svg");
  if (svgEl) {
    downloadBlob(`analysis_angle_stacked_${ts}.svg`, new Blob([svgEl.outerHTML], { type: "image/svg+xml" }));
  }

  const canvas = el("timeseries-canvas");
  if (canvas) {
    canvas.toBlob((blob) => {
      if (blob) downloadBlob(`analysis_timeseries_${ts}.png`, blob);
    }, "image/png");
  }

  setStatus("結果ファイルを出力しました（CSV/JSON/SVG/PNG）。");
}

async function init() {
  el("btn-load-default").addEventListener("click", loadDefaults);
  el("btn-load-folder").addEventListener("click", loadFromFolderInput);
  el("btn-export-results").addEventListener("click", exportResults);
  el("btn-analyze").addEventListener("click", async () => {
    const loadedByInput = await loadFromInputs();
    if (!loadedByInput && !appState.datasets.length && (!appState.emgRows.length || !appState.summaryRows.length || !appState.rawRows.length)) {
      await loadDefaults();
    }
    runAnalysis();
  });
  el("btn-auto-offset").addEventListener("click", async () => {
    const loadedByInput = await loadFromInputs();
    if (!loadedByInput && !appState.datasets.length && (!appState.emgRows.length || !appState.rawRows.length)) {
      await loadDefaults();
    }
    let emgRows = appState.emgRows;
    let rawRows = appState.rawRows;
    if (appState.datasets.length) {
      emgRows = appState.datasets[0].emgRows;
      rawRows = appState.datasets[0].rawRows;
    }
    if (!emgRows.length || !rawRows.length) {
      setStatus("EMGとrawを先に読み込んでください。", true);
      return;
    }
    setStatus("同期オフセット推定中...");
    const off = estimateOffset(emgRows, rawRows);
    el("offset-sec").value = String(off);
    setStatus(`推定オフセット: ${off.toFixed(1)} 秒`);
  });
}

init();
