# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repository Is

macOS 専用の Capture One 現像ワークフロー自動化スクリプト。C1 で選択中の RAW 対象(PureRAW 現像後の DNG、または PureRAW を使わない場合の ARW。複数選択可)に、同一セッション内に import 済みの同名 creative-look JPEG から Capture One の Match Look 機能で look を転写する。

外部依存: Capture One 16.5.0+、macOS のみ。ビルドは `pkf`(pkfire タスクランナー)と `bunx tsc`(TypeScript、zero install)。辞書スクリプティング(select 等)と Match Look のメニュー操作(System Events UI スクリプティング)のいずれにも、起動プロセス(ターミナル / Raycast、または C1 Scripts メニューから起動時は Capture One 自身)に Automation・Accessibility 権限が要る。C1 自身が起動プロセスになる場合の権限手順は Troubleshooting を参照。

## Running the Script

ソースは `src/matchlook_pipeline.ts`(TypeScript 単一ファイル)。import/export を書かないこと(module 化すると `run()` が top-level global でなくなり osascript が起動できない)。ビルドと実行は pkf タスク。

```bash
pkf run build                  # TS -> JS(bunx tsc) -> .scpt(osacompile)
pkf run sel                    # C1 で現在選択中の対象に Match Look を適用
pkf run install                # .scpt を ~/Library/Scripts/Capture One Scripts/ へ配置(メニュー表示名は Apply Match Look from Reference)
pkf run test                   # 純粋ロジックのユニットテスト(node --test)
```

- `src/dist/*.js`(tsc 出力)と `src/dist/*.scpt`(osacompile 出力)はビルド成果物。`src/dist/` は gitignore 済。追跡するのは `.ts` / `src/jxa.d.ts` / `tsconfig.json` / `Taskfile.pkl` / `scripts/`。
- Raycast からは `scripts/raycast/match-look-sel.sh` を Script Commands ディレクトリに登録して `pkf run sel` を叩く。wrapper は `$0` から repo ルートへ cd する。
- C1 Scripts メニューから `.scpt` を起動した場合も `pkf run sel` と同じ挙動(選択中の対象へ適用)。メニュー表示名は `Taskfile.pkl` の `menuName`(`Apply Match Look from Reference`)。

## Architecture

設定は冒頭の `CONFIG` に集約。主要フィールド: `manifestSubpath`(Output/matchlook_pairs.tsv・追記ログの出力先)/ `rawTargetExts`(Match Look 対象として受理する拡張子。受理拡張子の唯一の真実はこのフィールド自体であり散文へ列挙しない)/ `jpegExts` / `stripSuffixes`(PureRAW サフィックス)/ `allImagesCollection`(全画像 smart album 名・UI 言語依存)/ `menuMatchLook`(メニューラベル・UI 言語依存)。

ペアリングと Match Look 適用は常に実行される単一モード。旧 `SCOPE`(all/sel)・`MATCHLOOK`(true/false)env による切替は撤廃した。

### タスク1 — ペアリング(All Images コレクション基準)

`selectedTargetItems()` が(currentCollection 切替前に)選択中の variant を読み、`parentImage` の拡張子が `CONFIG.rawTargetExts` に含まれるものだけ WorkItem 化する(`baseName` は `stripSuffixes` 適用後・小文字、`ext` は選択時点の拡張子)。切替後、`buildVariantIndex()` が `doc.variants()` を1回だけ全走査して `baseName` ごとに `{ext, variant}` の配列へ索引化する(All Images には同名の ARW/JPG/DNG が並ぶため `ext` を保持する)。`findVariantInIndex()` は `baseName` + 期待拡張子群で検索し、出現順で最初に一致した variant を返す(同名衝突時の先勝ち)。JPEG は `CONFIG.jpegExts` で、対象は選択時点の `ext` 一本で引き直す(ARW/DNG の取り違え防止)。

### タスク2 — Match Look 適用(UI スクリプティング一択)

辞書に `match look` 相当のコマンドは無い(辞書を全走査して確認済み。辞書は各自 C1 の Script Editor / Open Scripting Dictionary で開く)。`copyAdjustments` / `applyAdjustments` は全調整の丸コピーで別機能。実機でも Match Look は AdjustmentSettings に直接値を書き style としては残らない。よって `applyMatchLook_viaMenu()`(メニュークリック)が唯一の経路。JPEG を単独選択 → 「調整 > セットマッチルックリファレンス」→ 対象を単独選択 → 「調整 > マッチルックを適用」。

実機検証で判明した2つの重要事実(いずれも実データの通し実行で確定):

- `variants()` は current collection スコープ。対象のコレクションだけをブラウズ中は JPEG が variants() に載らず、Match Look の参照 variant を引けない。そこで `ensureAllImagesCollection()` が `currentCollection` を全画像 smart album(`CONFIG.allImagesCollection`)へ設定して対象+JPEG を同一コレクションに揃え、処理後に元のコレクションへ戻す。対象と JPEG が同一セッションに import 済みであれば、ユーザーの手動お気に入り操作は不要。All Images には ARW+JPG+DNG が同名で並ぶため、拡張子弁別が必須。
- メニューの enabled 更新は非同期に遅延する。`d.select` 後すぐにメニューをクリックすると disabled で失敗する。`clickMenuItem()` は enabled をポーリング(最大約5秒)して true になった瞬間に click する。

`findVariantInIndex()` は `buildVariantIndex()` が事前に索引化した `baseName` ごとの `{ext, variant}` 一覧から、期待拡張子(`CONFIG.jpegExts` または対象の `ext`)に一致する最初の variant を返す。索引化自体は `variant.name()`(拡張子なし・RAW/JPEG/DNG 同名)を `parentImage().name()` の拡張子で弁別して行う。これを怠ると同名衝突で自己適用の no-op になる。

### タスク3 — ペアリング追記ログ

画像コピーは行わない。ペアリング結果を追記ログ(TSV: `time` / `target` / `jpeg` / `matchlook`)として `Output/matchlook_pairs.tsv` へ追記する。ヘッダはファイル新規時のみ `manifestHeaderLines()` で1回書き、以降は `appendManifest()` が行だけ追記する(上書きしない)。大量セッションで JPEG を複製しないため容量負担が無い。`matchlook` は `applied`(適用済み)/ `no-ref`(ペアは見つかったが対象 variant を索引から引けなかった)/ `-`(JPEG が見つからなかった)のいずれか。

## Known Limitations / Open Items

1. Match Look は辞書に無い(確定・実機で全件検証済み): Route B メニュークリックが唯一。過去に一括76枚へ適用し look 変化を目視確認済み(現在の sel 単一モードでも同一経路を通る)。前提は launcher への Accessibility 権限。ラベルは `CONFIG.menuMatchLook`。
2. 全画像コレクション依存: `variants()` が current collection スコープのため、`CONFIG.allImagesCollection`(UI 言語依存)の smart album へ切替が必要。名前が違う環境では CONFIG を合わせる。
3. メニュー enabled ポーリング: select 後のメニュー有効化遅延に対応するため必須。固定 delay に戻さないこと。
4. 同名衝突の拡張子弁別: `buildVariantIndex` / `findVariantInIndex` の `parentImage().name()` 拡張子フィルタを移植/改修で必ず維持する。
5. PureRAW のサフィックス: 出力 DNG にサフィックスが付く場合は `CONFIG.stripSuffixes` に追加(例: `['-dxo']`)。
6. 前段(PureRAW 送り)未実装: `open -a "DxO PureRAW" <RAWパス>` 案があるが無人バッチ完了は未確認。
7. 破壊的適用前のバックアップ: Match Look 適用は AdjustmentSettings に直接値を書き既存調整を上書きする(style として残らず undo も濁りやすい)。調整済み対象を含むセッションで実行する前に、Capture One セッションの `.cosessiondb` をバックアップするか対象 variant を複製すること。Time Machine 有効化も推奨(実データで既存調整を上書きし復旧困難になった事例あり)。

## Session Folder Contract

必須のフォルダ構成は無い。対象(PureRAW 現像後の DNG、または PureRAW 非使用時の ARW)と、同名の creative-look JPEG が同一セッションに import 済みであれば、All Images コレクション基準で解決する。PureRAW を使わない場合は Selects 直下などにある ARW を直接選択して適用できる。

固定パスなのは追記ログの出力先のみ:

| パス | 内容 |
|---|---|
| `Output/matchlook_pairs.tsv` | ペアリング追記ログ(タスク3の出力・ヘッダ以外は毎回追記) |

## Troubleshooting

### AppleScript エラー -10004(権限違反)

C1 の Scripts メニューから起動すると Capture One 自身が操作プロセスになるため、UI 操作の権限が要る:

- システム設定 > プライバシーとセキュリティ > オートメーション > Capture One > 「システムイベント」を許可。
- システム設定 > プライバシーとセキュリティ > アクセシビリティ > 「Capture One」を許可。

過去に拒否したダイアログは再表示されない。強制的に再プロンプトさせるには:

    tccutil reset AppleEvents com.captureone.captureone16

その後 Capture One を再起動しスクリプトを一度実行して許可を確定する。
