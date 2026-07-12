"use strict";

// Capture One 用 JXA パイプライン(TypeScript ソース / 単一ファイル・import 禁止)。
// C1 で選択中の RAW 対象に、同名の creative-look JPEG の look を Match Look(メニュー操作)で
// 転写する。ペアリングは C1 の All Images コレクション基準で行い、フォルダ構成や PureRAW の
// 有無に依存しない。処理結果は追記ログ(TSV)へ残す。

// manifest 1 行の正規化単位。target=対象の原名、jpeg=参照 JPEG の原名(無ければ null)。
type ManifestRow = {
  target: string;
  jpeg: string | null;
  matchlook: "applied" | "no-ref" | "-";
};

// 処理対象の正規化単位。baseName=照合用(stripSuffixes 済み・小文字)、label=ログ表示用(原名)、
// ext=切替後に対象 variant を厳密に引き直すための拡張子(rawTargetExts のいずれか)。
type WorkItem = { baseName: string; label: string; ext: string };

// ================= 設定 =================
const CONFIG = {
  c1AppName: "Capture One",
  sessionRootOverride: "",
  // 追記ログの出力先(session-root 相対)。
  manifestSubpath: "Output/matchlook_pairs.tsv",
  // Match Look を当てる対象として受理する拡張子。PureRAW の DNG と非使用時の ARW を既定で受理。
  // 将来他形式が増える場合はここに追記する(このリストが唯一の真実)。
  rawTargetExts: ["dng", "arw"],
  jpegExts: ["jpg", "jpeg"],
  stripSuffixes: [] as string[],
  // Match Look 用に対象と JPEG を同一コレクションに揃えるための全画像 smart album 名。
  // UI 言語依存(menuMatchLook と同じ。日本語 UI では「すべてのイメージ」)。
  allImagesCollection: "すべてのイメージ",
  menuMatchLook: {
    menu: "調整",
    setReference: "セットマッチルックリファレンス",
    apply: "マッチルックを適用",
  },
};

// ================= 基本ヘルパー =================

// 追記ログ用のタイムスタンプ(ローカル時刻・YYYY-MM-DD HH:MM:SS)。do shell script は
// Capture One のサンドボックスで -10004 になるため sh("date") を避けネイティブに生成する。
function formatStamp(d: Date): string {
  const p = (n: number): string => (n < 10 ? "0" : "") + n;
  return (
    d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
    " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds())
  );
}

function joinPath(a: string, b: string): string {
  return a.replace(/\/+$/, "") + "/" + b.replace(/^\/+/, "");
}

function parentDir(p: string): string {
  return p.replace(/\/+$/, "").replace(/\/[^\/]*$/, "");
}

// Capture One の file プロパティを POSIX パス文字列に寄せる(実機では変換不要)。
function toPOSIX(x: unknown): string | null {
  if (x == null) return null;
  return String(x);
}

// ファイル名から拡張子(小文字)を取り出す。ドットが無ければ全体を返す(実データの
// parentImage 名は常に拡張子付き)。同名衝突の拡張子弁別の producer 側の要。
function extOf(name: string): string {
  return String(name).split(".").pop()!.toLowerCase();
}

function stripSuffixes(name: string): string {
  for (const suf of CONFIG.stripSuffixes) {
    if (name.endsWith(suf)) return name.slice(0, -suf.length);
  }
  return name;
}

// 照合キーの正規化。小文字化してから PureRAW サフィックスを剥がす。索引側(buildVariantIndex)と
// 選択側(selectedTargetItems)で必ずこの順序を通す。順序が逆(strip -> lower)だと stripSuffixes の
// endsWith が大文字小文字で取りこぼし、索引キーと照合キーが食い違って対象自身の variant を引けず
// no-ref に落ちる(例: ファイル名 IMG-DxO と CONFIG.stripSuffixes=['-dxo'] で不一致)。
function normalizeBase(name: string): string {
  return stripSuffixes(name.toLowerCase());
}

// 進捗 HUD のタイトル表示テキスト(pure)。ユーザー可視なので英語。
function progressLabel(done: number, total: number): string {
  return "Applying Match Look " + done + " / " + total;
}

// 進捗 HUD 表示中は run loop を回して窓を生かす。null のときは通常の delay で確実に待つ
// (runUntilDate は入力ソースが無いと即戻るため、窓が無い間は delay を使う)。
let activeHUD: any = null;

function sleep(seconds: number): void {
  if (activeHUD) {
    $.NSRunLoop.mainRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(seconds));
  } else {
    delay(seconds);
  }
}

// ================= セッションルート検出 =================
function detectSessionRoot(C1: any): string {
  if (CONFIG.sessionRootOverride) return CONFIG.sessionRootOverride;
  const doc = C1.currentDocument;
  const candidates = ["output", "captures"];
  for (const prop of candidates) {
    try {
      const p = toPOSIX(doc[prop]());
      if (p && p.startsWith("/")) return parentDir(p);
    } catch (e) {
      /* 次の候補へ */
    }
  }
  throw new Error(
    "セッションルートを自動検出できませんでした。" +
      "Capture One でセッションが開いているか確認するか、" +
      "CONFIG.sessionRootOverride に絶対パスを設定してください。",
  );
}

// ================= Match Look(UI スクリプティング) =================

// ================= 進捗 HUD(AppKit) =================
// C1 を最前面に保つため nonactivating panel を使い activate しない。生成/更新/クローズは全て
// 握りつぶす(進捗表示は装飾。失敗しても Match Look 本体を止めない)。
function createProgressHUD(total: number): any {
  try {
    ObjC.import("AppKit");
    const W = 340;
    const H = 96;
    const panel = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer(
      $.NSMakeRect(0, 0, W, H),
      $.NSWindowStyleMaskTitled | $.NSWindowStyleMaskNonactivatingPanel,
      $.NSBackingStoreBuffered,
      false,
    );
    panel.title = "Apply Match Look";
    panel.level = $.NSFloatingWindowLevel;
    panel.hidesOnDeactivate = false;
    panel.center;

    const content = panel.contentView;
    const mkLabel = (y: number, h: number, size: number): any => {
      const t = $.NSTextField.alloc.initWithFrame($.NSMakeRect(16, y, W - 32, h));
      t.bezeled = false;
      t.drawsBackground = false;
      t.editable = false;
      t.selectable = false;
      t.font = $.NSFont.systemFontOfSize(size);
      return t;
    };

    const title = mkLabel(58, 20, 13);
    title.stringValue = progressLabel(0, total);
    content.addSubview(title);

    const bar = $.NSProgressIndicator.alloc.initWithFrame($.NSMakeRect(16, 38, W - 60, 14));
    bar.style = $.NSProgressIndicatorStyleBar;
    bar.indeterminate = false;
    bar.minValue = 0;
    bar.maxValue = total;
    bar.doubleValue = 0;
    content.addSubview(bar);

    const spinner = $.NSProgressIndicator.alloc.initWithFrame($.NSMakeRect(W - 36, 36, 18, 18));
    spinner.style = $.NSProgressIndicatorStyleSpinning;
    spinner.indeterminate = true;
    content.addSubview(spinner);
    spinner.startAnimation($());

    const sub = mkLabel(12, 18, 11);
    sub.textColor = $.NSColor.secondaryLabelColor;
    sub.stringValue = "";
    content.addSubview(sub);

    panel.orderFrontRegardless; // activate せず最前面へ(C1 を frontmost に保つ)
    const hud = { panel: panel, bar: bar, spinner: spinner, title: title, sub: sub };
    activeHUD = hud;
    return hud;
  } catch (e) {
    activeHUD = null;
    return null;
  }
}

function hudSetItem(hud: any, done: number, total: number, filename: string): void {
  if (!hud) return;
  try {
    hud.bar.doubleValue = done;
    hud.title.stringValue = progressLabel(done, total);
    hud.sub.stringValue = filename;
  } catch (e) {
    /* 表示更新の失敗は無視 */
  }
}

function hudClose(hud: any): void {
  activeHUD = null; // close が throw しても以降の sleep は delay に落ちるよう先にクリア
  if (!hud) return;
  try {
    hud.spinner.stopAnimation($());
    hud.panel.orderOut($());
    hud.panel.close;
  } catch (e) {
    /* クローズ失敗は無視 */
  }
}

// メニュー項目を「有効化されるまで待って」クリックする。
// 実機で判明: select 後にメニューの enabled が更新されるまで非同期の遅延があり、
// 固定 delay では取りこぼす。enabled をポーリングして true になった瞬間に click する。
function clickMenuItem(SE: any, menuName: string, itemName: string): void {
  for (let t = 0; t < 25; t++) {
    const item = SE.processes
      .byName(CONFIG.c1AppName)
      .menuBars[0].menuBarItems.byName(menuName)
      .menus[0].menuItems.byName(itemName);
    let enabled = false;
    try {
      enabled = item.enabled();
    } catch (e) {
      /* まだツリーが取れない場合がある */
    }
    if (enabled) {
      item.click();
      delay(0.4);
      return;
    }
    delay(0.2);
  }
  throw new Error("メニュー項目が有効化されない: " + menuName + " > " + itemName);
}

// 現在の選択を一旦すべて解除し、target だけを選択する。
function selectOnly(doc: any, variant: C1Variant): void {
  const selected = doc.variants.whose({ selected: true })();
  if (selected.length) doc.deselect({ variants: selected });
  doc.select({ variant: variant });
  delay(0.3);
}

function applyMatchLook_viaMenu(
  C1: any,
  SE: any,
  jpegVariant: C1Variant,
  targetVariant: C1Variant,
): void {
  const m = CONFIG.menuMatchLook;
  const doc = C1.currentDocument;
  C1.activate(); // メニュー操作は frontmost の C1 に対して行う
  delay(0.4);
  selectOnly(doc, jpegVariant); // 参照側 JPEG だけを選択
  clickMenuItem(SE, m.menu, m.setReference); // 参照にセット
  selectOnly(doc, targetVariant); // 対象 RAW だけを選択
  clickMenuItem(SE, m.menu, m.apply); // 適用
}

// baseName(stripSuffixes 済み・小文字) -> その名前を持つ variant の一覧(variants() 出現順)。
type VariantIndex = Record<string, { ext: string; variant: C1Variant }[]>;

// doc.variants() を 1 回だけ全走査して baseName ごとに索引化する。
// All Images には同名の ARW+JPG+DNG が並ぶため parentImage の拡張子も併せて持つ。
function buildVariantIndex(C1: any): VariantIndex {
  const doc = C1.currentDocument;
  // filename 由来の base をキーにするため null-proto オブジェクトを使う。通常の {} だと
  // base==="constructor"/"__proto__" が Object.prototype と衝突し `base in index` が誤って真になり、
  // index[base] が Function/prototype に解決されて .push が TypeError になる(run 全体がクラッシュ)。
  const index: VariantIndex = Object.create(null);
  for (const v of doc.variants() as C1Variant[]) {
    let base = "";
    let imgExt = "";
    try {
      base = normalizeBase(String(v.name()));
      imgExt = extOf(v.parentImage().name());
    } catch (e) {
      continue;
    }
    if (!(base in index)) index[base] = [];
    // variants() の出現順で push し、同名複数ヒット時の先勝ちを findVariantInIndex で再現する。
    index[base].push({ ext: imgExt, variant: v });
  }
  return index;
}

// 索引から baseName + expectedExts に該当する variant を引く。variants() 出現順で
// 最初に拡張子が一致した variant を返す(同名衝突の拡張子弁別・先勝ちの要)。
function findVariantInIndex(
  index: VariantIndex,
  baseName: string,
  expectedExts: string[],
): C1Variant | null {
  const entries = index[baseName.toLowerCase()];
  if (!entries) return null;
  for (const e of entries) {
    if (expectedExts.indexOf(e.ext) >= 0) return e.variant;
  }
  return null;
}

// 全画像 smart album を currentCollection に設定し、対象と JPEG を同一コレクションに揃える。
// 実機で判明: variants() は current collection スコープ。対象フォルダだけ見ていると JPEG が
// variants() に載らず Match Look の参照 variant を引けない。全画像ビューへ切り替えて解決する。
function ensureAllImagesCollection(C1: any): void {
  const doc = C1.currentDocument;
  const cols = doc.collections();
  for (let i = 0; i < cols.length; i++) {
    try {
      if (
        String(cols[i].kind()) === "smart album" &&
        String(cols[i].name()) === CONFIG.allImagesCollection
      ) {
        doc.currentCollection = cols[i];
        delay(0.5);
        return;
      }
    } catch (e) {
      /* 次の候補へ */
    }
  }
  throw new Error(
    "全画像コレクション「" +
      CONFIG.allImagesCollection +
      "」が見つかりません。CONFIG.allImagesCollection を C1 の表示言語に合わせてください。",
  );
}

// C1 で現在選択中の対象 variant を WorkItem として返す。parentImage 拡張子が rawTargetExts の
// ものだけ拾う。currentCollection 切替で選択は失われるため切替の前に呼んで確定する。
function selectedTargetItems(C1: any): WorkItem[] {
  const doc = C1.currentDocument;
  const sel = doc.variants.whose({ selected: true })() as C1Variant[];
  const out: WorkItem[] = [];
  for (const v of sel) {
    let ext = "";
    let nm = "";
    let imgName = "";
    try {
      nm = String(v.name());
      imgName = String(v.parentImage().name());
      ext = extOf(imgName);
    } catch (e) {
      continue;
    }
    if (CONFIG.rawTargetExts.indexOf(ext) >= 0) {
      out.push({ baseName: normalizeBase(nm), label: imgName, ext: ext });
    }
  }
  return out;
}

// ================= 追記ログ(manifest) =================
// 画像はコピーせず、ペアリング結果を TSV でセッションフォルダへ追記する。
// ヘッダはファイル新規時のみ書き、以降は行だけ追記する。

// ログのヘッダ 2 行(末尾改行付き)。ファイルが存在しない初回だけ書き出す。
function manifestHeaderLines(sessionRoot: string): string {
  return (
    "# matchlook pairs log\tsession=" + sessionRoot + "\n" +
    "time\ttarget\tjpeg\tmatchlook\n"
  );
}

// 1 行ぶんのタブ区切り(末尾改行なし)。jpeg が null のときは "-" を出す。
function manifestRowLine(
  stamp: string,
  target: string,
  jpeg: string | null,
  matchlook: string,
): string {
  return [stamp, target, jpeg === null ? "-" : jpeg, matchlook].join("\t");
}

// ネイティブ(ObjC/Foundation)ファイル I/O。do shell script は Capture One のサンドボックスで
// シェル起動が禁じられ -10004 になるため、シェルを介さず書き込む(実機の C1 メニュー起動で確認済み)。
// 失敗は握りつぶさず throw する(manifest は「何を適用したか」の実行後ログ。Match Look 適用の後に
// 書くので事前監査には使えないが、無音で失うと何を上書きしたか追跡不能になるため fail-loud にする)。
function ensureDir(dir: string): void {
  const ok = $.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(
    $(dir), true, $(), $(),
  );
  if (!ok) throw new Error("ディレクトリを作成できません: " + dir);
}

function fileExists(path: string): boolean {
  return $.NSFileManager.defaultManager.fileExistsAtPath($(path));
}

// NSString は String() だと中身でなく "[id __NSCFString]" を返すため ObjC.unwrap で取り出す。
function readTextFile(path: string): string {
  const s = ObjC.unwrap(
    $.NSString.stringWithContentsOfFileEncodingError($(path), $.NSUTF8StringEncoding, $()),
  );
  if (typeof s !== "string") throw new Error("ファイルを読み取れません: " + path);
  return s;
}

function writeTextFile(path: string, text: string): void {
  const ok = $(text).writeToFileAtomicallyEncodingError(
    $(path), true, $.NSUTF8StringEncoding, $(),
  );
  if (!ok) throw new Error("ファイルを書き込めません: " + path);
}

// 追記後のファイル全文を組み立てる(pure)。existing が null なら新規=ヘッダを先頭に、
// あれば既存内容の末尾へ body を足す(ヘッダは二重に出さない)。
function manifestContent(existing: string | null, header: string, body: string): string {
  return (existing === null ? header : existing) + body + "\n";
}

function appendManifest(sessionRoot: string, stamp: string, rows: ManifestRow[]): void {
  const body = rows
    .map((r) => manifestRowLine(stamp, r.target, r.jpeg, r.matchlook))
    .join("\n");
  if (!body) return;
  ObjC.import("Foundation");
  const dest = joinPath(sessionRoot, CONFIG.manifestSubpath);
  ensureDir(parentDir(dest));
  // 既存があれば読み出して末尾へ追記、無ければヘッダを1回だけ先頭に置く(read-modify-write)。
  // 単一ユーザーの手動起動を前提とし、同時実行の lost-update は想定しない。
  const existing = fileExists(dest) ? readTextFile(dest) : null;
  writeTextFile(dest, manifestContent(existing, manifestHeaderLines(sessionRoot), body));
}

// run() の結果 summary(1 行)。早期 return(対象 0 件)と本処理の両方で使い、出力スキーマの
// 二重管理を避ける(フィールドの追加/改名はここ 1 箇所で済む)。
function formatSummary(items: number, applied: number, noRef: number, noJpeg: number): string {
  return (
    "items=" + items +
    " applied=" + applied +
    " noref=" + noRef +
    " nojpeg=" + noJpeg +
    " manifest=" + CONFIG.manifestSubpath
  );
}

// ================= メイン =================
function run(): string {
  const C1 = Application(CONFIG.c1AppName);
  const SE = Application("System Events");
  const root = detectSessionRoot(C1);
  const stamp = formatStamp(new Date());

  // currentCollection 切替で選択が失われるため、切替の前に対象を確定する。
  const items = selectedTargetItems(C1);

  // 対象が無ければコレクション切替もログ出力もせず即返す(無駄なビュー切替とヘッダのみログを避ける)。
  if (items.length === 0) {
    return formatSummary(0, 0, 0, 0);
  }

  // ペアリングも Match Look も All Images コレクション基準のため、常に全画像ビューへ切り替える。
  // 切替前に元コレクションを控え、処理後に必ず戻す。
  let originalCollection: any = null;
  try {
    originalCollection = C1.currentDocument.currentCollection();
  } catch (e) {
    /* 取れなければ復帰しない */
  }
  ensureAllImagesCollection(C1);

  const rows: ManifestRow[] = [];

  // 切替後に例外が出ても finally で必ず元コレクションへ戻すため try で囲む。
  try {
    // variant 索引は遅延メモ化する。1 件も対象が無ければ doc.variants() を一度も引かない。
    let variantIndexCache: VariantIndex | null = null;
    const getVariantIndex = (): VariantIndex => {
      if (variantIndexCache) return variantIndexCache;
      variantIndexCache = buildVariantIndex(C1);
      return variantIndexCache;
    };

    for (const it of items) {
      let jpegLabel: string | null = null;
      let matchlook: ManifestRow["matchlook"] = "-";
      try {
        const vi = getVariantIndex();
        // JPEG variant は対象と同じ baseName で引く(同名 import 前提)。
        const jv = findVariantInIndex(vi, it.baseName, CONFIG.jpegExts);
        if (jv) {
          jpegLabel = String(jv.parentImage().name());
          // 対象 variant は選択した拡張子で厳密に引き直す(ARW/DNG の取り違え防止)。
          const tv = findVariantInIndex(vi, it.baseName, [it.ext]);
          if (tv) {
            applyMatchLook_viaMenu(C1, SE, jv, tv);
            matchlook = "applied";
          } else {
            matchlook = "no-ref";
          }
        }
        // JPEG が見つからなければ matchlook は初期値 "-" のまま(集計時に nojpeg 扱い)。
      } catch (e) {
        matchlook = "no-ref";
      }
      rows.push({ target: it.label, jpeg: jpegLabel, matchlook: matchlook });
    }

    // カウンタは rows(唯一の真実)から導出する。ループ中に別変数で数えると乖離しうる。
    // matchlook は applied / no-ref / "-"(nojpeg) のいずれか 1 つを必ず持つので排他に集計できる。
    const applied = rows.filter((r) => r.matchlook === "applied").length;
    const noRef = rows.filter((r) => r.matchlook === "no-ref").length;
    const noJpeg = rows.filter((r) => r.matchlook === "-").length;

    // 破壊的な Match Look 適用はこの時点で完了済み。summary(何件に何を適用したか)を先に
    // 組み立て、ログ保存が失敗しても summary を載せて throw する。fail-loud は保ちつつ、
    // 「ユーザーの写真に何をしたか」だけは必ず伝える(黙って applied=N を返して失敗を隠さない)。
    const summary = formatSummary(items.length, applied, noRef, noJpeg);
    try {
      appendManifest(root, stamp, rows);
    } catch (e) {
      throw new Error(summary + " / manifest 書き込み失敗: " + String(e));
    }
    return summary;
  } finally {
    // ビューを元のコレクションへ戻す(return / throw いずれでも finally で必ず実行する)。
    if (originalCollection) {
      try {
        C1.currentDocument.currentCollection = originalCollection;
        delay(0.3);
      } catch (e) {
        /* 戻せなくても致命的ではない */
      }
    }
  }
}
