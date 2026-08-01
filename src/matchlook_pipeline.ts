"use strict";

// Capture One 用 JXA パイプライン(TypeScript ソース / 単一ファイル・import 禁止)。
// C1 で選択中の RAW 対象に、同名の creative-look JPEG の look を Match Look(メニュー操作)で
// 転写する。ペアリングは対象と JPEG を同一コレクション(対象と同名 JPEG が最も多く同居する
// もの)に揃えて行い、フォルダ構成や PureRAW の有無に依存しない。処理結果は追記ログ(TSV)へ残す。

// 追記ログ(TSV)の matchlook 列が取りうる値。値の一覧はこの union が唯一の真実で、
// 状態ごとの集計(MatchLookTally)も未適用理由への写像(MATCHLOOK_REASON)も Record で
// この union に従う。メンバを増やすと両方の Record がコンパイルエラーになるため、
// 値による分岐の取りこぼしが型で捕まる。
type MatchLookStatus = "applied" | "no-ref" | "-";

// manifest 1 行の正規化単位。target=対象の原名、jpeg=参照 JPEG の原名(無ければ null)。
type ManifestRow = {
  target: string;
  jpeg: string | null;
  matchlook: MatchLookStatus;
};

// Match Look を適用できなかった理由。matchlook 値からの写像は MATCHLOOK_REASON が持つ。
// 表示文言はここに持たず NOT_APPLIED_LABEL が持つ(判定値と表示文言を混ぜない)。
type NotAppliedReason = "nojpeg" | "failed";

// 未適用 1 件の正規化単位。target は対象の原名。
type NotAppliedEntry = { target: string; reason: NotAppliedReason };

// バッチ全体の帰結。none-applied は throw、partial はダイアログ、ok は無通知。
type Outcome = "none-applied" | "partial" | "ok";

// 処理対象の正規化単位。baseName=JPEG 照合用(stripSuffixes 済み・小文字)、label=ログ表示用(原名)、
// variant=選択時点の参照。コレクション切替後もこの参照はそのまま select に使えるため(実機で確認)、
// 切替後に索引から引き直さない。引き直すと切替先に同名の別 variant(ゴミ箱へ送った旧 DNG や
// 書き出し済み JPEG など)が居たとき対象を取り違える。
type WorkItem = { baseName: string; label: string; variant: C1Variant };

// メニューバーの構造スナップショット。セパレータは項目名が null で返るため items は null を含む。
// string[] と宣言すると代入元が any の都合で tsc が矛盾を検出できず、型が実態について嘘をつく。
type MenuTree = { menu: string; items: (string | null)[] }[];

// クリック対象を一意に指す組(メニュー名 + 項目名)。
type MenuCommand = { menu: string; item: string };

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
  // Match Look のメニュー項目ラベル候補(Capture One が対応する全言語)。UI 表示言語が
  // どれであっても、この候補のいずれかに一致する項目を走査で見つける。メニュー名(調整 /
  // Adjustments 等)は候補に持たず、項目名の一致からメニューごと特定する。
  // 値の唯一の真実はこのフィールド。散文やドキュメントへ再掲しないこと。
  // 再生成: pkf run labels(scripts/extract_matchlook_labels.mjs が C1 のリソースから抽出)
  matchLookLabels: {
    setReference: [
      "Set Match Look Reference",
      "Festlegen der Referenz für Look anpassen",
      "Establecer referencia para Reproducir Look",
      "Définir la référence pour répliquer rendu",
      "Imposta corrispondenza look: riferimenti",
      "セットマッチルックリファレンス",
      "매치 룩 레퍼런스 설정",
      "Referentie voor overeenkomende look instellen",
      "Ustawianie odniesienia do wyglądu dopasowania",
      "Definir referência de aparência de correspondência",
      "Установить эталон Match Look",
      "Ställ in referens för matchningsutseende",
      "设置匹配外观参考",
      "設置匹配外觀參考",
    ],
    apply: [
      "Apply Match Look",
      "Look anpassen anwenden",
      "Aplicar Reproducir Look",
      "Appliquer répliquer rendu",
      "Applica Riproduci Look",
      "マッチルックを適用",
      "매치 룩 적용",
      "Overeenkomende look toepassen",
      "Zastosuj wygląd dopasowania",
      "Aplicar Match Look",
      "Применить Match Look",
      "Använd Matcha Utseende",
      "应用 Match Look",
      "應用 Match Look",
    ],
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

// 最大値の添字を返す(同値は先勝ち)。負値は「件数を取得できなかった」を表す番兵で、
// 初期値 -1 がそのまま候補外の判定を兼ねる。有効な候補が 1 つも無ければ -1。
// この -1 は ensureWorkingCollection が異常を throw へ変換する根拠になるので、
// 初期値を -Infinity 等へ変えてはいけない(全件失敗が先頭コレクションの採用に化ける)。
function pickLargestIndex(counts: number[]): number {
  let best = -1;
  let bestCount = -1;
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] > bestCount) {
      bestCount = counts[i];
      best = i;
    }
  }
  return best;
}

// 失敗時の診断用に `名前(件数)` をカンマ区切りで並べた 1 行を返す。
// メニュー解決の失敗とコレクション選択の失敗の両方で使う(同じ形の診断を二重に書かない)。
function describeCounts(entries: { label: string; count: number }[]): string {
  return entries.map((e) => e.label + "(" + e.count + ")").join(", ");
}

function stripSuffixes(name: string): string {
  for (const suf of CONFIG.stripSuffixes) {
    if (name.endsWith(suf)) return name.slice(0, -suf.length);
  }
  return name;
}

// 照合キーの正規化。小文字化してから PureRAW サフィックスを剥がす。索引側(buildVariantIndex)と
// 照合側(selectedTargetItems の baseName)で必ずこの順序を通す。順序が逆(strip -> lower)だと
// stripSuffixes の endsWith が大文字小文字で取りこぼし、索引キーと照合キーが食い違う。対象 variant は
// 索引を経由しないため影響を受けないが、JPEG 側は索引から引くため jv が null になり matchlook は
// "-"(nojpeg)のままになる(例: ファイル名 IMG-DxO と CONFIG.stripSuffixes=['-dxo'] で不一致)。
function normalizeBase(name: string): string {
  return stripSuffixes(name.toLowerCase());
}

// 進捗 HUD のタイトル表示テキスト(pure)。ユーザー可視なので英語。
function progressLabel(done: number, total: number): string {
  return "Applying Match Look " + done + " / " + total;
}

// 進捗 HUD のフェーズ行テキスト(pure)。ユーザー可視なので英語。
function phaseLabel(phase: string): string {
  return phase === "reference" ? "Setting reference…" : "Applying look…";
}

// フェーズ「開始」時点のバー値(pure)。maxValue は枚数なので half-item 単位で前進する。
// reference 開始 = この枚は未着手 = done-1、apply 開始 = reference 完了済み = done-0.5。
function phaseBarValue(done: number, phase: string): number {
  return phase === "reference" ? done - 1 : done - 0.5;
}

// Match Look 適用シーケンス中の待機は必ず JXA 組込みの delay を使う(run loop を pump しない)。
// runUntilDate で run loop を pump すると複数枚適用の 2 枚目以降が壊れる(実機で root cause 確定)。
// HUD の描画反映は hudPump() が HUD 更新の瞬間だけ短く run loop を回す(apply の Apple Event とは
// 交錯しないため安全。10 枚バッチで全枚着地を実機確認)。旧 sleep()/activeHUD は撤去した。

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

// ================= 進捗 HUD(AppKit) =================
// C1 を最前面に保つため nonactivating panel を使い activate しない。生成/更新/クローズは全て
// 握りつぶす(進捗表示は装飾。失敗しても Match Look 本体を止めない)。
function createProgressHUD(total: number): any {
  try {
    ObjC.import("AppKit");
    const W = 340;
    const H = 112;
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

    const title = mkLabel(74, 20, 13);
    title.stringValue = progressLabel(0, total);
    content.addSubview(title);

    const bar = $.NSProgressIndicator.alloc.initWithFrame($.NSMakeRect(16, 54, W - 60, 14));
    bar.style = $.NSProgressIndicatorStyleBar;
    bar.indeterminate = false;
    bar.minValue = 0;
    bar.maxValue = total;
    bar.doubleValue = 0;
    content.addSubview(bar);

    const spinner = $.NSProgressIndicator.alloc.initWithFrame($.NSMakeRect(W - 36, 52, 18, 18));
    spinner.style = $.NSProgressIndicatorStyleSpinning;
    spinner.indeterminate = true;
    content.addSubview(spinner);
    spinner.startAnimation($());

    const sub = mkLabel(30, 18, 11);
    sub.textColor = $.NSColor.secondaryLabelColor;
    sub.stringValue = "";
    content.addSubview(sub);

    const phase = mkLabel(10, 16, 11);
    phase.textColor = $.NSColor.secondaryLabelColor;
    phase.stringValue = "";
    content.addSubview(phase);

    panel.orderFrontRegardless; // activate せず最前面へ(C1 を frontmost に保つ)
    const hud = { panel: panel, bar: bar, spinner: spinner, title: title, sub: sub, phase: phase };
    return hud;
  } catch (e) {
    return null;
  }
}

// HUD の値変更を画面へ反映するため run loop を短く回す。apply の待機(delay)では回さない
// (runUntilDate を適用シーケンスに挟むと複数枚適用が壊れる。実機で確定)。ここは HUD 更新の
// 瞬間だけで apply の Apple Event と交錯しないため安全。
function hudPump(): void {
  try {
    $.NSRunLoop.mainRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.15));
  } catch (e) {
    /* pump 失敗は無視 */
  }
}

function hudSetItem(hud: any, done: number, total: number, filename: string): void {
  if (!hud) return;
  try {
    hud.title.stringValue = progressLabel(done, total);
    hud.sub.stringValue = filename;
    hud.phase.stringValue = ""; // 前枚の残フェーズ表示を消す(バーはフェーズ/完了側が持つ)
    hudPump(); // 変更を描画へ反映
  } catch (e) {
    /* 表示更新の失敗は無視 */
  }
}

// 1 枚の途中でフェーズが変わるたびに呼ぶ。バーを half-item 前進させフェーズ行を更新する。
function hudSetPhase(hud: any, done: number, phase: string): void {
  if (!hud) return;
  try {
    hud.bar.doubleValue = phaseBarValue(done, phase);
    hud.phase.stringValue = phaseLabel(phase);
    hudPump(); // 変更を描画へ反映
  } catch (e) {
    /* 表示更新の失敗は無視 */
  }
}

// 1 枚の処理完了時に呼ぶ。applied/スキップを問わずバーを done へ確定前進させる。
function hudItemDone(hud: any, done: number): void {
  if (!hud) return;
  try {
    hud.bar.doubleValue = done;
    hudPump(); // 変更を描画へ反映
  } catch (e) {
    /* 表示更新の失敗は無視 */
  }
}

function hudClose(hud: any): void {
  if (!hud) return;
  try {
    hud.spinner.stopAnimation($());
    hud.panel.orderOut($());
    hud.panel.close;
  } catch (e) {
    /* クローズ失敗は無視 */
  }
}

// ================= Match Look(UI スクリプティング) =================

// 候補ラベルのいずれかと完全一致する項目を持つ最初の (menu, item) を返す。
// メニュー名はハードコードせずここで探索するため、UI 言語が変わっても引ける。
// 照合は正規化しない完全一致(部分一致だと "Apply Match Look to Layer" 等を誤って掴む)。
// セパレータ(null)は読み飛ばし、走査は最後まで続ける。
// この完全一致は将来も緩めないこと: 本リポジトリが Capture One の Scripts メニューへ自身を
// インストールするエントリ名(Taskfile.pkl の menuName)は CONFIG.matchLookLabels.apply の候補に
// 2 語足しただけで、findMenuCommand はメニューバー順で最初の一致を返し readMenuTree は per-メニューの
// 読み取り失敗を握りつぶすため、前方一致/部分一致に緩めると Adjustments メニューが読めない場合に
// Scripts メニューの自作エントリを誤って掴みうる。
function findMenuCommand(tree: MenuTree, candidates: string[]): MenuCommand | null {
  for (const entry of tree) {
    for (const item of entry.items) {
      if (typeof item !== "string") continue;
      if (candidates.indexOf(item) >= 0) return { menu: entry.menu, item: item };
    }
  }
  return null;
}

// メニューバーを読めなかったときの失敗種別。分岐は errorNumber だけで行う。例外の message は
// システム言語でローカライズされるため、文字列で分岐すると UI 言語に依存する(メニュー項目を
// 全言語の候補表で引くのと同じ理由で、ここも表示言語に依存させない)。
type MenuAccessFailure = "app-not-found" | "no-menu-bar" | "unknown";

// errorNumber から失敗種別を決める(pure)。errorNumber と種別の対応はこの実装が唯一の真実で、
// 数値をコメントや散文へ再掲しない。未知の値は unknown へ寄せ、生の値は文面末尾に載せる。
function classifyMenuAccessError(errorNumber: number | null): MenuAccessFailure {
  if (errorNumber === -1728) return "app-not-found";
  if (errorNumber === -1719) return "no-menu-bar";
  return "unknown";
}

// 例外から errorNumber を取り出す(pure)。Apple Event の例外は errorNumber を載せるが、
// 経路によっては載らない/数値でないことがあるため、数値でなければ null にする。
function errorNumberOf(e: any): number | null {
  const n = e == null ? null : e.errorNumber;
  return typeof n === "number" ? n : null;
}

// 失敗種別ごとの状況説明(文面の 1 文目)。Record にしておくと種別が増えたときキー不足が
// コンパイルエラーになる(NOT_APPLIED_GUIDANCE と同じパターン)。appName は呼び出し側が前置する。
const MENU_ACCESS_SITUATION: Record<MenuAccessFailure, string> = {
  "app-not-found": "のプロセスが System Events から見つかりません。",
  "no-menu-bar": "のメニューバーを取得できません。",
  unknown: "のメニューバーを読み取れません。",
};

// メニューバーを読めなかったときの診断文面(pure)。readMenuTree が呼ばれる時点で Capture One への
// 辞書スクリプティングは既に成功しているため(セッションルート検出と選択取得)、アプリが起動して
// いない可能性は事実上無く、権限を第一候補として書く。復旧手順は README の Troubleshooting に
// あるのでここへ再掲しない(コンパイル済み成果物に 3 つ目の写しを作らない)。生の errorNumber と
// message は未知の値でも診断できるよう verbatim で末尾に置く。アプリ名は必ず引数で受けた appName を
// 使い、文面へリテラルで焼き込まない(CONFIG.c1AppName が唯一の真実)。
function menuAccessFailureMessage(
  kind: MenuAccessFailure,
  appName: string,
  errorNumber: number | null,
  rawMessage: string,
): string {
  return (
    appName + " " + MENU_ACCESS_SITUATION[kind] +
    "Match Look はメニュー操作でしか実行できないため中止しました。\n" +
    appName + " への辞書スクリプティングは成功しているため、アクセシビリティと" +
    "システムイベントへのオートメーションの権限が第一候補です。\n" +
    "復旧手順は README の Troubleshooting を参照してください。\n" +
    "errorNumber=" + String(errorNumber) + " message=" + rawMessage
  );
}

// メニューバーの構造を一括取得する。複数形アクセスで 1 メニューあたり 1 イベントに抑える
// (実機で全 13 メニューの全項目名が 229ms。1 項目ずつ引くと 1 メニューだけで 451ms かかる)。
function readMenuTree(SE: any): MenuTree {
  const bar = SE.processes.byName(CONFIG.c1AppName).menuBars[0];
  const names = bar.menuBarItems.name() as string[];
  const tree: MenuTree = [];
  for (let i = 0; i < names.length; i++) {
    let items: (string | null)[] = [];
    try {
      items = bar.menuBarItems[i].menus[0].menuItems.name();
    } catch (e) {
      /* 項目を取れないメニューは空のまま続行(全体を止めない) */
    }
    tree.push({ menu: String(names[i]), items: items });
  }
  return tree;
}

// Match Look の 2 コマンドを解決する。バッチ開始時に 1 回だけ呼び、ループ内で再走査しない。
// 2 つは独立に探索する(実機ではどちらも Adjustments にあるが、同一メニューを要求しない)。
function resolveMatchLookMenu(SE: any): { setReference: MenuCommand; apply: MenuCommand } {
  const tree = readMenuTree(SE);
  const setRef = findMenuCommand(tree, CONFIG.matchLookLabels.setReference);
  const apply = findMenuCommand(tree, CONFIG.matchLookLabels.apply);
  if (setRef && apply) return { setReference: setRef, apply: apply };
  const missing: string[] = [];
  if (!setRef) missing.push("set-reference");
  if (!apply) missing.push("apply");
  // 件数 0 は「その特定のメニューの項目だけが読めなかった」(readMenuTree の per-メニュー catch で
  // 吸収された)ことを表す。Accessibility 権限が無い等の全体障害は readMenuTree 冒頭の
  // menuBars[0] / menuBarItems.name() 読み取りで無条件 throw して先に落ちるため、ここには到達しない
  // (件数 0 がそのまま権限失敗を意味するわけではない)。件数はあるのに不一致なら「ラベルが候補に無い」。
  throw new Error(
    "Match Look のメニュー項目が見つかりません(" +
      missing.join(" / ") +
      ")。Capture One のメニュー構成: " +
      describeCounts(tree.map((t) => ({ label: t.menu, count: t.items.length }))),
  );
}

// メニュー項目を「有効化されるまで待って」クリックする。
// 実機で判明: select 後にメニューの enabled が更新されるまで非同期の遅延があり、
// 固定 delay では取りこぼす。enabled をポーリングして true になった瞬間に click する。
function clickMenuItem(SE: any, cmd: MenuCommand): void {
  for (let t = 0; t < 25; t++) {
    const item = SE.processes
      .byName(CONFIG.c1AppName)
      .menuBars[0].menuBarItems.byName(cmd.menu)
      .menus[0].menuItems.byName(cmd.item);
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
  throw new Error("メニュー項目が有効化されない: " + cmd.menu + " > " + cmd.item);
}

// 現在の選択を一旦すべて解除し、target だけを選択する。
//
// 警告: この関数へ run loop を回す処理(NSRunLoop.runUntilDate を使う sleep / pump 系)を
// 足さないこと。selectOnly は Match Look の適用シーケンスから呼ばれる適用パスであり、
// ここの待機を run loop pump に変えると複数枚適用の 2 枚目以降が着地しない
// (CLAUDE.md Known Limitations 11。実機で root cause 確定済みの regression)。
// 待機は JXA 組込みの plain delay のままにする。
//
// なお ensureWorkingCollection の安全弁にある選択解除 2 行はここと逐語的に重複しているが、
// 共通化のためにこの関数へ触ると複数枚での live smoke をやり直すことになるため、重複は
// 意図的に残している(挙動不変の 2 行削減に実機コストを払うのは見合わない)。
function selectOnly(doc: any, variant: C1Variant): void {
  const selected = doc.variants.whose({ selected: true })();
  if (selected.length) doc.deselect({ variants: selected });
  doc.select({ variant: variant });
  delay(0.3);
}

function applyMatchLook_viaMenu(
  C1: any,
  SE: any,
  cmds: { setReference: MenuCommand; apply: MenuCommand },
  jpegVariant: C1Variant,
  targetVariant: C1Variant,
  onPhase?: (phase: string) => void,
): void {
  const doc = C1.currentDocument;
  if (onPhase) onPhase("reference"); // フェーズ行を先に更新してから遅いポーリングへ入る
  C1.activate(); // メニュー操作は frontmost の C1 に対して行う
  delay(0.4);
  selectOnly(doc, jpegVariant); // 参照側 JPEG だけを選択
  clickMenuItem(SE, cmds.setReference); // 参照にセット
  if (onPhase) onPhase("apply");
  selectOnly(doc, targetVariant); // 対象 RAW だけを選択
  clickMenuItem(SE, cmds.apply); // 適用
}

// baseName(stripSuffixes 済み・小文字) -> その名前を持つ variant の一覧(variants() 出現順)。
type VariantIndex = Record<string, { ext: string; variant: C1Variant }[]>;

// 一括読みで得た 3 本の配列(添字で対応)から索引を組む(pure)。
// 長さが揃わない場合は throw する。ある variant の名前を別の variant の拡張子と組み合わせた
// 索引は誤った参照 JPEG を引き、静かに間違った look を当てるため fail-loud にする。
function buildIndexFromBulk(
  variants: C1Variant[],
  names: unknown[],
  imageNames: unknown[],
): VariantIndex {
  if (names.length !== variants.length || imageNames.length !== variants.length) {
    throw new Error(
      "variants の一括読みで件数が食い違いました(variants=" + variants.length +
        " names=" + names.length + " parentImage names=" + imageNames.length +
        ")。添字の対応が壊れた索引は誤った参照 JPEG を引くため中断します。",
    );
  }
  // filename 由来の base をキーにするため null-proto オブジェクトを使う。通常の {} だと
  // base==="constructor"/"__proto__" が Object.prototype と衝突し `base in index` が誤って真になり、
  // index[base] が Function/prototype に解決されて .push が TypeError になる(run 全体がクラッシュ)。
  const index: VariantIndex = Object.create(null);
  for (let i = 0; i < variants.length; i++) {
    const variant = variants[i];
    const rawName = names[i];
    const rawImageName = imageNames[i];
    // 読めなかった要素はその添字だけ落とす(逐次読み時代の per-variant try/catch の耐性)。
    // 添字を詰めずに continue するため、後続の添字対応はずれない。
    if (variant == null || rawName == null || rawImageName == null) continue;
    const name = String(rawName);
    const imageName = String(rawImageName);
    if (!name || !imageName) continue;
    // 索引側と照合側で同一キーにするため必ず normalizeBase(小文字化 → サフィックス除去)を通す。
    const base = normalizeBase(name);
    if (!(base in index)) index[base] = [];
    // variants の出現順で push し、同名複数ヒット時の先勝ちを findVariantInIndex で再現する。
    index[base].push({ ext: extOf(imageName), variant: variant });
  }
  return index;
}

// current collection の variants を baseName ごとに索引化する。
// 切替先コレクションには同名の ARW+JPG+DNG が並びうるため parentImage の拡張子も併せて持つ。
// 読み取りは複数形アクセスの一括読み 3 本で行う(readMenuTree と同じ手口)。逐次に
// v.name() / v.parentImage().name() を引くと 614 variants で 16 秒かかる(実機実測)。
// 3 本が同一の件数・同一の順序で返ることは実機で確認済みで、同名衝突の先勝ちも保たれる。
// 一括読み自体が失敗した場合のフォールバックは持たない(1 回の Apple Event が失敗する状況
// では逐次読みも失敗するため、複雑さに見合わない)。
function buildVariantIndex(C1: any): VariantIndex {
  const doc = C1.currentDocument;
  const variants = doc.variants() as C1Variant[];
  const names = doc.variants.name() as unknown[];
  const imageNames = doc.variants.parentImage.name() as unknown[];
  return buildIndexFromBulk(variants, names, imageNames);
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

// コレクション 1 件の中身。baseName(normalizeBase 済み・小文字) -> その名前を持つ
// parentImage の拡張子(小文字)一覧(コレクション内の出現順)。
type CollectionContents = Record<string, string[]>;

// 候補コレクションの中身を複数形アクセスの一括読みで取る(currentCollection の切替は不要。
// 実機で全 11 コレクションの検査が 550ms)。読めなければ null を返し throw しない。
// 候補 1 件の検査失敗は「その候補を選ばない」で足り、他の候補が読めていれば選定は続けられる
// (coverageOf が null を番兵へ写す)。索引本体の buildIndexFromBulk が件数不一致で throw する
// のとは扱いが違うのは、あちらが誤った参照 JPEG を引く原因になるのに対し、こちらは選定の
// ヒントに過ぎず、切替後の select 安全弁が最終判定を持つため。
function readCollectionContents(collection: any): CollectionContents | null {
  try {
    const names = collection.variants.name() as unknown[];
    const imageNames = collection.variants.parentImage.name() as unknown[];
    // 件数が食い違うと別 variant の拡張子と組み合わさり coverage が嘘になる。検査失敗にする。
    if (!names || !imageNames || names.length !== imageNames.length) return null;
    // baseName をキーにするため null-proto を使う(buildIndexFromBulk と同じ理由。
    // "constructor" / "__proto__" が Object.prototype と衝突すると in 判定が誤って真になり
    // push が TypeError になる)。
    const contents: CollectionContents = Object.create(null);
    for (let i = 0; i < names.length; i++) {
      const rawName = names[i];
      const rawImageName = imageNames[i];
      // 読めなかった要素はその添字だけ落とす。添字を詰めないので後続の対応はずれない。
      if (rawName == null || rawImageName == null) continue;
      const name = String(rawName);
      const imageName = String(rawImageName);
      if (!name || !imageName) continue;
      const base = normalizeBase(name);
      if (!(base in contents)) contents[base] = [];
      contents[base].push(extOf(imageName));
    }
    return contents;
  } catch (e) {
    return null;
  }
}

// 選択中の対象のうち「対象自身の拡張子を持ち かつ 同名 JPEG も同じコレクションに居る」件数を
// 数える(pure)。contents が null(検査失敗)なら -1 を返す。0(同居が無い)と同じ値へ潰すと、
// 一括読みが使えない環境で全候補が同点になったことを pickBestCandidateIndex が判別できず、
// 件数へのフォールバックが効かなくなる。
function coverageOf(
  contents: CollectionContents | null,
  baseNames: string[],
  targetExts: string[],
  jpegExts: string[],
): number {
  if (contents === null) return -1;
  let covered = 0;
  for (const base of baseNames) {
    const exts = contents[base];
    if (!exts) continue;
    let hasTarget = false;
    let hasJpeg = false;
    for (const ext of exts) {
      if (targetExts.indexOf(ext) >= 0) hasTarget = true;
      if (jpegExts.indexOf(ext) >= 0) hasJpeg = true;
    }
    if (hasTarget && hasJpeg) covered++;
  }
  return covered;
}

// 切替先の候補を選ぶ(pure)。coverage 最大 -> 同値なら variant 数最大の順で決める。
// coverage が全 0(対象と JPEG が同居する候補が無い)なら件数最大へ落ちるため、coverage
// 導入前と同じ選定になる。番兵 -1 の扱いは pickLargestIndex に委ねる(coverage の -1 は
// 検査失敗、count の -1 は件数取得失敗で、どちらも候補には残すが選ばれない)。
//
// pickLargestIndex の呼び出しは最大 3 回(coverage 最大 / 同点タイブレーク / 検査が全滅した
// ときの件数フォールバック)。2 回に減らすと coverage を読めない環境で -1 が返り
// 「切替先のコレクションを決められません」で run 全体が止まる。現行コードなら動いていた環境を
// 壊す退行なので、simplify やレビューで 2 回へ減らさないこと。
function pickBestCandidateIndex(candidates: CollectionCandidate[]): number {
  const coverages = candidates.map((c) => c.coverage);
  const counts = candidates.map((c) => c.count);
  const byCoverage = pickLargestIndex(coverages);
  // どの候補も検査できなかった場合は件数だけで選ぶ。一括読みが使えない環境で選定ごと
  // 失敗させないためのフォールバックで、切替後の select 安全弁はそのまま残る。
  if (byCoverage < 0) return pickLargestIndex(counts);
  const best = coverages[byCoverage];
  // coverage が最大の候補だけを件数比較に残し、それ以外は番兵で候補外にする。
  const tieCounts = counts.map((n, i) => (coverages[i] === best ? n : -1));
  const byCount = pickLargestIndex(tieCounts);
  if (byCount >= 0) return byCount;
  // coverage 最大の候補がどれも件数を読めなかった場合。coverage が 1 以上なら対象と JPEG の
  // 同居を実際に確認できているので coverage の先勝ちを採る(件数不明だけを理由に候補ごと
  // 捨てない)。coverage が 0 なら選ぶ根拠が何も無いので -1 を返し、ensureWorkingCollection の
  // 「切替先のコレクションを決められません」へ落とす(件数が全滅したら診断付きで止まるという
  // 従来の契約を維持する)。
  return best > 0 ? byCoverage : -1;
}

// 一括読み(複数形アクセス)の戻り値を文字列配列へ正規化する(pure)。配列でない、または
// 件数が expected と違う場合は null を返し、呼び出し側を逐次読みへ落とす。件数の違う結果を
// そのまま使うと添字とコレクションの対応が壊れ、別のコレクションの id / name を貼り付ける。
// 個別要素が読めない(null / undefined)場合はその要素だけ空文字にする(候補からは外さない)。
function normalizeBulkStrings(raw: unknown, expected: number): string[] | null {
  // 文字列も length を持つので、object かどうかをここで弾かないと "AB" が長さ 2 の配列として
  // 通ってしまう(長さ検査では弾けない)。
  if (raw === null || typeof raw !== "object") return null;
  const len = (raw as { length?: unknown }).length;
  // typeof len !== "number" は防御的な冗長条件。expected が number である限り後続の
  // len !== expected が同じ入力を全て弾くので単独では到達しないが、型を外れた呼び出しに
  // 備えて残す(String(undefined) のような値を長さとして扱わないため)。
  if (typeof len !== "number" || len !== expected) return null;
  const arr = raw as unknown[];
  const out: string[] = [];
  for (let i = 0; i < len; i++) {
    const v = arr[i];
    out.push(v === null || v === undefined ? "" : String(v));
  }
  return out;
}

// コレクション N 件の文字列プロパティを読む。まず複数形アクセス(doc.collections.id() 等)で
// 1 イベントに畳み、読めなければ per-collection の逐次読みへ落とす(一括読みが使えない
// 環境でも候補を失わない)。読めなかった要素は空文字になる。
function readCollectionStrings(doc: any, cols: any[], prop: string): string[] {
  let bulk: string[] | null = null;
  try {
    bulk = normalizeBulkStrings(doc.collections[prop](), cols.length);
  } catch (e) {
    /* 一括読みが失敗したら逐次読みへ落ちる */
  }
  if (bulk) return bulk;
  const out: string[] = [];
  for (let i = 0; i < cols.length; i++) {
    let v = "";
    try {
      v = String(cols[i][prop]());
    } catch (e) {
      /* 読めない要素は空文字のまま(候補からは外さない) */
    }
    out.push(v);
  }
  return out;
}

// 切替先コレクションの候補 1 件。collection は切替代入に使う参照、count は variant 数。
// count の -1 は「件数を取得できなかった」番兵で、候補には残すが pickLargestIndex では
// 選ばれない。coverage は対象と参照 JPEG が同居する件数の枠で、ここでは 0 で初期化する。
type CollectionCandidate = {
  collection: any;
  id: string;
  name: string;
  count: number;
  coverage: number;
};

// 切替先の候補を列挙する。ゴミ箱は言語非依存の id で除外する(大量カリング後は全画像より
// 大きくなりうるため件数では弾けない)。件数を取得できなかった候補も残す: 除外すると
// 全件失敗時に候補一覧が空になり、ensureWorkingCollection の throw が原因を示せなくなる。
function collectCollectionCandidates(C1: any): CollectionCandidate[] {
  const doc = C1.currentDocument;
  const cols = doc.collections() as any[];
  const ids = readCollectionStrings(doc, cols, "id");
  const names = readCollectionStrings(doc, cols, "name");
  const out: CollectionCandidate[] = [];
  for (let i = 0; i < cols.length; i++) {
    if (ids[i] === "trash") continue;
    let count = -1;
    try {
      count = cols[i].variants().length;
    } catch (e) {
      /* 件数を取れないものは -1(候補には残すが選ばれない番兵) */
    }
    out.push({
      collection: cols[i],
      id: ids[i],
      name: names[i] || "?",
      count: count,
      coverage: 0,
    });
  }
  return out;
}

// 診断(describeCounts)へ渡す形へ射影する(pure)。
function candidateEntries(candidates: CollectionCandidate[]): { label: string; count: number }[] {
  return candidates.map((c) => ({ label: c.name, count: c.count }));
}

// コレクション切替の判定(pure)。expectedId は選定した切替先の id、actualId は
// doc.currentCollection() から読んだ id。どちらかが空文字なら判定不能(id を読めなかった)。
// 早期 return(既に切替先を見ている)の判定と、切替後の着地検証で同じ 1 本を読む。
// 同じ判定規則を 2 本の関数へ分けると片方だけ緩む drift が起きるため統合してある。
type SwitchVerdict = "ok" | "mismatch" | "unverified";

function collectionSwitchVerdict(expectedId: string, actualId: string): SwitchVerdict {
  if (!expectedId || !actualId) return "unverified";
  return expectedId === actualId ? "ok" : "mismatch";
}

// 対象と JPEG を同一コレクションに揃える。variants() は current collection スコープなので、
// 対象のコレクションだけをブラウズ中だと JPEG が載らず Match Look の参照を引けない。
//
// 切替先は名前ではなく中身で決める(UI 言語に依存しない)。候補ごとに切替なしで一括読みして
// coverage(選択中の対象と同名 JPEG が同居する件数)を測り、coverage 最大を選ぶ。同値なら
// variant 数最大。検査がどの候補でも失敗した場合は件数最大へ落ちる。
//
// coverage は「良い候補を選ぶ」ためのものであり「選んだ候補が正しいことを証明する」ものでは
// ない。検査で分かるのは「同名かつ対象拡張子の variant がそのコレクションに居る」ことまでで、
// 選択中の対象 variant そのものが居ることではない(clone は元と同じ parentImage を持つため
// baseName も拡張子も一致し、別コレクションの同名ファイルとも区別できない)。したがって
// 切替後に対象を select する安全弁は必須であり、coverage が通ったことを理由に削ってはいけない。
//
// 候補の列挙(ゴミ箱の除外・id / name の読み取り・件数取得)は collectCollectionCandidates が
// 持つ。ここは選定・切替・切替後の妥当性確認だけを行う。
// 切替後は currentCollection の id を読み直して着地を確認する。id が一致しない場合は診断付きで
// throw し、id を読めない場合は下の select 安全弁へ委ねる(判定は collectionSwitchVerdict)。
function ensureWorkingCollection(C1: any, items: WorkItem[]): void {
  const doc = C1.currentDocument;
  const candidates = collectCollectionCandidates(C1);

  // 候補の検査は currentCollection を切り替えずに行える(実機で全 11 コレクション 550ms)。
  const baseNames = items.map((it) => it.baseName);
  for (const cand of candidates) {
    cand.coverage = coverageOf(
      readCollectionContents(cand.collection),
      baseNames,
      CONFIG.rawTargetExts,
      CONFIG.jpegExts,
    );
  }

  const entries = candidateEntries(candidates);

  const pick = pickBestCandidateIndex(candidates);
  if (pick < 0) {
    throw new Error("切替先のコレクションを決められません。候補: " + describeCounts(entries));
  }

  // 既に切替先を見ているなら何もしない(選択元のコレクションなので対象を含むことは自明)。
  // 同名のコレクションが複数ありうるため、比較は名前ではなく id で行う。id を読めない場合は
  // 判定不能なので切替へ進む(安全側)。判定規則は collectionSwitchVerdict が唯一の真実。
  let currentId = "";
  try {
    currentId = String(doc.currentCollection().id());
  } catch (e) {
    /* 取れなければ切替を行う(安全側) */
  }
  if (collectionSwitchVerdict(candidates[pick].id, currentId) === "ok") return;

  doc.currentCollection = candidates[pick].collection;
  delay(0.5); // 切替の反映待ち。plain delay を使う(run loop を pump しない)

  // 着地検証: 切替後の currentCollection を読み直して期待した id と突き合わせる。
  // doc.currentCollection() が返すのは live specifier ではない具体参照なので、切替前に取った
  // 参照を読んでも古い値のままになる(実測)。必ずここで読み直す。
  // mismatch のときだけ止める。unverified(id を読めない)は下の select 安全弁へ委ねる
  // (id が読めないこと自体は切替の失敗を意味しない)。リトライは持たない
  // (切替代入が無視される事象は未観測。観測されてから足す)。
  let landedId = "";
  try {
    landedId = String(doc.currentCollection().id());
  } catch (e) {
    /* 読めなければ unverified 扱いで select 安全弁へ委ねる */
  }
  if (collectionSwitchVerdict(candidates[pick].id, landedId) === "mismatch") {
    throw new Error(
      "コレクションの切替が着地しませんでした。切替先「" +
        candidates[pick].name +
        "」(id=" +
        candidates[pick].id +
        ")を指定しましたが、現在のコレクションは id=" +
        landedId +
        " です。候補: " +
        describeCounts(entries),
    );
  }

  // 安全弁: 対象が本当にこのコレクションに居ることを確認する。coverage は同名・同拡張子の
  // variant が居ることしか示さないため、選択中の対象そのものの所在を確かめられるのはここだけ。
  try {
    doc.select({ variant: items[0].variant });
  } catch (e) {
    throw new Error(
      "切替先コレクション「" +
        candidates[pick].name +
        "」で対象を選択できません(" +
        String(e) +
        ")。候補: " +
        describeCounts(entries),
    );
  }
  const selected = doc.variants.whose({ selected: true })();
  if (selected.length) doc.deselect({ variants: selected });
}

// C1 で現在選択中の対象 variant を WorkItem として返す。parentImage 拡張子が rawTargetExts の
// ものだけ拾う。currentCollection 切替で選択は失われるため切替の前に呼んで確定する。
// variant 参照をそのまま持ち回るので、拡張子は受理判定にのみ使い WorkItem には残さない。
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
      out.push({ baseName: normalizeBase(nm), label: imgName, variant: v });
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

// manifest を書き、失敗しても throw せず例外の内容を文字列で返す(成功は null)。
// ここで投げないのは、投げると finally を抜けて run() の外へ出てしまい、その後ろにある
// 帰結判定(全件未適用の throw / 部分未適用のダイアログ)へ到達しなくなるため。
// 呼び出し側が戻り値を保持し、帰結を伝えた後に finishRun が投げる。
function appendManifestOrError(
  sessionRoot: string,
  stamp: string,
  rows: ManifestRow[],
): string | null {
  try {
    appendManifest(sessionRoot, stamp, rows);
    return null;
  } catch (e) {
    return String(e);
  }
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

// バッチの帰結を分類する(pure)。itemCount === 0 は run() が早期 return するため到達しないが、
// notAppliedCount === 0 の条件が先に成立するので "ok" を返す(番兵を別途持たない)。
function classifyOutcome(itemCount: number, notAppliedCount: number): Outcome {
  if (notAppliedCount === 0) return "ok";
  if (notAppliedCount === itemCount) return "none-applied";
  return "partial";
}

// matchlook の値から未適用理由への写像。適用済みは未適用ではないので理由を持たない(null)。
// Record なので MatchLookStatus にメンバが増えるとここがコンパイルエラーになる。
// 未知値での実行時 throw は入れない: この写像は破壊的な Match Look 適用が完了した後に
// 呼ばれるため、throw すると summary を載せない生の Error が飛び「ユーザーの写真に何をしたか」
// を伝えられなくなる(CLAUDE.md Known Limitations 10 の fail-loud の型を破る)。
const MATCHLOOK_REASON: Record<MatchLookStatus, NotAppliedReason | null> = {
  applied: null,
  "no-ref": "failed",
  "-": "nojpeg",
};

// 上の写像を引く(pure)。呼び出し側が Record を直接触らずに済ませ、参照点を 1 つに保つ。
function matchLookReason(status: MatchLookStatus): NotAppliedReason | null {
  return MATCHLOOK_REASON[status];
}

// 状態ごとの件数。キーは MatchLookStatus の全メンバ(過不足は Record が型で捕まえる)。
type MatchLookTally = Record<MatchLookStatus, number>;

// 追記ログの行を状態ごとに数える(pure)。初期化がキーを全て持つため、該当 0 件の状態も
// undefined ではなく 0 で返る。集計は排他(1 行はちょうど 1 つの状態に数えられる)。
function tallyMatchlook(rows: ManifestRow[]): MatchLookTally {
  const tally: MatchLookTally = { applied: 0, "no-ref": 0, "-": 0 };
  for (const r of rows) tally[r.matchlook]++;
  return tally;
}

// 追記ログの行から未適用のものだけを出現順に抜き出す(pure)。matchlook の値がそのまま
// 理由になるので、集計とは別に数え直さない(rows が唯一の真実)。理由への写像は
// matchLookReason に閉じ、null(=適用済み)をそのまま除外条件に使う。
function notAppliedEntries(rows: ManifestRow[]): NotAppliedEntry[] {
  const out: NotAppliedEntry[] = [];
  for (const r of rows) {
    const reason = matchLookReason(r.matchlook);
    if (reason === null) continue;
    out.push({ target: r.target, reason: reason });
  }
  return out;
}

// 未適用の対象名を並べる上限。表示上の都合であり、受理拡張子やラベルのような機械検証可能な
// 制約ではないため CONFIG には置かない。throw の文面とアラート本文の双方で同じ値を使う。
const NOT_APPLIED_NAME_LIMIT = 5;

// 未適用の理由に対応するユーザー可視の文言。判定値(NotAppliedReason)と表示文言の対応は
// ここ 1 箇所に閉じる。Record なので理由が増えるとコンパイルエラーになる。
const NOT_APPLIED_LABEL: Record<NotAppliedReason, string> = {
  nojpeg: "参照 JPEG なし",
  failed: "適用に失敗",
};

// 上の対応表を引く(pure)。
function notAppliedReasonLabel(reason: NotAppliedReason): string {
  return NOT_APPLIED_LABEL[reason];
}

// 未適用の対象を「  名前 (理由)」の行で並べる(pure)。max を超えた分は「  他 N 件」へ畳む。
function formatNotAppliedNames(entries: NotAppliedEntry[], max: number): string {
  const shown = entries.slice(0, max);
  const lines = shown.map((e) => "  " + e.target + " (" + notAppliedReasonLabel(e.reason) + ")");
  const rest = entries.length - shown.length;
  if (rest > 0) lines.push("  他 " + rest + " 件");
  return lines.join("\n");
}

// 未適用の理由に対応する対処ガイダンス(pure)。notAppliedReasonLabel と同じパターンで、判定値と
// 表示文言の対応をここ 1 箇所に閉じる。nojpeg の対処(JPEG が import 済みか確認)は failed(参照は
// 引けたが適用に失敗)には無関係(JPEG は既に import 済みのため確認は空振りする)なので、
// notAppliedGuidanceLines 側で entries に実際に含まれる reason のぶんだけに絞る。
// (機序は CLAUDE.md Known Limitations 項目 15 を参照。文言自体には含めない)
const NOT_APPLIED_GUIDANCE: Record<NotAppliedReason, string> = {
  nojpeg: "対象と同名の JPEG がこのセッションに import されているか確認してください。",
  failed:
    "適用に失敗した対象は時間をおいて再実行してください(import 直後はプレビュー生成が終わらず失敗することがあります)。",
};

// ガイダンスを出す固定順(nojpeg → failed)。entries の出現順に依存すると選択順で文面が入れ替わり
// テストが脆くなるため、順序は entries の並びと独立に固定する。
const NOT_APPLIED_GUIDANCE_ORDER: NotAppliedReason[] = ["nojpeg", "failed"];

// entries に実際に含まれる reason のぶんだけ、対処ガイダンスを固定順で組み立てる(pure)。
// 存在しない reason のガイダンスは出さない。noneAppliedMessage 専用にせず独立関数にしてあるのは、
// 将来 notAppliedAlertText 側でも使うことになった場合に同じロジックをコピーして二重管理に
// しないため。
function notAppliedGuidanceLines(entries: NotAppliedEntry[]): string {
  const present = new Set(entries.map((e) => e.reason));
  return NOT_APPLIED_GUIDANCE_ORDER.filter((reason) => present.has(reason))
    .map((reason) => NOT_APPLIED_GUIDANCE[reason] + "\n")
    .join("");
}

// 全件未適用のときに throw する文面(pure)。対処ガイダンスは notAppliedGuidanceLines が
// entries に実際に含まれる reason のぶんだけ固定順(nojpeg → failed)で組み立てるため、
// 存在しない理由への対処(例: failed しか無いのに JPEG import 確認を促す)が出ることは構造的に
// 起きない。「Match Look ツールに前回の参照が残っている場合がありますが、このスクリプトは
// 何も適用していません。」は「C1 に残る前回の参照とこのスクリプトの動作は無関係」を明示する
// 再発防止線(この取り違えが実際に起きたため文面で直接答える)。
function noneAppliedMessage(summary: string, entries: NotAppliedEntry[]): string {
  return (
    "選択した " + entries.length + " 件すべてに Match Look を適用できませんでした。\n" +
    formatNotAppliedNames(entries, NOT_APPLIED_NAME_LIMIT) + "\n" +
    notAppliedGuidanceLines(entries) +
    "Match Look ツールに前回の参照が残っている場合がありますが、このスクリプトは何も適用していません。\n" +
    summary
  );
}

// 部分未適用のときにダイアログへ出す本文(pure)。
function notAppliedAlertText(applied: number, entries: NotAppliedEntry[]): string {
  return (
    applied + " 件に適用、" + entries.length + " 件を適用できませんでした。\n\n" +
    "適用できなかった対象:\n" +
    formatNotAppliedNames(entries, NOT_APPLIED_NAME_LIMIT)
  );
}

// manifest 書き込み失敗を既存の文面の末尾へ 1 行足す(pure)。detail が null なら base を
// そのまま返す。全件未適用の throw 文面とログ失敗単独の throw 文面の双方でこれを使い、
// 「何を適用したか」を先に載せてから失敗を足す並びを二重管理しない。
function withManifestFailure(base: string, detail: string | null): string {
  if (detail === null) return base;
  return base + "\nmanifest 書き込み失敗: " + detail;
}

// 部分未適用をダイアログで知らせる。runModal は run loop を回すため、必ず適用ループと HUD の
// クローズが終わってから呼ぶこと(適用中に run loop を pump すると複数枚適用が壊れる)。
// 表示に失敗しても握りつぶす(通知は装飾。summary の return を妨げない)。
function showNotAppliedAlert(text: string): void {
  try {
    ObjC.import("AppKit");
    const alert = $.NSAlert.alloc.init;
    alert.messageText = "Match Look — 一部を適用できませんでした";
    alert.informativeText = text;
    alert.addButtonWithTitle("OK");
    alert.runModal;
  } catch (e) {
    /* 通知できなくても処理結果は summary と追記ログに残る */
  }
}

// finally 通過後(コレクション復帰済み・HUD クローズ済み)の帰結処理。未適用の帰結を先に
// 伝え、保持した manifest 例外は最後に投げる。この順序は逆にしないこと: manifest の失敗を
// 先に投げると「何が適用できなかったか」がユーザーへ届かない(read-only な Output や
// 壊れた既存ファイルでは毎回この経路を通る)。
// notify を注入するのは、既定の実装 showNotAppliedAlert が NSAlert で run loop を回すため。
// この関数は必ず run() の finally より後で呼ぶこと(適用シーケンス中に run loop を回すと
// 複数枚適用の 2 枚目以降が着地しない)。
function finishRun(
  summary: string,
  rows: ManifestRow[],
  manifestError: string | null,
  notify: (text: string) => void,
): string {
  const notApplied = notAppliedEntries(rows);
  const outcome = classifyOutcome(rows.length, notApplied.length);
  if (outcome === "none-applied") {
    throw new Error(withManifestFailure(noneAppliedMessage(summary, notApplied), manifestError));
  }
  if (outcome === "partial") {
    notify(notAppliedAlertText(rows.length - notApplied.length, notApplied));
  }
  // 通知を出し終えてから投げる。summary を先頭に載せるので、ログ保存に失敗しても
  // 「写真に何を適用したか」は失われない。
  if (manifestError !== null) {
    throw new Error(withManifestFailure(summary, manifestError));
  }
  return summary;
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

  // メニューコマンドはバッチ開始時に 1 回だけ解決する(毎枚走査しない)。HUD 生成より前に
  // 置くのは、解決に失敗したときに HUD を出しっぱなしにしないため。
  const menuCmds = resolveMatchLookMenu(SE);

  // バッチ進捗 HUD(生成失敗時 null で継続。以降 hud* は no-op になる)。
  const hud = createProgressHUD(items.length);

  // ペアリングも Match Look も対象と JPEG を同一コレクションで引くため、対象と同名 JPEG が
  // 最も多く同居するコレクションへ切り替える。切替前に元コレクションを控え、処理後に必ず戻す。
  let originalCollection: any = null;
  try {
    originalCollection = C1.currentDocument.currentCollection();
  } catch (e) {
    /* 取れなければ復帰しない */
  }
  const rows: ManifestRow[] = [];
  // 判定は finally の後で行うため summary を try の外へ持ち出す(NSAlert は run loop を回すので
  // HUD を閉じコレクションを戻してから呼ぶ。throw も復帰後に投げる)。
  let summary = "";
  // manifest 書き込みの失敗もここに保持し、finally 通過後の帰結判定より後に投げる
  // (try の中で投げると未適用の通知へ到達しない)。
  let manifestError: string | null = null;

  // コレクション切替と本処理を try で囲む。createProgressHUD の後に throw しうる文を
  // try の外に置かないこと(切替が throw しても finally で必ず元コレクションへ戻し HUD を閉じる)。
  try {
    ensureWorkingCollection(C1, items);
    // variant 索引はバッチ共通資源なのでループの前に 1 回だけ構築する。対象 0 件は run() が
    // 既に早期 return 済みなので遅延メモ化の動機は無い。
    //
    // 構築の失敗は個別 variant の失敗ではなく doc.variants() の読み取りそのものの失敗
    // (権限・接続・セッション状態)なので、per-item catch の内側に置かず、ここでバッチごと
    // 中断する。ループ内に置くと対象 N 件それぞれが同じ失敗を踏んで全件 no-ref になり、
    // 真の原因はどこにも出ないまま「時間をおいて再実行」という無関係な助言だけが出る
    // (実際にそうなっていた)。「一過性の失敗をその 1 件だけ degrade させる」という過去の
    // 設計意図を、バッチ共通資源と個別 variant を別物として扱う方針へ意図的に覆す判断。
    //
    // この文は try の内側に置くこと。外へ出すと finally を通らず、コレクションが切替先の
    // ままになり HUD も開いたまま残る。
    let variantIndex: VariantIndex;
    try {
      variantIndex = buildVariantIndex(C1);
    } catch (e) {
      // 索引構築は適用ループより前なので、この時点で適用は 1 件も起きていない。載せる summary は
      // 無いが、代わりに「適用していない」ことを明示する(Match Look ツールに残る前回の参照との
      // 取り違えを防ぐ。noneAppliedMessage の末尾行と同じ理由)。
      throw new Error(
        "variant 索引を構築できません(" + String(e) + ")。" +
          "対象 " + items.length + " 件の処理を中断しました。Match Look は適用していません。",
      );
    }

    let done = 0;
    for (const it of items) {
      done++;
      hudSetItem(hud, done, items.length, it.label);
      let jpegLabel: string | null = null;
      let matchlook: MatchLookStatus = "-";
      try {
        // JPEG variant は対象と同じ baseName で引く(同名 import 前提)。
        const jv = findVariantInIndex(variantIndex, it.baseName, CONFIG.jpegExts);
        if (jv) {
          jpegLabel = String(jv.parentImage().name());
          // 対象 variant は選択時点の参照をそのまま使う(索引から引き直さない)。
          applyMatchLook_viaMenu(C1, SE, menuCmds, jv, it.variant, (phase) => hudSetPhase(hud, done, phase));
          matchlook = "applied";
        }
        // JPEG が見つからなければ matchlook は初期値 "-" のまま(集計時に nojpeg 扱い)。
      } catch (e) {
        matchlook = "no-ref";
      }
      hudItemDone(hud, done); // applied/スキップを問わずバーを done へ確定前進
      rows.push({ target: it.label, jpeg: jpegLabel, matchlook: matchlook });
    }

    // カウンタは rows(唯一の真実)から導出する。ループ中に別変数で数えると乖離しうる。
    // 状態ごとの排他集計は tallyMatchlook に閉じる(キーの過不足は Record が型で捕まえる)。
    const tally = tallyMatchlook(rows);

    // 破壊的な Match Look 適用はこの時点で完了済み。summary(何件に何を適用したか)を先に
    // 組み立て、ログ保存が失敗しても summary を載せて throw する。fail-loud は保ちつつ、
    // 「ユーザーの写真に何をしたか」だけは必ず伝える(黙って applied=N を返して失敗を隠さない)。
    summary = formatSummary(items.length, tally.applied, tally["no-ref"], tally["-"]);
    // 失敗はここで投げず保持する(投げると finally を抜けて未適用の通知へ到達しない)。
    manifestError = appendManifestOrError(root, stamp, rows);
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
    hudClose(hud);
  }

  // ここから先は finally 通過後(コレクション復帰済み・HUD クローズ済み)。適用の Apple Event は
  // すべて完了しているので、run loop を回す NSAlert を出しても適用シーケンスと交錯しない。
  // finishRun をここより前(try / finally の中)へ移さないこと: NSAlert が run loop を回すため、
  // 適用シーケンスと交錯すると複数枚適用の 2 枚目以降が着地しなくなる。
  // 追記ログの書き込みは finally より前に済ませてあり、失敗していれば manifestError に入っている。
  return finishRun(summary, rows, manifestError, showNotAppliedAlert);
}
