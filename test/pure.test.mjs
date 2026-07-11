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

function loadModule() {
  const src = readFileSync(distJs, "utf8");
  const epilogue =
    "\n;globalThis.__M = {" +
    " stripSuffixes, baseNameNoExt, q, joinPath, parentDir," +
    " findVariantInIndex, manifestHeaderLines, manifestRowLine, CONFIG };\n";
  // top-level 実行文(app = Application.currentApplication())が触るものだけスタブ。
  const stubApp = { includeStandardAdditions: false };
  const Application = () => stubApp;
  Application.currentApplication = () => stubApp;
  const sandbox = { Application, delay: () => {} };
  vm.createContext(sandbox);
  vm.runInContext(src + epilogue, sandbox, { filename: "matchlook_pipeline.js" });
  return sandbox.__M;
}

const M = loadModule();

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

test("baseNameNoExt: パス/拡張子/多重ドット", () => {
  assert.equal(M.baseNameNoExt("/a/b/IMG1234.dng"), "IMG1234");
  assert.equal(M.baseNameNoExt("IMG1234"), "IMG1234");
  assert.equal(M.baseNameNoExt("/a/b/photo.final.jpg"), "photo.final");
});

test("q: シングルクォートを安全にエスケープ", () => {
  assert.equal(M.q("plain"), "'plain'");
  assert.equal(M.q("it's"), "'it'\\''s'");
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
