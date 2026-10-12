#!/bin/bash

set -euo pipefail

WACOM_DIR="/Users/k248578/博士後期課程/博士後期でやる研究/App"
MEDIAPIPE_DIR="/Users/k248578/Documents/MediaPipe/right-hand-hand-landmarker-app"
WACOM_PORT=8000
MEDIAPIPE_PORT=8080
WACOM_URL="http://localhost:${WACOM_PORT}/"
MEDIAPIPE_URL="http://localhost:${MEDIAPIPE_PORT}/"
LAUNCHER_LOG_DIR="${TMPDIR:-/tmp}/wacom-mediapipe-launcher"

WACOM_PID=""
MEDIAPIPE_PID=""

validate_environment() {
  if [[ ! -f "${WACOM_DIR}/index.html" ]]; then
    echo "Wacomアプリが見つかりません: ${WACOM_DIR}"
    exit 1
  fi
  if [[ ! -f "${MEDIAPIPE_DIR}/index.html" ]]; then
    echo "MediaPipeアプリが見つかりません: ${MEDIAPIPE_DIR}"
    exit 1
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    echo "python3が見つかりません。"
    exit 1
  fi
}

port_is_in_use() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

cleanup() {
  echo
  echo "このスクリプトが起動したサーバーを終了します。"
  if [[ -n "${WACOM_PID}" ]]; then
    kill "${WACOM_PID}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${MEDIAPIPE_PID}" ]]; then
    kill "${MEDIAPIPE_PID}" >/dev/null 2>&1 || true
  fi
}

start_server() {
  local name="$1"
  local directory="$2"
  local port="$3"
  local log_file="$4"

  if port_is_in_use "${port}"; then
    echo "${name}: ポート${port}は既に使用中です。既存サーバーを利用します。"
    return 0
  fi

  python3 -m http.server "${port}" --bind 127.0.0.1 --directory "${directory}" >"${log_file}" 2>&1 &
  local server_pid=$!
  if [[ "${name}" == "Wacom" ]]; then
    WACOM_PID="${server_pid}"
  else
    MEDIAPIPE_PID="${server_pid}"
  fi
  echo "${name}: ${directory} を ${port}番ポートで起動しました。"
}

validate_environment

if [[ "${1:-}" == "--check" ]]; then
  echo "起動条件を確認しました。WacomとMediaPipeの両アプリが見つかりました。"
  exit 0
fi

mkdir -p "${LAUNCHER_LOG_DIR}"
trap cleanup EXIT INT TERM HUP

start_server "Wacom" "${WACOM_DIR}" "${WACOM_PORT}" "${LAUNCHER_LOG_DIR}/wacom.log"
start_server "MediaPipe" "${MEDIAPIPE_DIR}" "${MEDIAPIPE_PORT}" "${LAUNCHER_LOG_DIR}/mediapipe.log"

# ローカルサーバーの起動を少し待ってからChromeで開く。
sleep 1
open -a "Google Chrome" "${WACOM_URL}"
open -a "Google Chrome" "${MEDIAPIPE_URL}"

echo
echo "Wacom:     ${WACOM_URL}"
echo "MediaPipe: ${MEDIAPIPE_URL}"
echo
echo "Chromeで同じウィンドウのタブとして開いた場合は、MediaPipeタブを別ウィンドウへ移してください。"
echo "Wacom画面はWacom One側でフルスクリーン、MediaPipe画面はMac本体側で表示したままにします。"
echo "終了するときは、このターミナルで Control+C を押してください。"

# 起動したサーバーの少なくとも一方が動いている間、このターミナルを維持する。
if [[ -n "${WACOM_PID}" && -n "${MEDIAPIPE_PID}" ]]; then
  wait "${WACOM_PID}" "${MEDIAPIPE_PID}"
elif [[ -n "${WACOM_PID}" ]]; then
  wait "${WACOM_PID}"
elif [[ -n "${MEDIAPIPE_PID}" ]]; then
  wait "${MEDIAPIPE_PID}"
fi
