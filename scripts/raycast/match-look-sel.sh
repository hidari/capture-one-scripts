#!/bin/bash
# @raycast.schemaVersion 1
# @raycast.title Match Look (selection)
# @raycast.mode silent
# @raycast.packageName Capture One
# @raycast.description Capture One で現在選択中の対象に Match Look を適用する

# 自身の位置から repo ルートへ移動(パス直書き回避)。Raycast は in-place 実行。
cd "$(dirname "$0")/../.." || exit 1
"$HOME/.local/bin/pkf" run sel
