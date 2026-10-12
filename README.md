# Wacom 直線運筆 実験アプリ

Wacom One 上に直線運筆課題を表示し、ペン軌跡（座標 / 筆圧 / 時刻）を記録する実験用 Web アプリです。
取得したデータは、後処理で PicoLog の筋電位（EMG）データと「同期タップ」を介して同期し、
**運筆方向・軌跡・筆圧・時刻**を対応づけることを目的とします。

- 動作環境: **Mac + Google Chrome / Safari + Wacom One**（ペン入力）
- 外部サーバー / データベースは使いません。**すべてローカルのブラウザ内で完結**します。
- 技術: Vanilla HTML / CSS / JavaScript（外部ライブラリなし）

## ファイル構成

| ファイル | 役割 |
| --- | --- |
| `index.html` | 画面構成（設定 / キャリブ / 練習 / 同期 / 試行 / 休憩 / 保存）と canvas・HUD |
| `style.css` | 研究用フルスクリーン UI、筆圧バー、同期円などのスタイル |
| `app.js` | 状態管理・試行順生成・Pointer 記録・同期タップ・summary 計算・CSV 保存 |
| `20260629/00_tablet_emg_sync/sync_tablet_emg.py` | Wacom時刻をPicoLog時刻へ変換し、接触・実移動・安静・MVCの同期区間を出力 |
| `README.md` | 本ドキュメント |

## 起動方法

`file://` でも動きますが、Pointer Events を安定させるためローカルサーバ経由を推奨します。

```bash
cd "このフォルダ"
python3 -m http.server 8000
```

ブラウザ（Chrome）で次を開きます。

```
http://localhost:8000/
```

- ペン入力が `mouse` 扱いになる場合もテストできるよう、マウスでも動作します。
- 本番では「フルスクリーン開始」を押し、全画面で使用してください。
- 距離換算は Wacom One 13 touch (DTH134) の表示領域 294 × 165 mm を、フルスクリーンのcanvas全体へ対応づけます。Chrome/Safariともフルスクリーンで使用してください。
- アプリ内部では描画・Pointer Event処理にCSS pxを使いますが、設定値・判定値・CSVの空間情報はmmで保存します。

## 実験手順

1. **設定画面**で参加者 ID や各パラメータを入力し、「実験設定を確定」。
   - `participant_id`, `target_duration_ms`(初期1000), `target_line_length_mm`(初期50),
     `repetitions_per_direction`(初期10), `pressure_tolerance`(初期0.08),
     `rest_every_trials`(初期24), `pre_trial_sync_wait_ms`(初期1500)
   - 安静時設定: `baseline_duration_ms`（初期30000）、`baseline_guard_ms`（初期5000）
2. PicoLog と MediaPipe の記録を開始し、**開始前同期タップ**を3回行う。
3. **安静時ベースライン**を計測。
   1. **完全安静**：開始タップ後にペンを机へ置き、腕と手を楽にして30秒静止。
   2. **タスク姿勢安静**：開始タップ後に課題時と同じ姿勢でペンを握り、画面へ触れず30秒静止。
   3. 各条件の30秒が終わったら終了タップ。解析区間は開始タップの `pointerup + 5秒` から、終了タップの `pointerdown - 5秒` まで。
4. **MVCキャリブレーション**：PicoLog・MediaPipeの記録を継続したまま、手首4方向の最大随意収縮を記録。
5. **筆圧キャリブレーション**：中央の線を自然な強さで3回なぞり、平均筆圧を `target_pressure` とする。
6. **練習**（任意）：筆圧ガイドを大きく表示して数試行練習。`phase=practice` で raw 保存。
7. **本番試行**（24方向 × 繰り返し回数。初期で 240 試行）。各試行は次の流れ。
   1. 試行前同期タップ画面で、中央を強く **1回** タップ（`phase=pre_trial_sync`）。ペンを離した瞬間から、その角度の `attempt_id` に属する試行区間を開始する。
   2. タップ後 `pre_trial_sync_wait_ms` だけ待機（タップの筋活動が運筆に混ざらないように）。
   3. 始点・終点・点線と、始点上に青いガイドリングが表示される。
   4. 「準備できたら始点をタッチし、ペン先をガイドリングに合わせてください」。
   5. 参加者が自分のタイミングで**始点（緑の円）をタッチ**。始点にペンが触れた瞬間を
      `touch_start_time_ms`（実質運筆開始時刻）として記録する。同時にガイドリングが一定速度で動き始め、設定時間（初期1秒）で終点へ到達する。
   6. ガイドリングを追って終点まで運筆し、リングが終点で緑になったらペンを離す。`pointerdown/move/up` を `phase=trial` で記録し、終点でペンを離した `pointerup` を
      `last_pointerup_time_ms` として記録し、運筆区間を終了する。
   7. 試行サマリーを表示 → 「次の試行」または「やり直し」。ボタンを押した瞬間に試行区間を終了し、`accepted` または `rejected` を保存する。
8. `rest_every_trials` ごとに **休憩画面**。
9. 全試行終了後、**終了後同期タップ** を **3回**。その後PicoLogとMediaPipeの記録を停止。
10. **データ保存画面**で「すべて保存」を押し、raw CSV / summary CSV / settings JSON を含む ZIP を保存。保存先に ZIP があることを確認してチェックを入れると、個別保存や新しい実験のボタンが使えるようになります。

### 安静時ベースライン

- 各条件の開始・終了タップは `phase=baseline`, `sync_role=baseline_marker_tap` としてraw CSVへ保存します。通常の同期タップ抽出条件 `*_sync_tap` には入りません。
- 解析開始・終了は `baseline_analysis_start` / `baseline_analysis_end` のマーカー行としてraw CSVへ保存します。
- 計測中に画面へ触れた回数を `baseline_unexpected_contact_count` に保存します。タスク姿勢安静ではペン先を浮かせてください。
- settings JSONの `recorded_baseline_intervals` に、4つの境界時刻、解析区間、実計測時間、接触回数、妥当性を条件別に保存します。
- MediaPipeの `frame_epoch_ms` は `analysis_start_epoch_ms <= frame_epoch_ms <= analysis_end_epoch_ms` で抽出できます。
- `20260629/00_tablet_emg_sync/sync_tablet_emg.py` を実行すると、同期後のEMG解析区間が `synced_baseline_windows.csv` に出力されます。

### 試行順（ブロックランダム）

- 1ブロック = 24方向を各1回（ブロック内でランダム順）。
- `repetitions_per_direction = R` なら R ブロック作成 → 合計 `24 × R` 試行。
- `repetition_index` は「そのブロック番号（= その方向の何回目か）」を表します。
- `trial_index` はブロック内の番号（1〜24）、`trial_global_index` は全体の通し番号です。
- 同じ試行をやり直すたびに `attempt_index` が1増え、一意な `attempt_id` が付与されます。角度と `trial_global_index` は変わりません。
- `target_angle_deg` は試行前同期タップ画面を表示する前に確定済みです。同期タップと、その後の全イベントには同じ角度を保存します。

### attempt区間

- 1 attempt = **試行前同期タップの `pointerup` から、結果画面のボタン押下まで**。
- 開始・準備完了・結果表示・終了は、raw CSVに `trial_window_start` / `trial_ready` / `result_displayed` / `trial_window_end` のマーカー行として保存します。
- 区間内にブラウザから届いた非接触・ホバー等のPointer Eventも `phase=trial_window` で保存します。イベントが届かない時間について座標を生成・補間することはありません。
- `attempt_outcome=accepted` は採用試行、`attempt_outcome=rejected` は「やり直し」を選んだ試行です。summary CSVには両方を保存します。

### 運筆開始・終了方式（自己ペース開始・一定速度追従方式）

参加者は自分のタイミングで始点をタッチします。接触した瞬間から、青いガイドリングが
点線上を一定速度で移動し、`target_duration_ms` で終点へ到達します。
参加者はペン先をリングに合わせ、接触を保ったまま終点まで線を引きます。
始点にペンが触れた `pointerdown` の時刻を `touch_start_time_ms` として記録し、
これを実質運筆開始時刻として扱います。
終点でペンを離した `pointerup` の時刻を `last_pointerup_time_ms` として記録します。
運筆時間 `actual_duration_ms` は `last_pointerup_time_ms - touch_start_time_ms` で計算します。
左上には `touch_start_time_ms` からの経過時間を表示します。
リング位置は描画フレーム数ではなく経過時刻から計算するため、画面描画の一時的な遅れが累積しません。

- 始点判定: 始点から `START_ZONE_RADIUS_MM`(5mm) 以内の `pointerdown` のみ開始とみなします。
  範囲外のタッチは `phase=pre_start_touch` として raw にのみ残し、trial データには含めません。
- `movement_onset_time_ms`: 理想始点ではなく、実際に最初に接触した座標から
  `MOVEMENT_ONSET_THRESHOLD_MM`(1mm) 以上動いた時刻。閾値をまたぐ2点間は線形補間する。
- `movement_offset_time_ms`: 線分進捗80%以上で、平滑化速度10 mm/s未満の最終低速区間が
  50 ms以上続き、その後ペン離脱まで再加速しなかった時点から運動終了を推定する。
  条件を満たさない場合は `last_pointerup_time_ms` を使用する。
- `kinematic_duration_ms = movement_offset_time_ms - movement_onset_time_ms`。
- `start_delay_ms` は接触から実移動開始まで、`dwell_after_movement_ms` は実移動終了からペン離脱までの時間。
- 従来の `actual_duration_ms = last_pointerup_time_ms - touch_start_time_ms` も互換性のため保存する。
- `pen_lift_count`: 始点タッチ後の途中ペン離れ回数（始点タッチの `pointerdown` は数えません）。成功条件では0回です。

本番試行では、参加者が自分のタイミングで始点をタッチすると、その瞬間から
canvas 左側のデジタルタイマーが 0.00 秒で開始します。
タイマーの周囲には、目標時間までの進行リング（視覚メトロノーム）が表示されます
（0〜0.8=青 / 0.8〜1.2=緑 / 1.2〜=赤）。
参加者はガイドリングを主な速度基準とし、canvas内タイマーと上部HUDの `Time:` 表示も
補助情報として利用できます。

### ガイド追従の暫定評価

- ガイドリング半径: `MOVING_GUIDE_RADIUS_MM = 4 mm`
- 追従許容距離: `TRACKING_TOLERANCE_MM = 5 mm`
- 指標計算間隔: `TRACKING_EVAL_INTERVAL_MS = 5 ms`（評価用の補間であり、raw取得周波数ではありません）
- 成功: 目標1秒間のうちガイドから5 mm以内にいた時間割合が80%以上
- やり直し候補: 同割合が50%以上

追従評価では、保存されたPointer Event間のペン位置を線形補間し、開始から目標時間までを
5 ms間隔で評価します。途中でペンが離れている時間や、目標時間より早くペンを離した後の時間は
許容範囲内に数えません。終点へ早く到着して静止した場合も、その間は移動中のガイドより先行するため
追従誤差になります。これらの値は予備実験後に再調整します。

## PicoLog との同期方法

PicoLog とアプリは**直接通信しません**。後処理で同期タップを使って時刻を対応づけます。

1. PicoLogとMediaPipeの記録を開始する。
2. Wacom アプリで **開始前同期タップを3回** 行う。
3. 安静時計測、MVC、筆圧キャリブレーション、練習を行う。
4. **各本番試行の直前に、画面中央を1回強くタップ** する。
5. タップ後、`pre_trial_sync_wait_ms` だけ待機してから「始点タッチ待ち」状態へ移行する。
6. 参加者が始点をタッチし、一定速度のガイドリングを追って終点まで直線運筆を行う。
7. 全試行終了後、**終了後同期タップを3回** 行う。
8. PicoLogとMediaPipeを停止する。
9. 後処理で、Wacom 側の同期タップ時刻（筆圧ピーク）と PicoLog 側の EMG ピークを対応づける。
10. 接触基準では `touch_start_time_ms`、実移動基準では `movement_onset_time_ms` を開始として使う。
11. 試行前準備から結果判断までを解析する場合は、`trial_window_start_time_ms` 〜 `trial_window_end_time_ms` を同じ `attempt_id`・`target_angle_deg` の区間として使う。
12. 必要に応じて `emg_window_start_candidate_ms` 〜 `emg_window_end_candidate_ms` を運筆近傍の EMG 切り出し範囲として使う。
    EMG 切り出し候補区間は、`touch_start_time_ms - 200ms` から `last_pointerup_time_ms + 200ms` までとします。

### 時刻について

- PicoLog 側は **1ms 刻みの相対時刻** で記録される想定。
- Wacom 側の `timestamp_ms` は `PointerEvent.timeStamp` をセッション開始基準へ変換した相対時刻です。
  `handler_timestamp_ms` と `event_processing_delay_ms` も保存するため、ブラウザ処理遅延を確認できます。
  **両者の 0 秒は一致しません**。そのため同期タップで後処理変換します。
- `epoch_ms` と `iso_time` も併記します。Pointer Event行はイベント発生時刻をUnix時刻へ変換し、
  区間マーカー行は`Date.now()`を使うため、壁時計時刻でも突き合わせ可能です。

### 同期タップの3種類（`phase` と `sync_role` で区別）

| 種類 | タイミング | 回数 | `phase` | `sync_role` | `tap_index` |
| --- | --- | --- | --- | --- | --- |
| 開始前同期タップ | 実験開始前 | 3 | `start_sync` | `start_sync_tap` | 1,2,3 |
| 各試行前同期タップ | 各本番試行の直前 | 1 | `pre_trial_sync` | `pre_trial_sync_tap` | 1 |
| 終了後同期タップ | 全試行終了後 | 3 | `end_sync` | `end_sync_tap` | 1,2,3 |

通常の運筆イベントは `sync_role = none` です。
開始前・終了後の3回タップは実験全体の時刻ずれ確認に、各試行前の1回タップは各試行の局所同期マーカーに使います。
安静時計測の境界タップは `baseline_marker_tap` であり、この3種類とは別に扱います。

## CSV の説明

### raw CSV

すべてのペンイベント（同期タップ含む）を1行ずつ記録します。主な列：

- 識別: `session_id`, `participant_id`, `phase`, `sync_role`,
  `block_index`, `trial_index`, `trial_global_index`, `repetition_index`, `target_angle_deg`, `tap_index`
- イベント: `event_type`, `pointer_type`, `pointer_id`
- 時刻: `timestamp_ms`（Pointer Event発生時刻をセッション基準へ変換した相対ms）、`epoch_ms`, `iso_time`,
  `handler_timestamp_ms`, `event_processing_delay_ms`, `event_timestamp_source`
- イベントバッチ: `coalesced_batch_size`, `coalesced_event_index`
- 座標/筆圧: `x_mm`, `y_mm`（canvas 左上基準）, `pressure`
- 設定/筆圧基準: `target_pressure`, `pressure_tolerance`, `pressure_low`, `pressure_high`,
  `target_duration_ms`, `target_line_length_mm`, `pre_trial_sync_wait_ms`
- 試行タイミング（試行確定後に全行へ backfill）:
  `trial_start_button_time_ms`, `countdown_go_time_ms`（本番では空）, `first_pointerdown_time_ms`,
  `last_pointerup_time_ms`, `trial_end_time_ms`, `touch_start_time_ms`, `movement_onset_time_ms`
- attempt識別・区間: `attempt_index`, `attempt_id`, `attempt_stage`, `attempt_outcome`,
  `trial_window_start_time_ms`, `trial_window_start_epoch_ms`, `trial_ready_time_ms`,
  `result_display_time_ms`, `trial_window_end_time_ms`, `trial_window_end_epoch_ms`
- ガイド追従: `guide_progress`, `guide_x_mm`, `guide_y_mm`, `tracking_error_mm`,
  `along_track_error_mm`, `cross_track_error_mm`
- 運動境界: `movement_onset_reference`, `movement_offset_time_ms`, `movement_offset_method`
- 安静時: `baseline_id`, `baseline_type`, `baseline_stage`, `baseline_target_duration_ms`,
  `baseline_guard_ms`, `baseline_unexpected_contact_count`, `baseline_valid`
- 環境: `canvas_width_mm`, `canvas_height_mm`, `device_pixel_ratio`

`phase` は `baseline` / `mvc` / `calibration` / `practice` / `start_sync` / `pre_trial_sync` / `trial` /
`trial_window`（区間マーカー・非接触イベント）/ `end_sync` / `pre_start_touch`（始点範囲外のタッチ）
を取り得ます。

### summary CSV

本番attemptごとの要約。採用・やり直しの両方を含むため、採用試行だけを使う場合は `attempt_outcome=accepted` で抽出します。主な指標：

- 角度: `actual_angle_deg`, `angle_error_deg`
- 時間/速度: `actual_duration_ms`, `duration_error_ms`,
  `target_velocity_mm_per_s`, `mean_velocity_mm_per_s`, `velocity_error_mm_per_s`
- 軌跡: `actual_path_length_mm`, `straightness_error_mm`, `pen_lift_count`
- 筆圧: `mean_pressure`, `max_pressure`, `pressure_sd`, `pressure_in_range_ratio`
- 同期/区間: `pre_trial_sync_tap_time_ms`, `pre_trial_sync_tap_epoch_ms`, `pre_trial_sync_tap_pressure`,
  `countdown_go_time_ms`（本番では空）, `first_pointerdown_time_ms`, `last_pointerup_time_ms`, `trial_end_time_ms`,
  `emg_window_start_candidate_ms`, `emg_window_end_candidate_ms`
- 自己ペース開始・一定速度追従方式: `touch_start_time_ms`, `movement_onset_time_ms`, `movement_duration_ms`,
  `start_touch_x_mm`, `start_touch_y_mm`, `start_touch_distance_from_ideal_mm`,
  `end_release_x_mm`, `end_release_y_mm`, `end_release_distance_from_ideal_mm`
- 判定: `success_flag`, `notes`, `verdict`, `angle_ok`, `duration_ok`, `pressure_ok`, `lift_ok`
- ガイド追従: `guide_tracking_tolerance_mm`, `tracking_rmse_mm`, `tracking_max_error_mm`,
  `tracking_in_range_ratio`, `tracking_observed_ratio`, `mean_abs_along_track_error_mm`,
  `mean_abs_cross_track_error_mm`, `goal_arrival_time_ms`, `goal_arrival_elapsed_ms`,
  `release_time_error_ms`, `tracking_ok`
- 接触・実移動: `movement_offset_time_ms`, `kinematic_duration_ms`, `start_delay_ms`,
  `dwell_after_movement_ms`, `goal_dwell_ms`, `movement_offset_method`
- 時刻品質: `pointer_event_count`, `median_pointer_interval_ms`, `p95_pointer_interval_ms`,
  `max_pointer_interval_ms`, `estimated_pointer_rate_hz`, `median_event_processing_delay_ms`,
  `p95_event_processing_delay_ms`, `coalesced_event_ratio`
- attempt: `attempt_index`, `attempt_id`, `attempt_outcome`, `trial_window_start_time_ms`,
  `trial_ready_time_ms`, `result_display_time_ms`, `trial_window_end_time_ms`（開始・終了のepoch列も保存）

#### 主な計算式

- `actual_angle_rad = atan2(-(end_release_y - start_touch_y), end_release_x - start_touch_x)`
  （始点タッチ位置 → 終点リリース位置）
- `angle_error_deg = |normalize180(target_angle_deg - actual_angle_deg)|`
- `actual_duration_ms = last_pointerup_time_ms - touch_start_time_ms`
- `movement_duration_ms = last_pointerup_time_ms - movement_onset_time_ms`
- `kinematic_duration_ms = movement_offset_time_ms - movement_onset_time_ms`
- `start_delay_ms = movement_onset_time_ms - touch_start_time_ms`
- `dwell_after_movement_ms = last_pointerup_time_ms - movement_offset_time_ms`
- `mean_velocity_mm_per_s = actual_path_length_mm / actual_duration_ms * 1000`
- `pressure_in_range_ratio = (pressure_low ≤ p ≤ pressure_high のサンプル数) / (p>0 のサンプル数)`
- `straightness_error_mm` = 各点から理想線分への垂直距離の平均
- `pen_lift_count = 始点タッチ後の pointerdown 回数 - 1`
- `release_time_error_ms = actual_duration_ms - target_duration_ms`
- `tracking_in_range_ratio = ガイドから5 mm以内だった評価時点数 / 全評価時点数`
- `tracking_rmse_mm` は接触中に観測できた評価時点のガイド・ペン間距離のRMSE
- `emg_window_start_candidate_ms = touch_start_time_ms - 200`
- `emg_window_end_candidate_ms = last_pointerup_time_ms + 200`

上記の運筆系指標はすべて `phase=trial`（始点タッチ以降）のデータのみで計算します。
同期タップや `pre_start_touch` は含めません。

#### 成功判定（予備実験用）

`app.js` の `SUCCESS_CRITERIA` でまとめて変更できます。

- `angle_error_deg <= 5`
- `actual_duration_ms` が `target_duration_ms ± 10%` 以内
- `pressure_in_range_ratio >= 0.4`
- `pen_lift_count = 0`
- `tracking_in_range_ratio >= 0.8`（暫定）

この基準は予備実験用です。本実験では、予備実験の結果を見て再調整してください。

#### やり直し候補

成功基準は満たさないが、以下の範囲に入る場合は「やり直し候補」として表示します
（`app.js` の `RETRY_CRITERIA`）。

- `angle_error_deg <= 25`
- `actual_duration_ms` が `target_duration_ms ± 50%` 以内
- `pressure_in_range_ratio >= 0.2`
- `pen_lift_count <= 1`
- `tracking_in_range_ratio >= 0.5`（暫定）

試行サマリー画面には総合判定を表示します。summary CSV の `notes` には
判定理由（例: `retry_candidate: duration_ng, tracking_ng | angle_ok=true; ...`）が残り、
追加列 `verdict`, `angle_ok`, `duration_ok`, `pressure_ok`, `lift_ok`, `tracking_ok` にも詳細が出力されます。
`success_flag` は従来どおり成功なら `1`、それ以外は `0` です。

### settings JSON

`session_id`, `participant_id`, 各設定値, `target_pressure`, `pressure_low/high`,
`baseline_protocol`, `recorded_baseline_intervals`,
`generated_trial_order`, ガイド半径・追従許容距離・追従成功基準、
DTH134のPointer Event時刻方式、実接触点基準の運動開始方式、運動終了判定の暫定閾値、
DTH134の表示寸法とpx→mm換算係数、`canvas_width_mm/height_mm`, `device_pixel_ratio`,
`user_agent`, `created_at_iso` を保存します。

### ファイル名

`participant_id` と日時を含みます。例：

```
P01_wacom_raw_20260618_161500.csv
P01_wacom_summary_20260618_161500.csv
P01_wacom_settings_20260618_161500.json
P01_wacom_all_20260618_161500.zip（上記3ファイルを格納）
```

## 角度定義

- `0°` = 右、`90°` = 上、`180°` = 左、`270°` = 下
- 画面座標は y が下向きに増えるため、角度計算では y を反転して扱います：

```
actual_angle_deg = atan2(-(end_y - start_y), end_x - start_x)
```

- 始点・終点は canvas 中央を基準に `target_line_length_mm` の実寸長で配置し、線分の中心が中央に来ます。

## 注意点

- canvas には `touch-action: none;` を設定し、`pointerdown` 時に `setPointerCapture` を使用します。
- `pointermove` では `getCoalescedEvents()` が使える場合に高密度サンプルを記録します。
- 座標は `clientX/clientY` ではなく **canvas 左上基準**に変換して保存します。
- 同期タップ後は `pre_trial_sync_wait_ms` 待機してから運筆を開始し、タップの筋活動が運筆区間に混ざるのを避けます。
- `timestamp_ms` はセッション開始時の `performance.now()` を基準とした相対時刻です。
- Pointer Event行の `timestamp_ms` はイベント固有の `timeStamp`を使います。区間マーカーなど
  Pointer Event以外の行は従来どおり処理時点の`performance.now()`を使います。
- データは**保存ボタンを押すまでブラウザのメモリ上にのみ**あります。終了前に必ず ZIP を保存し、保存先にあることを確認してください（リロード・タブを閉じると失われます）。未保存のデータがある状態でページを閉じようとすると、対応ブラウザでは警告が表示されます。
