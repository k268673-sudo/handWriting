/* ===================================================================
   Wacom 直線運筆 実験アプリ  (Vanilla JS)
   -------------------------------------------------------------------
   目的:
     Wacom One 上に直線運筆課題を表示し、ペン軌跡(座標/筆圧/時刻)を記録する。
     後処理で PicoLog の筋電位(EMG)データと「同期タップ」を介して同期する。

   同期タップは 3 種類。phase と sync_role で区別する:
     1) 開始前同期タップ   : phase=start_sync     / sync_role=start_sync_tap     (3回)
     2) 各試行前同期タップ : phase=pre_trial_sync / sync_role=pre_trial_sync_tap (各試行1回)
     3) 終了後同期タップ   : phase=end_sync       / sync_role=end_sync_tap       (3回)
     通常の運筆イベントは phase=trial(またはpractice) / sync_role=none。

   外部サーバ/DB は使わない。すべてブラウザ内で完結する。
=================================================================== */

'use strict';

/* ===================================================================
   0. 定数
=================================================================== */

// 方向: 0〜345° / 15°刻み / 24方向 (0=右, 90=上, 180=左, 270=下)
const DIRECTION_STEP_DEG = 15;
const NUM_DIRECTIONS = 24;

// pointerup後に試行確定するまでの猶予。
// 自己ペース方式(始点タッチで開始、終点で離して終了)では長い猶予は不要。
// この時間内に再 pointerdown が来れば同一試行として継続、来なければ確定。
const FINALIZE_GRACE_MS = 100;

// 筆圧0が続いた場合の補助的なペン離れ検出のしきい値 (ms)。
// hover中のpressure0 moveで誤検出する場合は ENABLE_PRESSURE_ZERO_LIFT を false に。
const PRESSURE_ZERO_LIFT_MS = 80;
const ENABLE_PRESSURE_ZERO_LIFT = true;

// Wacom One 13 touch (DTH134) の表示領域。フルスクリーン時のcanvasを
// この実寸へ対応づけ、実験用の長さ・距離をmmで扱う。
const DISPLAY_DEVICE_MODEL = 'Wacom One 13 touch (DTH134)';
const DISPLAY_WIDTH_MM = 294;
const DISPLAY_HEIGHT_MM = 165;

// 運筆条件（すべて実寸mm）。
const START_ZONE_RADIUS_MM = 5;
const MOVEMENT_ONSET_THRESHOLD_MM = 1;

// 一定速度ガイドと追従判定の暫定値。予備実験後に再調整する。
const MOVING_GUIDE_RADIUS_MM = 4;
const TRACKING_TOLERANCE_MM = 5;
const TRACKING_EVAL_INTERVAL_MS = 5;

// 運動終了をペン離脱と分けるための暫定基準。予備実験後に再調整する。
const MOVEMENT_OFFSET_SPEED_THRESHOLD_MM_S = 10;
const MOVEMENT_OFFSET_SUSTAIN_MS = 50;
const MOVEMENT_OFFSET_SMOOTHING_MS = 20;
const MOVEMENT_OFFSET_MIN_PROGRESS = 0.8;

// canvas 内の大きなデジタルタイマー(視覚メトロノーム)の表示位置(canvasサイズ比)。
// 線分や始点・終点と重なる場合に調整しやすいよう定数化している。
const VISUAL_TIMER_X_RATIO = 0.18;
const VISUAL_TIMER_Y_RATIO = 0.35;

// 練習試行の本数
const NUM_PRACTICE_TRIALS = 3;

// EMG 切り出し候補のマージン (ms)
const EMG_PRE_MARGIN_MS = 200;
const EMG_POST_MARGIN_MS = 200;

// EMG・骨格計測用の安静時ベースライン。設定画面で変更できる初期値。
const DEFAULT_BASELINE_DURATION_MS = 30000;
const DEFAULT_BASELINE_GUARD_MS = 5000;
const BASELINE_CONDITIONS = [
  {
    id: 1,
    type: 'complete_rest',
    label: '完全安静',
    instruction: '開始タップ後はペンを机に置き、腕と手を楽にして動かさないでください。',
  },
  {
    id: 2,
    type: 'task_posture_rest',
    label: 'タスク姿勢安静',
    instruction: '開始タップ後は課題時と同じようにペンを握り、ペン先を画面に触れず静止してください。',
  },
];

// 予備実験用の成功判定基準。
// 本実験では、予備実験の結果を見て再調整する。
const SUCCESS_CRITERIA = {
  angle_error_deg_max: 5,          // 角度誤差 <= 5°
  duration_tolerance_ratio: 0.10,   // 運筆時間が目標 ±10% 以内
  pressure_in_range_ratio_min: 0.4, // 筆圧適正率 >= 0.4
  pen_lift_count_max: 0,            // 途中ペン離れは許容しない
  tracking_in_range_ratio_min: 0.8, // ガイド5mm以内の時間割合 >= 0.8
};

// 「やり直し候補」の判定基準(成功基準は満たさないが大きな問題が少ない場合)。
const RETRY_CRITERIA = {
  angle_error_deg_max: 25,          // 角度誤差 <= 25°
  duration_tolerance_ratio: 0.50,   // 運筆時間が目標 ±50% 以内
  pressure_in_range_ratio_min: 0.2, // 筆圧適正率 >= 0.2
  pen_lift_count_max: 1,            // 途中ペン離れ 1回まで
  tracking_in_range_ratio_min: 0.5, // ガイド5mm以内の時間割合 >= 0.5
};

// raw CSV の列(順序固定)
const RAW_COLUMNS = [
  'session_id', 'participant_id', 'phase', 'sync_role',
  'block_index', 'trial_index', 'trial_global_index', 'repetition_index',
  'target_angle_deg', 'event_type', 'pointer_type', 'pointer_id', 'tap_index',
  'timestamp_ms', 'epoch_ms', 'iso_time',
  'handler_timestamp_ms', 'event_processing_delay_ms', 'event_timestamp_source',
  'coalesced_batch_size', 'coalesced_event_index',
  'x_mm', 'y_mm', 'pressure',
  'target_pressure', 'pressure_tolerance', 'pressure_low', 'pressure_high',
  'target_duration_ms', 'target_line_length_mm', 'pre_trial_sync_wait_ms',
  'trial_start_button_time_ms', 'countdown_go_time_ms', 'first_pointerdown_time_ms',
  'last_pointerup_time_ms', 'trial_end_time_ms',
  'canvas_width_mm', 'canvas_height_mm', 'device_pixel_ratio',
  // 自己ペース開始方式で追加(既存列の後ろに追加)
  'touch_start_time_ms', 'movement_onset_time_ms', 'movement_onset_reference',
  'movement_offset_time_ms', 'movement_offset_method',
  // EMG最大随意収縮(MVC)キャリブレーション用(既存列の後ろに追加)
  'mvc_direction',
  // 試行前同期タップ終了〜結果ボタン押下を1 attemptとして識別する
  'attempt_index', 'attempt_id', 'attempt_stage', 'attempt_outcome',
  'trial_window_start_time_ms', 'trial_window_start_epoch_ms',
  'trial_ready_time_ms', 'result_display_time_ms',
  'trial_window_end_time_ms', 'trial_window_end_epoch_ms',
  // 各Pointer Event時点の一定速度ガイド位置と追従誤差
  'guide_progress', 'guide_x_mm', 'guide_y_mm',
  'tracking_error_mm', 'along_track_error_mm', 'cross_track_error_mm',
  // EMG・骨格計測用の安静時ベースライン
  'baseline_id', 'baseline_type', 'baseline_stage',
  'baseline_target_duration_ms', 'baseline_guard_ms',
  'baseline_unexpected_contact_count', 'baseline_valid',
  // 既存列の順序を保ったまま、運動開始定義をCSV単体で解釈できるよう追加
  'movement_onset_threshold_mm',
];

// summary CSV の列(順序固定)
const SUMMARY_COLUMNS = [
  'session_id', 'participant_id', 'block_index', 'trial_index', 'trial_global_index',
  'repetition_index', 'target_angle_deg', 'actual_angle_deg', 'angle_error_deg',
  'target_duration_ms', 'actual_duration_ms', 'duration_error_ms',
  'target_line_length_mm', 'actual_path_length_mm',
  'target_velocity_mm_per_s', 'mean_velocity_mm_per_s', 'velocity_error_mm_per_s',
  'target_pressure', 'pressure_tolerance', 'pressure_low', 'pressure_high',
  'mean_pressure', 'max_pressure', 'pressure_sd', 'pressure_in_range_ratio',
  'straightness_error_mm', 'pen_lift_count',
  'pre_trial_sync_tap_time_ms', 'pre_trial_sync_tap_epoch_ms', 'pre_trial_sync_tap_pressure',
  'countdown_go_time_ms', 'first_pointerdown_time_ms', 'last_pointerup_time_ms', 'trial_end_time_ms',
  'emg_window_start_candidate_ms', 'emg_window_end_candidate_ms',
  'success_flag', 'notes',
  // 判定詳細(既存列の後ろに追加)
  'verdict', 'angle_ok', 'duration_ok', 'pressure_ok', 'lift_ok',
  // 自己ペース開始方式で追加(既存列の後ろに追加)
  'touch_start_time_ms', 'movement_onset_time_ms', 'movement_duration_ms',
  'start_touch_x_mm', 'start_touch_y_mm', 'start_touch_distance_from_ideal_mm',
  'end_release_x_mm', 'end_release_y_mm', 'end_release_distance_from_ideal_mm',
  // 成功・失敗を含む全attemptの区間情報
  'attempt_index', 'attempt_id', 'attempt_outcome',
  'trial_window_start_time_ms', 'trial_window_start_epoch_ms',
  'trial_ready_time_ms', 'result_display_time_ms',
  'trial_window_end_time_ms', 'trial_window_end_epoch_ms',
  // 一定速度ガイドへの追従成績
  'guide_tracking_tolerance_mm', 'tracking_rmse_mm', 'tracking_max_error_mm',
  'tracking_in_range_ratio', 'tracking_observed_ratio',
  'mean_abs_along_track_error_mm', 'mean_abs_cross_track_error_mm',
  'goal_arrival_time_ms', 'goal_arrival_elapsed_ms', 'release_time_error_ms',
  'tracking_ok',
  // 接触・実移動・ペン離脱を分けた時間指標
  'movement_offset_time_ms', 'kinematic_duration_ms', 'start_delay_ms',
  'dwell_after_movement_ms', 'goal_dwell_ms', 'movement_offset_method',
  'emg_touch_window_start_candidate_ms', 'emg_movement_window_start_candidate_ms',
  // Pointer Event時刻の品質確認
  'pointer_event_count', 'median_pointer_interval_ms', 'p95_pointer_interval_ms',
  'max_pointer_interval_ms', 'estimated_pointer_rate_hz', 'median_event_processing_delay_ms',
  'p95_event_processing_delay_ms', 'coalesced_event_ratio',
  // 既存列の後ろに追加するタイミング定義
  'contact_duration_ms', 'movement_onset_reference', 'movement_onset_threshold_mm',
];

/* ===================================================================
   1. グローバル状態 (appState)
=================================================================== */

const appState = {
  screen: 'settings',          // 現在の画面
  mode: 'idle',                // pointer 処理のルーティング用: idle/calibration/sync/trial
  sessionStartPerformanceNow: 0, // timestamp_ms の基準 (performance.now())
  sessionStartEpochMs: 0,

  settings: null,              // 確定した設定
  session_id: '',

  // 筆圧キャリブレーション
  target_pressure: null,
  pressure_low: null,
  pressure_high: null,

  // 試行順
  trialOrder: [],              // {block_index, trial_index, trial_global_index, repetition_index, target_angle_deg}
  currentTrialPos: 0,          // trialOrder のインデックス(0始まり)
  attemptCounts: {},           // trial_global_indexごとの実施回数

  // canvas 情報
  canvas: null,
  ctx: null,
  cssW: 0,
  cssH: 0,

  // 動的な描画状態
  render: {
    targetProgress: 0,         // 目標点の進捗 0..1
    showSyncCircle: false,
    showGuideLine: false,
    practiceGuides: false,     // 練習中はガイドを大きく
    penX: null,
    penY: null,
    penPressure: 0,
    penVisible: false,         // ペン先リングを表示するか
  },

  currentPressure: 0,
  archiveConfirmed: false,
  baselineIntervals: [],
};

// 記録配列
const trialDataRaw = [];       // 全ペンイベント
const trialSummaries = [];     // 本番attemptごとの要約（accepted/rejectedの両方）

/* ===================================================================
   2. 画面要素の取得
=================================================================== */

const panels = {
  settings: document.getElementById('panel-settings'),
  stage: document.getElementById('panel-stage'),
  rest: document.getElementById('panel-rest'),
  save: document.getElementById('panel-save'),
};

const hud = {
  top: document.getElementById('hud-top'),
  pressure: document.getElementById('hud-pressure'),
  bottom: document.getElementById('hud-bottom'),
  center: document.getElementById('hud-center'),
  centerText: document.getElementById('hud-center-text'),
  centerSub: document.getElementById('hud-center-sub'),
  centerCount: document.getElementById('hud-center-count'),
  controls: document.getElementById('hud-controls'),
  summary: document.getElementById('hud-summary'),
};

const hudInfo = {
  timer: document.getElementById('hud-timer'),
  pid: document.getElementById('hud-pid'),
  trial: document.getElementById('hud-trial'),
  block: document.getElementById('hud-block'),
  rep: document.getElementById('hud-rep'),
  angle: document.getElementById('hud-angle'),
  phase: document.getElementById('hud-phase'),
};

const pressureUI = {
  band: document.getElementById('pressure-band'),
  targetLine: document.getElementById('pressure-target-line'),
  fill: document.getElementById('pressure-fill'),
  current: document.getElementById('pressure-current'),
  target: document.getElementById('pressure-target'),
  range: document.getElementById('pressure-range'),
};

/* ===================================================================
   3. ユーティリティ
=================================================================== */

// セッション基準時刻からの経過 ms。timestamp_ms はこれを使う。
function nowMs() {
  return performance.now() - appState.sessionStartPerformanceNow;
}

// 数値を丸める(CSV 用)。null/undefined はそのまま。
function round(v, digits) {
  if (v === null || v === undefined || v === '' || Number.isNaN(v)) return v;
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}

// 値を [min, max] に収める
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// DTH134の表示領域と現在のcanvas表示サイズを対応づける。
// x/yを別々に換算することで、画面比率やブラウザの丸めによる歪みを避ける。
function mmPerCssPxX() {
  const widthPx = appState.cssW || window.innerWidth || 1;
  return DISPLAY_WIDTH_MM / widthPx;
}

function mmPerCssPxY() {
  const heightPx = appState.cssH || window.innerHeight || 1;
  return DISPLAY_HEIGHT_MM / heightPx;
}

function cssPxToMmX(px) { return Number(px) * mmPerCssPxX(); }
function cssPxToMmY(px) { return Number(px) * mmPerCssPxY(); }
function mmToCssPxX(mm) { return Number(mm) / mmPerCssPxX(); }
function mmToCssPxY(mm) { return Number(mm) / mmPerCssPxY(); }

function pointPxToMm(x, y) {
  return { x: cssPxToMmX(x), y: cssPxToMmY(y) };
}

function distanceCssPxInMm(x1, y1, x2, y2) {
  return Math.hypot((Number(x2) - Number(x1)) * mmPerCssPxX(),
    (Number(y2) - Number(y1)) * mmPerCssPxY());
}

function drawMmCircle(ctx, x, y, radiusMm) {
  ctx.ellipse(x, y, mmToCssPxX(radiusMm), mmToCssPxY(radiusMm), 0, 0, Math.PI * 2);
}

// 0〜360° に正規化
function normalize360(deg) {
  let d = deg % 360;
  if (d < 0) d += 360;
  return d;
}

// -180〜+180° に正規化
function normalize180(deg) {
  let d = ((deg + 180) % 360 + 360) % 360 - 180;
  return d;
}

// 配列をシャッフル(Fisher-Yates)
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 日時文字列 yyyymmdd_hhmmss
function dateStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* ===================================================================
   4. raw 行の生成
   -------------------------------------------------------------------
   全イベントは pushRaw() で記録する。session/設定/筆圧などの固定値を
   自動で埋める。trial 系のタイミング列は確定後にバックフィルする。
=================================================================== */

function makeBaseRow(partial) {
  const s = appState.settings || {};
  const row = {
    session_id: appState.session_id,
    participant_id: s.participant_id || '',
    phase: '',
    sync_role: 'none',
    block_index: '',
    trial_index: '',
    trial_global_index: '',
    repetition_index: '',
    target_angle_deg: '',
    event_type: '',
    pointer_type: '',
    pointer_id: '',
    tap_index: '',
    timestamp_ms: '',
    epoch_ms: '',
    iso_time: '',
    handler_timestamp_ms: '',
    event_processing_delay_ms: '',
    event_timestamp_source: '',
    coalesced_batch_size: '',
    coalesced_event_index: '',
    // x_px/y_pxはブラウザ内の描画・補間専用。CSVにはmm列だけを書き出す。
    x_px: '',
    y_px: '',
    x_mm: '',
    y_mm: '',
    pressure: '',
    target_pressure: appState.target_pressure,
    pressure_tolerance: s.pressure_tolerance,
    pressure_low: appState.pressure_low,
    pressure_high: appState.pressure_high,
    target_duration_ms: s.target_duration_ms,
    target_line_length_mm: s.target_line_length_mm,
    pre_trial_sync_wait_ms: s.pre_trial_sync_wait_ms,
    trial_start_button_time_ms: '',
    countdown_go_time_ms: '',
    first_pointerdown_time_ms: '',
    last_pointerup_time_ms: '',
    trial_end_time_ms: '',
    touch_start_time_ms: '',
    movement_onset_time_ms: '',
    movement_onset_reference: '',
    movement_onset_threshold_mm: '',
    movement_offset_time_ms: '',
    movement_offset_method: '',
    mvc_direction: '',
    attempt_index: '',
    attempt_id: '',
    attempt_stage: '',
    attempt_outcome: '',
    trial_window_start_time_ms: '',
    trial_window_start_epoch_ms: '',
    trial_ready_time_ms: '',
    result_display_time_ms: '',
    trial_window_end_time_ms: '',
    trial_window_end_epoch_ms: '',
    guide_progress: '',
    guide_x_mm: '',
    guide_y_mm: '',
    tracking_error_mm: '',
    along_track_error_mm: '',
    cross_track_error_mm: '',
    baseline_id: '',
    baseline_type: '',
    baseline_stage: '',
    baseline_target_duration_ms: s.baseline_duration_ms,
    baseline_guard_ms: s.baseline_guard_ms,
    baseline_unexpected_contact_count: '',
    baseline_valid: '',
    canvas_width_mm: DISPLAY_WIDTH_MM,
    canvas_height_mm: DISPLAY_HEIGHT_MM,
    device_pixel_ratio: window.devicePixelRatio || 1,
  };
  return Object.assign(row, partial);
}

function pushRaw(partial) {
  const row = makeBaseRow(partial);
  trialDataRaw.push(row);
  return row;
}

// pointer event から座標/筆圧/時刻を抽出した raw 行 partial を作る
// PointerEvent.timeStampをperformance.now()と同じ時間軸へ正規化する。
// 一部環境でUnix時刻形式が返る場合も吸収し、異常値は処理時刻へフォールバックする。
function normalizedPointerEventTime(ev, handlerPerformanceNow) {
  const raw = Number(ev && ev.timeStamp);
  const sessionDerivedOrigin = Number(appState.sessionStartEpochMs) - Number(appState.sessionStartPerformanceNow);
  const timeOrigin = Number(performance.timeOrigin) ||
    (Number.isFinite(sessionDerivedOrigin) && appState.sessionStartEpochMs ? sessionDerivedOrigin : Date.now() - handlerPerformanceNow);
  if (!Number.isFinite(raw) || raw <= 0) {
    return {
      performance_ms: handlerPerformanceNow,
      epoch_ms: timeOrigin + handlerPerformanceNow,
      source: 'handler_fallback',
    };
  }

  let eventPerformanceMs = raw;
  let eventEpochMs = timeOrigin + raw;
  let source = 'pointer_event_timestamp';
  if (raw > 1e12) {
    eventEpochMs = raw;
    eventPerformanceMs = raw - timeOrigin;
    source = 'pointer_event_epoch_timestamp';
  }

  // 異なる時間原点や壊れた値を誤って採用しない。
  if (!Number.isFinite(eventPerformanceMs) || Math.abs(eventPerformanceMs - handlerPerformanceNow) > 86400000) {
    return {
      performance_ms: handlerPerformanceNow,
      epoch_ms: timeOrigin + handlerPerformanceNow,
      source: 'handler_fallback',
    };
  }
  return { performance_ms: eventPerformanceMs, epoch_ms: eventEpochMs, source };
}

function eventToRowFields(ev, eventTypeOverride, timingMeta = {}) {
  const rect = appState.canvas.getBoundingClientRect();
  // 座標は canvas 左上基準に変換して保存する
  const x = ev.clientX - rect.left;
  const y = ev.clientY - rect.top;
  const handlerPerformanceNow = Number.isFinite(Number(timingMeta.handlerPerformanceNow))
    ? Number(timingMeta.handlerPerformanceNow) : performance.now();
  const handlerTimestampMs = handlerPerformanceNow - appState.sessionStartPerformanceNow;
  const eventTime = normalizedPointerEventTime(ev, handlerPerformanceNow);
  const eventTimestampMs = eventTime.performance_ms - appState.sessionStartPerformanceNow;
  const batchSize = Number.isFinite(Number(timingMeta.coalescedBatchSize))
    ? Number(timingMeta.coalescedBatchSize) : 1;
  const batchIndex = Number.isFinite(Number(timingMeta.coalescedEventIndex))
    ? Number(timingMeta.coalescedEventIndex) : 0;
  return {
    event_type: eventTypeOverride || ev.type,
    pointer_type: ev.pointerType || '',
    pointer_id: ev.pointerId !== undefined ? ev.pointerId : '',
    timestamp_ms: round(eventTimestampMs, 3),
    epoch_ms: round(eventTime.epoch_ms, 3),
    iso_time: new Date(eventTime.epoch_ms).toISOString(),
    handler_timestamp_ms: round(handlerTimestampMs, 3),
    event_processing_delay_ms: round(handlerTimestampMs - eventTimestampMs, 3),
    event_timestamp_source: eventTime.source,
    coalesced_batch_size: batchSize,
    coalesced_event_index: batchIndex,
    x_px: round(x, 2),
    y_px: round(y, 2),
    x_mm: round(cssPxToMmX(x), 3),
    y_mm: round(cssPxToMmY(y), 3),
    pressure: round(ev.pressure, 4),
  };
}

/* ===================================================================
   5. 試行順の生成 (ブロックランダム)
   -------------------------------------------------------------------
   1ブロック = 24方向を各1回(ランダム順)。
   repetitions_per_direction = R なら R ブロック作る。
   => 合計 24 * R 試行。
   repetition_index は「何ブロック目か(=その方向の何回目か)」を表す。
=================================================================== */

function generateTrialOrder(repetitions) {
  const allAngles = [];
  for (let i = 0; i < NUM_DIRECTIONS; i++) {
    allAngles.push(i * DIRECTION_STEP_DEG);
  }

  const order = [];
  let global = 0;
  for (let block = 1; block <= repetitions; block++) {
    const blockAngles = shuffle(allAngles); // 各ブロック内でランダム順
    for (let k = 0; k < blockAngles.length; k++) {
      global += 1;
      order.push({
        block_index: block,
        trial_index: k + 1,          // ブロック内の番号 (1..24)
        trial_global_index: global,  // 全体の通し番号 (1..24R)
        repetition_index: block,     // その方向の何回目か(=ブロック番号)
        target_angle_deg: blockAngles[k],
      });
    }
  }
  return order;
}

/* ===================================================================
   6. 幾何計算 (始点/終点/目標点)
   -------------------------------------------------------------------
   角度定義: 0=右, 90=上, 180=左, 270=下。
   画面座標は y が下向きに増えるため、上方向(90°)は y が減る方向。
   atan2(-(end_y-start_y), end_x-start_x) == target で一致するよう、
   方向ベクトルを screenVec = (cosθ, -sinθ) とする。
   線分の中心が canvas 中央に来るよう start/end を配置する。
=================================================================== */

function computeLineEndpoints(angleDeg) {
  // canvas サイズが 0 のまま計算しないよう、必要なら再計測する
  if (!appState.cssW || !appState.cssH) {
    resizeCanvas();
  }
  const W = appState.cssW || window.innerWidth;
  const H = appState.cssH || window.innerHeight;

  const s = appState.settings;
  const Lmm = Number(s.target_line_length_mm);
  const cx = W / 2;
  const cy = H / 2;
  const rad = angleDeg * Math.PI / 180;
  // まず実寸mmで方向ベクトルを作り、x/yそれぞれをCSS pxへ換算する。
  const dxPx = mmToCssPxX(Lmm * Math.cos(rad));
  const dyPx = mmToCssPxY(-Lmm * Math.sin(rad)); // 画面 y は下向き
  return {
    start: { x: cx - 0.5 * dxPx, y: cy - 0.5 * dyPx },
    end: { x: cx + 0.5 * dxPx, y: cy + 0.5 * dyPx },
  };
}

/* ===================================================================
   7. canvas 初期化 / 描画ループ
=================================================================== */

function setupCanvas() {
  const canvas = document.getElementById('stage');
  appState.canvas = canvas;
  appState.ctx = canvas.getContext('2d');
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Pointer Events を登録
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  // Wacom/Chrome では pointerup の代わりに capture が外れる場合があるため保険
  canvas.addEventListener('lostpointercapture', onLostPointerCapture);
}

function resizeCanvas() {
  const canvas = appState.canvas;
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;

  // panel 非表示時などで clientWidth/Height が 0 になる場合は
  // window のサイズをフォールバックに使う
  let w = canvas.clientWidth;
  let h = canvas.clientHeight;
  if (!w || w <= 0) w = window.innerWidth;
  if (!h || h <= 0) h = window.innerHeight;

  appState.cssW = w;
  appState.cssH = h;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  // CSS px で描画できるよう変換をかける
  const ctx = canvas.getContext('2d');
  appState.ctx = ctx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

let rafId = null;
function startRenderLoop() {
  if (rafId) return;
  const loop = () => {
    drawStage();
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);
}
function stopRenderLoop() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
}

function drawStage() {
  // W/H が 0 のときは描画前に再計測する(描画スキップではなく resize)
  if (!appState.cssW || !appState.cssH) {
    resizeCanvas();
  }
  const ctx = appState.ctx;
  const W = appState.cssW || window.innerWidth;
  const H = appState.cssH || window.innerHeight;
  if (!ctx || !W || !H) return;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#f7f8fa';
  ctx.fillRect(0, 0, W, H);

  const r = appState.render;

  // --- 同期タップ用の大きな円 ---
  if (r.showSyncCircle) {
    const cx = W / 2, cy = H / 2;
    const radius = Math.min(W, H) * 0.18;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(9,105,218,0.10)';
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#0969da';
    ctx.stroke();
  }

  // --- 手首/前腕ガイド (試行・練習中) ---
  if (r.showGuideLine) {
    drawWristGuides(ctx, W, H);
  }

  // --- 直線運筆ガイド (始点/終点/直線/一定速度ガイド) ---
  if (r.showGuideLine && appState.currentLine) {
    const { start, end } = appState.currentLine;

    // 直線ガイド
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#c0c7cf';
    ctx.setLineDash([10, 8]);
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // 始点の許可ゾーン(始点タッチ待ち中のみ、薄く表示)
    if (trialCtx && trialCtx.awaitingStart && !trialCtx.started) {
      ctx.beginPath();
      drawMmCircle(ctx, start.x, start.y, START_ZONE_RADIUS_MM);
      ctx.fillStyle = 'rgba(26,127,55,0.12)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(26,127,55,0.5)';
      ctx.stroke();
    }

    // 始点(緑)・終点(赤)を大きく表示
    drawDot(ctx, start.x, start.y, 16, '#1a7f37', '始点');
    drawDot(ctx, end.x, end.y, 16, '#cf222e', '終点');

    // 始点接触後、目標時間をかけて終点へ進む一定速度ガイド。
    drawMovingGuide(ctx);
  }

  // --- MVCキャリブレーションの手イラスト + 方向矢印 ---
  if (appState.screen === 'mvc') {
    drawMvcHand(ctx, W, H);
  }

  // --- canvas 内の大きなデジタルタイマー(視覚メトロノーム) ---
  // 本番/練習の「始点タッチ待ち」および運筆中に表示する。
  if (appState.screen === 'trial' && r.showGuideLine) {
    drawVisualTimer(ctx, W, H);
  }

  // --- ペン先付近の筆圧リング ---
  // showGuideLine に依存させず、ペンが見えていて target_pressure があれば常に表示する。
  // (キャリブ/練習/同期タップ/待機/本番運筆 すべてで表示)
  if (r.penVisible && r.penX !== null && appState.target_pressure !== null) {
    drawPressureRing(ctx, r.penX, r.penY, r.penPressure);
  }

  // --- 左上の経過時間タイマー(補助・確認用) ---
  updateTimerHud();
}

// 2点間の距離
function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// 指定時刻の一定速度ガイド位置。フレーム数ではなく時刻から毎回計算するため、
// 描画フレームが一時的に遅れてもガイド時刻は累積してずれない。
function movingGuideStateAt(timestampMs, lineOverride) {
  const line = lineOverride || appState.currentLine;
  const targetMs = Number(appState.settings && appState.settings.target_duration_ms);
  if (!line || !Number.isFinite(targetMs) || targetMs <= 0) return null;

  let elapsedMs = 0;
  if (trialCtx && trialCtx.started && trialCtx.touch_start_time_ms !== '') {
    elapsedMs = Math.max(0, Number(timestampMs) - Number(trialCtx.touch_start_time_ms));
  }
  const progressRaw = elapsedMs / targetMs;
  const progress = clamp(progressRaw, 0, 1);
  return {
    elapsed_ms: elapsedMs,
    progress_raw: progressRaw,
    progress,
    x: line.start.x + (line.end.x - line.start.x) * progress,
    y: line.start.y + (line.end.y - line.start.y) * progress,
  };
}

function trackingFieldsAt(timestampMs, x, y, lineOverride) {
  const line = lineOverride || appState.currentLine;
  const guide = movingGuideStateAt(timestampMs, line);
  if (!guide || !Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) return {};

  const px = Number(x), py = Number(y);
  const lineStartMm = pointPxToMm(line.start.x, line.start.y);
  const lineEndMm = pointPxToMm(line.end.x, line.end.y);
  const guideMm = pointPxToMm(guide.x, guide.y);
  const penMm = pointPxToMm(px, py);
  const lineDx = lineEndMm.x - lineStartMm.x;
  const lineDy = lineEndMm.y - lineStartMm.y;
  const lineLength = Math.hypot(lineDx, lineDy) || 1;
  const ux = lineDx / lineLength;
  const uy = lineDy / lineLength;
  const dx = penMm.x - guideMm.x;
  const dy = penMm.y - guideMm.y;
  return {
    guide_progress: round(guide.progress, 5),
    guide_x_mm: round(guideMm.x, 3),
    guide_y_mm: round(guideMm.y, 3),
    tracking_error_mm: round(Math.hypot(dx, dy), 3),
    along_track_error_mm: round(dx * ux + dy * uy, 3),
    cross_track_error_mm: round(dx * (-uy) + dy * ux, 3),
  };
}

function drawMovingGuide(ctx) {
  if (!appState.currentLine || !trialCtx || appState.screen !== 'trial') return;
  let guideTime = nowMs();
  if (trialCtx.started && trialCtx.last_pointerup_time_ms !== null && !trialCtx.drawing) {
    guideTime = trialCtx.last_pointerup_time_ms;
  }
  const guide = movingGuideStateAt(guideTime);
  if (!guide) return;

  const reachedGoal = trialCtx.started && guide.progress_raw >= 1;
  ctx.save();
  // 白い縁を先に描き、線・ペン・手の近くでもリングを見やすくする。
  ctx.beginPath();
  drawMmCircle(ctx, guide.x, guide.y, MOVING_GUIDE_RADIUS_MM + 0.7);
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 8;
  ctx.stroke();
  ctx.beginPath();
  drawMmCircle(ctx, guide.x, guide.y, MOVING_GUIDE_RADIUS_MM);
  ctx.strokeStyle = reachedGoal ? '#2da44e' : '#0969da';
  ctx.lineWidth = 5;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(guide.x, guide.y, 3, 0, Math.PI * 2);
  ctx.fillStyle = reachedGoal ? '#2da44e' : '#0969da';
  ctx.fill();
  if (reachedGoal) {
    ctx.font = 'bold 15px sans-serif';
    ctx.fillStyle = '#1a7f37';
    ctx.textAlign = 'center';
    ctx.fillText('ペンを離す', guide.x, guide.y - mmToCssPxY(MOVING_GUIDE_RADIUS_MM) - 10);
  }
  ctx.restore();
}

// 角丸矩形パス
function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

// canvas 内の大きなデジタルタイマー + 進行リング(視覚メトロノーム)。
// touch_start_time_ms を基準に経過時間を表示し、目標時間までの進行をリングで示す。
function drawVisualTimer(ctx, W, H) {
  const s = appState.settings;
  if (!s) return;
  const targetMs = Number(s.target_duration_ms);
  if (!Number.isFinite(targetMs) || targetMs <= 0) return;

  // 基本位置(canvas 左中央あたり)。線分と近すぎる場合は下→右へ退避する。
  let x = W * VISUAL_TIMER_X_RATIO;
  let y = H * VISUAL_TIMER_Y_RATIO;
  if (appState.currentLine) {
    const minDist = 140;
    const tooClose = () => (
      distance({ x, y }, appState.currentLine.start) < minDist ||
      distance({ x, y }, appState.currentLine.end) < minDist
    );
    if (tooClose()) { y = H * 0.72; }          // まず下へ
    if (tooClose()) { x = W * 0.82; y = H * 0.35; } // それでも近ければ右へ
  }

  // 始点タッチ後の経過時間
  let elapsedMs = 0;
  let started = false;
  if (trialCtx && trialCtx.started && trialCtx.touch_start_time_ms !== '') {
    // 運筆終了(ペン離れ確定)後は last_pointerup で止める
    const end = (trialCtx.last_pointerup_time_ms !== null && !trialCtx.drawing)
      ? trialCtx.last_pointerup_time_ms : nowMs();
    elapsedMs = Math.max(0, end - Number(trialCtx.touch_start_time_ms));
    started = true;
  }

  const elapsedS = elapsedMs / 1000;
  const targetS = targetMs / 1000;
  const progressRaw = elapsedMs / targetMs;
  const progress = Math.max(0, Math.min(1, progressRaw));

  ctx.save();

  // 背景カード
  const cardW = 230;
  const cardH = 150;
  roundRect(ctx, x - cardW / 2, y - cardH / 2, cardW, cardH, 18);
  ctx.fillStyle = 'rgba(255,255,255,0.88)';
  ctx.strokeStyle = 'rgba(31,35,40,0.18)';
  ctx.lineWidth = 2;
  ctx.fill();
  ctx.stroke();

  // 進行リング(目標時間までの進行率)
  const ringR = 48;
  const ringCx = x;
  const ringCy = y - 10;
  ctx.beginPath();
  ctx.arc(ringCx, ringCy, ringR, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(110,119,129,0.25)';
  ctx.lineWidth = 8;
  ctx.stroke();

  // 色: 0〜0.8 青 / 0.8〜1.2 緑 / 1.2〜 赤
  let ringColor = '#0969da';
  if (progressRaw >= 0.9 && progressRaw <= 1.1) ringColor = '#2da44e';
  if (progressRaw > 1.1) ringColor = '#cf222e';

  ctx.beginPath();
  ctx.arc(ringCx, ringCy, ringR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
  ctx.strokeStyle = ringColor;
  ctx.lineWidth = 8;
  ctx.lineCap = 'round';
  ctx.stroke();

  // デジタル秒数
  ctx.fillStyle = '#1f2328';
  ctx.font = 'bold 34px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${elapsedS.toFixed(2)} s`, x, y - 10);

  // Target
  ctx.font = '16px sans-serif';
  ctx.fillStyle = '#57606a';
  ctx.fillText(`Target ${targetS.toFixed(2)} s`, x, y + 48);

  // 始点タッチ前の説明
  if (!started) {
    ctx.font = '14px sans-serif';
    ctx.fillStyle = '#0969da';
    ctx.fillText('始点をタッチすると開始', x, y + 70);
  }

  ctx.restore();
}

// 左上タイマー: touch_start_time_ms からの経過時間を表示する。
// 例: "Time: 0.73 s / Target: 1.00 s"
function updateTimerHud() {
  if (!hudInfo.timer) return;
  const target = appState.settings ? appState.settings.target_duration_ms : 0;
  const targetS = (target / 1000).toFixed(2);
  if (appState.screen === 'trial' && trialCtx && trialCtx.started && trialCtx.touch_start_time_ms !== '') {
    // 運筆中: ペン離れ確定までは経過時間が増え続ける
    const end = (trialCtx.last_pointerup_time_ms !== null && !trialCtx.drawing)
      ? trialCtx.last_pointerup_time_ms : nowMs();
    const elapsedS = ((end - trialCtx.touch_start_time_ms) / 1000).toFixed(2);
    hudInfo.timer.textContent = `Time: ${elapsedS} s / Target: ${targetS} s`;
  } else if (appState.screen === 'trial' && trialCtx && trialCtx.awaitingStart) {
    // 始点タッチ待ち: 0.00 で待機表示
    hudInfo.timer.textContent = `Time: 0.00 s / Target: ${targetS} s`;
  } else {
    hudInfo.timer.textContent = '';
  }
}

function drawDot(ctx, x, y, radius, color, label) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  if (label) {
    ctx.fillStyle = '#1f2328';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(label, x, y - radius - 6);
  }
}

// 手首位置目安・前腕方向ガイド(視覚的な目安のみ)
function drawWristGuides(ctx, W, H) {
  ctx.save();
  ctx.strokeStyle = 'rgba(110,119,129,0.35)';
  ctx.lineWidth = 2;
  // 手首位置目安(下部の水平線)
  const wristY = H * 0.82;
  ctx.setLineDash([14, 10]);
  ctx.beginPath();
  ctx.moveTo(W * 0.15, wristY);
  ctx.lineTo(W * 0.85, wristY);
  ctx.stroke();
  // 前腕方向ガイド(中央下から下方向)
  ctx.beginPath();
  ctx.moveTo(W / 2, H / 2);
  ctx.lineTo(W / 2, wristY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

// ペン先付近の筆圧リング。ペン先そのものではなく少し右上にずらして描く
// (Wacom ペンで隠れにくいように)。画面外には出さないよう clamp する。
//   灰色の円        : 目標筆圧 target_pressure
//   現在筆圧の円    : pressure / target_pressure に応じて半径変化
//   適正範囲内=緑 / 弱すぎ=青 / 強すぎ=赤
//   円の近くに現在筆圧を P: 0.42 のように表示
function drawPressureRing(ctx, x, y, pressure) {
  if (appState.target_pressure === null) return;

  // ペン先から少し右上にオフセットし、画面外にはみ出さないよう clamp
  const offsetX = 36;
  const offsetY = -36;
  const cx = clamp(x + offsetX, 40, appState.cssW - 40);
  const cy = clamp(y + offsetY, 40, appState.cssH - 40);

  const targetPressure = appState.target_pressure;
  const low = appState.pressure_low;
  const high = appState.pressure_high;

  const isPractice = appState.render.practiceGuides; // 練習は大きめ、本番は控えめ
  const baseR = isPractice ? 34 : 24;

  const ratio = targetPressure > 0 ? pressure / targetPressure : 0;
  const currentR = clamp(baseR * ratio, 5, baseR * 1.8);

  const inRange = pressure >= low && pressure <= high;
  const strokeColor = inRange ? '#2da44e' : (pressure < low ? '#0969da' : '#cf222e');

  ctx.save();

  // 背景(視認性向上)
  ctx.beginPath();
  ctx.arc(cx, cy, baseR + 10, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fill();

  // 目標筆圧リング(灰)
  ctx.beginPath();
  ctx.arc(cx, cy, baseR, 0, Math.PI * 2);
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(110,119,129,0.7)';
  ctx.stroke();

  // 現在筆圧リング
  ctx.beginPath();
  ctx.arc(cx, cy, currentR, 0, Math.PI * 2);
  ctx.lineWidth = isPractice ? 4 : 3;
  ctx.strokeStyle = strokeColor;
  ctx.stroke();

  // 現在筆圧の数値
  ctx.font = isPractice ? '14px sans-serif' : '12px sans-serif';
  ctx.fillStyle = '#1f2328';
  ctx.textAlign = 'center';
  ctx.fillText(`P: ${(pressure || 0).toFixed(2)}`, cx, cy + baseR + 20);

  ctx.restore();
}

/* ===================================================================
   8. 筆圧バー(右側 HUD)の更新
=================================================================== */

function updatePressureBar(pressure) {
  appState.currentPressure = pressure;
  pressureUI.current.textContent = (pressure || 0).toFixed(3);
  // バーの高さ(0..1 を 0..100%)
  const pct = Math.max(0, Math.min(1, pressure || 0)) * 100;
  pressureUI.fill.style.height = pct + '%';

  if (appState.target_pressure !== null) {
    const tp = appState.target_pressure;
    const lo = appState.pressure_low;
    const hi = appState.pressure_high;
    pressureUI.target.textContent = tp.toFixed(3);
    pressureUI.range.textContent = `${lo.toFixed(3)}〜${hi.toFixed(3)}`;
    // 適正範囲バンド(下から % 表示)
    const bandBottom = Math.max(0, Math.min(1, lo)) * 100;
    const bandTop = Math.max(0, Math.min(1, hi)) * 100;
    pressureUI.band.style.bottom = bandBottom + '%';
    pressureUI.band.style.height = (bandTop - bandBottom) + '%';
    pressureUI.targetLine.style.bottom = (Math.max(0, Math.min(1, tp)) * 100) + '%';
  }
}

/* ===================================================================
   9. 画面遷移 (showScreen)
=================================================================== */

function showPanel(name) {
  Object.keys(panels).forEach((k) => {
    panels[k].classList.toggle('active', k === name);
  });
  if (name === 'stage') {
    // panel-stage を表示してから canvas サイズを測る(0サイズ防止)
    requestAnimationFrame(() => {
      resizeCanvas();
      startRenderLoop();
    });
  } else {
    stopRenderLoop();
  }
}

// HUD の表示/非表示をまとめて制御
function setHud({ top, pressure, bottom, center, controls, summary }) {
  hud.top.classList.toggle('hidden', !top);
  hud.pressure.classList.toggle('hidden', !pressure);
  hud.bottom.classList.toggle('hidden', !bottom);
  hud.center.classList.toggle('hidden', !center);
  hud.controls.classList.toggle('hidden', !controls);
  hud.summary.classList.toggle('hidden', !summary);
}

// HUD 上部の試行情報を更新
function updateTopInfo(trial, phaseLabel) {
  const s = appState.settings;
  hudInfo.pid.textContent = 'ID: ' + (s ? s.participant_id : '');
  if (trial) {
    hudInfo.trial.textContent = `試行: ${trial.trial_global_index} / ${appState.trialOrder.length}`;
    hudInfo.block.textContent = `block: ${trial.block_index}`;
    hudInfo.rep.textContent = `rep: ${trial.repetition_index}`;
    hudInfo.angle.textContent = `角度: ${trial.target_angle_deg}°`;
  } else {
    hudInfo.trial.textContent = '';
    hudInfo.block.textContent = '';
    hudInfo.rep.textContent = '';
    hudInfo.angle.textContent = '';
  }
  hudInfo.phase.textContent = phaseLabel || '';
}

// 中央メッセージ設定
function setCenter(text, sub, count) {
  hud.centerText.textContent = text || '';
  hud.centerSub.textContent = sub || '';
  hud.centerCount.textContent = count || '';
}

// 制御ボタンを動的に作る
function setControls(buttons) {
  hud.controls.innerHTML = '';
  buttons.forEach((b) => {
    const btn = document.createElement('button');
    btn.className = 'btn' + (b.secondary ? ' btn-secondary' : '');
    btn.textContent = b.label;
    btn.addEventListener('click', b.onClick);
    if (b.id) btn.id = b.id;
    hud.controls.appendChild(btn);
  });
}

/* ===================================================================
   10. Pointer Events ハンドラ (mode によりルーティング)
=================================================================== */

// ペン位置・筆圧の共通更新。pointerdown/move/up/cancel すべてで呼ぶ。
// これによりペン先の筆圧リングと筆圧バーがどの場面でも即時に反映される。
// options.forcePressureZero=true で、ペン離れ(up/cancel)時に筆圧を即0表示にする。
function updatePenStateFromEvent(ev, options = {}) {
  const rect = appState.canvas.getBoundingClientRect();
  if (typeof ev.clientX === 'number') appState.render.penX = ev.clientX - rect.left;
  if (typeof ev.clientY === 'number') appState.render.penY = ev.clientY - rect.top;
  const pressure = options.forcePressureZero ? 0 : (ev.pressure || 0);
  appState.render.penPressure = pressure;
  appState.render.penVisible = true;
  updatePressureBar(pressure);
}

// pointerup/cancel 後、リングをすぐ消さず最後の位置に少し残すためのタイマー
let penFadeTimer = null;
function schedulePenFade() {
  if (penFadeTimer) clearTimeout(penFadeTimer);
  penFadeTimer = setTimeout(() => {
    appState.render.penVisible = false;
    appState.render.penPressure = 0;
  }, 400);
}
function cancelPenFade() {
  if (penFadeTimer) { clearTimeout(penFadeTimer); penFadeTimer = null; }
}

// 試行区間中にブラウザから届いた非接触・待機中のPointer Eventも保存する。
// イベントが届かない時間について座標を生成・補間することはしない。
function recordAttemptPointerEvents(ev, eventType) {
  if (!trialCtx || trialCtx.phase !== 'trial' || !trialCtx.trial_window_active) return;
  let events = [ev];
  if (eventType === 'pointermove' && typeof ev.getCoalescedEvents === 'function') {
    const coalesced = ev.getCoalescedEvents();
    if (coalesced && coalesced.length > 0) events = coalesced;
  }
  const handlerPerformanceNow = performance.now();
  events.forEach((event, index) => {
    pushAttemptRaw(Object.assign(eventToRowFields(event, eventType, {
      handlerPerformanceNow,
      coalescedBatchSize: events.length,
      coalescedEventIndex: index,
    }), trialTagFields(), {
      phase: 'trial_window',
    }));
  });
}

function onPointerDown(ev) {
  ev.preventDefault();
  // pointerdown 時に capture して、はみ出しても追従させる
  try { appState.canvas.setPointerCapture(ev.pointerId); } catch (e) { /* noop */ }
  cancelPenFade();
  updatePenStateFromEvent(ev);

  switch (appState.mode) {
    case 'calibration': calibrationPointerDown(ev); break;
    case 'baseline': baselinePointerDown(ev); break;
    case 'sync': syncPointerDown(ev); break;
    case 'pre_trial_sync_mode': preTrialSyncDown(ev); break;
    case 'trial': trialPointerDown(ev); break;
    case 'idle': recordAttemptPointerEvents(ev, 'pointerdown'); break;
  }
}

function onPointerMove(ev) {
  cancelPenFade();
  updatePenStateFromEvent(ev);

  switch (appState.mode) {
    case 'calibration': calibrationPointerMove(ev); break;
    case 'baseline': baselinePointerMove(ev); break;
    case 'trial': trialPointerMove(ev); break;
    case 'idle': recordAttemptPointerEvents(ev, 'pointermove'); break;
  }
}

function onPointerUp(ev) {
  try { appState.canvas.releasePointerCapture(ev.pointerId); } catch (e) { /* noop */ }
  // pointerup 時は筆圧バー/リングを即時に0表示にする(反応を速く)
  updatePenStateFromEvent(ev, { forcePressureZero: true });
  schedulePenFade();

  switch (appState.mode) {
    case 'calibration': calibrationPointerUp(ev); break;
    case 'baseline': baselinePointerUp(ev); break;
    case 'sync': syncPointerUp(ev); break;
    case 'pre_trial_sync_mode': preTrialSyncUp(ev); break;
    case 'trial': trialPointerUp(ev); break;
    case 'idle': recordAttemptPointerEvents(ev, 'pointerup'); break;
  }
}

function onPointerCancel(ev) {
  updatePenStateFromEvent(ev, { forcePressureZero: true });
  schedulePenFade();
  // キャンセルは記録に残す（従来どおり試行確定のトリガーにはしない）。
  if (appState.mode === 'baseline') {
    baselinePointerCancel(ev);
  } else if (appState.mode === 'trial' && trialCtx && trialCtx.drawing) {
    pushAttemptRaw(Object.assign(eventToRowFields(ev, 'pointercancel'), trialTagFields()), 'drawing');
  } else {
    recordAttemptPointerEvents(ev, 'pointercancel');
  }
}

// Wacom/Chrome で pointerup の代わりに capture が外れる挙動の保険。
// 試行中かつ描画中のときだけ pointerup 相当として扱い、二重記録を防ぐ。
function onLostPointerCapture(ev) {
  if (appState.mode === 'trial' && trialCtx && trialCtx.drawing) {
    console.log('[lostpointercapture] treated as pen lift', nowMs());
    trialPointerUp(ev);
  }
}

/* ===================================================================
   11. 筆圧キャリブレーション (4-2)
   -------------------------------------------------------------------
   自然な強さで3回なぞり、pressure>0 の平均を target_pressure とする。
=================================================================== */

const calib = {
  strokeCount: 0,
  pressures: [],   // pressure>0 のサンプルを蓄積
  drawing: false,
};

function enterCalibration() {
  appState.screen = 'calibration';
  appState.mode = 'idle';
  calib.strokeCount = 0;
  calib.pressures = [];
  calib.drawing = false;
  appState.render.showGuideLine = false;
  appState.render.showSyncCircle = false;
  appState.currentLine = computeLineEndpoints(0); // 中央に水平の短い線(なぞる対象)

  showPanel('stage');
  updateTopInfo(null, 'キャリブレーション');
  setHud({ top: true, pressure: true, bottom: false, center: true, controls: true, summary: false });
  updateCalibrationUI();

  setControls([
    { label: 'キャリブレーション開始', onClick: startCalibration },
    { label: 'やり直し', secondary: true, onClick: resetCalibration },
    { label: '次へ', secondary: true, id: 'calib-next', onClick: () => enterPracticeIntro() },
  ]);
}

function startCalibration() {
  calib.strokeCount = 0;
  calib.pressures = [];
  appState.mode = 'calibration';
  appState.render.showGuideLine = true;
  appState.render.practiceGuides = true;
  // なぞる対象として中央の短い線を表示
  const cx = appState.cssW / 2, cy = appState.cssH / 2;
  const half = 120;
  appState.currentLine = { start: { x: cx - half, y: cy }, end: { x: cx + half, y: cy } };
  // なぞる間は中央の操作カードを隠す(線と重ならないように)
  setHud({ top: true, pressure: true, bottom: false, center: true, controls: false, summary: false });
  updateCalibrationUI();
}

function resetCalibration() {
  calib.strokeCount = 0;
  calib.pressures = [];
  appState.target_pressure = null;
  appState.pressure_low = null;
  appState.pressure_high = null;
  appState.mode = 'idle';
  appState.render.showGuideLine = false;
  updateCalibrationUI();
}

function calibrationPointerDown(ev) {
  calib.drawing = true;
  recordCalibrationSample(ev, 'pointerdown');
}
function calibrationPointerMove(ev) {
  if (calib.drawing) recordCalibrationSample(ev, 'pointermove');
}
function calibrationPointerUp(ev) {
  if (!calib.drawing) return;
  calib.drawing = false;
  recordCalibrationSample(ev, 'pointerup');
  calib.strokeCount += 1;
  // pressure>0 の平均を target_pressure とする
  if (calib.pressures.length > 0) {
    const mean = calib.pressures.reduce((a, b) => a + b, 0) / calib.pressures.length;
    appState.target_pressure = mean;
    appState.pressure_low = Math.max(0, mean - appState.settings.pressure_tolerance);
    appState.pressure_high = mean + appState.settings.pressure_tolerance;
  }
  updateCalibrationUI();
  if (calib.strokeCount >= 3) {
    appState.mode = 'idle';
    // なぞり終了後、中央の操作カード(やり直し/次へ)を再表示する
    setHud({ top: true, pressure: true, bottom: false, center: true, controls: true, summary: false });
    updateCalibrationUI();
  }
}

function recordCalibrationSample(ev, type) {
  // 記録(raw にも phase=calibration として残す)
  pushRaw(Object.assign(eventToRowFields(ev, type), {
    phase: 'calibration',
    sync_role: 'none',
  }));
  if (ev.pressure > 0) calib.pressures.push(ev.pressure);
}

function updateCalibrationUI() {
  const tp = appState.target_pressure;
  setCenter(
    `キャリブレーション ${Math.min(calib.strokeCount, 3)} / 3`,
    tp !== null
      ? `target_pressure = ${tp.toFixed(3)} / 適正範囲 ${appState.pressure_low.toFixed(3)}〜${appState.pressure_high.toFixed(3)}`
      : '「キャリブレーション開始」を押し、中央の線を自然な強さで3回なぞってください',
    ''
  );
  const nextBtn = document.getElementById('calib-next');
  if (nextBtn) nextBtn.disabled = (tp === null || calib.strokeCount < 3);
}

/* ===================================================================
   12. 練習 (4-3)
   -------------------------------------------------------------------
   本番前に数試行だけ練習。phase=practice として raw に保存。
   summary には残さない。同期タップは行わない簡易版。
=================================================================== */

const practice = { remaining: 0 };

function enterPracticeIntro() {
  appState.screen = 'practice_intro';
  appState.mode = 'idle';
  appState.render.showGuideLine = false;
  appState.render.showSyncCircle = false;
  appState.render.practiceGuides = true;
  showPanel('stage');
  updateTopInfo(null, '練習');
  setHud({ top: true, pressure: true, bottom: true, center: true, controls: true, summary: false });
  setCenter('練習', '速度ガイドと筆圧ガイドを大きく表示して練習できます', '');
  setControls([
    { label: '練習開始', onClick: () => startPracticeTrial() },
    { label: '練習をスキップ', secondary: true, onClick: () => startMainExperiment() },
    { label: '本番へ進む', secondary: true, onClick: () => startMainExperiment() },
  ]);
  practice.remaining = NUM_PRACTICE_TRIALS;
}

function startPracticeTrial() {
  // ランダムな角度で練習試行を1本行う。練習では同期タップは行わず、
  // 本番と同じ自己ペース開始方式(始点タッチで開始)で運筆する。
  // phase=practice として raw に記録。
  const angle = Math.floor(Math.random() * NUM_DIRECTIONS) * DIRECTION_STEP_DEG;
  const fakeTrial = {
    block_index: '', trial_index: '', trial_global_index: '', repetition_index: '',
    target_angle_deg: angle,
  };
  trialCtx = newTrialCtx(fakeTrial, 'practice');
  appState.currentLine = computeLineEndpoints(angle);
  appState.render.practiceGuides = true; // 練習はガイドを大きく
  enterTrialReady();
}

function afterPracticeTrial() {
  practice.remaining -= 1;
  setHud({ top: true, pressure: true, bottom: true, center: true, controls: true, summary: false });
  if (practice.remaining > 0) {
    setCenter('練習', `残り ${practice.remaining} 本。続けますか？`, '');
    setControls([
      { label: 'もう一度練習', onClick: () => startPracticeTrial() },
      { label: '本番へ進む', secondary: true, onClick: () => startMainExperiment() },
    ]);
  } else {
    setCenter('練習終了', '本番へ進んでください', '');
    setControls([
      { label: 'もう一度練習', secondary: true, onClick: () => { practice.remaining = 1; startPracticeTrial(); } },
      { label: '本番へ進む', onClick: () => startMainExperiment() },
    ]);
  }
}

/* ===================================================================
   13. 同期タップ (汎用)
   -------------------------------------------------------------------
   開始前(3回) / 終了後(3回) を扱う。各試行前(1回)は試行シーケンス側で扱う。
=================================================================== */

const sync = {
  role: 'none',     // start_sync_tap / end_sync_tap
  phase: '',        // start_sync / end_sync
  needed: 0,
  count: 0,
  onComplete: null,
  downPending: false,
};

function enterStartSync() {
  appState.screen = 'start_sync';
  startGenericSync({
    phase: 'start_sync',
    role: 'start_sync_tap',
    needed: 3,
    title: '開始前同期タップ',
    instruction: 'PicoLogとMediaPipeの記録を開始した後、画面中央をペンで強く3回タップしてください',
    onComplete: () => enterBaselineProtocol(),
  });
}

function enterEndSync() {
  appState.screen = 'end_sync';
  startGenericSync({
    phase: 'end_sync',
    role: 'end_sync_tap',
    needed: 3,
    title: '終了後同期タップ',
    instruction: '最後にもう一度、画面中央をペンで強く3回タップしてください。その後PicoLogの記録を停止してください',
    onComplete: () => enterSave(),
  });
}

function startGenericSync(opts) {
  appState.mode = 'sync';
  sync.phase = opts.phase;
  sync.role = opts.role;
  sync.needed = opts.needed;
  sync.count = 0;
  sync.downPending = false;
  sync.onComplete = opts.onComplete;

  appState.render.showSyncCircle = true;
  appState.render.showGuideLine = false;

  showPanel('stage');
  updateTopInfo(null, opts.title);
  setHud({ top: true, pressure: true, bottom: false, center: true, controls: false, summary: false });
  setCenter(opts.title, opts.instruction, `0 / ${opts.needed}`);
}

// 同期タップの pointerdown: tap_index を付けて raw に記録
function syncPointerDown(ev) {
  sync.downPending = true;
  const tapIndex = sync.count + 1;
  pushRaw(Object.assign(eventToRowFields(ev, 'pointerdown'), {
    phase: sync.phase,
    sync_role: sync.role,
    tap_index: tapIndex,
  }));
}

function syncPointerUp(ev) {
  if (!sync.downPending) return;
  sync.downPending = false;
  const tapIndex = sync.count + 1;
  pushRaw(Object.assign(eventToRowFields(ev, 'pointerup'), {
    phase: sync.phase,
    sync_role: sync.role,
    tap_index: tapIndex,
  }));
  sync.count += 1;
  hud.centerCount.textContent = `${sync.count} / ${sync.needed}`;
  if (sync.count >= sync.needed) {
    appState.mode = 'idle';
    appState.render.showSyncCircle = false;
    const cb = sync.onComplete;
    setTimeout(() => { if (cb) cb(); }, 400);
  }
}

/* ===================================================================
   13.2 安静時ベースライン計測
   -------------------------------------------------------------------
   MVCより前に「完全安静」「タスク姿勢安静」を各1回計測する。
   各条件の開始・終了は物理タップで記録し、解析区間は
   開始pointerup+guard ～ 終了pointerdown-guard とする。
=================================================================== */

const baseline = {
  conditionIndex: 0,
  stage: 'idle',
  downPending: false,
  startTapDown: null,
  startTapUp: null,
  endTapDown: null,
  endTapUp: null,
  unexpectedContactCount: 0,
  targetEndTimeMs: null,
  countdownTimer: null,
};

function currentBaselineCondition() {
  return BASELINE_CONDITIONS[baseline.conditionIndex] || null;
}

function clearBaselineTimer() {
  if (baseline.countdownTimer !== null) {
    clearInterval(baseline.countdownTimer);
    baseline.countdownTimer = null;
  }
}

function resetCurrentBaselineCondition() {
  clearBaselineTimer();
  baseline.stage = 'intro';
  baseline.downPending = false;
  baseline.startTapDown = null;
  baseline.startTapUp = null;
  baseline.endTapDown = null;
  baseline.endTapUp = null;
  baseline.unexpectedContactCount = 0;
  baseline.targetEndTimeMs = null;
}

function enterBaselineProtocol() {
  appState.screen = 'baseline';
  appState.mode = 'idle';
  baseline.conditionIndex = 0;
  resetCurrentBaselineCondition();
  appState.render.showSyncCircle = false;
  appState.render.showGuideLine = false;
  showPanel('stage');
  showBaselineConditionIntro();
}

function showBaselineConditionIntro() {
  const condition = currentBaselineCondition();
  if (!condition) {
    finishBaselineProtocol();
    return;
  }
  appState.mode = 'idle';
  baseline.stage = 'intro';
  appState.render.showSyncCircle = false;
  updateTopInfo(null, '安静時ベースライン');
  setHud({ top: true, pressure: false, bottom: false, center: true, controls: true, summary: false });
  const firstNote = baseline.conditionIndex === 0
    ? 'PicoLogとMediaPipeの記録を継続してください。 '
    : '';
  setCenter(
    `安静時計測 ${condition.id} / ${BASELINE_CONDITIONS.length}：${condition.label}`,
    `${firstNote}${condition.instruction} 計測時間は${appState.settings.baseline_duration_ms / 1000}秒です。`,
    ''
  );
  setControls([
    { label: '準備完了・開始タップへ', onClick: prepareBaselineStartTap },
  ]);
}

function prepareBaselineStartTap() {
  const condition = currentBaselineCondition();
  if (!condition) return;
  appState.mode = 'baseline';
  baseline.stage = 'awaiting_start_tap';
  baseline.downPending = false;
  appState.render.showSyncCircle = true;
  setHud({ top: true, pressure: true, bottom: false, center: true, controls: false, summary: false });
  setCenter(
    `${condition.label}：開始タップ`,
    '画面中央をペンで1回強くタップしてください。ペンを離した時点から計測を開始します。',
    '開始待ち'
  );
}

function baselineTagFields(stage) {
  const condition = currentBaselineCondition();
  const isBoundaryTap = stage.startsWith('start_boundary') || stage.startsWith('end_boundary');
  return {
    phase: 'baseline',
    // 一般の同期タップ抽出条件(*_sync_tap)へ混入させない専用名。
    sync_role: isBoundaryTap ? 'baseline_marker_tap' : 'none',
    tap_index: stage === 'start_boundary' ? 1 : (stage === 'end_boundary' ? 2 : ''),
    baseline_id: condition ? condition.id : '',
    baseline_type: condition ? condition.type : '',
    baseline_stage: stage,
    baseline_target_duration_ms: appState.settings.baseline_duration_ms,
    baseline_guard_ms: appState.settings.baseline_guard_ms,
    baseline_unexpected_contact_count: baseline.unexpectedContactCount,
  };
}

function pushBaselinePointer(ev, eventType, stage) {
  return pushRaw(Object.assign(eventToRowFields(ev, eventType), baselineTagFields(stage)));
}

function baselinePointerDown(ev) {
  if (baseline.stage === 'awaiting_start_tap') {
    if (baseline.downPending) return;
    baseline.downPending = true;
    baseline.startTapDown = pushBaselinePointer(ev, 'pointerdown', 'start_boundary');
    return;
  }
  if (baseline.stage === 'baseline_interval') {
    baseline.unexpectedContactCount += 1;
    pushBaselinePointer(ev, 'pointerdown', 'unexpected_contact');
    return;
  }
  if (baseline.stage === 'awaiting_end_tap') {
    if (baseline.downPending) return;
    baseline.downPending = true;
    baseline.endTapDown = pushBaselinePointer(ev, 'pointerdown', 'end_boundary');
  }
}

function baselinePointerMove(ev) {
  if (baseline.stage === 'baseline_interval') {
    pushBaselinePointer(ev, 'pointermove', 'baseline_interval');
  }
}

function baselinePointerUp(ev) {
  if (baseline.stage === 'awaiting_start_tap' && baseline.downPending) {
    baseline.downPending = false;
    baseline.startTapUp = pushBaselinePointer(ev, 'pointerup', 'start_boundary');
    startBaselineInterval();
    return;
  }
  if (baseline.stage === 'baseline_interval') {
    pushBaselinePointer(ev, 'pointerup', 'unexpected_contact');
    return;
  }
  if (baseline.stage === 'awaiting_end_tap' && baseline.downPending) {
    baseline.downPending = false;
    baseline.endTapUp = pushBaselinePointer(ev, 'pointerup', 'end_boundary');
    finishBaselineCondition();
  }
}

function baselinePointerCancel(ev) {
  const stage = baseline.stage === 'awaiting_start_tap'
    ? 'start_boundary_cancelled'
    : (baseline.stage === 'awaiting_end_tap' ? 'end_boundary_cancelled' : 'unexpected_contact');
  pushBaselinePointer(ev, 'pointercancel', stage);
  baseline.downPending = false;
}

function startBaselineInterval() {
  const condition = currentBaselineCondition();
  baseline.stage = 'baseline_interval';
  baseline.targetEndTimeMs = Number(baseline.startTapUp.timestamp_ms) + appState.settings.baseline_duration_ms;
  appState.render.showSyncCircle = false;
  setHud({ top: true, pressure: false, bottom: false, center: true, controls: false, summary: false });
  setCenter(`${condition.label}：計測中`, condition.instruction, '');

  const updateCountdown = () => {
    const remainingMs = Math.max(0, baseline.targetEndTimeMs - nowMs());
    hud.centerCount.textContent = `残り ${(remainingMs / 1000).toFixed(1)} 秒`;
    if (remainingMs <= 0) enableBaselineEndTap();
  };
  updateCountdown();
  baseline.countdownTimer = setInterval(updateCountdown, 100);
}

function enableBaselineEndTap() {
  if (baseline.stage !== 'baseline_interval') return;
  clearBaselineTimer();
  const condition = currentBaselineCondition();
  baseline.stage = 'awaiting_end_tap';
  baseline.downPending = false;
  appState.render.showSyncCircle = true;
  setHud({ top: true, pressure: true, bottom: false, center: true, controls: false, summary: false });
  setCenter(
    `${condition.label}：終了タップ`,
    '計測時間が終了しました。画面中央をペンで1回強くタップしてください。',
    '終了待ち'
  );
}

function pushBaselineAnalysisMarker(eventType, timestampMs, epochMs, valid) {
  const stage = eventType === 'baseline_analysis_start' ? 'analysis_start' : 'analysis_end';
  return pushRaw(Object.assign(baselineTagFields(stage), {
    sync_role: 'none',
    event_type: eventType,
    timestamp_ms: round(timestampMs, 3),
    epoch_ms: Math.round(epochMs),
    iso_time: new Date(epochMs).toISOString(),
    baseline_unexpected_contact_count: baseline.unexpectedContactCount,
    baseline_valid: valid ? 1 : 0,
  }));
}

function finishBaselineCondition() {
  clearBaselineTimer();
  appState.mode = 'idle';
  appState.render.showSyncCircle = false;
  const condition = currentBaselineCondition();
  const guardMs = appState.settings.baseline_guard_ms;
  const startUpMs = Number(baseline.startTapUp.timestamp_ms);
  const startUpEpochMs = Number(baseline.startTapUp.epoch_ms);
  const endDownMs = Number(baseline.endTapDown.timestamp_ms);
  const endDownEpochMs = Number(baseline.endTapDown.epoch_ms);
  const analysisStartMs = startUpMs + guardMs;
  const analysisEndMs = endDownMs - guardMs;
  const analysisStartEpochMs = startUpEpochMs + guardMs;
  const analysisEndEpochMs = endDownEpochMs - guardMs;
  const analysisDurationMs = analysisEndMs - analysisStartMs;
  const recordedDurationMs = endDownMs - startUpMs;
  const valid = analysisDurationMs > 0
    && recordedDurationMs >= appState.settings.baseline_duration_ms
    && baseline.unexpectedContactCount === 0;

  pushBaselineAnalysisMarker('baseline_analysis_start', analysisStartMs, analysisStartEpochMs, valid);
  pushBaselineAnalysisMarker('baseline_analysis_end', analysisEndMs, analysisEndEpochMs, valid);
  appState.baselineIntervals.push({
    baseline_id: condition.id,
    baseline_type: condition.type,
    baseline_label: condition.label,
    start_tap_pointerdown_time_ms: Number(baseline.startTapDown.timestamp_ms),
    start_tap_pointerdown_epoch_ms: Number(baseline.startTapDown.epoch_ms),
    start_tap_pointerup_time_ms: startUpMs,
    start_tap_pointerup_epoch_ms: startUpEpochMs,
    end_tap_pointerdown_time_ms: endDownMs,
    end_tap_pointerdown_epoch_ms: endDownEpochMs,
    end_tap_pointerup_time_ms: Number(baseline.endTapUp.timestamp_ms),
    end_tap_pointerup_epoch_ms: Number(baseline.endTapUp.epoch_ms),
    analysis_start_time_ms: analysisStartMs,
    analysis_start_epoch_ms: analysisStartEpochMs,
    analysis_end_time_ms: analysisEndMs,
    analysis_end_epoch_ms: analysisEndEpochMs,
    analysis_duration_ms: analysisDurationMs,
    recorded_duration_ms: recordedDurationMs,
    target_duration_ms: appState.settings.baseline_duration_ms,
    guard_ms: guardMs,
    unexpected_contact_count: baseline.unexpectedContactCount,
    valid,
  });

  baseline.stage = 'complete';
  updateTopInfo(null, '安静時ベースライン');
  setHud({ top: true, pressure: false, bottom: false, center: true, controls: true, summary: false });
  setCenter(
    `${condition.label}の計測完了`,
    `解析区間 ${(analysisDurationMs / 1000).toFixed(1)}秒 ／ 画面への予期しない接触 ${baseline.unexpectedContactCount}回`,
    valid
      ? '記録済み'
      : (baseline.unexpectedContactCount > 0 ? '接触があったため、この区間は要確認です' : '解析区間が不正です')
  );
  const isLast = baseline.conditionIndex >= BASELINE_CONDITIONS.length - 1;
  setControls([{
    label: isLast ? 'MVCキャリブレーションへ' : '次の安静条件へ',
    onClick: () => {
      baseline.conditionIndex += 1;
      if (baseline.conditionIndex >= BASELINE_CONDITIONS.length) finishBaselineProtocol();
      else {
        resetCurrentBaselineCondition();
        showBaselineConditionIntro();
      }
    },
  }]);
}

function finishBaselineProtocol() {
  clearBaselineTimer();
  appState.mode = 'idle';
  enterMvcCalibration();
}

/* ===================================================================
   13.5 EMG 最大随意収縮(MVC)キャリブレーション
   -------------------------------------------------------------------
   筋電図の正規化用に、手首の4方向(掌屈/背屈/橈屈/尺屈)で最大随意収縮を行い、
   各収縮の「開始時刻」「終了時刻」を Wacom の timestamp_ms で記録する。
   PicoLog 記録中に行い、後処理で同期タップを介して EMG 区間を切り出せるようにする。
   (筋電位そのものはアプリでは取得しない。記録するのは時刻マーカーのみ)
=================================================================== */

// 4方向のMVC。arrow は手UIの矢印方向(canvas座標: 上は -y)。
const MVC_DIRECTIONS = [
  { key: 'palmar_flexion', label: '掌屈', instruction: '手首を手のひら側へ思い切り曲げてください', arrow: 'down' },
  { key: 'dorsiflexion',   label: '背屈', instruction: '手首を手の甲側へ思い切り反らしてください', arrow: 'up' },
  { key: 'radial_deviation', label: '橈屈', instruction: '手首を親指側へ思い切り曲げてください', arrow: 'right' },
  { key: 'ulnar_deviation',  label: '尺屈', instruction: '手首を小指側へ思い切り曲げてください', arrow: 'left' },
];

const mvc = {
  index: 0,          // 現在の方向(0..3)
  recording: false,  // 収縮中(計測中)か
  startTimeMs: null,
};

function enterMvcCalibration() {
  appState.screen = 'mvc';
  appState.mode = 'idle';
  mvc.index = 0;
  mvc.recording = false;
  mvc.startTimeMs = null;
  appState.render.showSyncCircle = false;
  appState.render.showGuideLine = false;
  showPanel('stage');
  showMvcStep();
}

// 現在の方向の「開始前」表示(スタート待ち)
function showMvcStep() {
  if (mvc.index >= MVC_DIRECTIONS.length) { finishMvc(); return; }
  const dir = MVC_DIRECTIONS[mvc.index];
  mvc.recording = false;
  updateTopInfo(null, 'MVCキャリブレーション');
  setHud({ top: true, pressure: false, bottom: false, center: true, controls: true, summary: false });
  // PicoLog・MediaPipeは安静時計測から継続記録する。
  const picologNote = (mvc.index === 0)
    ? '※ PicoLog・MediaPipeの記録を継続してください。 '
    : '';
  setCenter(
    `最大随意収縮(MVC) ${mvc.index + 1} / 4 : ${dir.label}`,
    `${picologNote}準備ができたら「スタート」を押し、合図後に ${dir.instruction.replace('てください', '')} てください`,
    ''
  );
  setControls([
    { label: `スタート（${dir.label}）`, onClick: mvcStart },
  ]);
}

// スタート: 収縮開始時刻を記録し、終了ボタンを表示
function mvcStart() {
  const dir = MVC_DIRECTIONS[mvc.index];
  mvc.recording = true;
  mvc.startTimeMs = round(nowMs(), 3);
  // raw に開始マーカーを記録
  pushRaw({
    phase: 'mvc',
    sync_role: 'none',
    event_type: 'mvc_start',
    mvc_direction: dir.key,
    tap_index: mvc.index + 1,
    timestamp_ms: mvc.startTimeMs,
    epoch_ms: Date.now(),
    iso_time: new Date().toISOString(),
  });
  console.log('[mvc_start]', dir.key, mvc.startTimeMs);

  setHud({ top: true, pressure: false, bottom: false, center: true, controls: true, summary: false });
  setCenter(`${dir.label}：思い切り収縮してください`, dir.instruction, '計測中…');
  setControls([
    { label: '終了しました', onClick: mvcEnd },
  ]);
}

// 終了しました: 収縮終了時刻を記録し、次の方向へ
function mvcEnd() {
  if (!mvc.recording) return;
  const dir = MVC_DIRECTIONS[mvc.index];
  mvc.recording = false;
  const endMs = round(nowMs(), 3);
  pushRaw({
    phase: 'mvc',
    sync_role: 'none',
    event_type: 'mvc_end',
    mvc_direction: dir.key,
    tap_index: mvc.index + 1,
    timestamp_ms: endMs,
    epoch_ms: Date.now(),
    iso_time: new Date().toISOString(),
  });
  console.log('[mvc_end]', dir.key, endMs, 'duration_ms=', round(endMs - mvc.startTimeMs, 1));

  mvc.index += 1;
  showMvcStep();
}

function finishMvc() {
  appState.screen = 'mvc_done';
  setHud({ top: true, pressure: false, bottom: false, center: true, controls: true, summary: false });
  setCenter('MVCキャリブレーション完了', '4方向の最大随意収縮を記録しました。続いて筆圧キャリブレーションへ進みます。', '');
  setControls([
    { label: '筆圧キャリブレーションへ', onClick: () => enterCalibration() },
  ]);
}

// MVC 画面で手のイラスト(✋)と方向矢印を描く
function drawMvcHand(ctx, W, H) {
  if (mvc.index >= MVC_DIRECTIONS.length) return;
  const dir = MVC_DIRECTIONS[mvc.index];
  // 中央の操作カードと重ならないよう、手イラストは左側に表示する
  const cx = W * 0.22;
  const cy = H * 0.45;

  ctx.save();
  // 手のイラスト(絵文字)
  ctx.font = '120px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('✋', cx, cy);

  // 方向矢印
  const len = 90;
  let ax = 0, ay = 0;
  if (dir.arrow === 'up') ay = -1;
  else if (dir.arrow === 'down') ay = 1;
  else if (dir.arrow === 'left') ax = -1;
  else if (dir.arrow === 'right') ax = 1;

  const offset = 110; // 手から少し離す
  const sx = cx + ax * offset;
  const sy = cy + ay * offset;
  const ex = sx + ax * len;
  const ey = sy + ay * len;

  ctx.strokeStyle = mvc.recording ? '#cf222e' : '#0969da';
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = 10;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(ex, ey);
  ctx.stroke();
  // 矢じり
  const head = 22;
  const angle = Math.atan2(ey - sy, ex - sx);
  ctx.beginPath();
  ctx.moveTo(ex, ey);
  ctx.lineTo(ex - head * Math.cos(angle - Math.PI / 6), ey - head * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(ex - head * Math.cos(angle + Math.PI / 6), ey - head * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();

  // 方向ラベル
  ctx.font = 'bold 26px sans-serif';
  ctx.fillStyle = '#1f2328';
  ctx.fillText(dir.label, cx, cy + 95);
  ctx.restore();
}

/* ===================================================================
   14. 本番実験の進行
=================================================================== */

function startMainExperiment() {
  appState.currentTrialPos = 0;
  nextTrial();
}

function nextTrial() {
  if (appState.currentTrialPos >= appState.trialOrder.length) {
    // 全試行終了 → 終了後同期タップ
    enterEndSync();
    return;
  }
  const trial = appState.trialOrder[appState.currentTrialPos];
  enterPreTrialSync(trial);
}

// 休憩判定: rest_every_trials ごとに休憩画面
function maybeRest(afterTrialGlobalIndex) {
  const every = appState.settings.rest_every_trials;
  const total = appState.trialOrder.length;
  if (afterTrialGlobalIndex < total && every > 0 && afterTrialGlobalIndex % every === 0) {
    enterRest(afterTrialGlobalIndex, total);
    return true;
  }
  return false;
}

/* ===================================================================
   15. 各試行前同期タップ (4-5) + 待機 + カウントダウン + 試行
   -------------------------------------------------------------------
   1試行のシーケンス全体をここで管理する。
=================================================================== */

// 現在の試行コンテキスト(記録のバックフィルや summary 計算に使う)
let trialCtx = null;

function newTrialCtx(trial, phase) {
  let attemptIndex = '';
  let attemptId = '';
  if (phase === 'trial') {
    const key = String(trial.trial_global_index);
    attemptIndex = (appState.attemptCounts[key] || 0) + 1;
    appState.attemptCounts[key] = attemptIndex;
    attemptId = `${appState.session_id}_T${String(trial.trial_global_index).padStart(3, '0')}_A${String(attemptIndex).padStart(2, '0')}`;
  }
  return {
    trial,
    phase,                          // 'trial' or 'practice'
    rawRows: [],                    // この試行(運筆)で記録した raw 行
    preTrialSyncRows: [],           // pre_trial_sync タップの raw 行
    attemptRows: [],                // 同期タップ〜結果ボタンまでに属する全raw行
    attempt_index: attemptIndex,
    attempt_id: attemptId,
    attempt_stage: phase === 'trial' ? 'pre_trial_sync' : '',
    attempt_outcome: '',
    trial_window_active: false,
    trial_window_start_time_ms: '',
    trial_window_start_epoch_ms: '',
    trial_ready_time_ms: '',
    result_display_time_ms: '',
    trial_window_end_time_ms: '',
    trial_window_end_epoch_ms: '',
    trial_start_button_time_ms: '',
    countdown_go_time_ms: '',
    first_pointerdown_time_ms: null,
    last_pointerup_time_ms: null,
    trial_end_time_ms: null,
    pre_sync_tap_time_ms: '',
    pre_sync_tap_epoch_ms: '',
    pre_sync_tap_pressure: '',
    pointerdown_count: 0,
    drawing: false,
    finalizeTimer: null,
    pressureZeroTimer: null,        // 筆圧0継続による補助的ペン離れ検出
    targetStartPerf: 0,
    rejected: false,
    // --- 自己ペース開始方式 ---
    awaitingStart: false,           // 始点タッチ待ち
    started: false,                 // 始点タッチ済み(trial記録開始済み)
    touch_start_time_ms: '',        // 始点タッチ時刻(実質運筆開始)
    movement_onset_time_ms: null,   // 始点から閾値以上動いた最初の時刻
    movement_offset_time_ms: null,
    movement_offset_method: '',
    kinematicTiming: null,
    last_movement_sample: null,
    start_touch_x_px: '',
    start_touch_y_px: '',
    end_release_x_px: '',
    end_release_y_px: '',
  };
}

function attemptTagFields(stageOverride) {
  if (!trialCtx || trialCtx.phase !== 'trial') return {};
  return {
    attempt_index: trialCtx.attempt_index,
    attempt_id: trialCtx.attempt_id,
    attempt_stage: stageOverride || trialCtx.attempt_stage,
    attempt_outcome: trialCtx.attempt_outcome,
    trial_window_start_time_ms: trialCtx.trial_window_start_time_ms,
    trial_window_start_epoch_ms: trialCtx.trial_window_start_epoch_ms,
    trial_ready_time_ms: trialCtx.trial_ready_time_ms,
    result_display_time_ms: trialCtx.result_display_time_ms,
    trial_window_end_time_ms: trialCtx.trial_window_end_time_ms,
    trial_window_end_epoch_ms: trialCtx.trial_window_end_epoch_ms,
  };
}

function pushAttemptRaw(partial, stageOverride) {
  const enriched = Object.assign({}, partial);
  if (trialCtx && trialCtx.started &&
      Number.isFinite(Number(enriched.timestamp_ms)) &&
      Number.isFinite(Number(enriched.x_px)) &&
      Number.isFinite(Number(enriched.y_px))) {
    Object.assign(enriched, trackingFieldsAt(
      Number(enriched.timestamp_ms), Number(enriched.x_px), Number(enriched.y_px)
    ));
  }
  const row = pushRaw(Object.assign(enriched, attemptTagFields(stageOverride)));
  if (trialCtx && trialCtx.phase === 'trial') trialCtx.attemptRows.push(row);
  return row;
}

function pushAttemptMarker(eventType, sourceTimeFields, stageOverride) {
  const timeFields = sourceTimeFields || {
    timestamp_ms: round(nowMs(), 3),
    epoch_ms: Date.now(),
    iso_time: new Date().toISOString(),
  };
  return pushAttemptRaw(Object.assign({}, timeFields, trialTagFields(), {
    phase: 'trial_window',
    sync_role: 'none',
    event_type: eventType,
  }), stageOverride);
}

// 試行前同期タップ画面
function enterPreTrialSync(trial) {
  appState.screen = 'pre_trial_sync';
  appState.mode = 'sync';
  trialCtx = newTrialCtx(trial, 'trial');
  trialCtx.trial_start_button_time_ms = round(nowMs(), 3);

  appState.currentLine = computeLineEndpoints(trial.target_angle_deg);
  appState.render.showSyncCircle = true;
  appState.render.showGuideLine = false;
  appState.render.practiceGuides = false;

  // pre_trial_sync 専用に sync オブジェクトを設定(1回タップ)
  sync.phase = 'pre_trial_sync';
  sync.role = 'pre_trial_sync_tap';
  sync.needed = 1;
  sync.count = 0;
  sync.downPending = false;
  sync.onComplete = null; // 専用ハンドラで処理

  showPanel('stage');
  updateTopInfo(trial, '試行前同期タップ');
  setHud({ top: true, pressure: true, bottom: false, center: true, controls: false, summary: false });
  setCenter('同期用に、画面中央をペンで強く1回タップしてください', '', '0 / 1');

  // pre_trial_sync は専用の pointer 処理に差し替える
  appState.mode = 'pre_trial_sync_mode';
}

// pre_trial_sync は mode 'pre_trial_sync_mode' として onPointer* から分岐させる。
// (10章のルーティングに追記する代わりに、ここで個別処理を呼ぶ)

function preTrialSyncDown(ev) {
  const row = pushAttemptRaw(Object.assign(eventToRowFields(ev, 'pointerdown'),
    Object.assign(trialTagFields(), {
      phase: 'pre_trial_sync',
      sync_role: 'pre_trial_sync_tap',
      tap_index: 1,
    })), 'pre_trial_sync');
  trialCtx.preTrialSyncRows.push(row);
  // summary 用に pointerdown 時点の値を保持
  trialCtx.pre_sync_tap_time_ms = row.timestamp_ms;
  trialCtx.pre_sync_tap_epoch_ms = row.epoch_ms;
  trialCtx.pre_sync_tap_pressure = row.pressure;
  sync.downPending = true;
}

function preTrialSyncUp(ev) {
  if (!sync.downPending) return;
  sync.downPending = false;
  const row = pushAttemptRaw(Object.assign(eventToRowFields(ev, 'pointerup'),
    Object.assign(trialTagFields(), {
      phase: 'pre_trial_sync',
      sync_role: 'pre_trial_sync_tap',
      tap_index: 1,
    })), 'pre_trial_sync');
  trialCtx.preTrialSyncRows.push(row);
  // 試行区間は同期タップを離した瞬間から開始する。
  trialCtx.trial_window_start_time_ms = row.timestamp_ms;
  trialCtx.trial_window_start_epoch_ms = row.epoch_ms;
  trialCtx.trial_window_active = true;
  trialCtx.attempt_stage = 'post_sync_wait';
  pushAttemptMarker('trial_window_start', {
    timestamp_ms: row.timestamp_ms,
    epoch_ms: row.epoch_ms,
    iso_time: row.iso_time,
  }, 'post_sync_wait');
  hud.centerCount.textContent = '1 / 1';
  appState.mode = 'idle';
  appState.render.showSyncCircle = false;
  // タップの筋活動が運筆に混ざらないよう pre_trial_sync_wait_ms 待機
  startPreTrialWait();
}

function startPreTrialWait() {
  const wait = appState.settings.pre_trial_sync_wait_ms;
  setCenter('待機中...', 'タップ後の筋活動を落ち着かせています', '');
  // 待機後、カウントダウンせず「始点タッチ待ち」状態へ移行する
  setTimeout(() => enterTrialReady(), wait);
}

/* ---------- 始点タッチ待ち + 一定速度ガイド方式 ----------
   始点・終点・点線を表示し、参加者が自分のタイミングで始点をタッチする。
   始点ゾーン内の pointerdown を実質運筆開始(touch_start_time_ms)とし、
   その瞬間からガイドリングが目標時間をかけて終点へ進む。 */
function enterTrialReady() {
  appState.screen = 'trial';
  appState.mode = 'trial';
  const trial = trialCtx.trial;
  // 現在の canvas サイズ・現在の線の長さで始点/終点/点線を必ず再計算する
  resizeCanvas();
  appState.currentLine = computeLineEndpoints(trial.target_angle_deg);
  appState.render.showGuideLine = true;          // 始点/終点/直線を表示
  appState.render.targetProgress = 0;
  appState.render.practiceGuides = (trialCtx.phase === 'practice');

  // 始点タッチ待ち状態
  trialCtx.awaitingStart = true;
  trialCtx.started = false;
  if (trialCtx.phase === 'trial') {
    trialCtx.trial_ready_time_ms = round(nowMs(), 3);
    trialCtx.attempt_stage = 'awaiting_start';
    pushAttemptMarker('trial_ready', null, 'awaiting_start');
  }

  setHud({ top: true, pressure: true, bottom: true, center: true, controls: false, summary: false });
  // 始点タッチ前のみ指示文を表示(運筆中は trialPointerDown でクリアして線を優先)。
  // 大きな中央見出しは線に重なるため、控えめなサブ表示にする。
  const targetSeconds = (Number(appState.settings.target_duration_ms) / 1000).toFixed(2);
  const detail = (trialCtx.phase === 'practice') ? '練習' : '本番';
  setCenter('', `始点をタッチすると青いガイドリングが動きます。ペン先をリングに合わせ、${targetSeconds}秒かけて終点まで動かしてください / ${detail}`, '');

  // 各試行開始時のデバッグ表示
  console.log('[trial ready]', trialCtx.trial);
  console.log('[line]', appState.currentLine);
  console.log('[canvas]', appState.cssW, appState.cssH);
  if (!appState.cssW || !appState.cssH) {
    console.warn('Canvas size is zero. Check panel visibility and resize timing.');
  }
}

/* ---------- 試行中の pointer 処理 ---------- */

// 現在の試行のタグ列(phase/角度/index など)を返す
function trialTagFields() {
  const t = trialCtx ? trialCtx.trial : null;
  return Object.assign({
    phase: trialCtx ? trialCtx.phase : '',
    sync_role: 'none',
    block_index: t ? t.block_index : '',
    trial_index: t ? t.trial_index : '',
    trial_global_index: t ? t.trial_global_index : '',
    repetition_index: t ? t.repetition_index : '',
    target_angle_deg: t ? t.target_angle_deg : '',
  }, attemptTagFields());
}

// 補助的ペン離れ検出のタイマーを止める
function clearPressureZeroTimer() {
  if (trialCtx && trialCtx.pressureZeroTimer) {
    clearTimeout(trialCtx.pressureZeroTimer);
    trialCtx.pressureZeroTimer = null;
  }
}

function trialPointerDown(ev) {
  const fields = eventToRowFields(ev, 'pointerdown');
  const ideal = appState.currentLine;

  // --- まだ始点タッチしていない場合: 始点ゾーン判定 ---
  if (!trialCtx.started) {
    const dist = ideal ? distanceCssPxInMm(fields.x_px, fields.y_px, ideal.start.x, ideal.start.y) : 0;
    // 練習・本番とも、同じ5mmの始点ゾーン内のみ開始する。
    const inZone = dist <= START_ZONE_RADIUS_MM;
    if (!inZone) {
      // 始点範囲外のタッチ。trialには含めず pre_start_touch として raw にだけ残す。
      pushAttemptRaw(Object.assign(fields, Object.assign(trialTagFields(), {
        phase: 'pre_start_touch', sync_role: 'none',
      })), 'awaiting_start');
      setCenter('', '始点の円の中をタッチしてください', '');
      console.log('[pre_start_touch] outside start zone', round(dist, 1));
      return;
    }
    // 始点タッチ成立: この瞬間を実質運筆開始とする
    trialCtx.started = true;
    trialCtx.awaitingStart = false;
    trialCtx.drawing = true;
    trialCtx.attempt_stage = 'drawing';
    trialCtx.pointerdown_count = 1;            // 始点タッチは「0回目」(ペン離れに数えない)
    trialCtx.touch_start_time_ms = fields.timestamp_ms;
    trialCtx.start_touch_x_px = fields.x_px;
    trialCtx.start_touch_y_px = fields.y_px;
    trialCtx.last_movement_sample = { timestamp_ms: fields.timestamp_ms, distance_mm: 0 };
    setCenter('', '', '');                     // 指示文を消す
    const row = pushAttemptRaw(Object.assign(fields, trialTagFields()), 'drawing'); // phase=trial
    trialCtx.rawRows.push(row);
    if (trialCtx.first_pointerdown_time_ms === null) {
      trialCtx.first_pointerdown_time_ms = row.timestamp_ms;
    }
    console.log('[trial start touch]', row.timestamp_ms, row.pressure, 'dist_mm=', round(ideal ? distanceCssPxInMm(fields.x_px, fields.y_px, ideal.start.x, ideal.start.y) : 0, 2));
    return;
  }

  // --- 既に開始済み: ペン離れからの復帰(同一試行として継続) ---
  if (trialCtx.finalizeTimer) {
    clearTimeout(trialCtx.finalizeTimer);
    trialCtx.finalizeTimer = null;
  }
  clearPressureZeroTimer();
  setCenter('', '', ''); // 「ペン離れ検出」表示を消す
  trialCtx.drawing = true;
  trialCtx.attempt_stage = 'drawing';
  trialCtx.pointerdown_count += 1;
  const row = pushAttemptRaw(Object.assign(fields, trialTagFields()), 'drawing');
  trialCtx.rawRows.push(row);
  console.log('[pointerdown re-touch]', row.timestamp_ms, row.pressure);
}

function trialPointerMove(ev) {
  if (!trialCtx.drawing) {
    recordAttemptPointerEvents(ev, 'pointermove');
    return;
  }
  // getCoalescedEvents が使える場合は高密度に記録する
  let events = [ev];
  if (typeof ev.getCoalescedEvents === 'function') {
    const co = ev.getCoalescedEvents();
    if (co && co.length > 0) events = co;
  }
  const handlerPerformanceNow = performance.now();
  events.forEach((e, index) => {
    const row = pushAttemptRaw(Object.assign(eventToRowFields(e, 'pointermove', {
      handlerPerformanceNow,
      coalescedBatchSize: events.length,
      coalescedEventIndex: index,
    }), trialTagFields()), 'drawing');
    trialCtx.rawRows.push(row);
    // movement onset: 実際の最初の接触位置から閾値以上離れた最初の時刻
    if (trialCtx.movement_onset_time_ms === null &&
        Number.isFinite(Number(trialCtx.start_touch_x_px)) &&
        Number.isFinite(Number(trialCtx.start_touch_y_px))) {
      const d = distanceCssPxInMm(
        trialCtx.start_touch_x_px, trialCtx.start_touch_y_px, row.x_px, row.y_px
      );
      if (d >= MOVEMENT_ONSET_THRESHOLD_MM) {
        // 閾値をまたぐ2点間を線形補間し、サンプル間の通過時刻を推定する。
        const previous = trialCtx.last_movement_sample;
        if (previous && previous.distance_mm < MOVEMENT_ONSET_THRESHOLD_MM && d > previous.distance_mm) {
          const ratio = clamp(
            (MOVEMENT_ONSET_THRESHOLD_MM - previous.distance_mm) / (d - previous.distance_mm), 0, 1
          );
          trialCtx.movement_onset_time_ms = round(
            Number(previous.timestamp_ms) + (Number(row.timestamp_ms) - Number(previous.timestamp_ms)) * ratio, 3
          );
        } else {
          trialCtx.movement_onset_time_ms = row.timestamp_ms;
        }
      }
      trialCtx.last_movement_sample = { timestamp_ms: row.timestamp_ms, distance_mm: d };
    }
  });

  // --- 補助的なペン離れ検出(筆圧0が一定時間続いた場合) ---
  // Wacom では hover 中に pressure 0 の move が入ることがあるため、すぐ確定せず
  // PRESSURE_ZERO_LIFT_MS 継続したら pointerup 相当とみなす。無効化も可能。
  if (ENABLE_PRESSURE_ZERO_LIFT) {
    if ((ev.pressure || 0) === 0) {
      if (!trialCtx.pressureZeroTimer) {
        trialCtx.pressureZeroTimer = setTimeout(() => {
          if (trialCtx && trialCtx.drawing) {
            console.log('[pressure-zero lift] treated as pen lift', nowMs());
            trialPointerUp(ev);
          }
        }, PRESSURE_ZERO_LIFT_MS);
      }
    } else {
      clearPressureZeroTimer(); // 筆圧が戻ったらキャンセル
    }
  }
}

function trialPointerUp(ev) {
  if (!trialCtx.drawing) {
    recordAttemptPointerEvents(ev, 'pointerup');
    return;
  }
  trialCtx.drawing = false;
  clearPressureZeroTimer();
  const row = pushAttemptRaw(Object.assign(eventToRowFields(ev, 'pointerup'), trialTagFields()), 'drawing');
  trialCtx.rawRows.push(row);
  // last_pointerup_time_ms は「ペンが離れた瞬間」の時刻。遅延させず即時保存する。
  trialCtx.last_pointerup_time_ms = row.timestamp_ms;
  // 終点リリース座標(最後の pointerup の座標)を保持
  trialCtx.end_release_x_px = row.x_px;
  trialCtx.end_release_y_px = row.y_px;
  trialCtx.attempt_stage = 'post_drawing_grace';
  console.log('[pointerup]', row.timestamp_ms, row.pressure);

  // UI 上の即時フィードバック(データの確定は猶予後)
  setCenter('', 'ペン離れを検出しました', '');

  // 猶予時間内に再 pointerdown が無ければ試行確定(UIの確定だけ遅らせる)
  console.log('[finalize scheduled]', FINALIZE_GRACE_MS);
  trialCtx.finalizeTimer = setTimeout(() => finalizeTrial(), FINALIZE_GRACE_MS);
}

/* ===================================================================
   16. 試行確定 → summary 計算
=================================================================== */

function finalizeTrial() {
  // 多重実行を防ぐ(pressure-zero/lostpointercapture/pointerup が重なる可能性)
  if (appState.screen === 'trial_summary') return;
  appState.mode = 'idle';
  appState.screen = 'trial_summary';
  if (trialCtx.finalizeTimer) { clearTimeout(trialCtx.finalizeTimer); trialCtx.finalizeTimer = null; }
  clearPressureZeroTimer();
  if (trialCtx.animId) cancelAnimationFrame(trialCtx.animId);
  // 結果画面を表示した時刻。試行区間自体は結果ボタン押下まで継続する。
  const resultTime = round(nowMs(), 3);
  const resultEpoch = Date.now();
  trialCtx.trial_end_time_ms = resultTime; // 後方互換: 従来列は結果表示時刻
  if (trialCtx.phase === 'trial') {
    trialCtx.result_display_time_ms = resultTime;
    trialCtx.attempt_stage = 'result_screen';
    pushAttemptMarker('result_displayed', {
      timestamp_ms: resultTime,
      epoch_ms: resultEpoch,
      iso_time: new Date(resultEpoch).toISOString(),
    }, 'result_screen');
  }
  console.log('[finalizeTrial]', nowMs());

  trialCtx.kinematicTiming = computeKinematicTiming(
    trialCtx.rawRows,
    appState.currentLine,
    trialCtx.touch_start_time_ms,
    trialCtx.movement_onset_time_ms,
    trialCtx.last_pointerup_time_ms
  );
  trialCtx.movement_offset_time_ms = trialCtx.kinematicTiming.movement_offset_time_ms === ''
    ? null : trialCtx.kinematicTiming.movement_offset_time_ms;
  trialCtx.movement_offset_method = trialCtx.kinematicTiming.movement_offset_method;

  // タイミング列を、この試行の全 raw 行へバックフィルする
  backfillTrialTiming();

  if (trialCtx.phase === 'practice') {
    // 練習: summary は残さず、フィードバックだけ表示
    showPanel('stage');
    afterPracticeTrial();
    return;
  }

  // 本番: summary を計算して仮保持
  const summary = computeSummary();
  trialCtx.pendingSummary = summary;
  showTrialSummary(summary);
}

function backfillTrialTiming() {
  // attempt_stage は各イベントが発生した時点の段階を残す。
  // 終了時刻やoutcomeなど、attempt全体で共通の値だけを後から埋める。
  const attemptFields = attemptTagFields();
  delete attemptFields.attempt_stage;
  const fields = Object.assign({
    trial_start_button_time_ms: trialCtx.trial_start_button_time_ms,
    countdown_go_time_ms: trialCtx.countdown_go_time_ms, // 本番では空(カウントダウン廃止)
    first_pointerdown_time_ms: trialCtx.first_pointerdown_time_ms === null ? '' : trialCtx.first_pointerdown_time_ms,
    last_pointerup_time_ms: trialCtx.last_pointerup_time_ms === null ? '' : trialCtx.last_pointerup_time_ms,
    trial_end_time_ms: trialCtx.trial_end_time_ms,
    // 自己ペース開始方式の時刻を各 trial 行へバックフィル
    touch_start_time_ms: trialCtx.touch_start_time_ms,
    movement_onset_time_ms: trialCtx.movement_onset_time_ms === null ? '' : trialCtx.movement_onset_time_ms,
    movement_onset_reference: 'actual_touch_point',
    movement_onset_threshold_mm: MOVEMENT_ONSET_THRESHOLD_MM,
    movement_offset_time_ms: trialCtx.movement_offset_time_ms === null ? '' : trialCtx.movement_offset_time_ms,
    movement_offset_method: trialCtx.movement_offset_method,
  }, attemptFields);
  const all = trialCtx.phase === 'trial'
    ? trialCtx.attemptRows
    : trialCtx.preTrialSyncRows.concat(trialCtx.rawRows);
  for (const row of all) Object.assign(row, fields);
}

function percentile(values, ratio) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return '';
  const index = clamp((sorted.length - 1) * ratio, 0, sorted.length - 1);
  const lower = Math.floor(index), upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

// 接触区間を補間し、終点到達・実移動終了・Pointer Event品質を計算する。
// 運動終了基準は予備実験用であり、元のpointerup時刻も必ず併記する。
function computeKinematicTiming(rows, line, touchStartMs, movementOnsetMs, lastPointerUpMs) {
  const optionalNumber = (value) => (value === '' || value === null || value === undefined)
    ? NaN : Number(value);
  const touch = optionalNumber(touchStartMs);
  const onset = optionalNumber(movementOnsetMs);
  const release = optionalNumber(lastPointerUpMs);
  const usable = rows
    .filter((row) => Number.isFinite(Number(row.timestamp_ms)) &&
      Number.isFinite(Number(row.x_px)) && Number.isFinite(Number(row.y_px)))
    .map((row) => Object.assign({}, row, {
      timestamp_ms: Number(row.timestamp_ms), x_px: Number(row.x_px), y_px: Number(row.y_px),
    }))
    .sort((a, b) => a.timestamp_ms - b.timestamp_ms);

  const intervals = [];
  for (let i = 1; i < usable.length; i++) {
    const dt = usable[i].timestamp_ms - usable[i - 1].timestamp_ms;
    if (dt > 0) intervals.push(dt);
  }
  const delays = usable
    .map((row) => Number(row.event_processing_delay_ms))
    .filter(Number.isFinite);
  const coalescedCount = usable.filter((row) => Number(row.coalesced_batch_size) > 1).length;
  const medianInterval = percentile(intervals, 0.5);
  const quality = {
    pointer_event_count: usable.length,
    median_pointer_interval_ms: round(medianInterval, 3),
    p95_pointer_interval_ms: round(percentile(intervals, 0.95), 3),
    max_pointer_interval_ms: intervals.length ? round(Math.max(...intervals), 3) : '',
    estimated_pointer_rate_hz: Number.isFinite(medianInterval) && medianInterval > 0
      ? round(1000 / medianInterval, 2) : '',
    median_event_processing_delay_ms: round(percentile(delays, 0.5), 3),
    p95_event_processing_delay_ms: round(percentile(delays, 0.95), 3),
    coalesced_event_ratio: usable.length ? round(coalescedCount / usable.length, 3) : '',
  };

  if (!line || !Number.isFinite(touch) || !Number.isFinite(release) || release <= touch || !usable.length) {
    return Object.assign({
      goal_arrival_time_ms: '', goal_arrival_elapsed_ms: '',
      movement_offset_time_ms: '', movement_offset_method: '',
      contact_duration_ms: '', kinematic_duration_ms: '', start_delay_ms: '',
      dwell_after_movement_ms: '', goal_dwell_ms: '',
    }, quality);
  }

  const strokes = [];
  let stroke = null;
  for (const row of usable) {
    if (row.event_type === 'pointerdown') {
      if (stroke && stroke.length) strokes.push(stroke);
      stroke = [row];
    } else if (stroke) {
      stroke.push(row);
      if (row.event_type === 'pointerup' || row.event_type === 'pointercancel') {
        strokes.push(stroke);
        stroke = null;
      }
    }
  }
  if (stroke && stroke.length) strokes.push(stroke);

  function positionAt(timeMs) {
    const active = strokes.find((candidate) =>
      timeMs >= candidate[0].timestamp_ms && timeMs <= candidate[candidate.length - 1].timestamp_ms
    );
    if (!active) return null;
    if (active.length === 1) return { x: active[0].x_px, y: active[0].y_px };
    for (let i = 1; i < active.length; i++) {
      const a = active[i - 1], b = active[i];
      if (timeMs <= b.timestamp_ms) {
        const dt = b.timestamp_ms - a.timestamp_ms;
        const u = dt > 0 ? clamp((timeMs - a.timestamp_ms) / dt, 0, 1) : 1;
        return { x: a.x_px + (b.x_px - a.x_px) * u, y: a.y_px + (b.y_px - a.y_px) * u };
      }
    }
    const last = active[active.length - 1];
    return { x: last.x_px, y: last.y_px };
  }

  const lineStartMm = pointPxToMm(line.start.x, line.start.y);
  const lineEndMm = pointPxToMm(line.end.x, line.end.y);
  const lineDx = lineEndMm.x - lineStartMm.x;
  const lineDy = lineEndMm.y - lineStartMm.y;
  const lineLength = Math.hypot(lineDx, lineDy) || 1;
  const sampleStepMs = TRACKING_EVAL_INTERVAL_MS;
  const sampleCount = Math.max(1, Math.ceil((release - touch) / sampleStepMs));
  const samples = [];
  let goalArrival = '';
  for (let i = 0; i <= sampleCount; i++) {
    const timeMs = Math.min(release, touch + i * sampleStepMs);
    const position = positionAt(timeMs);
    if (!position) {
      samples.push({ time_ms: timeMs, position: null, progress: null, speed_mm_s: null });
      continue;
    }
    const pointMm = pointPxToMm(position.x, position.y);
    const progress = ((pointMm.x - lineStartMm.x) * lineDx + (pointMm.y - lineStartMm.y) * lineDy) /
      (lineLength * lineLength);
    if (goalArrival === '' && Math.hypot(pointMm.x - lineEndMm.x, pointMm.y - lineEndMm.y) <= TRACKING_TOLERANCE_MM) {
      goalArrival = timeMs;
    }
    samples.push({ time_ms: timeMs, position, point_mm: pointMm, progress, speed_mm_s: null });
  }

  const smoothSteps = Math.max(1, Math.round(MOVEMENT_OFFSET_SMOOTHING_MS / sampleStepMs));
  for (let i = smoothSteps; i < samples.length; i++) {
    const current = samples[i], previous = samples[i - smoothSteps];
    if (!current.point_mm || !previous.point_mm) continue;
    const dtSec = (current.time_ms - previous.time_ms) / 1000;
    if (dtSec <= 0) continue;
    current.speed_mm_s = Math.hypot(
      current.point_mm.x - previous.point_mm.x,
      current.point_mm.y - previous.point_mm.y
    ) / dtSec;
  }

  const sustainSteps = Math.max(1, Math.ceil(MOVEMENT_OFFSET_SUSTAIN_MS / sampleStepMs));
  let movementOffset = release;
  let offsetMethod = 'pointerup_fallback';
  for (let i = smoothSteps; i + sustainSteps < samples.length; i++) {
    const sample = samples[i];
    if (sample.progress === null || sample.progress < MOVEMENT_OFFSET_MIN_PROGRESS) continue;
    let sustained = true;
    // 最後の低速区間だけを採用し、途中の一時停止後に再び動いた場合は開始点にしない。
    for (let j = i; j < samples.length; j++) {
      const speed = samples[j].speed_mm_s;
      if (!Number.isFinite(speed) || speed >= MOVEMENT_OFFSET_SPEED_THRESHOLD_MM_S) {
        sustained = false;
        break;
      }
    }
    if (sustained) {
      movementOffset = Math.max(touch, sample.time_ms - MOVEMENT_OFFSET_SMOOTHING_MS);
      offsetMethod = 'sustained_low_speed';
      break;
    }
  }
  if (Number.isFinite(onset) && movementOffset < onset) {
    movementOffset = release;
    offsetMethod = 'pointerup_fallback';
  }

  return Object.assign({
    goal_arrival_time_ms: goalArrival === '' ? '' : round(goalArrival, 3),
    goal_arrival_elapsed_ms: goalArrival === '' ? '' : round(goalArrival - touch, 3),
    movement_offset_time_ms: round(movementOffset, 3),
    movement_offset_method: offsetMethod,
    contact_duration_ms: round(release - touch, 3),
    kinematic_duration_ms: Number.isFinite(onset) ? round(movementOffset - onset, 3) : '',
    start_delay_ms: Number.isFinite(onset) ? round(onset - touch, 3) : '',
    dwell_after_movement_ms: round(release - movementOffset, 3),
    goal_dwell_ms: goalArrival === '' ? '' : round(release - goalArrival, 3),
  }, quality);
}

// Pointer Eventの間を線形補間し、一定時間刻みでガイド追従を評価する。
// 評価グリッドは指標計算専用であり、rawデータを疑似的に増やすものではない。
function computeTrackingMetrics(rows, line, touchStartMs, targetDurationMs) {
  const startMs = Number(touchStartMs);
  const durationMs = Number(targetDurationMs);
  if (!line || !Number.isFinite(startMs) || !Number.isFinite(durationMs) || durationMs <= 0) {
    return {
      tracking_rmse_mm: '', tracking_max_error_mm: '', tracking_in_range_ratio: '',
      tracking_observed_ratio: '', mean_abs_along_track_error_mm: '',
      mean_abs_cross_track_error_mm: '', goal_arrival_time_ms: '', goal_arrival_elapsed_ms: '',
    };
  }

  const usable = rows
    .filter((r) => Number.isFinite(Number(r.timestamp_ms)) &&
      Number.isFinite(Number(r.x_px)) && Number.isFinite(Number(r.y_px)))
    .map((r) => Object.assign({}, r, {
      timestamp_ms: Number(r.timestamp_ms), x_px: Number(r.x_px), y_px: Number(r.y_px),
    }))
    .sort((a, b) => a.timestamp_ms - b.timestamp_ms);

  // pointerdown〜pointerupを接触区間として分割し、ペン離れ中は観測なしとする。
  const strokes = [];
  let stroke = null;
  for (const row of usable) {
    if (row.event_type === 'pointerdown') {
      if (stroke && stroke.length) strokes.push(stroke);
      stroke = [row];
    } else if (stroke) {
      stroke.push(row);
      if (row.event_type === 'pointerup' || row.event_type === 'pointercancel') {
        strokes.push(stroke);
        stroke = null;
      }
    }
  }
  if (stroke && stroke.length) strokes.push(stroke);

  function positionAt(timeMs) {
    const active = strokes.find((s) =>
      timeMs >= s[0].timestamp_ms && timeMs <= s[s.length - 1].timestamp_ms
    );
    if (!active) return null;
    if (active.length === 1) return { x: active[0].x_px, y: active[0].y_px };
    for (let i = 1; i < active.length; i++) {
      const a = active[i - 1], b = active[i];
      if (timeMs <= b.timestamp_ms) {
        const dt = b.timestamp_ms - a.timestamp_ms;
        const u = dt > 0 ? clamp((timeMs - a.timestamp_ms) / dt, 0, 1) : 1;
        return { x: a.x_px + (b.x_px - a.x_px) * u, y: a.y_px + (b.y_px - a.y_px) * u };
      }
    }
    const last = active[active.length - 1];
    return { x: last.x_px, y: last.y_px };
  }

  const lineStartMm = pointPxToMm(line.start.x, line.start.y);
  const lineEndMm = pointPxToMm(line.end.x, line.end.y);
  const lineDx = lineEndMm.x - lineStartMm.x;
  const lineDy = lineEndMm.y - lineStartMm.y;
  const lineLength = Math.hypot(lineDx, lineDy) || 1;
  const ux = lineDx / lineLength, uy = lineDy / lineLength;
  const totalSteps = Math.max(1, Math.ceil(durationMs / TRACKING_EVAL_INTERVAL_MS));
  const totalSamples = totalSteps + 1;
  let observed = 0, inRange = 0, sumSq = 0, maxError = 0;
  let sumAbsAlong = 0, sumAbsCross = 0;
  let goalArrivalTime = '';

  for (let i = 0; i <= totalSteps; i++) {
    const elapsed = Math.min(durationMs, i * durationMs / totalSteps);
    const timeMs = startMs + elapsed;
    const pen = positionAt(timeMs);
    if (!pen) continue; // 未接触時間はin-rangeに数えない

    const progress = clamp(elapsed / durationMs, 0, 1);
    const guideMm = {
      x: lineStartMm.x + lineDx * progress,
      y: lineStartMm.y + lineDy * progress,
    };
    const penMm = pointPxToMm(pen.x, pen.y);
    const dx = penMm.x - guideMm.x, dy = penMm.y - guideMm.y;
    const error = Math.hypot(dx, dy);
    const along = dx * ux + dy * uy;
    const cross = dx * (-uy) + dy * ux;
    observed += 1;
    if (error <= TRACKING_TOLERANCE_MM) inRange += 1;
    sumSq += error * error;
    maxError = Math.max(maxError, error);
    sumAbsAlong += Math.abs(along);
    sumAbsCross += Math.abs(cross);
    if (goalArrivalTime === '' && Math.hypot(penMm.x - lineEndMm.x, penMm.y - lineEndMm.y) <= TRACKING_TOLERANCE_MM) {
      goalArrivalTime = timeMs;
    }
  }

  return {
    tracking_rmse_mm: observed ? round(Math.sqrt(sumSq / observed), 3) : '',
    tracking_max_error_mm: observed ? round(maxError, 3) : '',
    tracking_in_range_ratio: round(inRange / totalSamples, 3),
    tracking_observed_ratio: round(observed / totalSamples, 3),
    mean_abs_along_track_error_mm: observed ? round(sumAbsAlong / observed, 3) : '',
    mean_abs_cross_track_error_mm: observed ? round(sumAbsCross / observed, 3) : '',
    goal_arrival_time_ms: goalArrivalTime === '' ? '' : round(goalArrivalTime, 3),
    goal_arrival_elapsed_ms: goalArrivalTime === '' ? '' : round(goalArrivalTime - startMs, 2),
  };
}

// summary の各指標を計算する。
// すべて phase=trial のデータ(trialCtx.rawRows = 始点タッチ以降)だけを使う。
// 同期タップや pre_start_touch は含まれない。
function computeSummary() {
  const t = trialCtx.trial;
  const s = appState.settings;
  const moves = trialCtx.rawRows; // 始点タッチ以降の pointerdown/move/up/cancel

  // 理想の始点/終点
  const ideal = appState.currentLine || computeLineEndpoints(t.target_angle_deg);

  // 始点 = 始点タッチ座標、終点 = 終点リリース座標(最後の pointerup)
  const downs = moves.filter((r) => r.event_type === 'pointerdown');
  const ups = moves.filter((r) => r.event_type === 'pointerup');
  const sx = trialCtx.start_touch_x_px !== '' ? trialCtx.start_touch_x_px : (downs[0] ? downs[0].x_px : '');
  const sy = trialCtx.start_touch_y_px !== '' ? trialCtx.start_touch_y_px : (downs[0] ? downs[0].y_px : '');
  const ex = trialCtx.end_release_x_px !== '' ? trialCtx.end_release_x_px : (ups.length ? ups[ups.length - 1].x_px : '');
  const ey = trialCtx.end_release_y_px !== '' ? trialCtx.end_release_y_px : (ups.length ? ups[ups.length - 1].y_px : '');
  const hasEndpoints = sx !== '' && sy !== '' && ex !== '' && ey !== '';

  // --- actual_angle_deg (始点タッチ → 終点リリース) ---
  let actual_angle_deg = '';
  let angle_error_deg = '';
  if (hasEndpoints) {
    const rad = Math.atan2(-((ey - sy) * mmPerCssPxY()), (ex - sx) * mmPerCssPxX());
    actual_angle_deg = normalize360(rad * 180 / Math.PI);
    angle_error_deg = Math.abs(normalize180(t.target_angle_deg - actual_angle_deg));
  }

  // --- actual_duration_ms = last_pointerup_time_ms - touch_start_time_ms ---
  let actual_duration_ms = '';
  if (trialCtx.touch_start_time_ms !== '' && trialCtx.last_pointerup_time_ms !== null) {
    actual_duration_ms = trialCtx.last_pointerup_time_ms - trialCtx.touch_start_time_ms;
  }

  // --- movement_duration_ms = last_pointerup_time_ms - movement_onset_time_ms ---
  // onset が取得できなければ touch_start_time_ms を代用する。
  const movement_onset_ms = (trialCtx.movement_onset_time_ms === null)
    ? trialCtx.touch_start_time_ms : trialCtx.movement_onset_time_ms;
  let movement_duration_ms = '';
  if (movement_onset_ms !== '' && trialCtx.last_pointerup_time_ms !== null) {
    movement_duration_ms = trialCtx.last_pointerup_time_ms - movement_onset_ms;
  }

  // --- actual_path_length_mm (連続点間の実寸距離の合計) ---
  let actual_path_length_mm = 0;
  let prev = null;
  for (const r of moves) {
    if (prev) {
      actual_path_length_mm += distanceCssPxInMm(prev.x_px, prev.y_px, r.x_px, r.y_px);
    }
    prev = r;
  }

  // --- 速度 ---
  const target_velocity = s.target_line_length_mm / s.target_duration_ms * 1000;
  let mean_velocity = '';
  let velocity_error = '';
  if (actual_duration_ms && actual_duration_ms > 0) {
    mean_velocity = actual_path_length_mm / actual_duration_ms * 1000;
    velocity_error = mean_velocity - target_velocity;
  }

  // --- 筆圧 (pressure>0 のみ) ---
  const pres = moves.map((r) => r.pressure).filter((p) => typeof p === 'number' && p > 0);
  let mean_pressure = '', max_pressure = '', pressure_sd = '', pressure_in_range_ratio = '';
  if (pres.length > 0) {
    mean_pressure = pres.reduce((a, b) => a + b, 0) / pres.length;
    max_pressure = Math.max(...pres);
    const variance = pres.reduce((a, b) => a + (b - mean_pressure) ** 2, 0) / pres.length;
    pressure_sd = Math.sqrt(variance);
    const inRange = pres.filter((p) => p >= appState.pressure_low && p <= appState.pressure_high).length;
    pressure_in_range_ratio = inRange / pres.length;
  }

  // --- straightness_error_mm (理想線分への実寸垂直距離の平均) ---
  let straightness_error_mm = '';
  if (moves.length > 0) {
    const idealStartMm = pointPxToMm(ideal.start.x, ideal.start.y);
    const idealEndMm = pointPxToMm(ideal.end.x, ideal.end.y);
    const dists = moves.map((r) => {
      const p = pointPxToMm(r.x_px, r.y_px);
      return pointToSegmentDistance(p.x, p.y, idealStartMm, idealEndMm);
    });
    straightness_error_mm = dists.reduce((a, b) => a + b, 0) / dists.length;
  }

  // --- pen_lift_count: 始点タッチ後の途中ペン離れ回数(pointerdown回数 - 1) ---
  const pen_lift_count = Math.max(0, downs.length - 1);

  // --- 始点/終点の理想点からの距離 ---
  const start_touch_distance = hasEndpoints ? distanceCssPxInMm(sx, sy, ideal.start.x, ideal.start.y) : '';
  const end_release_distance = hasEndpoints ? distanceCssPxInMm(ex, ey, ideal.end.x, ideal.end.y) : '';
  const startTouchMm = hasEndpoints ? pointPxToMm(sx, sy) : { x: '', y: '' };
  const endReleaseMm = hasEndpoints ? pointPxToMm(ex, ey) : { x: '', y: '' };

  // --- 一定速度ガイドへの時系列追従 ---
  const tracking = computeTrackingMetrics(
    moves, ideal, trialCtx.touch_start_time_ms, s.target_duration_ms
  );
  const kinematic = trialCtx.kinematicTiming || computeKinematicTiming(
    moves, ideal, trialCtx.touch_start_time_ms, trialCtx.movement_onset_time_ms,
    trialCtx.last_pointerup_time_ms
  );
  const release_time_error_ms = actual_duration_ms === ''
    ? '' : actual_duration_ms - s.target_duration_ms;

  // --- EMG 切り出し候補区間 (touch_start の200ms前 〜 pointerup の200ms後) ---
  let emg_start = '', emg_end = '';
  if (trialCtx.touch_start_time_ms !== '') emg_start = trialCtx.touch_start_time_ms - EMG_PRE_MARGIN_MS;
  if (trialCtx.last_pointerup_time_ms !== null) emg_end = trialCtx.last_pointerup_time_ms + EMG_POST_MARGIN_MS;
  const emgMovementStart = trialCtx.movement_onset_time_ms === null
    ? '' : trialCtx.movement_onset_time_ms - EMG_PRE_MARGIN_MS;

  // --- 成功 / やり直し候補 / 失敗 の判定(共通関数) ---
  const evalResult = evaluateTrialQuality({
    angle_error_deg: angle_error_deg,
    actual_duration_ms: actual_duration_ms,
    target_duration_ms: s.target_duration_ms,
    pressure_in_range_ratio: pressure_in_range_ratio,
    pen_lift_count: pen_lift_count,
    tracking_in_range_ratio: tracking.tracking_in_range_ratio,
  });
  const success_flag = evalResult.success_flag;

  const summary = {
    session_id: appState.session_id,
    participant_id: s.participant_id,
    block_index: t.block_index,
    trial_index: t.trial_index,
    trial_global_index: t.trial_global_index,
    repetition_index: t.repetition_index,
    target_angle_deg: t.target_angle_deg,
    actual_angle_deg: round(actual_angle_deg, 2),
    angle_error_deg: round(angle_error_deg, 2),
    target_duration_ms: s.target_duration_ms,
    actual_duration_ms: round(actual_duration_ms, 2),
    duration_error_ms: actual_duration_ms === '' ? '' : round(actual_duration_ms - s.target_duration_ms, 2),
    target_line_length_mm: s.target_line_length_mm,
    actual_path_length_mm: round(actual_path_length_mm, 3),
    target_velocity_mm_per_s: round(target_velocity, 3),
    mean_velocity_mm_per_s: round(mean_velocity, 3),
    velocity_error_mm_per_s: round(velocity_error, 3),
    target_pressure: round(appState.target_pressure, 4),
    pressure_tolerance: s.pressure_tolerance,
    pressure_low: round(appState.pressure_low, 4),
    pressure_high: round(appState.pressure_high, 4),
    mean_pressure: round(mean_pressure, 4),
    max_pressure: round(max_pressure, 4),
    pressure_sd: round(pressure_sd, 4),
    pressure_in_range_ratio: round(pressure_in_range_ratio, 3),
    straightness_error_mm: round(straightness_error_mm, 3),
    pen_lift_count: pen_lift_count,
    pre_trial_sync_tap_time_ms: trialCtx.pre_sync_tap_time_ms,
    pre_trial_sync_tap_epoch_ms: trialCtx.pre_sync_tap_epoch_ms,
    pre_trial_sync_tap_pressure: trialCtx.pre_sync_tap_pressure,
    countdown_go_time_ms: trialCtx.countdown_go_time_ms,
    first_pointerdown_time_ms: trialCtx.first_pointerdown_time_ms === null ? '' : trialCtx.first_pointerdown_time_ms,
    last_pointerup_time_ms: trialCtx.last_pointerup_time_ms === null ? '' : trialCtx.last_pointerup_time_ms,
    trial_end_time_ms: trialCtx.trial_end_time_ms,
    emg_window_start_candidate_ms: round(emg_start, 2),
    emg_window_end_candidate_ms: round(emg_end, 2),
    emg_touch_window_start_candidate_ms: round(emg_start, 2),
    emg_movement_window_start_candidate_ms: round(emgMovementStart, 2),
    success_flag: success_flag,
    notes: evalResult.notes,
    // 追加の判定詳細列(既存列の後ろに追記)
    verdict: evalResult.verdict,
    angle_ok: evalResult.angle_ok,
    duration_ok: evalResult.duration_ok,
    pressure_ok: evalResult.pressure_ok,
    lift_ok: evalResult.lift_ok,
    // 自己ペース開始方式の指標(既存列の後ろに追記)
    touch_start_time_ms: trialCtx.touch_start_time_ms,
    movement_onset_time_ms: trialCtx.movement_onset_time_ms === null ? '' : trialCtx.movement_onset_time_ms,
    movement_duration_ms: round(movement_duration_ms, 2),
    start_touch_x_mm: round(startTouchMm.x, 3),
    start_touch_y_mm: round(startTouchMm.y, 3),
    start_touch_distance_from_ideal_mm: round(start_touch_distance, 3),
    end_release_x_mm: round(endReleaseMm.x, 3),
    end_release_y_mm: round(endReleaseMm.y, 3),
    end_release_distance_from_ideal_mm: round(end_release_distance, 3),
    attempt_index: trialCtx.attempt_index,
    attempt_id: trialCtx.attempt_id,
    attempt_outcome: trialCtx.attempt_outcome,
    trial_window_start_time_ms: trialCtx.trial_window_start_time_ms,
    trial_window_start_epoch_ms: trialCtx.trial_window_start_epoch_ms,
    trial_ready_time_ms: trialCtx.trial_ready_time_ms,
    result_display_time_ms: trialCtx.result_display_time_ms,
    trial_window_end_time_ms: trialCtx.trial_window_end_time_ms,
    trial_window_end_epoch_ms: trialCtx.trial_window_end_epoch_ms,
    guide_tracking_tolerance_mm: TRACKING_TOLERANCE_MM,
    tracking_rmse_mm: tracking.tracking_rmse_mm,
    tracking_max_error_mm: tracking.tracking_max_error_mm,
    tracking_in_range_ratio: tracking.tracking_in_range_ratio,
    tracking_observed_ratio: tracking.tracking_observed_ratio,
    mean_abs_along_track_error_mm: tracking.mean_abs_along_track_error_mm,
    mean_abs_cross_track_error_mm: tracking.mean_abs_cross_track_error_mm,
    goal_arrival_time_ms: kinematic.goal_arrival_time_ms,
    goal_arrival_elapsed_ms: kinematic.goal_arrival_elapsed_ms,
    release_time_error_ms: round(release_time_error_ms, 2),
    tracking_ok: evalResult.tracking_ok,
    movement_offset_time_ms: kinematic.movement_offset_time_ms,
    contact_duration_ms: kinematic.contact_duration_ms,
    kinematic_duration_ms: kinematic.kinematic_duration_ms,
    start_delay_ms: kinematic.start_delay_ms,
    dwell_after_movement_ms: kinematic.dwell_after_movement_ms,
    goal_dwell_ms: kinematic.goal_dwell_ms,
    movement_offset_method: kinematic.movement_offset_method,
    movement_onset_reference: 'actual_touch_point',
    movement_onset_threshold_mm: MOVEMENT_ONSET_THRESHOLD_MM,
    pointer_event_count: kinematic.pointer_event_count,
    median_pointer_interval_ms: kinematic.median_pointer_interval_ms,
    p95_pointer_interval_ms: kinematic.p95_pointer_interval_ms,
    max_pointer_interval_ms: kinematic.max_pointer_interval_ms,
    estimated_pointer_rate_hz: kinematic.estimated_pointer_rate_hz,
    median_event_processing_delay_ms: kinematic.median_event_processing_delay_ms,
    p95_event_processing_delay_ms: kinematic.p95_event_processing_delay_ms,
    coalesced_event_ratio: kinematic.coalesced_event_ratio,
  };
  return summary;
}

// 成功 / やり直し候補 / 失敗 を判定する共通関数。
// computeSummary(CSV) と showTrialSummary(画面表示) の両方で使い、判定を一致させる。
// m: {angle_error_deg, actual_duration_ms, target_duration_ms, pressure_in_range_ratio,
//     pen_lift_count, tracking_in_range_ratio}
function evaluateTrialQuality(m) {
  const hasAngle = m.angle_error_deg !== '' && m.angle_error_deg !== null && m.angle_error_deg !== undefined;
  const hasDur = m.actual_duration_ms !== '' && m.actual_duration_ms !== null && m.actual_duration_ms !== undefined;
  const hasPres = m.pressure_in_range_ratio !== '' && m.pressure_in_range_ratio !== null && m.pressure_in_range_ratio !== undefined;
  const hasTracking = m.tracking_in_range_ratio !== '' && m.tracking_in_range_ratio !== null && m.tracking_in_range_ratio !== undefined;
  const durDiff = hasDur ? Math.abs(m.actual_duration_ms - m.target_duration_ms) : Infinity;

  // 成功基準 (SUCCESS_CRITERIA)
  const angle_ok = hasAngle && m.angle_error_deg <= SUCCESS_CRITERIA.angle_error_deg_max;
  const duration_ok = hasDur && durDiff <= m.target_duration_ms * SUCCESS_CRITERIA.duration_tolerance_ratio;
  const pressure_ok = hasPres && m.pressure_in_range_ratio >= SUCCESS_CRITERIA.pressure_in_range_ratio_min;
  const lift_ok = m.pen_lift_count <= SUCCESS_CRITERIA.pen_lift_count_max;
  const tracking_ok = hasTracking && m.tracking_in_range_ratio >= SUCCESS_CRITERIA.tracking_in_range_ratio_min;
  const success_flag = (angle_ok && duration_ok && pressure_ok && lift_ok && tracking_ok) ? 1 : 0;

  // やり直し候補基準 (RETRY_CRITERIA)
  const angle_retry = hasAngle && m.angle_error_deg <= RETRY_CRITERIA.angle_error_deg_max;
  const duration_retry = hasDur && durDiff <= m.target_duration_ms * RETRY_CRITERIA.duration_tolerance_ratio;
  const pressure_retry = hasPres && m.pressure_in_range_ratio >= RETRY_CRITERIA.pressure_in_range_ratio_min;
  const lift_retry = m.pen_lift_count <= RETRY_CRITERIA.pen_lift_count_max;
  const tracking_retry = hasTracking && m.tracking_in_range_ratio >= RETRY_CRITERIA.tracking_in_range_ratio_min;

  let verdict;
  if (success_flag === 1) verdict = 'success';
  else if (angle_retry && duration_retry && pressure_retry && lift_retry && tracking_retry) verdict = 'retry';
  else verdict = 'failed';

  // notes: 後で CSV を見たときに原因が分かる形式
  let notes;
  if (verdict === 'success') {
    notes = 'success';
  } else {
    const ng = [];
    if (!angle_ok) ng.push('angle_ng');
    if (!duration_ok) ng.push('duration_ng');
    if (!pressure_ok) ng.push('pressure_ng');
    if (!lift_ok) ng.push('lift_ng');
    if (!tracking_ok) ng.push('tracking_ng');
    const prefix = (verdict === 'retry') ? 'retry_candidate' : 'failed';
    notes = `${prefix}: ${ng.join(', ')}`;
  }
  notes += ` | angle_ok=${angle_ok}; duration_ok=${duration_ok}; pressure_ok=${pressure_ok}; lift_ok=${lift_ok}; tracking_ok=${tracking_ok}; verdict=${verdict}`;

  return { angle_ok, duration_ok, pressure_ok, lift_ok, tracking_ok, success_flag, verdict, notes };
}

// 点(x,y)から線分 a-b への距離。呼び出し側と同じ単位で返す。
function pointToSegmentDistance(x, y, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(x - a.x, y - a.y);
  let t = ((x - a.x) * dx + (y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return Math.hypot(x - projX, y - projY);
}

/* ===================================================================
   17. 試行サマリー表示 (4-6 / 9)
=================================================================== */

function showTrialSummary(sm) {
  showPanel('stage');
  setHud({ top: true, pressure: true, bottom: false, center: false, controls: false, summary: true });

  // 判定は computeSummary と同じ共通関数で再評価して一致させる
  const ev = evaluateTrialQuality({
    angle_error_deg: sm.angle_error_deg,
    actual_duration_ms: sm.actual_duration_ms,
    target_duration_ms: sm.target_duration_ms,
    pressure_in_range_ratio: sm.pressure_in_range_ratio,
    pen_lift_count: sm.pen_lift_count,
    tracking_in_range_ratio: sm.tracking_in_range_ratio,
  });

  // 被験者向けには詳細データは表示せず、「成功 / やり直し / 失敗」のみを大きく表示する。
  // (詳細な計測値・判定条件は CSV に保存されるため、画面表示は不要)
  let verdict = '失敗';
  let cls = 'verdict-fail';
  if (ev.verdict === 'success') { verdict = '成功'; cls = 'verdict-success'; }
  else if (ev.verdict === 'retry') { verdict = 'やり直し'; cls = 'verdict-retry'; }

  const vEl = document.getElementById('summary-verdict');
  vEl.textContent = verdict;
  vEl.className = cls;
  updateSummaryButtons(sm, ev);

  const isSuccess = sm.success_flag === 1 || ev.verdict === 'success' || sm.verdict === 'success';
  const operationMessage = isSuccess
    ? 'この試行は採用されます。'
    : 'もう一度同じ試行を行ってください。';

  const body = document.getElementById('summary-body');
  body.innerHTML = `<div class="summary-message">${operationMessage}</div>`;
}

// 判定結果に応じて、サマリー画面の操作ボタンを制限する。
// 成功のみ次へ進める。やり直し候補は今回の運用では失敗側として扱う。
function updateSummaryButtons(summary, evaluation) {
  const nextBtn = document.getElementById('btn-summary-next');
  const redoBtn = document.getElementById('btn-summary-redo');
  if (!nextBtn || !redoBtn) return;

  const verdict = (evaluation && evaluation.verdict) || summary.verdict || '';
  const isSuccess =
    summary.success_flag === 1 ||
    verdict === 'success' ||
    verdict === '成功';

  nextBtn.style.display = isSuccess ? 'inline-block' : 'none';
  redoBtn.style.display = isSuccess ? 'none' : 'inline-block';
  nextBtn.disabled = !isSuccess;
  redoBtn.disabled = isSuccess;
}

function completeAttempt(outcome) {
  if (!trialCtx || trialCtx.phase !== 'trial' || trialCtx.trial_window_end_time_ms !== '') return false;
  const endTime = round(nowMs(), 3);
  const endEpoch = Date.now();
  trialCtx.attempt_outcome = outcome;
  trialCtx.trial_window_end_time_ms = endTime;
  trialCtx.trial_window_end_epoch_ms = endEpoch;
  trialCtx.attempt_stage = 'completed';
  pushAttemptMarker('trial_window_end', {
    timestamp_ms: endTime,
    epoch_ms: endEpoch,
    iso_time: new Date(endEpoch).toISOString(),
  }, 'completed');
  trialCtx.trial_window_active = false;
  backfillTrialTiming();

  if (trialCtx.pendingSummary) {
    Object.assign(trialCtx.pendingSummary, {
      attempt_outcome: outcome,
      trial_window_end_time_ms: endTime,
      trial_window_end_epoch_ms: endEpoch,
    });
    trialSummaries.push(trialCtx.pendingSummary);
    console.log('[attempt summary]', trialCtx.pendingSummary);
    trialCtx.pendingSummary = null;
  }
  document.getElementById('btn-summary-next').disabled = true;
  document.getElementById('btn-summary-redo').disabled = true;
  return true;
}

// 「次の試行」: acceptedとして区間を閉じ、次へ
function onSummaryNext() {
  if (!completeAttempt('accepted')) return;
  const finishedGlobal = trialCtx.trial.trial_global_index;
  appState.currentTrialPos += 1;
  // 休憩判定
  if (!maybeRest(finishedGlobal)) {
    nextTrial();
  }
}

// 「やり直し」: rejectedとして区間を閉じ、同じ角度を新しいattemptとして再実施
function onSummaryRedo() {
  if (!completeAttempt('rejected')) return;
  console.log('[redo] rejected trial, rerun same angle:', trialCtx.trial);
  // currentTrialPos は進めない → 同じ試行を再実施
  enterPreTrialSync(appState.trialOrder[appState.currentTrialPos]);
}

/* ===================================================================
   18. 休憩画面 (4-9)
=================================================================== */

function enterRest(done, total) {
  appState.screen = 'rest';
  appState.mode = 'idle';
  showPanel('rest');
  document.getElementById('rest-progress').textContent =
    `ここまで ${done} 試行 / 残り ${total - done} 試行`;
}

/* ===================================================================
   19. データ保存画面 (4-11)
=================================================================== */

function enterSave() {
  appState.screen = 'save';
  appState.mode = 'idle';
  showPanel('save');
  const confirmation = document.getElementById('save-confirmed');
  confirmation.checked = false;
  confirmation.disabled = true;
  appState.archiveConfirmed = false;
  updateSaveControls();
  console.log('[raw rows]', trialDataRaw.length, trialDataRaw);
  console.log('[summaries]', trialSummaries.length, trialSummaries);
  document.getElementById('save-status').textContent =
    `raw: ${trialDataRaw.length} 行 / summary: ${trialSummaries.length} attempt。ZIP保存後に保存先を確認してください。`;
}

/* ---------- CSV / JSON 生成 ---------- */

// 1セルを CSV 用にエスケープ
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function rowsToCsv(columns, rows) {
  const header = columns.join(',');
  const lines = rows.map((r) => columns.map((c) => csvCell(r[c])).join(','));
  return header + '\n' + lines.join('\n') + '\n';
}

// 1回のクリックにつき1ファイルだけダウンロードする。
function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  // Safari でもダウンロード開始前に URL を破棄しないよう猶予を設ける。
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 60000);
}

function downloadText(filename, text, mime) {
  downloadBlob(filename, new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' }));
}

// ZIP の CRC-32。外部ライブラリやネットワーク接続を必要としない。
const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let i = 0; i < 8; i += 1) {
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

// ZIP 形式（無圧縮）。3ファイルを1回のダウンロードにまとめる。
function createZip(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  let offset = 0;
  let centralSize = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = encoder.encode(file.text);
    if (name.length > 0xffff || data.length > 0xffffffff || offset + 30 + name.length + data.length > 0xffffffff) {
      throw new Error('ZIPに格納できるファイルサイズを超えました。');
    }
    const checksum = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true); // UTF-8 ファイル名
    localView.setUint16(8, 0, true);      // 無圧縮
    localView.setUint16(10, dosTime, true);
    localView.setUint16(12, dosDate, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    localParts.push(local, data);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, dosTime, true);
    centralView.setUint16(14, dosDate, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centralParts.push(central);
    offset += local.length + data.length;
    centralSize += central.length;
  }

  if (files.length > 0xffff || offset + centralSize > 0xffffffff) {
    throw new Error('ZIPに格納できるファイル数またはサイズを超えました。');
  }
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' });
}

function fileBaseName(kind, stamp = dateStamp(new Date())) {
  const s = appState.settings;
  const participantId = s.participant_id.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
  return `${participantId}_wacom_${kind}_${stamp}`;
}

function buildSettingsJson() {
  const s = appState.settings;
  return {
    session_id: appState.session_id,
    participant_id: s.participant_id,
    target_duration_ms: s.target_duration_ms,
    target_line_length_mm: s.target_line_length_mm,
    repetitions_per_direction: s.repetitions_per_direction,
    pressure_tolerance: s.pressure_tolerance,
    target_pressure: appState.target_pressure,
    pressure_low: appState.pressure_low,
    pressure_high: appState.pressure_high,
    rest_every_trials: s.rest_every_trials,
    pre_trial_sync_wait_ms: s.pre_trial_sync_wait_ms,
    baseline_duration_ms: s.baseline_duration_ms,
    baseline_guard_ms: s.baseline_guard_ms,
    baseline_protocol: {
      conditions: BASELINE_CONDITIONS.map((condition) => ({
        baseline_id: condition.id,
        baseline_type: condition.type,
        baseline_label: condition.label,
      })),
      target_duration_ms: s.baseline_duration_ms,
      guard_ms: s.baseline_guard_ms,
      analysis_window_definition: 'start_tap_pointerup_plus_guard_to_end_tap_pointerdown_minus_guard',
    },
    recorded_baseline_intervals: appState.baselineIntervals,
    generated_trial_order: appState.trialOrder,
    attempt_counts_by_trial: appState.attemptCounts,
    trial_window_definition: 'pre_trial_sync_pointerup_to_result_button_click',
    summary_includes_rejected_attempts: true,
    moving_guide_enabled: true,
    display_device_model: DISPLAY_DEVICE_MODEL,
    display_width_mm: DISPLAY_WIDTH_MM,
    display_height_mm: DISPLAY_HEIGHT_MM,
    coordinate_origin: 'canvas_top_left',
    coordinate_unit: 'mm',
    spatial_schema_version: 'mm_v1',
    calibration_method: 'DTH134_display_dimensions_mapped_to_fullscreen_canvas',
    fullscreen_required_for_mm_accuracy: true,
    pointer_timestamp_source: 'PointerEvent.timeStamp',
    pointer_timestamp_fallback: 'performance.now()',
    pointer_timestamp_schema_version: 'event_time_v1',
    session_start_performance_ms: round(appState.sessionStartPerformanceNow, 3),
    session_start_epoch_ms: appState.sessionStartEpochMs,
    movement_onset_reference: 'actual_touch_point',
    mm_per_css_px_x: round(mmPerCssPxX(), 8),
    mm_per_css_px_y: round(mmPerCssPxY(), 8),
    moving_guide_radius_mm: MOVING_GUIDE_RADIUS_MM,
    start_zone_radius_mm: START_ZONE_RADIUS_MM,
    movement_onset_threshold_mm: MOVEMENT_ONSET_THRESHOLD_MM,
    movement_offset_method: 'smoothed_velocity_threshold_with_pointerup_fallback',
    movement_offset_velocity_threshold_mm_s: MOVEMENT_OFFSET_SPEED_THRESHOLD_MM_S,
    movement_offset_sustain_ms: MOVEMENT_OFFSET_SUSTAIN_MS,
    movement_offset_smoothing_ms: MOVEMENT_OFFSET_SMOOTHING_MS,
    movement_offset_min_progress: MOVEMENT_OFFSET_MIN_PROGRESS,
    tracking_tolerance_mm: TRACKING_TOLERANCE_MM,
    tracking_evaluation_interval_ms: TRACKING_EVAL_INTERVAL_MS,
    success_tracking_in_range_ratio_min: SUCCESS_CRITERIA.tracking_in_range_ratio_min,
    retry_tracking_in_range_ratio_min: RETRY_CRITERIA.tracking_in_range_ratio_min,
    success_pen_lift_count_max: SUCCESS_CRITERIA.pen_lift_count_max,
    canvas_width_mm: DISPLAY_WIDTH_MM,
    canvas_height_mm: DISPLAY_HEIGHT_MM,
    internal_canvas_width_css_px: round(appState.cssW, 1),
    internal_canvas_height_css_px: round(appState.cssH, 1),
    device_pixel_ratio: window.devicePixelRatio || 1,
    user_agent: navigator.userAgent,
    created_at_iso: appState.created_at_iso,
  };
}

function saveRaw() {
  const csv = rowsToCsv(RAW_COLUMNS, trialDataRaw);
  console.log('[raw csv]\n' + csv.slice(0, 2000));
  downloadText(fileBaseName('raw') + '.csv', csv, 'text/csv');
}
function saveSummary() {
  const csv = rowsToCsv(SUMMARY_COLUMNS, trialSummaries);
  console.log('[summary csv]\n' + csv);
  downloadText(fileBaseName('summary') + '.csv', csv, 'text/csv');
}
function saveSettings() {
  const json = JSON.stringify(buildSettingsJson(), null, 2);
  console.log('[settings json]\n' + json);
  downloadText(fileBaseName('settings') + '.json', json, 'application/json');
}

function updateSaveControls() {
  for (const id of ['btn-save-raw', 'btn-save-summary', 'btn-save-settings', 'btn-back-to-settings']) {
    document.getElementById(id).disabled = !appState.archiveConfirmed;
  }
}

function saveAllZip() {
  const confirmation = document.getElementById('save-confirmed');
  confirmation.checked = false;
  confirmation.disabled = true;
  appState.archiveConfirmed = false;
  updateSaveControls();

  try {
    const stamp = dateStamp(new Date());
    const zip = createZip([
      { name: fileBaseName('raw', stamp) + '.csv', text: rowsToCsv(RAW_COLUMNS, trialDataRaw) },
      { name: fileBaseName('summary', stamp) + '.csv', text: rowsToCsv(SUMMARY_COLUMNS, trialSummaries) },
      { name: fileBaseName('settings', stamp) + '.json', text: JSON.stringify(buildSettingsJson(), null, 2) },
    ]);
    downloadBlob(fileBaseName('all', stamp) + '.zip', zip);
    confirmation.disabled = false;
    document.getElementById('save-status').textContent =
      'ZIPのダウンロードを開始しました。保存先にZIPファイルがあることを確認し、チェックを入れてください。見当たらない場合は「すべて保存」を再度押してください。';
  } catch (error) {
    console.error('[ZIP save failed]', error);
    document.getElementById('save-status').textContent =
      `ZIPを作成できませんでした: ${error.message}`;
  }
}

/* ===================================================================
   20. 設定確定 / 初期化 / イベント結線
=================================================================== */

// 数値入力を安全に読む。不正(NaN/範囲外)なら初期値に戻す。
function readNumberInput(id, defaultValue, minValue) {
  const v = Number(document.getElementById(id).value);
  if (!Number.isFinite(v) || v < minValue) return defaultValue;
  return v;
}

function readSettingsFromForm() {
  const val = (id) => document.getElementById(id).value;
  const baselineDurationMs = readNumberInput(
    'set-baseline_duration_ms', DEFAULT_BASELINE_DURATION_MS, 20000
  );
  let baselineGuardMs = readNumberInput(
    'set-baseline_guard_ms', DEFAULT_BASELINE_GUARD_MS, 1000
  );
  // 前後guardを除いて解析区間が必ず残る値に補正する。
  if (baselineGuardMs * 2 >= baselineDurationMs) {
    baselineGuardMs = Math.min(DEFAULT_BASELINE_GUARD_MS, Math.floor((baselineDurationMs - 1000) / 2));
  }
  return {
    participant_id: val('set-participant_id').trim() || 'P00',
    target_duration_ms: readNumberInput('set-target_duration_ms', 1000, 100),
    target_line_length_mm: readNumberInput('set-target_line_length_mm', 50, 10),
    repetitions_per_direction: Math.max(1, Math.round(readNumberInput('set-repetitions_per_direction', 10, 1))),
    pressure_tolerance: readNumberInput('set-pressure_tolerance', 0.08, 0.01),
    rest_every_trials: Math.max(1, Math.round(readNumberInput('set-rest_every_trials', 24, 1))),
    pre_trial_sync_wait_ms: readNumberInput('set-pre_trial_sync_wait_ms', 1500, 0),
    baseline_duration_ms: baselineDurationMs,
    baseline_guard_ms: baselineGuardMs,
  };
}

// 実験再開時に前回の状態が残らないようリセットする
function resetExperimentState() {
  clearBaselineTimer();
  trialDataRaw.length = 0;
  trialSummaries.length = 0;
  appState.archiveConfirmed = false;
  const confirmation = document.getElementById('save-confirmed');
  confirmation.checked = false;
  confirmation.disabled = true;
  updateSaveControls();

  appState.currentTrialPos = 0;
  appState.trialOrder = [];
  appState.attemptCounts = {};
  appState.baselineIntervals = [];
  appState.currentLine = null;

  appState.render.targetProgress = 0;
  appState.render.showSyncCircle = false;
  appState.render.showGuideLine = false;
  appState.render.practiceGuides = false;
  appState.render.penX = null;
  appState.render.penY = null;
  appState.render.penPressure = 0;
  appState.render.penVisible = false;

  appState.currentPressure = 0;

  // 筆圧キャリブレーションは新しい実験で再度行うためリセット
  appState.target_pressure = null;
  appState.pressure_low = null;
  appState.pressure_high = null;
}

function confirmSettings() {
  // まず前回の実験状態を完全にリセット
  resetExperimentState();

  const s = readSettingsFromForm();
  appState.settings = s;

  // セッション基準時刻と session_id を確定
  appState.sessionStartPerformanceNow = performance.now();
  appState.sessionStartEpochMs = Date.now();
  appState.created_at_iso = new Date().toISOString();
  appState.session_id = `${s.participant_id}_${dateStamp(new Date())}`;

  // 全方向で両端に10mmずつ余白を残せる長さを目安にする。
  const maxFit = Math.min(DISPLAY_WIDTH_MM, DISPLAY_HEIGHT_MM) - 20;
  if (s.target_line_length_mm > maxFit) {
    console.warn(`target_line_length_mm=${s.target_line_length_mm} は画面に収まらない可能性があります (推奨 <= ${maxFit}mm)`);
  }

  // 試行順を生成 (ブロックランダム)
  appState.trialOrder = generateTrialOrder(s.repetitions_per_direction);

  // canvas サイズを先に確定しておく(stage 表示前でも window フォールバックで取得)
  resizeCanvas();

  // デバッグ表示
  console.log('[settings]', appState.settings);
  console.log('[canvas]', appState.cssW, appState.cssH);
  console.log('[trialOrder length]', appState.trialOrder.length);
  console.log('[session_id]', appState.session_id);
  if (!appState.cssW || !appState.cssH) {
    console.warn('Canvas size is zero. Check panel visibility and resize timing.');
  }

  let note = `設定確定。session_id=${appState.session_id} / 合計 ${appState.trialOrder.length} 試行。続いて開始前同期タップへ。`;
  if (s.target_line_length_mm > maxFit) {
    note += `\n警告: 線の長さ(${s.target_line_length_mm}mm)が画面サイズより大きい可能性があります(推奨 <= ${maxFit}mm)。`;
  }
  document.getElementById('settings-status').textContent = note;

  // 開始同期 → 安静時ベースライン → MVC → 筆圧キャリブレーション → 練習 の順に進む。
  enterStartSync();
}

function requestFullscreen() {
  const el = document.documentElement;
  if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
}

function init() {
  setupCanvas();

  // 設定画面
  document.getElementById('btn-confirm-settings').addEventListener('click', confirmSettings);
  document.getElementById('btn-fullscreen').addEventListener('click', requestFullscreen);

  // サマリーのボタン
  document.getElementById('btn-summary-next').addEventListener('click', onSummaryNext);
  document.getElementById('btn-summary-redo').addEventListener('click', onSummaryRedo);

  // 休憩
  document.getElementById('btn-rest-resume').addEventListener('click', () => { showPanel('stage'); nextTrial(); });

  // 保存
  document.getElementById('btn-save-raw').addEventListener('click', saveRaw);
  document.getElementById('btn-save-summary').addEventListener('click', saveSummary);
  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
  document.getElementById('btn-save-all').addEventListener('click', saveAllZip);
  document.getElementById('save-confirmed').addEventListener('change', (event) => {
    appState.archiveConfirmed = event.target.checked;
    updateSaveControls();
    document.getElementById('save-status').textContent = appState.archiveConfirmed
      ? 'ZIPの保存確認が完了しました。個別保存や新しい実験の操作ができます。'
      : 'ZIPの保存を確認してチェックを入れてください。';
  });

  window.onbeforeunload = (event) => {
    if (appState.archiveConfirmed || (trialDataRaw.length === 0 && trialSummaries.length === 0)) return;
    event.preventDefault();
    event.returnValue = '';
  };

  // 設定画面に戻る(リロード無しで新しい実験を開始できる)。状態は確定時にリセットされる。
  document.getElementById('btn-back-to-settings').addEventListener('click', () => {
    document.getElementById('settings-status').textContent = '前回のデータは確定時にリセットされます。設定を入力してください。';
    showPanel('settings');
  });

  showPanel('settings');
}

window.addEventListener('DOMContentLoaded', init);
