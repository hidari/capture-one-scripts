import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

// ビルド済み JS(tsc 出力)を単一の真実として読み込み、pure 関数を露出させて検証する。
// 対象ファイルは osascript の top-level global 制約で import/export を持てないため、
// vm コンテキストで評価し末尾に露出エピローグを足して掴む(関数を再実装しない = DRY)。
const here = dirname(fileURLToPath(import.meta.url));
const distJs = join(here, "..", "src", "dist", "matchlook_pipeline.js");

// dist JS を vm で評価し、露出させたい関数を掴んで返す。extraSandbox で $/ObjC の fake を
// 注入でき、extraExposed で native 依存の関数(readTextFile 等)も掴める(既定は pure 関数のみ)。
function loadModule(extraSandbox = {}, extraExposed = []) {
  const src = readFileSync(distJs, "utf8");
  const base = [
    "stripSuffixes", "formatStamp", "joinPath", "parentDir", "extOf",
    "findVariantInIndex", "manifestHeaderLines", "manifestRowLine", "manifestContent", "CONFIG",
  ];
  const exposed = base.concat(extraExposed);
  const epilogue = "\n;globalThis.__M = { " + exposed.join(", ") + " };\n";
  // 評価用の最小スタブ(現状 top-level に実行文は無いが、将来の追加に備えて用意)。
  const stubApp = { includeStandardAdditions: false };
  const Application = () => stubApp;
  Application.currentApplication = () => stubApp;
  const sandbox = Object.assign({ Application, delay: () => {} }, extraSandbox);
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox, { filename: "matchlook_pipeline.js" });
  return sandbox.__M;
}

const M = loadModule();

// JXA の $/ObjC を最小に模した fake。修正前バグ(String(NSString) が中身でなく
// "[id __NSCFString]" を返す)を再現し、readTextFile が ObjC.unwrap 経由で中身を返すこと・
// nil(読み取り失敗)で throw することを Node 上で pin する。実 Foundation の round-trip は
// osascript の live smoke が別途担保するので、ここでは seam(String vs unwrap)の弁別だけを狙う。
function makeBridge(store) {
  const nsString = (content) => ({ __content: content, toString: () => "[id __NSCFString]" });
  const $ = (x) => x;
  $.NSUTF8StringEncoding = 4;
  $.NSString = {
    stringWithContentsOfFileEncodingError: (path) => (path in store ? nsString(store[path]) : null),
  };
  const ObjC = {
    import: () => {},
    unwrap: (x) => (x && typeof x === "object" && "__content" in x ? x.__content : undefined),
  };
  return { $, ObjC };
}

test("findVariantInIndex: 拡張子で弁別する(同名 ARW/JPG/DNG)", () => {
  const idx = Object.create(null);
  idx["img1234"] = [
    { ext: "arw", variant: "V_ARW" },
    { ext: "jpg", variant: "V_JPG" },
    { ext: "dng", variant: "V_DNG" },
  ];
  assert.equal(M.findVariantInIndex(idx, "img1234", ["jpg", "jpeg"]), "V_JPG");
  assert.equal(M.findVariantInIndex(idx, "img1234", ["dng"]), "V_DNG");
  assert.equal(M.findVariantInIndex(idx, "img1234", ["arw"]), "V_ARW");
});

test("findVariantInIndex: 出現順で先勝ち", () => {
  const idx = Object.create(null);
  idx["dup"] = [
    { ext: "jpg", variant: "FIRST" },
    { ext: "jpg", variant: "SECOND" },
  ];
  assert.equal(M.findVariantInIndex(idx, "dup", ["jpg"]), "FIRST");
});

test("findVariantInIndex: base は大文字小文字非依存 / 不在は null", () => {
  const idx = Object.create(null);
  idx["img1234"] = [{ ext: "dng", variant: "V_DNG" }];
  assert.equal(M.findVariantInIndex(idx, "IMG1234", ["dng"]), "V_DNG");
  assert.equal(M.findVariantInIndex(idx, "nope", ["dng"]), null);
  assert.equal(M.findVariantInIndex(idx, "img1234", ["jpg"]), null);
});

test("stripSuffixes: 設定時のみ末尾を除去 / 既定は恒等", () => {
  const saved = M.CONFIG.stripSuffixes;
  try {
    M.CONFIG.stripSuffixes = ["-dxo"];
    assert.equal(M.stripSuffixes("img1234-dxo"), "img1234");
    assert.equal(M.stripSuffixes("img1234"), "img1234");
    assert.equal(M.stripSuffixes("img1234-other"), "img1234-other");
  } finally {
    M.CONFIG.stripSuffixes = saved;
  }
  assert.equal(M.stripSuffixes("img1234-dxo"), "img1234-dxo");
});

test("extOf: 拡張子を小文字で取り出す / ドット無しは全体", () => {
  assert.equal(M.extOf("IMG1234.dng"), "dng");
  assert.equal(M.extOf("photo.final.JPG"), "jpg");
  assert.equal(M.extOf("noext"), "noext");
});

test("formatStamp: ローカル時刻を YYYY-MM-DD HH:MM:SS へ整形(ゼロ埋め)", () => {
  assert.equal(M.formatStamp(new Date(2026, 6, 12, 3, 58, 21)), "2026-07-12 03:58:21");
  assert.equal(M.formatStamp(new Date(2026, 0, 1, 0, 0, 0)), "2026-01-01 00:00:00");
  assert.equal(M.formatStamp(new Date(2026, 11, 31, 23, 59, 9)), "2026-12-31 23:59:09");
});

test("joinPath / parentDir: パス整形", () => {
  assert.equal(M.joinPath("/a/b/", "/c/d"), "/a/b/c/d");
  assert.equal(M.joinPath("/a/b", "c"), "/a/b/c");
  assert.equal(M.parentDir("/a/b/c.txt"), "/a/b");
  assert.equal(M.parentDir("/a/b/"), "/a");
});

test("manifestHeaderLines: セッション付き 2 行ヘッダ", () => {
  assert.equal(
    M.manifestHeaderLines("/S"),
    "# matchlook pairs log\tsession=/S\ntime\ttarget\tjpeg\tmatchlook\n",
  );
});

test("manifestRowLine: タブ区切り / null は '-'", () => {
  assert.equal(
    M.manifestRowLine("2026-07-12 01:00:00", "IMG.dng", "IMG.jpg", "applied"),
    "2026-07-12 01:00:00\tIMG.dng\tIMG.jpg\tapplied",
  );
  assert.equal(M.manifestRowLine("T", "IMG.dng", null, "-"), "T\tIMG.dng\t-\t-");
});

test("manifestContent: 新規はヘッダ先頭 / 既存は末尾へ追記(ヘッダ二重化しない)", () => {
  assert.equal(M.manifestContent(null, "H\n", "r1"), "H\nr1\n");
  assert.equal(M.manifestContent("H\nr1\n", "H\n", "r2"), "H\nr1\nr2\n");
  // 既存があるとき header は捨てる(二重ヘッダ防止)
  assert.equal(M.manifestContent("prev\n", "HEADER\n", "row"), "prev\nrow\n");
});

test("manifestContent: 空の既存(0 byte)は header 無しで body だけ追記(=== null を pin)", () => {
  // existing==="" は fileExists true 経路(readTextFile が "" を返す)なので header を付けない。
  // `existing === null` を `!existing` に緩めるとここが "H\nr\n" になり FAIL する(変異検出)。
  assert.equal(M.manifestContent("", "H\n", "r"), "r\n");
});

test("readTextFile: NSString の中身を返す(修正前 String() のラッパートークンではない)", () => {
  const content = "# matchlook pairs log\tsession=/S\ntime\ttarget\tjpeg\tmatchlook\nrow1\n";
  const Mb = loadModule(makeBridge({ "/x.tsv": content }), ["readTextFile"]);
  // String() へ revert すると "[id __NSCFString]" が返り、この 2 つの assert が FAIL する。
  assert.equal(Mb.readTextFile("/x.tsv"), content);
  assert.ok(Mb.readTextFile("/x.tsv").indexOf("[id __NSCFString]") < 0);
});

test("readTextFile: 読み取り失敗(nil)は typeof ガードで throw", () => {
  // typeof ガードを外すと undefined を素通しし throw しなくなり FAIL する(変異検出)。
  const Mb = loadModule(makeBridge({}), ["readTextFile"]);
  assert.throws(() => Mb.readTextFile("/missing"), /読み取れません/);
});
