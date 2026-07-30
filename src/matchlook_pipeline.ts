"use strict";

// Capture One 用 JXA パイプライン(TypeScript ソース / 単一ファイル・import 禁止)。
// C1 で選択中の RAW 対象に、同名の creative-look JPEG の look を Match Look(メニュー操作)で
// 転写する。ペアリングは対象と JPEG を同一コレクション(ゴミ箱を除いて variant 数が最大のもの)に
// 揃えて行い、フォルダ構成や PureRAW の有無に依存しない。処理結果は追記ログ(TSV)へ残す。

// manifest 1 行の正規化単位。target=対象の原名、jpeg=参照 JPEG の原名(無ければ null)。
type ManifestRow = {
  target: string;
  jpeg: string | null;
  matchlook: "applied" | "no-ref" | "-";
};

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

// doc.variants() を 1 回だけ全走査して baseName ごとに索引化する。
// 切替先コレクションには同名の ARW+JPG+DNG が並びうるため parentImage の拡張子も併せて持つ。
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

// 対象と JPEG を同一コレクションに揃える。variants() は current collection スコープなので、
// 対象のコレクションだけをブラウズ中だと JPEG が載らず Match Look の参照を引けない。
//
// 切替先は名前ではなく「ゴミ箱を除いて variant 数が最大」で決める(UI 言語に依存しない)。
// ただし「最大 = 全画像コレクション」とは限らないため、切替後に対象を select して
// 実際に作業可能であることを確認する。current collection 外の variant は C1 が select を
// 拒否するので、成否がそのまま「切替先が対象を含むか」の判定になる。名前照合を撤去しても
// 黙って誤ったコレクションで処理を続ける状態には落とさない。
function ensureWorkingCollection(C1: any, items: WorkItem[]): void {
  const doc = C1.currentDocument;
  const cols = doc.collections();
  const candidates: any[] = [];
  const ids: string[] = [];
  const entries: { label: string; count: number }[] = [];
  const counts: number[] = [];
  for (let i = 0; i < cols.length; i++) {
    let id = "";
    let name = "?";
    try {
      id = String(cols[i].id());
      name = String(cols[i].name());
    } catch (e) {
      /* 読めなくても候補には残す(件数側で弾く) */
    }
    // ゴミ箱は言語非依存の id で除外する。大量カリング後は全画像より大きくなりうるため。
    if (id === "trash") continue;
    let n = -1;
    try {
      n = cols[i].variants().length;
    } catch (e) {
      /* 件数を取れないものは -1(候補外の番兵) */
    }
    candidates.push(cols[i]);
    ids.push(id);
    entries.push({ label: name, count: n });
    counts.push(n);
  }

  const pick = pickLargestIndex(counts);
  if (pick < 0) {
    throw new Error("切替先のコレクションを決められません。候補: " + describeCounts(entries));
  }

  // 既に切替先を見ているなら何もしない(選択元のコレクションなので対象を含むことは自明)。
  // 同名のコレクションが複数ありうるため、比較は名前ではなく id で行う。
  let currentId = "";
  try {
    currentId = String(doc.currentCollection().id());
  } catch (e) {
    /* 取れなければ切替を行う(安全側) */
  }
  if (currentId && currentId === ids[pick]) return;

  doc.currentCollection = candidates[pick];
  delay(0.5); // 切替の反映待ち。plain delay を使う(run loop を pump しない)

  // 安全弁: 対象が本当にこのコレクションに居ることを確認する。
  try {
    doc.select({ variant: items[0].variant });
  } catch (e) {
    throw new Error(
      "切替先コレクション「" +
        entries[pick].label +
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

  // メニューコマンドはバッチ開始時に 1 回だけ解決する(毎枚走査しない)。HUD 生成より前に
  // 置くのは、解決に失敗したときに HUD を出しっぱなしにしないため。
  const menuCmds = resolveMatchLookMenu(SE);

  // バッチ進捗 HUD(生成失敗時 null で継続。以降 hud* は no-op になる)。
  const hud = createProgressHUD(items.length);

  // ペアリングも Match Look も対象と JPEG を同一コレクションで引くため、ゴミ箱を除いて
  // variant 数が最大のコレクションへ切り替える。切替前に元コレクションを控え、処理後に必ず戻す。
  let originalCollection: any = null;
  try {
    originalCollection = C1.currentDocument.currentCollection();
  } catch (e) {
    /* 取れなければ復帰しない */
  }
  const rows: ManifestRow[] = [];

  // コレクション切替と本処理を try で囲む。createProgressHUD の後に throw しうる文を
  // try の外に置かないこと(切替が throw しても finally で必ず元コレクションへ戻し HUD を閉じる)。
  try {
    ensureWorkingCollection(C1, items);
    // variant 索引は遅延メモ化する。対象 0 件は run() が既に早期 return 済みでここへは来ないため、
    // ここでの意味はループの都度ではなくバッチ全体で doc.variants() の全走査を 1 回に抑えること。
    let variantIndexCache: VariantIndex | null = null;
    const getVariantIndex = (): VariantIndex => {
      if (variantIndexCache) return variantIndexCache;
      variantIndexCache = buildVariantIndex(C1);
      return variantIndexCache;
    };

    let done = 0;
    for (const it of items) {
      done++;
      hudSetItem(hud, done, items.length, it.label);
      let jpegLabel: string | null = null;
      let matchlook: ManifestRow["matchlook"] = "-";
      try {
        const vi = getVariantIndex();
        // JPEG variant は対象と同じ baseName で引く(同名 import 前提)。
        const jv = findVariantInIndex(vi, it.baseName, CONFIG.jpegExts);
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
    hudClose(hud);
  }
}
