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

設定は冒頭の `CONFIG` に集約。主要フィールド: `manifestSubpath`(Output/matchlook_pairs.tsv・追記ログの出力先)/ `rawTargetExts`(Match Look 対象として受理する拡張子。受理拡張子の唯一の真実はこのフィールド自体であり散文へ列挙しない)/ `jpegExts` / `stripSuffixes`(PureRAW サフィックス)/ `matchLookLabels`(Match Look のメニュー項目ラベル候補・全言語ぶん。値の唯一の真実はこのフィールドで散文へ列挙しない。再生成は `pkf run labels`)。

ペアリングと Match Look 適用は常に実行される単一モード。旧 `SCOPE`(all/sel)・`MATCHLOOK`(true/false)env による切替は撤廃した。

### タスク1 — ペアリング(切替先コレクション基準)

`selectedTargetItems()` が(currentCollection 切替前に)選択中の variant を読み、`parentImage` の拡張子が `CONFIG.rawTargetExts` に含まれるものだけ WorkItem 化する(`baseName` は `stripSuffixes` 適用後・小文字、`variant` は選択時点の参照)。切替前に取得した variant 参照は切替後の `select` でもそのまま有効なため、対象は索引から引き直さない。JPEG のみ `CONFIG.jpegExts` で索引から引く。索引(`buildVariantIndex()`)は JPEG を引くためだけに `doc.variants()` を1回だけ全走査して `baseName` ごとに `{ext, variant}` の配列を作り、`parentImage` の拡張子で弁別する(同名の JPEG/RAW が並ぶ環境があるため)。`findVariantInIndex()` は出現順で最初に一致した variant を返す(同名衝突時の先勝ち)。

### タスク2 — Match Look 適用(UI スクリプティング一択)

辞書に `match look` 相当のコマンドは無い(辞書を全走査して確認済み。辞書は各自 C1 の Script Editor / Open Scripting Dictionary で開く)。`copyAdjustments` / `applyAdjustments` は全調整の丸コピーで別機能。実機でも Match Look は AdjustmentSettings に直接値を書き style としては残らない。よって `applyMatchLook_viaMenu()`(メニュークリック)が唯一の経路。JPEG を単独選択 → `CONFIG.matchLookLabels.setReference` に一致するメニュー項目をクリック → 対象を単独選択 → `CONFIG.matchLookLabels.apply` に一致するメニュー項目をクリック(メニュー名はハードコードせず、候補ラベルに一致する項目を持つメニューを `findMenuCommand()` が走査して特定する)。

実機検証で判明した2つの重要事実(いずれも実データの通し実行で確定):

- `variants()` は current collection スコープ。対象のコレクションだけをブラウズ中は JPEG が variants() に載らず、Match Look の参照 variant を引けない。そこで `ensureWorkingCollection()` が `currentCollection` を「対象と同名 JPEG が最も多く同居するコレクション(同値ならゴミ箱を除いて variant 数が最大)」へ設定して対象+JPEG を同一コレクションに揃え、処理後に元のコレクションへ戻す。対象と JPEG が同一セッションに import 済みであれば、ユーザーの手動お気に入り操作は不要。切替先には ARW/JPG/DNG が同名で並びうるが、拡張子弁別が必須なのは索引から引く JPEG 側だけ(対象は選択時点の variant 参照をそのまま使うため索引を経由しない)。
- メニューの enabled 更新は非同期に遅延する。`d.select` 後すぐにメニューをクリックすると disabled で失敗する。`clickMenuItem()` は enabled をポーリング(最大約5秒)して true になった瞬間に click する。

`findVariantInIndex()` は `buildVariantIndex()` が事前に索引化した `baseName` ごとの `{ext, variant}` 一覧から、期待拡張子(`CONFIG.jpegExts`)に一致する最初の variant を返す(JPEG 引きにのみ使う。対象は索引を経由しない)。索引化自体は `variant.name()`(拡張子なし・RAW/JPEG/DNG 同名)を `parentImage().name()` の拡張子で弁別して行う。これを怠ると同名衝突で自己適用の no-op になる。

### タスク3 — ペアリング追記ログ

画像コピーは行わない。ペアリング結果を追記ログ(TSV: `time` / `target` / `jpeg` / `matchlook`)として `Output/matchlook_pairs.tsv` へ追記する。ヘッダはファイル新規時のみ `manifestHeaderLines()` で1回書き、以降は `appendManifest()` が行だけ追記する(上書きしない)。書き込みは do shell script ではなくネイティブ ObjC(Foundation の NSFileManager/NSString)で read-modify-write し、時刻も `formatStamp()` でネイティブ生成する(理由は Known Limitations 8)。大量セッションで JPEG を複製しないため容量負担が無い。`matchlook` は `applied`(適用済み)/ `no-ref`(JPEG は見つかったが Match Look の適用に失敗した)/ `-`(JPEG が見つからなかった)のいずれか。

## Known Limitations / Open Items

1. Match Look は辞書に無い(確定・実機で全件検証済み): Route B メニュークリックが唯一。過去に一括76枚へ適用し look 変化を目視確認済み(現在の sel 単一モードでも同一経路を通る)。前提は launcher への Accessibility 権限。ラベル候補は `CONFIG.matchLookLabels`。
2. 切替先コレクションの推定: `variants()` が current collection スコープのため、対象と JPEG を同一コレクションに揃える切替が要る。切替先は候補ごとに切替なしで中身を一括読みして測った coverage(選択中の対象と同名 JPEG が同居する件数)が最大のもので選び、同値ならゴミ箱を除いて variant 数が最大のものを採る(いずれも UI 言語に依存しない)。どの候補も検査できなかった場合は件数最大へ落ちる。coverage が示すのは「同名かつ対象拡張子の variant がそのコレクションに居る」ことまでで、選択中の対象 variant そのものが居ることではない(clone は元と同じ `parentImage` を持つため baseName も拡張子も一致する。項目 7)。切替後に対象を `select` して妥当性を検証するため、対象を含まないコレクションを選んだ場合は診断付きで throw する(黙って nojpeg にはならない)。JPEG だけを含まない場合は検証を通過し全件 nojpeg になる。固定名を採らないのはコレクション名自体が UI 言語に依存するだけでなく、セッション作成時点の表示言語でスマートアルバム名が固定され、後から表示言語を切り替えても追従しないため(実機確認: 日本語 UI で作成したセッションは表示言語を英語に変えても元の日本語名のまま)。同一マシン上に言語の異なる名前のセッションが混在しうるため、どの固定名を選んでも原理的に対応できない。メニュー側と同じ「全言語の候補表と照合する」方式をコレクション名へ流用できないのも同じ理由で、名前が現在の表示言語の関数でない以上、候補表と突き合わせても当たる保証が無い。言語非依存の `id` を持つのはセッション標準のお気に入り(`capture` / `selects` / `output` / `trash`)だけで、全画像スマートアルバムはユーザーコレクションと同じ連番 `id` しか持たないため id 照合も採れない。ゴミ箱の除外に `id` を使えるのはこの標準お気に入りに含まれるため。coverage 導入で診断契約が 1 つ変わった: 以前は「どのコレクションも variant 件数を読めなければ『切替先のコレクションを決められません』で throw する」だったが、現在は件数が全て読めなくても coverage が 1 以上の候補があれば、その候補を選んで処理を続ける(対象と JPEG の同居を実際に確認できている候補を、件数不明だけを理由に捨てないため)。coverage が 1 以上の候補も無ければ従来どおり throw する。
3. メニュー enabled ポーリング: select 後のメニュー有効化遅延に対応するため必須。固定 delay に戻さないこと。
4. 同名衝突の拡張子弁別(JPEG 引きのみ): `buildVariantIndex` / `findVariantInIndex` の `parentImage().name()` 拡張子フィルタを移植/改修で必ず維持する。対象 variant は選択時点の参照を持ち回るため索引を経由しないが、JPEG は索引から引くのでこの弁別が要る。
5. PureRAW のサフィックス: 出力 DNG にサフィックスが付く場合は `CONFIG.stripSuffixes` に追加(例: `['-dxo']`)。
6. 前段(PureRAW 送り)未実装: `open -a "DxO PureRAW" <RAWパス>` 案があるが無人バッチ完了は未確認。
7. 破壊的適用前のバックアップ: Match Look 適用は AdjustmentSettings に直接値を書き既存調整を上書きする(style として残らず undo も濁りやすい)。調整済み対象を含むセッションで実行する前に、Capture One セッションの `.cosessiondb` をバックアップすること。Time Machine 有効化も推奨(実データで既存調整を上書きし復旧困難になった事例あり)。variant の複製(clone)による退避は使えない: clone は元と同じ `parentImage` を持つため baseName も拡張子も同一になり、`findVariantInIndex` の先勝ちで clone ではなく元の variant が引かれる(退避したつもりで元へ適用する事故になる)。
8. do shell script 禁止(C1 サンドボックス): C1 Scripts メニューから起動すると制御主体が Capture One になり、サンドボックスがシェル起動を禁じて `do shell script` が -10004 で失敗する(Raycast/ターミナル起動では通るため気付きにくい。実機で確認)。ファイル IO はネイティブ ObjC(Foundation)、タイムスタンプはネイティブ Date を使い、`sh()` / `doShellScript` を再導入しないこと。
9. 旧ビルドで壊れた manifest の一度きり復旧: かつて `readTextFile` が `String(NSString)` を使い中身でなく `"[id __NSCFString]"` を返していたため、旧ビルドで2回目以降に実行したセッションの `Output/matchlook_pairs.tsv` は先頭に `[id __NSCFString]` が残りヘッダを失っている場合がある。現行コードは中身を正しく読むが `existing` があれば末尾へ追記するだけで前方修正しかしない(壊れた先頭は自動修復しない)。該当ファイルは一度 `rm` するか手で直せば、次回実行時にヘッダから作り直される。
10. manifest 書き込みは post-batch(fail-loud の位置づけ): `appendManifest` は Match Look 適用ループの後に呼ぶ実行後ログで、事前監査には使えない。IO 失敗時は握りつぶさず throw するが、`run()` は throw 前に summary(items/applied/noref/nojpeg)を組み立ててエラーメッセージへ載せるので、ログ保存に失敗しても「写真に何を適用したか」は失われない。read-only な Output や壊れた既存ファイルではこの throw が毎回出るため、9 の手順で当該ファイルを一度片付けること。
11. apply パスは plain delay 必須(run loop を pump すると複数枚適用が壊れる): Match Look 適用シーケンス中の待機に `NSRunLoop.runUntilDate` で run loop を pump すると、複数枚適用の 2 枚目以降が着地しない(実機で root cause 確定。過去の smoke が単枚だったため長く未検出だった regression)。適用パスの待機は必ず JXA 組込みの `delay` を使い、run loop を回す `sleep` を適用パスへ再導入しないこと。HUD 描画反映のための pump は `hudPump()`(0.15s の `runUntilDate`)に閉じ込め、HUD 更新ヘルパ(`hudSetItem` / `hudSetPhase` / `hudItemDone`)からのみ呼ぶ(apply の Apple Event と交錯しなければ安全・10枚実機で実証)。同じ制約は `src/matchlook_pipeline.ts` の適用シーケンス冒頭と `hudPump` 定義のコメントにもある。これは項目 3(メニュー enabled ポーリングを固定 delay へ戻さない)とは別問題で、こちらは「適用パスの delay を run loop pump に変えない」。
12. 書き出し JPEG との同名衝突: 切替先が全画像コレクションになる通常構成では Output の書き出し済み JPEG も同じコレクションに載る。書き出しファイル名を参照 JPEG と同名にする運用にすると、`findVariantInIndex` の先勝ちでどちらが参照になるか並び順次第になる。現状は書き出し命名にサフィックスが付いており衝突していない。切替先の coverage 選定も名前と拡張子しか見ないため、同名の書き出し JPEG が居れば coverage を過大評価しうる(同じ前提の上に乗っている)。
13. Match Look の参照はセッションを跨いで残る(C1 のアプリ状態): `Set Match Look Reference` で設定した参照はドキュメントではなくアプリケーションの状態として保持され、別セッションを開いても Match Look ツールに表示され続ける。辞書にも Adjustments メニューにも参照をクリアする手段は無い。このため「参照 JPEG が無いセッションで実行した」場合に、ツールへ残った前回の参照を見て「別セッションの参照が適用された」と誤読しうる(実際に起きた)。現在は全件未適用なら throw、部分未適用ならダイアログで内訳を知らせるため、適用の有無は実行のたびに判別できる。throw の文面にも「ツールに残る参照とこのスクリプトの動作は無関係」である旨を含めている。
14. References フォルダの存在は import 済みを保証しない: セッションの References フォルダに JPEG が物理的に存在していても、Capture One に import されていなければ `variants()` に載らず参照を引けない(実例: References に JPG が 294 枚あるセッションで References コレクションの variants が 0、全画像スマートアルバムにも含まれていなかった)。`References/CaptureOne` フォルダの有無が C1 側で読み込み済みかどうかの目印になる。読み込ませるには C1 のライブラリでフォルダを同期する必要がある。未 import のまま実行すると全件 nojpeg になる(項目 2 の「JPEG だけを含まない場合」と同じ結果だが、原因はコレクション推定ではなく import 未了)。
15. import 直後の JPEG はプレビュー未生成で参照設定が失敗しうる(環境要因・再実行で解消): `Set Match Look Reference` は画像データ(プレビュー)を要求するため、import/同期直後でプレビュー生成が終わっていないとメニューが有効化されないまま項目 3 の約 5 秒ポーリングがタイムアウトし、`applyMatchLook_viaMenu` が throw して `no-ref` になると考えられる(この機序自体は直接測定しておらず、タイミング相関からの推定)。実測では 19MB の JPEG を同期した直後に失敗し、数分後に同一コード・同一対象で再実行すると成功した。実装の欠陥ではないため、`no-ref` が出た場合はまず時間をおいて再実行すること。

## Session Folder Contract

必須のフォルダ構成は無い。対象(PureRAW 現像後の DNG、または PureRAW 非使用時の ARW)と、同名の creative-look JPEG が同一セッションに import 済みであれば、切替先コレクション(対象と同名 JPEG が最も多く同居するコレクション)基準で解決する。PureRAW を使わない場合は Selects 直下などにある ARW を直接選択して適用できる。

固定パスなのは追記ログの出力先のみ:

| パス | 内容 |
|---|---|
| `Output/matchlook_pairs.tsv` | ペアリング追記ログ(タスク3の出力・ヘッダ以外は毎回追記) |

## Troubleshooting

### AppleScript エラー -10004(権限違反)

C1 の Scripts メニューから起動すると Capture One 自身が操作プロセスになる。ファイル IO はネイティブなのでシェル起因の -10004 は無く、残る -10004 は Match Look のメニュー操作(System Events)の権限:

- システム設定 > プライバシーとセキュリティ > オートメーション > Capture One > 「システムイベント」を許可。
- システム設定 > プライバシーとセキュリティ > アクセシビリティ > 「Capture One」を許可。

過去に拒否したダイアログは再表示されない。強制的に再プロンプトさせるには:

    tccutil reset AppleEvents com.captureone.captureone16

その後 Capture One を再起動しスクリプトを一度実行して許可を確定する。
