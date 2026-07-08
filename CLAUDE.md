# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repository Is

macOS 専用の Capture One 現像ワークフロー自動化スクリプト。Sony α7V の RAW+JPEG 同時記録を前提に、PureRAW で現像した DNG と撮影時の creative look JPEG をペアリングし、Capture One の Match Look 機能で look を DNG へ転写する。

外部依存: `exiftool`（Homebrew）、Capture One 16.5.0+、macOS のみ。ビルドは `pkf`（pkfire タスクランナー）と `bunx tsc`（TypeScript、zero install）。Match Look（メニュー操作）を実行するには、スクリプトを起動するプロセス（Raycast / ターミナル / メニュー起動なら Capture One 本体）に Accessibility（補助アクセス）権限が必要。辞書スクリプティング（select 等）には Automation 権限も要る。

## Running the Script

ソースは `src/matchlook_pipeline.ts`（TypeScript 単一ファイル）。**import/export を書かない**こと（module 化すると `run()` が top-level global でなくなり osascript が起動できない）。ビルドと実行は pkf タスク。

```bash
pkf run build                  # TS -> JS(bunx tsc) -> .scpt(osacompile)
pkf run sel                    # C1 で現在選択中の DNG のみに Match Look(高速)
pkf run all                    # Denoised フォルダ全体に Match Look(76枚で約27分)
pkf run all --matchlook=false  # Match Look せずペアリング + manifest のみ
pkf run install                # .scpt を ~/Library/Scripts/Capture One Scripts/ へ配置
```

- `src/dist/*.js`（tsc 出力）と `src/dist/*.scpt`（osacompile 出力）はビルド成果物。`src/dist/` は gitignore 済。追跡するのは `.ts` / `src/jxa.d.ts` / `tsconfig.json` / `Taskfile.pkl` / `scripts/`。
- Raycast からは `scripts/raycast/match-look-{all,sel}.sh` を Script Commands ディレクトリに登録して `pkf run` を叩く。wrapper は `$0` から repo ルートへ cd する。
- C1 Scripts メニューから `.scpt` を起動（env 無し）した場合の既定は `scope=sel` + `matchlook=true`（選択中の DNG に適用）。

## Architecture

設定は冒頭の `CONFIG` に集約。主要フィールド: `denoisedSubdir`（Selects/Denoised）/ `referencesSubdir`（References）/ `manifestSubpath`（Output/matchlook_pairs.tsv）/ `exiftool` / `dngExts` / `jpegExts` / `stripSuffixes`（PureRAW サフィックス）/ `runMatchLook`（env 未指定時の Match Look 既定・現状 true）/ `allImagesCollection`（全画像 smart album 名・UI 言語依存）/ `menuMatchLook`（メニューラベル・UI 言語依存）。

実行スコープと Match Look on/off は env で切り替える。pkf タスクが `SCOPE`（all/sel）と `MATCHLOOK`（true/false param）を osascript に渡し、TS 側が `app.systemAttribute` で読む。env 未指定（メニュー起動）は `scope=sel` / `matchlook=CONFIG.runMatchLook` にフォールバックする。

### タスク1 — ペアリング

`buildJpegIndex()` が References の JPEG を `byName`（ベース名・小文字・`stripSuffixes` 適用後）と `byTime`（`DateTimeOriginal`・exiftool）に登録。`matchToJpeg()` は名前一致を優先し、DNG のファイルパスがあるとき（all モード）のみ撮影時刻フォールバックを試みる。sel モードは path が無いので byName のみ（同名 RAW+JPEG 運用では常に成立）。

DNG の供給源は WorkItem に正規化される。`all` = `listFiles(Denoised)` のファイル、`sel` = `selectedDngItems()` が返す選択中の DNG variant（切替で選択が失われるため All Images 切替の前に確定する）。後段は両モード共通。

### タスク2 — Match Look 適用（UI スクリプティング一択）

辞書に `match look` 相当のコマンドは無い（辞書を全走査して確認済み。辞書は各自 C1 の Script Editor / Open Scripting Dictionary で開く）。`copyAdjustments` / `applyAdjustments` は全調整の丸コピーで別機能。実機でも Match Look は AdjustmentSettings に直接値を書き style としては残らない。よって `applyMatchLook_viaMenu()`（メニュークリック）が唯一の経路。JPEG を単独選択 → 「調整 > セットマッチルックリファレンス」→ DNG を単独選択 → 「調整 > マッチルックを適用」。

実機検証で判明した2つの重要事実（いずれも実データの通し実行で確定）:

- **`variants()` は current collection スコープ**。Denoised フォルダだけをブラウズ中は JPEG が variants() に載らず、Match Look の参照 variant を引けない。そこで `ensureAllImagesCollection()` が `currentCollection` を全画像 smart album（`CONFIG.allImagesCollection`）へ設定して DNG+JPG を同一コレクションに揃え、処理後に元のコレクションへ戻す。References/Denoised がセッションのフォルダに存在すれば、ユーザーの手動インポート/お気に入り操作は不要。All Images には ARW+JPG+DNG が同名で並ぶため、拡張子弁別が必須。
- **メニューの enabled 更新は非同期に遅延する**。`d.select` 後すぐにメニューをクリックすると disabled で失敗する。`clickMenuItem()` は enabled をポーリング（最大約5秒）して true になった瞬間に click する。

`findVariantByBaseName()` は `variants()` を走査し、`variant.name()`（拡張子なし・RAW/JPEG/DNG 同名）を `parentImage().name()` の拡張子で `CONFIG.jpegExts` / `CONFIG.dngExts` に弁別する。これを怠ると同名衝突で自己適用の no-op になる。

### タスク3 — ペアリング manifest

画像コピーは行わない。ペアリング結果を TSV（`dng` / `jpeg`[session 相対] / `method`[name/time/-] / `matchlook`[applied/off/no-ref/-]）で `Output/matchlook_pairs.tsv` に毎回上書き出力する。大量セッションで JPEG を複製しないため容量負担が無い。`matchlook=no-ref` はペアは disk 上にあるが variant を browser に引けなかったことを示す（切替や権限の問題の手がかり）。

## Known Limitations / Open Items

1. **Match Look は辞書に無い（確定・実機で全件検証済み）**: Route B メニュークリックが唯一。76枚全件に適用し look 変化を目視確認済み。前提は launcher への Accessibility 権限。ラベルは `CONFIG.menuMatchLook`。
2. **全画像コレクション依存**: `variants()` が current collection スコープのため、`CONFIG.allImagesCollection`（UI 言語依存）の smart album へ切替が必要。名前が違う環境では CONFIG を合わせる。
3. **メニュー enabled ポーリング**: select 後のメニュー有効化遅延に対応するため必須。固定 delay に戻さないこと。
4. **all モードの実行時間**: 76枚で約27分（1ペアあたり約21秒、主因はメニュー有効化待ち）。sel は数枚なら高速。最適化（`activate` の1回化等）は flakiness 再発に注意して別 follow-up で扱う。なお `buildVariantIndex` は `doc.variants()` をループ前に1回だけ取得しループ全体でキャッシュするため、variant object specifier が `currentCollection` 固定のまま約27分有効である前提に立つ（従来は per-item 再フェッチ）。この前提は sel でしか live smoke していないので、all を継続運用する前に一度 all の live smoke で確認すること（Issue #1 の残存項目）。
5. **同名衝突の拡張子弁別**: `findVariantByBaseName` の `parentImage().name()` 拡張子フィルタを移植/改修で必ず維持する。
6. **PureRAW のサフィックス**: 出力 DNG にサフィックスが付く場合は `CONFIG.stripSuffixes` に追加（例: `['-dxo']`）。
7. **前段（PureRAW 送り）未実装**: `open -a "DxO PureRAW" <RAWパス>` 案があるが無人バッチ完了は未確認。
8. **破壊的バッチ前のバックアップ**: `all` の Match Look は AdjustmentSettings に直接値を書き既存調整を上書きする（style として残らず undo も濁りやすい）。調整済み DNG を含むセッションに `all` を流す前に、Capture One セッションの `.cosessiondb` をバックアップするか対象 variant を複製すること。Time Machine 有効化も推奨（実データで既存調整を上書きし復旧困難になった事例あり）。

## Session Folder Contract

スクリプトが期待するフォルダ構成（`sessionRoot` 起点の相対パス）:

| パス | 内容 |
|---|---|
| `Selects/Denoised/` | PureRAW 出力 DNG（タスク1の入力・all モードの走査対象） |
| `References/` | creative look JPEG（タスク1の入力） |
| `Output/matchlook_pairs.tsv` | ペアリング対応表 TSV（タスク3の出力・毎回上書き） |
