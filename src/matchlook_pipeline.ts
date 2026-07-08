"use strict";
// Capture One 用 JXA パイプライン（TypeScript ソース / 単一ファイル・import 禁止）。
// タスク1 ペアリング / タスク2 Match Look(メニュー) / タスク3 TSV manifest を、
// all(Denoised 全体) と sel(C1 選択 DNG のみ) の2スコープで実行する。

// byTime は撮影時刻フォールバック専用のため遅延関数にする（詳細は buildJpegIndex）。
type JpegIndex = { byName: Record<string, string>; byTime: () => Record<string, string> };
type MatchResult = { jpeg: string | null; how: "name" | "time" | "none" };
type ManifestRow = {
  dng: string;
  jpeg: string | null;
  method: "name" | "time" | "none";
  matchlook: "applied" | "off" | "no-ref" | "-";
};
// 処理対象 DNG の正規化単位。all は Denoised の走査ファイル、sel は選択 variant 由来。
// dngPath は all のみ非 null（byTime フォールバック用）。sel は常に null。
type WorkItem = { baseName: string; label: string; dngPath: string | null };

// ================= 設定 =================
const CONFIG = {
  c1AppName: "Capture One",
  sessionRootOverride: "",
  denoisedSubdir: "Selects/Denoised",
  referencesSubdir: "References",
  // タスク3の manifest 出力先（session-root 相対）。
  manifestSubpath: "Output/matchlook_pairs.tsv",
  exiftool: "/opt/homebrew/bin/exiftool",
  dngExts: ["dng"],
  jpegExts: ["jpg", "jpeg"],
  stripSuffixes: [] as string[],
  // env 未指定(C1 Scripts メニュー起動等)の Match Look 既定。実機検証済みにつき ON。
  runMatchLook: true,
  // Match Look 用に DNG と JPEG を同一コレクションに揃えるための全画像 smart album 名。
  // UI 言語依存（menuMatchLook と同じ。日本語 UI では「すべてのイメージ」）。
  allImagesCollection: "すべてのイメージ",
  menuMatchLook: {
    menu: "調整",
    setReference: "セットマッチルックリファレンス",
    apply: "マッチルックを適用",
  },
};

// ================= 基本ヘルパー =================
const app = Application.currentApplication();
app.includeStandardAdditions = true;

function readEnv(a: StandardApp, name: string, fallback: string): string {
  const v = String(a.systemAttribute(name));
  return v !== "" ? v : fallback;
}

function sh(cmd: string): string {
  return app.doShellScript(cmd);
}
function q(s: string): string {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function joinPath(a: string, b: string): string {
  return a.replace(/\/+$/, "") + "/" + b.replace(/^\/+/, "");
}
function parentDir(p: string): string {
  return p.replace(/\/+$/, "").replace(/\/[^\/]*$/, "");
}

// Capture One の file プロパティを POSIX パス文字列に寄せる（実機では変換不要）。
function toPOSIX(x: unknown): string | null {
  if (x == null) return null;
  return String(x);
}

function baseNameNoExt(path: string): string {
  const parts = path.split("/");
  const file = parts[parts.length - 1];
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.substring(0, dot) : file;
}

function stripSuffixes(name: string): string {
  for (const suf of CONFIG.stripSuffixes) {
    if (name.endsWith(suf)) return name.slice(0, -suf.length);
  }
  return name;
}

// フォルダ内の指定拡張子ファイルのフルパス一覧
function listFiles(dir: string, exts: string[]): string[] {
  const orExpr = exts.map((e) => `-iname '*.${e}'`).join(" -o ");
  let out: string;
  try {
    out = sh(`find ${q(dir)} -maxdepth 1 -type f \\( ${orExpr} \\) 2>/dev/null`);
  } catch (e) {
    return [];
  }
  return out.split("\r").filter((l) => l.trim() !== "");
}

// exiftool で DateTimeOriginal を取得（無ければ空文字）
function captureTime(path: string): string {
  try {
    return sh(
      `${q(CONFIG.exiftool)} -s3 -DateTimeOriginal ${q(path)} 2>/dev/null`,
    ).trim();
  } catch (e) {
    return "";
  }
}

// ================= ペアリング（タスク1） =================
// byName は全 JPEG から即時構築する。byTime（撮影時刻 -> JPEG）は matchToJpeg の
// フォールバック専用で、同名運用（全 DNG が名前一致）では一度も引かれない。そこで
// byTime は初回参照時に一度だけ全 JPEG を走査してキャッシュする遅延関数にし、
// 常態では captureTime（exiftool サブプロセス）の全件起動を丸ごと省く。
function buildJpegIndex(jpegPaths: string[]): JpegIndex {
  // filename 由来の base をキーにするため null-proto オブジェクトを使う（"constructor" 等の
  // prototype キー衝突を防ぐ。buildVariantIndex と同じ理由）。byTime は時刻キーで衝突しないが uniform に揃える。
  const byName: Record<string, string> = Object.create(null);
  for (const p of jpegPaths) {
    const name = stripSuffixes(baseNameNoExt(p)).toLowerCase();
    if (!(name in byName)) byName[name] = p;
  }
  let byTimeCache: Record<string, string> | null = null;
  const byTime = (): Record<string, string> => {
    if (byTimeCache) return byTimeCache;
    const m: Record<string, string> = Object.create(null);
    for (const p of jpegPaths) {
      const t = captureTime(p);
      if (t && !(t in m)) m[t] = p;
    }
    byTimeCache = m;
    return m;
  };
  return { byName, byTime };
}

// baseName（stripSuffixes 済み・小文字）から JPEG を引く。byName 優先、
// dngPath があるとき（all モード）は撮影時刻フォールバックも試みる。
function matchToJpeg(
  baseName: string,
  dngPath: string | null,
  index: JpegIndex,
): MatchResult {
  if (baseName in index.byName) {
    return { jpeg: index.byName[baseName], how: "name" };
  }
  if (dngPath) {
    const t = captureTime(dngPath);
    if (t) {
      // ここで初めて byTime を materialize する（byName が外れた all モードのみ）。
      const byTime = index.byTime();
      if (t in byTime) return { jpeg: byTime[t], how: "time" };
    }
  }
  return { jpeg: null, how: "none" };
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

// ================= Match Look（タスク2・UI スクリプティング） =================

// メニュー項目を「有効化されるまで待って」クリックする。
// 実機で判明: d.select 後にメニューの enabled が更新されるまで非同期の遅延があり、
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
  dngVariant: C1Variant,
): void {
  const m = CONFIG.menuMatchLook;
  const doc = C1.currentDocument;
  C1.activate(); // メニュー操作は frontmost の C1 に対して行う
  delay(0.4);
  selectOnly(doc, jpegVariant); // 参照側 JPEG だけを選択
  clickMenuItem(SE, m.menu, m.setReference); // 参照にセット
  selectOnly(doc, dngVariant); // 対象 DNG だけを選択
  clickMenuItem(SE, m.menu, m.apply); // 適用
}

// baseName（stripSuffixes 済み・小文字）-> その名前を持つ variant の一覧（variants() 出現順）。
type VariantIndex = Record<string, { ext: string; variant: C1Variant }[]>;

// doc.variants() を 1 回だけ全走査して baseName ごとに索引化する。
// run() は DNG 件数分 findVariantInIndex を呼ぶが、Apple Events のフルフェッチは
// この 1 回に畳まれる（従来は 1 件あたり 2 回・計 2N 回フェッチしていた）。
// All Images には同名の ARW+JPG+DNG が並ぶため parentImage の拡張子も併せて持つ。
function buildVariantIndex(C1: any): VariantIndex {
  const doc = C1.currentDocument;
  // filename 由来の base をキーにするため null-proto オブジェクトを使う。通常の {} だと
  // base==="constructor"/"__proto__" が Object.prototype と衝突し `base in index` が誤って真になり、
  // index[base] が Function/prototype に解決されて .push が TypeError になる（run 全体がクラッシュ）。
  const index: VariantIndex = Object.create(null);
  for (const v of doc.variants() as C1Variant[]) {
    let n = "";
    let imgExt = "";
    try {
      n = String(v.name()).toLowerCase();
      imgExt = String(v.parentImage().name()).split(".").pop()!.toLowerCase();
    } catch (e) {
      continue;
    }
    const base = stripSuffixes(n);
    if (!(base in index)) index[base] = [];
    // variants() の出現順で push し、同名複数ヒット時の先勝ちを findVariantInIndex で再現する。
    index[base].push({ ext: imgExt, variant: v });
  }
  return index;
}

// 索引から baseName + expectedExts に該当する variant を引く。variants() 出現順で
// 最初に拡張子が一致した variant を返す（同名衝突の拡張子弁別・先勝ちの要）。
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

// 全画像 smart album を currentCollection に設定し、DNG と JPEG を同一コレクションに揃える。
// 実機で判明: variants() は current collection スコープ。Denoised だけ見ていると JPEG が
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

// C1 で現在選択中の DNG variant を WorkItem として返す（baseName=照合用・小文字、
// label=manifest 表示用・原名、dngPath=常に null: sel はパスを持たず byTime 不可）。
// currentCollection 切替で選択は失われるため、切替の前に呼んで確定する。
function selectedDngItems(C1: any): WorkItem[] {
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
      ext = imgName.split(".").pop()!.toLowerCase();
    } catch (e) {
      continue;
    }
    if (CONFIG.dngExts.indexOf(ext) >= 0) {
      out.push({ baseName: stripSuffixes(nm).toLowerCase(), label: imgName, dngPath: null });
    }
  }
  return out;
}

// MATCHLOOK env（"true"/"false"）を解釈。未設定は CONFIG.runMatchLook にフォールバック。
function resolveMatchLook(a: StandardApp): boolean {
  const v = readEnv(a, "MATCHLOOK", CONFIG.runMatchLook ? "true" : "false");
  return v === "true" || v === "1";
}

// ================= 集約 manifest（タスク3） =================
// 画像はコピーせず、ペアリング対応表を TSV でセッションフォルダに毎回上書き出力する。

function relToRoot(root: string, p: string): string {
  const prefix = root.replace(/\/+$/, "") + "/";
  return p.indexOf(prefix) === 0 ? p.slice(prefix.length) : p;
}

function manifestTsv(sessionRoot: string, rows: ManifestRow[]): string {
  const lines: string[] = [];
  lines.push("# matchlook pairs\tsession=" + sessionRoot);
  lines.push("dng\tjpeg\tmethod\tmatchlook");
  for (const r of rows) {
    const jpeg = r.jpeg === null ? "-" : r.jpeg;
    const method = r.method === "none" ? "-" : r.method;
    lines.push([r.dng, jpeg, method, r.matchlook].join("\t"));
  }
  return lines.join("\n") + "\n";
}

function writeManifest(sessionRoot: string, rows: ManifestRow[]): void {
  const dest = joinPath(sessionRoot, CONFIG.manifestSubpath);
  sh("mkdir -p " + q(parentDir(dest)));
  sh("printf '%s' " + q(manifestTsv(sessionRoot, rows)) + " > " + q(dest));
}

// ================= メイン =================
function run(): string {
  // env 未指定(メニュー起動等)は選択に適用する sel を既定にする(全件は重いため)。
  const scope = readEnv(app, "SCOPE", "sel");
  const doMatch = resolveMatchLook(app);
  const C1 = Application(CONFIG.c1AppName);
  const SE = Application("System Events");
  const root = detectSessionRoot(C1);

  // sel は currentCollection 切替で選択が失われるため、切替の前に対象を確定する。
  let selItems: WorkItem[] = [];
  if (scope === "sel") selItems = selectedDngItems(C1);

  // Match Look は DNG と JPEG が同一コレクションに要るため全画像ビューへ切り替える。
  // 切替前に元コレクションを控え、処理後に戻す。
  let originalCollection: any = null;
  if (doMatch) {
    try {
      originalCollection = C1.currentDocument.currentCollection();
    } catch (e) {
      /* 取れなければ復帰しない */
    }
    ensureAllImagesCollection(C1);
  }

  // 集計は finally でのコレクション復帰後に return で参照するため try の外で宣言する。
  const items: WorkItem[] = [];
  let nameCount = 0;
  let timeCount = 0;
  let noneCount = 0;
  let applied = 0;
  let noRef = 0;

  // 切替後に例外が出ても finally で必ず元コレクションへ戻すため try で囲む。
  try {
    const jpegs = listFiles(joinPath(root, CONFIG.referencesSubdir), CONFIG.jpegExts);
    const index = buildJpegIndex(jpegs);
    // variant 索引は byTime と同じく遅延メモ化する。狙いは効率改善と挙動保持の両立:
    // (1) 1 ペアも該当しなければ doc.variants() を一度も引かない（従来の variant 参照も
    //     res.jpeg && doMatch のときだけ呼ばれ、非該当時はフェッチ 0 回だった）。
    // (2) 構築（doc.variants() のフルフェッチ）を per-item try/catch の内側で走らせるため、
    //     一過性の Apple Events 失敗はその item だけ no-ref に degrade し、次 item で retry する
    //     （従来の per-item 回復挙動を保つ。外側 try に置くと run 全体が中断していた）。
    // (3) 成功後はキャッシュ再利用でフェッチをセッション通算 1 回に畳む（効率改善の主目的）。
    let variantIndexCache: VariantIndex | null = null;
    const getVariantIndex = (): VariantIndex => {
      if (variantIndexCache) return variantIndexCache;
      variantIndexCache = buildVariantIndex(C1);
      return variantIndexCache;
    };

    // 対象 DNG の WorkItem を供給源ごとに正規化する。
    // sel は selectedDngItems が既に WorkItem を返すためそのまま積む（詰め替え不要）。
    if (scope === "sel") {
      for (const s of selItems) items.push(s);
    } else {
      const dngs = listFiles(joinPath(root, CONFIG.denoisedSubdir), CONFIG.dngExts);
      for (const d of dngs) {
        items.push({
          baseName: stripSuffixes(baseNameNoExt(d)).toLowerCase(),
          label: d.split("/").pop() ?? d,
          dngPath: d,
        });
      }
    }

    const rows: ManifestRow[] = [];
    for (const it of items) {
      const res = matchToJpeg(it.baseName, it.dngPath, index);
      if (res.how === "name") nameCount++;
      else if (res.how === "time") timeCount++;
      else noneCount++;

      let matchlook: ManifestRow["matchlook"] = res.jpeg && !doMatch ? "off" : "-";
      if (res.jpeg && doMatch) {
        try {
          // JPEG variant は JPEG のベース名で引く（時刻一致で名前が異なる場合に備える）。
          // getVariantIndex() の doc.variants() 取得失敗はこの try が捕捉し no-ref に落とす。
          const jpegBase = stripSuffixes(baseNameNoExt(res.jpeg)).toLowerCase();
          const vi = getVariantIndex();
          const jv = findVariantInIndex(vi, jpegBase, CONFIG.jpegExts);
          const dv = findVariantInIndex(vi, it.baseName, CONFIG.dngExts);
          if (jv && dv) {
            applyMatchLook_viaMenu(C1, SE, jv, dv);
            applied++;
            matchlook = "applied";
          } else {
            // ペアは disk 上にあるが variant が browser に無い。
            matchlook = "no-ref";
            noRef++;
          }
        } catch (e) {
          matchlook = "no-ref";
          noRef++;
        }
      }
      rows.push({
        dng: it.label,
        jpeg: res.jpeg ? relToRoot(root, res.jpeg) : null,
        method: res.how,
        matchlook: matchlook,
      });
    }
    writeManifest(root, rows);
  } finally {
    // ビューを元のコレクションへ戻す(writeManifest 等の例外時も必ず実行する)。
    if (doMatch && originalCollection) {
      try {
        C1.currentDocument.currentCollection = originalCollection;
        delay(0.3);
      } catch (e) {
        /* 戻せなくても致命的ではない */
      }
    }
  }

  return (
    "scope=" + scope + " items=" + items.length +
    " name=" + nameCount + " time=" + timeCount + " none=" + noneCount +
    " domatch=" + doMatch + " applied=" + applied + " noref=" + noRef +
    " manifest=" + CONFIG.manifestSubpath
  );
}
