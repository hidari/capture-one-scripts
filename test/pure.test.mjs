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
    "stripSuffixes", "normalizeBase", "formatStamp", "joinPath", "parentDir", "extOf",
    "buildIndexFromBulk", "buildVariantIndex", "findVariantInIndex", "manifestHeaderLines", "manifestRowLine",
    "manifestContent", "formatSummary", "progressLabel", "phaseLabel", "phaseBarValue", "CONFIG",
    "findMenuCommand", "pickLargestIndex", "describeCounts", "ensureWorkingCollection",
    "normalizeBulkStrings", "collectCollectionCandidates", "candidateEntries",
    "readCollectionContents", "coverageOf", "pickBestCandidateIndex", "collectionSwitchVerdict",
    "classifyOutcome", "notAppliedEntries",
    "MATCHLOOK_REASON", "matchLookReason", "tallyMatchlook",
    "NOT_APPLIED_NAME_LIMIT", "formatNotAppliedNames", "notAppliedGuidanceLines",
    "noneAppliedMessage", "notAppliedAlertText",
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

// buildVariantIndex 検証用の最小 fake。variant.name() は拡張子なし、parentImage().name() は
// 拡張子付き(実機と同じ)。ObjC は不要なので既定の loadModule で通る。
function fakeVariant(variantName, imageName) {
  return { name: () => variantName, parentImage: () => ({ name: () => imageName }) };
}
// JXA の doc.variants は「関数でもありプロパティも持つ」specifier。一括読み
// (doc.variants.name() / doc.variants.parentImage.name())を模すため fake も同じ形にする。
// specifier の生成は Task 9 が導入した callableSpecifier を再利用する(Function.prototype.name が
// 非 writable であることの吸収もそちらに閉じている。specifier fake を新設しないこと)。
// 既定は variants から名前配列を導出し、overrides で一括読みの戻り値だけを差し替えられる
// (一括読みへの配線そのものの pin と、件数不一致の負のケースを作るため)。
function fakeC1(variants, overrides = {}) {
  const bulkNames = "names" in overrides ? overrides.names : variants.map((v) => v.name());
  const bulkImageNames = "imageNames" in overrides
    ? overrides.imageNames
    : variants.map((v) => v.parentImage().name());
  const specifier = callableSpecifier(() => variants, {
    name: () => bulkNames,
    parentImage: { name: () => bulkImageNames },
  });
  return { currentDocument: { variants: specifier } };
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

test("normalizeBase: 小文字化してからサフィックス除去(索引側と選択側で同一キー)", () => {
  const saved = M.CONFIG.stripSuffixes;
  try {
    M.CONFIG.stripSuffixes = ["-dxo"];
    // 肝: 大文字混じりサフィックスでも剥がれる。順序を strip -> lower に戻すと
    // "IMG1234-DxO" が "img1234-dxo" のままになりこの assert が FAIL する(変異検出)。
    assert.equal(M.normalizeBase("IMG1234-DxO"), "img1234");
    assert.equal(M.normalizeBase("img1234-dxo"), "img1234");
    assert.equal(M.normalizeBase("IMG1234"), "img1234");
  } finally {
    M.CONFIG.stripSuffixes = saved;
  }
  // 既定(サフィックス無し)は小文字化のみ。
  assert.equal(M.normalizeBase("IMG1234-DxO"), "img1234-dxo");
});

test("formatSummary: 出力スキーマを固定(早期 return と本処理で共通)", () => {
  assert.equal(
    M.formatSummary(3, 2, 1, 0),
    "items=3 applied=2 noref=1 nojpeg=0 manifest=Output/matchlook_pairs.tsv",
  );
  assert.equal(
    M.formatSummary(0, 0, 0, 0),
    "items=0 applied=0 noref=0 nojpeg=0 manifest=Output/matchlook_pairs.tsv",
  );
});

test("buildVariantIndex: parentImage 拡張子で弁別し baseName ごとに索引化(同名 ARW/JPG/DNG)", () => {
  const C1 = fakeC1([
    fakeVariant("IMG1234", "IMG1234.ARW"),
    fakeVariant("IMG1234", "IMG1234.JPG"),
    fakeVariant("IMG1234", "IMG1234.dng"),
  ]);
  const idx = M.buildVariantIndex(C1);
  // baseName は normalizeBase(小文字)。ext は parentImage 拡張子(小文字)で弁別。
  assert.equal(M.findVariantInIndex(idx, "img1234", ["jpg", "jpeg"]).parentImage().name(), "IMG1234.JPG");
  assert.equal(M.findVariantInIndex(idx, "img1234", ["dng"]).parentImage().name(), "IMG1234.dng");
  assert.equal(M.findVariantInIndex(idx, "img1234", ["arw"]).parentImage().name(), "IMG1234.ARW");
});

test("buildVariantIndex: constructor/__proto__ 名でもクラッシュせず索引化(Object.create(null) を pin)", () => {
  // 通常の {} だと base==="constructor" が Object.prototype と衝突し index[base] が
  // Function に解決されて .push が TypeError になる。Object.create(null) を {} に戻すと
  // buildVariantIndex が throw してこのテストが FAIL する(変異検出)。
  const C1 = fakeC1([
    fakeVariant("constructor", "constructor.dng"),
    fakeVariant("__proto__", "__proto__.jpg"),
  ]);
  const idx = M.buildVariantIndex(C1);
  assert.equal(M.findVariantInIndex(idx, "constructor", ["dng"]).parentImage().name(), "constructor.dng");
  assert.equal(M.findVariantInIndex(idx, "__proto__", ["jpg"]).parentImage().name(), "__proto__.jpg");
});

test("buildIndexFromBulk: 3 本の配列を添字で対応づけて索引化する", () => {
  const v0 = fakeVariant("IMG1234", "IMG1234.ARW");
  const v1 = fakeVariant("IMG1234", "IMG1234.JPG");
  const idx = M.buildIndexFromBulk([v0, v1], ["IMG1234", "IMG1234"], ["IMG1234.ARW", "IMG1234.JPG"]);
  assert.equal(M.findVariantInIndex(idx, "img1234", ["jpg"]), v1);
  assert.equal(M.findVariantInIndex(idx, "img1234", ["arw"]), v0);
});

test("buildIndexFromBulk: 長さが揃わなければ throw する(添字ずれの索引を作らない)", () => {
  // 添字の対応が壊れた索引は「ある variant の名前」を「別の variant の拡張子」と組み合わせ、
  // 誤った参照 JPEG を引く。静かに間違った look を当てるより止める(fail-loud)。
  const v0 = fakeVariant("A", "A.dng");
  const v1 = fakeVariant("B", "B.dng");
  assert.throws(() => M.buildIndexFromBulk([v0, v1], ["A"], ["A.dng", "B.dng"]), /件数が食い違い/);
  assert.throws(() => M.buildIndexFromBulk([v0, v1], ["A", "B"], ["A.dng"]), /件数が食い違い/);
  assert.throws(() => M.buildIndexFromBulk([v0], ["A", "B"], ["A.dng", "B.dng"]), /件数が食い違い/);
});

test("buildIndexFromBulk: 読めない要素はその添字だけ skip し後続の対応をずらさない", () => {
  // 肝: Object.keys の assert が無いと、null ガードを外しても String(null)==="null" という
  // 誰も引かないキーが増えるだけで findVariantInIndex 側の assert は緑のままになる(dead pin)。
  const v0 = fakeVariant("A", "A.dng");
  const v1 = fakeVariant("B", "B.dng");
  const v2 = fakeVariant("C", "C.jpg");
  const v3 = fakeVariant("D", "D.jpg");
  const idx = M.buildIndexFromBulk(
    [v0, v1, v2, v3],
    ["A", null, "C", "D"],
    ["A.dng", "B.dng", undefined, "D.jpg"],
  );
  assert.deepEqual(Object.keys(idx).sort(), ["a", "d"]);
  assert.equal(M.findVariantInIndex(idx, "a", ["dng"]), v0);
  assert.equal(M.findVariantInIndex(idx, "b", ["dng"]), null);
  assert.equal(M.findVariantInIndex(idx, "c", ["jpg"]), null);
  // 添字を詰めて skip すると d が C.jpg 由来の拡張子と組になり、この assert が FAIL する。
  assert.equal(M.findVariantInIndex(idx, "d", ["jpg"]), v3);
});

test("buildIndexFromBulk: 空文字の要素も skip する", () => {
  const v0 = fakeVariant("A", "A.dng");
  const v1 = fakeVariant("B", "B.dng");
  const idx = M.buildIndexFromBulk([v0, v1], ["", "B"], ["A.dng", ""]);
  assert.deepEqual(Object.keys(idx), []);
});

test("buildIndexFromBulk: 同名同拡張子が 2 件なら出現順で先勝ちになる", () => {
  // 肝: index[base].push を index[base].unshift へ変えると b が先頭に来てこの assert が FAIL する。
  // CLAUDE.md Known Limitations 4 の「同名衝突は出現順で先勝ち」を索引作成側で pin する
  // (既存の findVariantInIndex テストは手組みの索引を使うのでこの経路を通らない)。
  const a = fakeVariant("DUP", "DUP.JPG");
  const b = fakeVariant("DUP", "DUP.jpg");
  const idx = M.buildIndexFromBulk([a, b], ["DUP", "DUP"], ["DUP.JPG", "DUP.jpg"]);
  assert.equal(M.findVariantInIndex(idx, "dup", ["jpg"]), a);
});

test("buildIndexFromBulk: 索引キーは normalizeBase を通す(小文字化 → サフィックス除去)", () => {
  // 肝: normalizeBase(name) を name.toLowerCase() へ変えるとキーが "img1234-dxo" のまま残り、
  // img1234 で引けず FAIL する(変異検出)。索引側と照合側が同一キーになることの pin。
  const saved = M.CONFIG.stripSuffixes;
  const v = fakeVariant("IMG1234-DxO", "IMG1234-DxO.dng");
  try {
    M.CONFIG.stripSuffixes = ["-dxo"];
    const idx = M.buildIndexFromBulk([v], ["IMG1234-DxO"], ["IMG1234-DxO.dng"]);
    assert.deepEqual(Object.keys(idx), ["img1234"]);
    assert.equal(M.findVariantInIndex(idx, "img1234", ["dng"]), v);
  } finally {
    M.CONFIG.stripSuffixes = saved;
  }
});

test("buildVariantIndex: 索引は一括読み(doc.variants.name / parentImage.name)から作る", () => {
  // 肝: 逐次読み(v.name() / v.parentImage().name())へ戻すと索引キーが "decoy" になり、
  // img1234 が引けず FAIL する(変異検出)。一括読みへの配線そのものの pin。
  const C1 = fakeC1([fakeVariant("decoy", "decoy.txt")], {
    names: ["IMG1234"],
    imageNames: ["IMG1234.JPG"],
  });
  const idx = M.buildVariantIndex(C1);
  assert.equal(M.findVariantInIndex(idx, "img1234", ["jpg"]).name(), "decoy");
  assert.equal(M.findVariantInIndex(idx, "decoy", ["txt"]), null);
});

test("buildVariantIndex: 一括読みの件数が食い違えば throw する", () => {
  const C1 = fakeC1([fakeVariant("A", "A.dng"), fakeVariant("B", "B.dng")], { names: ["A"] });
  assert.throws(() => M.buildVariantIndex(C1), /件数が食い違い/);
});

test("progressLabel: 表示テキストを固定(done / total)", () => {
  assert.equal(M.progressLabel(8, 12), "Applying Match Look 8 / 12");
  assert.equal(M.progressLabel(0, 1), "Applying Match Look 0 / 1");
});

test("phaseLabel: フェーズ名を固定(reference / apply)", () => {
  assert.equal(M.phaseLabel("reference"), "Setting reference…");
  assert.equal(M.phaseLabel("apply"), "Applying look…");
});

test("phaseBarValue: フェーズ開始時のバー値(half-item)", () => {
  assert.equal(M.phaseBarValue(1, "reference"), 0);
  assert.equal(M.phaseBarValue(1, "apply"), 0.5);
  assert.equal(M.phaseBarValue(3, "reference"), 2);
  assert.equal(M.phaseBarValue(3, "apply"), 2.5);
});

// vm コンテキスト側で生成された値は main realm と Object.prototype が一致せず、
// node:assert/strict の deepEqual(= deepStrictEqual)は構造が同じでも FAIL する
// ("same structure but are not reference-equal")。配列は main realm の Array.from で写し、
// オブジェクトはスプレッドでプレーンオブジェクト化してから比較して、この realm 差だけを
// 吸収する(値の比較自体は緩めない)。Array.isArray は realm をまたいでも正しく判定する。
// null / 文字列などの非オブジェクトはそのまま渡すので、期待値がオブジェクトなら FAIL する
// (null 回帰は引き続き捕捉できる)。vm 由来の戻り値の比較は必ずこの 1 本を通す。
function assertPlainEqual(actual, expected) {
  const plain = (v) => (v !== null && typeof v === "object" ? { ...v } : v);
  assert.deepEqual(Array.isArray(actual) ? Array.from(actual, plain) : plain(actual), expected);
}

test("findMenuCommand: 英語ラベルで解決する", () => {
  const tree = [
    { menu: "File", items: ["New Session…", "Open…"] },
    { menu: "Adjustments", items: ["Reset", null, "Set Match Look Reference", "Apply Match Look"] },
  ];
  assertPlainEqual(M.findMenuCommand(tree, ["Set Match Look Reference", "セットマッチルックリファレンス"]), {
    menu: "Adjustments",
    item: "Set Match Look Reference",
  });
});

test("findMenuCommand: 同一の候補配列から日本語ラベルも解決する", () => {
  // 候補表は全言語ぶんを 1 本に持つ。UI 言語を変えても同じ配列で引けることが要件。
  const tree = [
    { menu: "調整", items: ["リセット", null, "セットマッチルックリファレンス", "マッチルックを適用"] },
  ];
  assertPlainEqual(M.findMenuCommand(tree, ["Apply Match Look", "マッチルックを適用"]), {
    menu: "調整",
    item: "マッチルックを適用",
  });
});

test("findMenuCommand: 先頭以外のメニューにある項目も見つける", () => {
  // 走査を先頭メニューだけに壊す(外側ループを 1 周で抜く)とここが null になり FAIL する(変異検出)。
  const tree = [
    { menu: "File", items: ["Open…"] },
    { menu: "Edit", items: ["Undo"] },
    { menu: "Adjustments", items: ["Apply Match Look"] },
  ];
  assertPlainEqual(M.findMenuCommand(tree, ["Apply Match Look"]), {
    menu: "Adjustments",
    item: "Apply Match Look",
  });
});

test("findMenuCommand: セパレータ(null)を挟んでも走査を続け後ろの項目を返す", () => {
  // 肝: null で走査を打ち切る実装(continue を break に変える)だとここが null になり FAIL する(変異検出)。
  // なお「typeof ガードを外す」変異では赤くならない(candidates.indexOf(null) は -1 で自然に不一致)。
  // pin しているのはガードの有無ではなく走査の継続である。
  const tree = [{ menu: "Adjustments", items: [null, "Reset", null, "Apply Match Look"] }];
  assertPlainEqual(M.findMenuCommand(tree, ["Apply Match Look"]), {
    menu: "Adjustments",
    item: "Apply Match Look",
  });
});

test("findMenuCommand: 不一致は null(部分一致で誤ヒットしない)", () => {
  // 完全一致でないと、別項目("Apply Match Look to Layer" 等)を掴んで誤操作する。
  const tree = [{ menu: "Adjustments", items: ["Apply Match Look to Layer", "Match"] }];
  assert.equal(M.findMenuCommand(tree, ["Apply Match Look"]), null);
  assert.equal(M.findMenuCommand([], ["Apply Match Look"]), null);
  assert.equal(M.findMenuCommand([{ menu: "Adjustments", items: [] }], ["Apply Match Look"]), null);
});

test("pickLargestIndex: 最大値の添字 / 同値は先勝ち", () => {
  assert.equal(M.pickLargestIndex([3, 7, 5]), 1);
  // 肝: 比較を > から >= へ緩めると後勝ちになりここが 2 を返して FAIL する(変異検出)。
  assert.equal(M.pickLargestIndex([3, 7, 7]), 1);
  // 0 件のコレクションも有効な候補(負値の番兵とは区別する)。
  assert.equal(M.pickLargestIndex([0, 0]), 0);
});

test("pickLargestIndex: 空配列と全負値は -1(番兵)", () => {
  assert.equal(M.pickLargestIndex([]), -1);
  // 肝: 負値は「件数を取得できなかった」を表す番兵で候補にしない。初期値を -Infinity に
  // 変えると [-1,-1,-1] が 0 を返しここが FAIL する(変異検出)。この -1 は
  // ensureWorkingCollection が「どのコレクションも読めなかった」を throw へ変換する根拠。
  assert.equal(M.pickLargestIndex([-1, -1, -1]), -1);
  assert.equal(M.pickLargestIndex([-1, 5, -1]), 1);
});

test("describeCounts: 診断用の 1 行(名前(件数) をカンマ区切り)", () => {
  assert.equal(M.describeCounts([]), "");
  assert.equal(M.describeCounts([{ label: "File", count: 45 }]), "File(45)");
  assert.equal(
    M.describeCounts([
      { label: "Apple", count: 21 },
      { label: "File", count: 45 },
    ]),
    "Apple(21), File(45)",
  );
});

test("classifyOutcome: 未適用件数から ok/none-applied/partial を判定する", () => {
  // 未適用 0 件は ok
  assert.equal(M.classifyOutcome(3, 0), "ok");
  assert.equal(M.classifyOutcome(1, 0), "ok");
  // 全件未適用は none-applied
  assert.equal(M.classifyOutcome(3, 3), "none-applied");
  assert.equal(M.classifyOutcome(1, 1), "none-applied");
  // 一部未適用は partial
  assert.equal(M.classifyOutcome(3, 1), "partial");
  assert.equal(M.classifyOutcome(3, 2), "partial");
  assert.equal(M.classifyOutcome(10, 9), "partial");
  // 対象 0 件は ok(早期 return で到達しないが防御的に)
  assert.equal(M.classifyOutcome(0, 0), "ok");
});

// matchlook の値(MatchLookStatus)による分岐は Record へ寄せてある。ここでは
// (1) 値 -> 未適用理由の写像、(2) 状態ごとの排他集計、の 2 つを exact 値で pin する。
// Record のキー過不足はコンパイルエラーで捕まるが、それは型検査であって実行時テストでは
// 捕まらないため、キーが実行時にも揃っていることを Object.keys で別途 pin する。
// 戻り値は vm realm のオブジェクトなので deepEqual に直接渡せない(プロトタイプ不一致で
// 必ず落ちる)。キーごとの assert.equal と、main realm 側から呼ぶ Object.keys で比較する。
test("matchLookReason: matchlook の値を未適用理由へ写す(applied は理由なし)", () => {
  // 肝: applied は「未適用ではない」を null で表す。ここを "nojpeg" 等に変えると
  // notAppliedEntries が applied 行まで拾い、既存の notAppliedEntries テストも FAIL する。
  assert.equal(M.matchLookReason("applied"), null);
  assert.equal(M.matchLookReason("no-ref"), "failed");
  assert.equal(M.matchLookReason("-"), "nojpeg");
});

test("MATCHLOOK_REASON: キーは MatchLookStatus の全メンバ(過不足なし)", () => {
  // Object.keys は main realm 側の呼び出しなので戻り値の配列も main realm(deepEqual 可)。
  assert.deepEqual(Object.keys(M.MATCHLOOK_REASON).sort(), ["-", "applied", "no-ref"]);
});

test("tallyMatchlook: 状態ごとに排他集計する", () => {
  const rows = [
    { target: "a.dng", jpeg: "a.JPG", matchlook: "applied" },
    { target: "b.dng", jpeg: null, matchlook: "-" },
    { target: "c.dng", jpeg: "c.JPG", matchlook: "no-ref" },
    { target: "d.dng", jpeg: "d.JPG", matchlook: "applied" },
  ];
  const tally = M.tallyMatchlook(rows);
  // 肝: 1 行はちょうど 1 つの状態に数えられる(合計 = rows.length)。
  assert.equal(tally.applied, 2);
  assert.equal(tally["no-ref"], 1);
  assert.equal(tally["-"], 1);
  assert.equal(tally.applied + tally["no-ref"] + tally["-"], rows.length);
});

test("tallyMatchlook: 空 rows は全キー 0(キーの初期化を pin)", () => {
  const tally = M.tallyMatchlook([]);
  // 肝: 初期化からキーを 1 つ落とすと undefined になりここが FAIL する(変異検出)。
  // 該当 0 件の状態が undefined で返ると formatSummary が "noref=undefined" を出す。
  assert.equal(tally.applied, 0);
  assert.equal(tally["no-ref"], 0);
  assert.equal(tally["-"], 0);
  assert.deepEqual(Object.keys(tally).sort(), ["-", "applied", "no-ref"]);
});

test("notAppliedEntries: applied を除き reason を対応づける", () => {
  const rows = [
    { target: "a.dng", jpeg: "a.JPG", matchlook: "applied" },
    { target: "b.dng", jpeg: null, matchlook: "-" },
    { target: "c.dng", jpeg: "c.JPG", matchlook: "no-ref" },
  ];
  assertPlainEqual(M.notAppliedEntries(rows), [
    { target: "b.dng", reason: "nojpeg" },
    { target: "c.dng", reason: "failed" },
  ]);
});

test("notAppliedEntries: 全件 applied なら空配列", () => {
  const rows = [
    { target: "a.dng", jpeg: "a.JPG", matchlook: "applied" },
    { target: "b.dng", jpeg: "b.JPG", matchlook: "applied" },
  ];
  assertPlainEqual(M.notAppliedEntries(rows), []);
});

test("notAppliedEntries: 出現順を保つ", () => {
  const rows = [
    { target: "x.dng", jpeg: "x.JPG", matchlook: "no-ref" },
    { target: "y.dng", jpeg: null, matchlook: "-" },
  ];
  assertPlainEqual(M.notAppliedEntries(rows), [
    { target: "x.dng", reason: "failed" },
    { target: "y.dng", reason: "nojpeg" },
  ]);
});

test("formatNotAppliedNames: 理由の文言を対応づける", () => {
  const entries = [
    { target: "a.dng", reason: "nojpeg" },
    { target: "b.dng", reason: "failed" },
  ];
  assert.equal(
    M.formatNotAppliedNames(entries, 5),
    "  a.dng (参照 JPEG なし)\n  b.dng (適用に失敗)",
  );
});

test("formatNotAppliedNames: 上限ちょうどなら畳まない", () => {
  const entries = [1, 2, 3].map((n) => ({ target: n + ".dng", reason: "nojpeg" }));
  assert.equal(
    M.formatNotAppliedNames(entries, 3),
    "  1.dng (参照 JPEG なし)\n  2.dng (参照 JPEG なし)\n  3.dng (参照 JPEG なし)",
  );
});

test("formatNotAppliedNames: 上限超過は「他 N 件」へ畳む", () => {
  const entries = [1, 2, 3, 4, 5].map((n) => ({ target: n + ".dng", reason: "nojpeg" }));
  assert.equal(
    M.formatNotAppliedNames(entries, 2),
    "  1.dng (参照 JPEG なし)\n  2.dng (参照 JPEG なし)\n  他 3 件",
  );
});

test("formatNotAppliedNames: 上限は 5(既定値)", () => {
  assert.equal(M.NOT_APPLIED_NAME_LIMIT, 5);
});

// notAppliedGuidanceLines: entries に実際に含まれる reason のぶんだけ、対処ガイダンスを
// 固定順(nojpeg → failed)で組み立てる。存在しない reason のガイダンスは出さない。
test("notAppliedGuidanceLines: nojpeg のみなら JPEG 確認の行だけを出す", () => {
  const entries = [{ target: "a.dng", reason: "nojpeg" }];
  assert.equal(
    M.notAppliedGuidanceLines(entries),
    "対象と同名の JPEG がこのセッションに import されているか確認してください。\n",
  );
});

test("notAppliedGuidanceLines: failed のみなら再実行の行だけを出す(JPEG 確認の行は出ない)", () => {
  const entries = [{ target: "a.dng", reason: "failed" }];
  assert.equal(
    M.notAppliedGuidanceLines(entries),
    "適用に失敗した対象は時間をおいて再実行してください(import 直後はプレビュー生成が終わらず失敗することがあります)。\n",
  );
});

test("notAppliedGuidanceLines: 両方の reason が混在すると entries の出現順によらず固定順(nojpeg → failed)で出す", () => {
  const forward = [
    { target: "a.dng", reason: "nojpeg" },
    { target: "b.dng", reason: "failed" },
  ];
  const reversed = [
    { target: "b.dng", reason: "failed" },
    { target: "a.dng", reason: "nojpeg" },
  ];
  const expected =
    "対象と同名の JPEG がこのセッションに import されているか確認してください。\n" +
    "適用に失敗した対象は時間をおいて再実行してください(import 直後はプレビュー生成が終わらず失敗することがあります)。\n";
  assert.equal(M.notAppliedGuidanceLines(forward), expected);
  assert.equal(M.notAppliedGuidanceLines(reversed), expected);
});

test("noneAppliedMessage: 件数・対象・注意書き・summary を含む(failed 混在で再実行行も出る)", () => {
  const entries = [
    { target: "a.dng", reason: "nojpeg" },
    { target: "b.dng", reason: "failed" },
  ];
  const msg = M.noneAppliedMessage("items=2 applied=0 noref=1 nojpeg=1", entries);
  assert.equal(
    msg,
    "選択した 2 件すべてに Match Look を適用できませんでした。\n" +
      "  a.dng (参照 JPEG なし)\n" +
      "  b.dng (適用に失敗)\n" +
      "対象と同名の JPEG がこのセッションに import されているか確認してください。\n" +
      "適用に失敗した対象は時間をおいて再実行してください(import 直後はプレビュー生成が終わらず失敗することがあります)。\n" +
      "Match Look ツールに前回の参照が残っている場合がありますが、このスクリプトは何も適用していません。\n" +
      "items=2 applied=0 noref=1 nojpeg=1",
  );
});

test("noneAppliedMessage: reason が failed を含まなければ再実行を促す行を足さない", () => {
  const entries = [
    { target: "a.dng", reason: "nojpeg" },
    { target: "b.dng", reason: "nojpeg" },
  ];
  const msg = M.noneAppliedMessage("items=2 applied=0 noref=0 nojpeg=2", entries);
  assert.equal(
    msg,
    "選択した 2 件すべてに Match Look を適用できませんでした。\n" +
      "  a.dng (参照 JPEG なし)\n" +
      "  b.dng (参照 JPEG なし)\n" +
      "対象と同名の JPEG がこのセッションに import されているか確認してください。\n" +
      "Match Look ツールに前回の参照が残っている場合がありますが、このスクリプトは何も適用していません。\n" +
      "items=2 applied=0 noref=0 nojpeg=2",
  );
});

test("noneAppliedMessage: reason が nojpeg を含まなければ JPEG 確認の行を出さない(全件 failed)", () => {
  const entries = [
    { target: "a.dng", reason: "failed" },
    { target: "b.dng", reason: "failed" },
  ];
  const msg = M.noneAppliedMessage("items=2 applied=0 noref=2 nojpeg=0", entries);
  assert.equal(
    msg,
    "選択した 2 件すべてに Match Look を適用できませんでした。\n" +
      "  a.dng (適用に失敗)\n" +
      "  b.dng (適用に失敗)\n" +
      "適用に失敗した対象は時間をおいて再実行してください(import 直後はプレビュー生成が終わらず失敗することがあります)。\n" +
      "Match Look ツールに前回の参照が残っている場合がありますが、このスクリプトは何も適用していません。\n" +
      "items=2 applied=0 noref=2 nojpeg=0",
  );
});

test("noneAppliedMessage: 混在時のガイダンス順は entries の出現順によらず固定(nojpeg → failed)", () => {
  const entries = [
    { target: "b.dng", reason: "failed" },
    { target: "a.dng", reason: "nojpeg" },
  ];
  const msg = M.noneAppliedMessage("items=2 applied=0 noref=1 nojpeg=1", entries);
  assert.equal(
    msg,
    "選択した 2 件すべてに Match Look を適用できませんでした。\n" +
      "  b.dng (適用に失敗)\n" +
      "  a.dng (参照 JPEG なし)\n" +
      "対象と同名の JPEG がこのセッションに import されているか確認してください。\n" +
      "適用に失敗した対象は時間をおいて再実行してください(import 直後はプレビュー生成が終わらず失敗することがあります)。\n" +
      "Match Look ツールに前回の参照が残っている場合がありますが、このスクリプトは何も適用していません。\n" +
      "items=2 applied=0 noref=1 nojpeg=1",
  );
});

// NOT_APPLIED_NAME_LIMIT(5)を超えるエントリで noneAppliedMessage を通し、
// formatNotAppliedNames への配線(渡す max が NOT_APPLIED_NAME_LIMIT そのものであること)を
// pin する。値・畳み込みロジック自体は別テストで検証済みなので、ここでは「他 1 件」への
// 折り畳みが noneAppliedMessage 経由でも起きることだけを見る(reason は failed を含めず
// 再実行行の有無と混同しない)。
test("noneAppliedMessage: NOT_APPLIED_NAME_LIMIT を超えると「他 N 件」へ畳む(配線 pin)", () => {
  const entries = [1, 2, 3, 4, 5, 6].map((n) => ({ target: n + ".dng", reason: "nojpeg" }));
  const msg = M.noneAppliedMessage("items=6 applied=0 noref=0 nojpeg=6", entries);
  assert.equal(
    msg,
    "選択した 6 件すべてに Match Look を適用できませんでした。\n" +
      "  1.dng (参照 JPEG なし)\n" +
      "  2.dng (参照 JPEG なし)\n" +
      "  3.dng (参照 JPEG なし)\n" +
      "  4.dng (参照 JPEG なし)\n" +
      "  5.dng (参照 JPEG なし)\n" +
      "  他 1 件\n" +
      "対象と同名の JPEG がこのセッションに import されているか確認してください。\n" +
      "Match Look ツールに前回の参照が残っている場合がありますが、このスクリプトは何も適用していません。\n" +
      "items=6 applied=0 noref=0 nojpeg=6",
  );
});

test("notAppliedAlertText: 適用件数と未適用件数を出す", () => {
  const entries = [{ target: "x.dng", reason: "nojpeg" }];
  assert.equal(
    M.notAppliedAlertText(9, entries),
    "9 件に適用、1 件を適用できませんでした。\n\n" +
      "適用できなかった対象:\n" +
      "  x.dng (参照 JPEG なし)",
  );
});

// noneAppliedMessage と同様、NOT_APPLIED_NAME_LIMIT を超えるエントリで notAppliedAlertText を
// 通し、formatNotAppliedNames への配線を pin する(配線 pin)。
test("notAppliedAlertText: NOT_APPLIED_NAME_LIMIT を超えると「他 N 件」へ畳む(配線 pin)", () => {
  const entries = [1, 2, 3, 4, 5, 6].map((n) => ({ target: n + ".dng", reason: "nojpeg" }));
  assert.equal(
    M.notAppliedAlertText(3, entries),
    "3 件に適用、6 件を適用できませんでした。\n\n" +
      "適用できなかった対象:\n" +
      "  1.dng (参照 JPEG なし)\n" +
      "  2.dng (参照 JPEG なし)\n" +
      "  3.dng (参照 JPEG なし)\n" +
      "  4.dng (参照 JPEG なし)\n" +
      "  5.dng (参照 JPEG なし)\n" +
      "  他 1 件",
  );
});

// ================= JXA specifier の共通 fake =================
// JXA の specifier は「関数として呼べて、かつプロパティも持つ」形をしている
// (doc.collections() で配列、doc.collections.id() で id の一括読み)。fake も同じ形にする。
// Function.prototype.name は非 writable なので `fn.name = ...` では置けない。このテストファイルは
// ESM で常に strict mode なので、代入すると黙って無視されるのではなく TypeError で落ちる。
// 必ず Object.defineProperty で置く。specifier の fake はこのヘルパ 1 本だけを通し、
// タスク 1(fakeC1 の一括読み)とタスク 3(fakeRunEnv)もこれを再利用する(独自実装を新設しない)。
function callableSpecifier(callImpl, props) {
  const fn = (...args) => callImpl(...args);
  for (const key of Object.keys(props)) {
    Object.defineProperty(fn, key, { value: props[key], writable: true, configurable: true });
  }
  return fn;
}

// ================= コレクション候補(ensureWorkingCollection 周辺)の fake =================
// 一括読み(doc.collections.id())は __id / __name を直接読み、逐次読み(cols[i].id())は
// reads カウンタを進めるので、どちらの経路を通ったかをテスト側から判別できる。
// count が負なら variants() が throw する(件数を取得できない候補の再現)。
// name が null なら逐次読みで name() が throw し、一括読みでは null 要素として返る。
// variants は callableSpecifier で作る。素の関数にすると variants.name が
// Function.prototype.name(文字列 "variants")になり、タスク 2 の readCollectionContents が
// 「読めない」のではなく「関数でない値を呼んだ TypeError」で null へ落ちる。狙って中身を
// 読ませないのか偶然壊れているのかを区別できないので、specifier の形は正しく作る。
// names / imageNames はコレクションの中身の一括読み(collection.variants.name() /
// collection.variants.parentImage.name())が返す値。省略するとその 2 つは undefined を返し、
// readCollectionContents が null を返して coverage が -1(検査失敗)になる。
// タスク 2 の coverage 配線テストだけがこの 2 引数を渡す。
function fakeCollection(id, name, count, names, imageNames) {
  const col = {
    __id: id,
    __name: name,
    reads: { id: 0, name: 0 },
    id: () => {
      col.reads.id++;
      return id;
    },
    name: () => {
      col.reads.name++;
      if (name === null) throw new Error("name unreadable");
      return name;
    },
    variants: callableSpecifier(
      () => {
        if (count < 0) throw new Error("variants unreadable");
        return new Array(count).fill(null);
      },
      { name: () => names, parentImage: { name: () => imageNames } },
    ),
  };
  return col;
}

// doc.collections を「関数でありプロパティ(複数形アクセス)も持つ」形にする。
// bulkMode: "ok"=一括読みが通る / "throw"=一括読みが失敗する / "short"=件数が食い違う。
function fakeCollectionsAccessor(cols, bulkMode) {
  const bulk = (prop) => () => {
    if (bulkMode === "throw") throw new Error("bulk read unavailable");
    const all = cols.map((c) => c["__" + prop]);
    return bulkMode === "short" ? all.slice(1) : all;
  };
  return callableSpecifier(() => cols, { id: bulk("id"), name: bulk("name") });
}

// opts:
//   currentId    切替前の currentCollection の id(既定 "")
//   bulk         fakeCollectionsAccessor の bulkMode(既定 "ok")
//   selected     doc.variants.whose({selected:true})() が返す配列(既定 [])
//   selectThrows doc.select が throw する(切替後の安全弁の失敗を再現)
//   landingId    切替代入のあと doc.currentCollection() が返すコレクションの id を強制する
//                (切替が着地しなかった環境の再現。タスク 5 の mismatch throw の pin に使う)
function fakeCollectionsDoc(cols, opts = {}) {
  const calls = { selected: [], deselected: [] };
  const variants = callableSpecifier(() => [], { whose: () => () => opts.selected || [] });
  const doc = {
    collections: fakeCollectionsAccessor(cols, opts.bulk || "ok"),
    variants: variants,
    select: (arg) => {
      if (opts.selectThrows) throw new Error("cannot select");
      calls.selected.push(arg.variant);
    },
    deselect: (arg) => {
      calls.deselected.push(arg.variants);
    },
  };
  // currentCollection は「setter で保存した値を getter がそのまま返す」形にする。
  // 初期値は呼べば現在の id を返す関数で、ensureWorkingCollection の切替前の読み取りに応える。
  // 切替代入のあとは、
  //   landingId なし: 代入された値そのものを保持する(doc.currentCollection === 代入したコレクション
  //                   になるので切替代入が起きたことを直接観測できる。呼び出せないので
  //                   タスク 5 の着地 id の読み取りは unverified になる)
  //   landingId あり: 呼べば landingId を返す関数を保持する(切替後に読み直した id が代入した
  //                   コレクションの id と食い違う環境の再現)
  // 素のデータプロパティ(doc.currentCollection = ...)に戻さないこと。戻すと landingId を
  // 渡しても切替後の読み直しが常に TypeError になり、タスク 5 の mismatch 経路が 1 度も通らない。
  let current = () => ({ id: () => String(opts.currentId || "") });
  Object.defineProperty(doc, "currentCollection", {
    get: () => current,
    set: (col) => {
      current = opts.landingId === undefined ? col : () => ({ id: () => String(opts.landingId) });
    },
    configurable: true,
  });
  return { C1: { currentDocument: doc }, doc: doc, calls: calls };
}

// ensureWorkingCollection へ渡す対象 1 件(select の引数として同一性だけを見る)。
const WORK_ITEM = { baseName: "img1234", label: "IMG1234.dng", variant: "V_TARGET" };

test("ensureWorkingCollection: 件数を取得できない候補も一覧に残して throw する(-1 番兵)", () => {
  // 肝: 件数 -1 の候補をフィルタで落とすと describeCounts が空文字になり、throw の
  // 原因(どのコレクションも読めなかったこと)が診断から消える(変異検出)。
  const cols = [fakeCollection("8", "All Images", -1), fakeCollection("11", "References", -1)];
  const { C1 } = fakeCollectionsDoc(cols);
  assert.throws(
    () => M.ensureWorkingCollection(C1, [WORK_ITEM]),
    (e) => {
      assert.match(e.message, /^切替先のコレクションを決められません。/);
      assert.match(e.message, /候補: All Images\(-1\), References\(-1\)$/);
      return true;
    },
  );
});

test("ensureWorkingCollection: ゴミ箱を除く件数最大へ切り替え、対象を select して選択を戻す", () => {
  // trash は件数が最大でも言語非依存の id で除外する。
  const cols = [
    fakeCollection("3", "Capture", 146),
    fakeCollection("8", "All Images", 614),
    fakeCollection("trash", "Trash", 999),
  ];
  const { C1, doc, calls } = fakeCollectionsDoc(cols, { currentId: "3", selected: ["V_SEL"] });
  M.ensureWorkingCollection(C1, [WORK_ITEM]);
  // landingId を渡していないので、切替代入後の currentCollection は代入した値そのもの。
  assert.equal(doc.currentCollection, cols[1]);
  assert.deepEqual(calls.selected, ["V_TARGET"]);
  assert.deepEqual(calls.deselected, [["V_SEL"]]);
});

test("ensureWorkingCollection: 既に切替先を見ているなら切り替えない(id 一致で早期 return)", () => {
  const cols = [fakeCollection("3", "Capture", 146), fakeCollection("8", "All Images", 614)];
  const { C1, doc, calls } = fakeCollectionsDoc(cols, { currentId: "8" });
  M.ensureWorkingCollection(C1, [WORK_ITEM]);
  // 切替代入が起きていなければ currentCollection は fake の初期値(関数)のまま。
  assert.equal(typeof doc.currentCollection, "function");
  assert.deepEqual(calls.selected, []);
});

test("ensureWorkingCollection: 切替後に select できなければコレクション名と候補を添えて throw", () => {
  const cols = [fakeCollection("8", "All Images", 614), fakeCollection("11", "References", 294)];
  const { C1 } = fakeCollectionsDoc(cols, { currentId: "3", selectThrows: true });
  assert.throws(
    () => M.ensureWorkingCollection(C1, [WORK_ITEM]),
    (e) => {
      assert.match(e.message, /切替先コレクション「All Images」で対象を選択できません/);
      assert.match(e.message, /候補: All Images\(614\), References\(294\)$/);
      return true;
    },
  );
});

test("normalizeBulkStrings: 要素を文字列化して返す", () => {
  assertPlainEqual(M.normalizeBulkStrings(["8", "11"], 2), ["8", "11"]);
  assertPlainEqual(M.normalizeBulkStrings([8, 11], 2), ["8", "11"]);
  assertPlainEqual(M.normalizeBulkStrings([], 0), []);
});

test("normalizeBulkStrings: 読めない要素(null / undefined)は空文字にする", () => {
  // 要素 1 つが読めなくても他の候補を失わない(添字は詰めない)。
  assertPlainEqual(M.normalizeBulkStrings([null, "A", undefined], 3), ["", "A", ""]);
});

test("normalizeBulkStrings: 件数が期待と違えば null(添字対応が壊れるため使わない)", () => {
  // 肝: 長さ検査を外すと短い一括読み結果をそのまま使い、別コレクションの id / name を
  // 貼り付ける。null を返して逐次読みへ落とすのが正しい(変異検出)。
  assert.equal(M.normalizeBulkStrings(["A"], 2), null);
  assert.equal(M.normalizeBulkStrings(["A", "B", "C"], 2), null);
});

test("normalizeBulkStrings: 配列でない戻り値は null(逐次読みへ落とす)", () => {
  // 肝: これは先頭ガード `raw === null || typeof raw !== "object"` の pin。
  // 文字列は length を持つので、このガードが無いと "AB" が長さ 2 の配列然として通り、
  // ["A","B"] が id / name の一括読み結果として使われてしまう。
  // (長さ検査 `len !== expected` はこの入力を弾かない。"AB".length は期待値 2 と一致する。)
  assert.equal(M.normalizeBulkStrings("AB", 2), null);
  assert.equal(M.normalizeBulkStrings(null, 0), null);
  assert.equal(M.normalizeBulkStrings(undefined, 0), null);
  assert.equal(M.normalizeBulkStrings({}, 0), null);
});

test("collectCollectionCandidates: 一括読みの id / name で候補を組み、ゴミ箱を除外する", () => {
  const cols = [
    fakeCollection("8", "All Images", 614),
    fakeCollection("trash", "Trash", 0),
    fakeCollection("11", "References", 294),
  ];
  const { C1 } = fakeCollectionsDoc(cols);
  const cands = M.collectCollectionCandidates(C1);
  assert.equal(cands.length, 2);
  assert.equal(cands[0].collection, cols[0]);
  assert.equal(cands[0].id, "8");
  assert.equal(cands[0].name, "All Images");
  assert.equal(cands[0].count, 614);
  // coverage は後段の検査が埋める枠。ここでは 0 初期化。
  assert.equal(cands[0].coverage, 0);
  assert.equal(cands[1].collection, cols[2]);
  assert.equal(cands[1].id, "11");
  assert.equal(cands[1].count, 294);
});

test("collectCollectionCandidates: 一括読みが通れば per-collection の逐次読みは行わない", () => {
  // 肝: id / name は doc.collections.id() / .name() で 1 イベントに畳む(実測で id 8ms /
  // name 6ms、逐次は合計 192ms)。逐次読みへ落ちると reads が 1 以上になり FAIL する。
  const cols = [fakeCollection("8", "All Images", 614), fakeCollection("11", "References", 294)];
  const { C1 } = fakeCollectionsDoc(cols);
  M.collectCollectionCandidates(C1);
  assert.deepEqual(cols.map((c) => c.reads), [{ id: 0, name: 0 }, { id: 0, name: 0 }]);
});

test("collectCollectionCandidates: 一括読みが throw したら逐次読みへフォールバックする", () => {
  const cols = [fakeCollection("8", "All Images", 614), fakeCollection("trash", "Trash", 0)];
  const { C1 } = fakeCollectionsDoc(cols, { bulk: "throw" });
  const cands = M.collectCollectionCandidates(C1);
  assert.equal(cands.length, 1);
  assert.equal(cands[0].name, "All Images");
  assert.equal(cands[0].count, 614);
  assert.equal(cols[0].reads.id, 1);
  assert.equal(cols[0].reads.name, 1);
});

test("collectCollectionCandidates: 一括読みの件数が合わなければ逐次読みへフォールバックする", () => {
  // 件数の違う結果をそのまま使うと添字がずれ、References の id を All Images に貼り付ける。
  const cols = [fakeCollection("8", "All Images", 614), fakeCollection("11", "References", 294)];
  const { C1 } = fakeCollectionsDoc(cols, { bulk: "short" });
  const cands = M.collectCollectionCandidates(C1);
  assertPlainEqual(cands.map((c) => c.id + ":" + c.name), ["8:All Images", "11:References"]);
});

test("collectCollectionCandidates: 件数を取得できない候補も -1 で残す(除外しない)", () => {
  // 肝: 除外すると全件失敗時に候補一覧が空になり、throw の診断が原因を示せなくなる。
  const cols = [fakeCollection("8", "All Images", 614), fakeCollection("13", "Denoised", -1)];
  const { C1 } = fakeCollectionsDoc(cols);
  const cands = M.collectCollectionCandidates(C1);
  assert.equal(cands.length, 2);
  assert.equal(cands[1].name, "Denoised");
  assert.equal(cands[1].count, -1);
});

test("collectCollectionCandidates: 名前を読めない候補は ? で残す", () => {
  const cols = [fakeCollection("13", null, 22)];
  const { C1 } = fakeCollectionsDoc(cols);
  const cands = M.collectCollectionCandidates(C1);
  assert.equal(cands.length, 1);
  assert.equal(cands[0].id, "13");
  assert.equal(cands[0].name, "?");
  assert.equal(cands[0].count, 22);
});

test("candidateEntries: 診断用の label / count へ射影する(-1 の候補も残す)", () => {
  const candidates = [
    { collection: "C0", id: "8", name: "All Images", count: 614, coverage: 0 },
    { collection: "C1", id: "13", name: "?", count: -1, coverage: 0 },
  ];
  assertPlainEqual(M.candidateEntries(candidates), [
    { label: "All Images", count: 614 },
    { label: "?", count: -1 },
  ]);
  assertPlainEqual(M.candidateEntries([]), []);
});

// readCollectionContents 検査用の最小 fake。この関数が使うのは複数形アクセス
// (collection.variants.name / collection.variants.parentImage.name)だけなので、
// 実機の specifier のように関数化する必要はない(関数にすると name が Function.name と
// 衝突して defineProperty が要る)。タスク 9 が同名のヘルパ fakeCollection を先に定義済みの
// ため、こちらは fakeContentsCollection と別名にする(ESM のトップレベル関数宣言が重複すると
// SyntaxError でテストファイル全体がパースできず、全件 0 実行になる)。
function fakeContentsCollection(names, imageNames) {
  return {
    variants: {
      name: () => names,
      parentImage: { name: () => imageNames },
    },
  };
}

// coverageOf が受け取る contents は readCollectionContents が返す null-proto オブジェクト。
// 通常の {} で作ると base==="constructor" が Object.prototype へ解決されて実装より緩い
// 前提でテストしてしまうため、テスト側も同じ形で作る。
function makeContents(map) {
  const contents = Object.create(null);
  for (const key of Object.keys(map)) contents[key] = map[key];
  return contents;
}

// CollectionCandidate の最小形(pickBestCandidateIndex が見るのは coverage と count だけ)。
function candidate(name, count, coverage) {
  return { collection: name, id: name, name: name, count: count, coverage: coverage };
}

test("readCollectionContents: baseName ごとに parentImage 拡張子を出現順で集める", () => {
  const col = fakeContentsCollection(
    ["IMG1234", "IMG1234", "IMG9999"],
    ["IMG1234.ARW", "IMG1234.JPG", "IMG9999.dng"],
  );
  const contents = M.readCollectionContents(col);
  // vm realm の配列なので Array.from で main realm へ写してから比較する。
  assert.deepEqual(Array.from(contents["img1234"]), ["arw", "jpg"]);
  assert.deepEqual(Array.from(contents["img9999"]), ["dng"]);
  assert.equal(contents["nope"], undefined);
});

test("readCollectionContents: 一括読みが throw したら null(検査失敗・例外は投げない)", () => {
  const broken = {
    variants: {
      name: () => {
        throw new Error("AX error");
      },
      parentImage: { name: () => [] },
    },
  };
  assert.equal(M.readCollectionContents(broken), null);
  // variants を持たない候補でも throw せず null を返す。
  assert.equal(M.readCollectionContents({}), null);
});

test("readCollectionContents: 名前と拡張子の件数が食い違えば null(添字対応が壊れている)", () => {
  // 肝: 件数不一致のまま索引化すると別 variant の拡張子と組み合わさり coverage が嘘になる。
  assert.equal(M.readCollectionContents(fakeContentsCollection(["A", "B"], ["A.jpg"])), null);
});

test("readCollectionContents: 読めない要素はその添字だけ落とし、後続の対応をずらさない", () => {
  const col = fakeContentsCollection(
    ["IMG1", null, "", "IMG4"],
    ["IMG1.arw", "IMG2.jpg", "IMG3.jpg", "IMG4.dng"],
  );
  const contents = M.readCollectionContents(col);
  assert.deepEqual(Array.from(contents["img1"]), ["arw"]);
  // 肝: 添字を詰める実装だと img4 が "jpg" を拾って FAIL する(変異検出)。
  assert.deepEqual(Array.from(contents["img4"]), ["dng"]);
  // 読めなかった添字はキーごと現れない(null を "null" として索引化しない)。
  assert.deepEqual(Object.keys(contents).sort(), ["img1", "img4"]);
});

test("readCollectionContents: parentImage 名が空文字の添字も落とす", () => {
  const contents = M.readCollectionContents(fakeContentsCollection(["IMG5"], [""]));
  assert.deepEqual(Object.keys(contents), []);
});

test("readCollectionContents: constructor/__proto__ 名でもクラッシュしない(Object.create(null) を pin)", () => {
  // {} に戻すと base in contents が誤って真になり push が TypeError -> catch で null になる。
  // その結果この assert が TypeError で FAIL する(変異検出)。
  const col = fakeContentsCollection(
    ["constructor", "__proto__"],
    ["constructor.dng", "__proto__.jpg"],
  );
  const contents = M.readCollectionContents(col);
  assert.deepEqual(Array.from(contents["constructor"]), ["dng"]);
  assert.deepEqual(Array.from(contents["__proto__"]), ["jpg"]);
});

test("coverageOf: 対象拡張子と JPEG が同居する baseName だけを数える", () => {
  const contents = makeContents({
    img1: ["arw", "jpg"],
    img2: ["arw"],
    img3: ["jpg"],
    img4: ["dng", "jpeg"],
  });
  // 肝: && を || に緩めると 4 になり FAIL する(変異検出)。
  assert.equal(M.coverageOf(contents, ["img1", "img2", "img3", "img4"], ["dng", "arw"], ["jpg", "jpeg"]), 2);
});

test("coverageOf: 索引に無い baseName と空の対象は 0", () => {
  const contents = makeContents({ img1: ["arw", "jpg"] });
  assert.equal(M.coverageOf(contents, ["nope"], ["dng", "arw"], ["jpg", "jpeg"]), 0);
  assert.equal(M.coverageOf(contents, [], ["dng", "arw"], ["jpg", "jpeg"]), 0);
});

test("coverageOf: 片側だけのコレクションは 0(JPEG のみ / 対象のみ)", () => {
  // References 相当(jpg のみ)と Denoised 相当(dng のみ)はどちらも coverage 0。
  const jpegOnly = makeContents({ img1: ["jpg"], img2: ["jpg"] });
  const targetOnly = makeContents({ img1: ["dng"], img2: ["dng"] });
  assert.equal(M.coverageOf(jpegOnly, ["img1", "img2"], ["dng"], ["jpg"]), 0);
  assert.equal(M.coverageOf(targetOnly, ["img1", "img2"], ["dng"], ["jpg"]), 0);
});

test("coverageOf: contents が null なら -1(検査失敗の番兵。0 と弁別する)", () => {
  // 肝: -1 を 0 に丸めると「検査できなかった」と「同居が無い」が同点になり、
  // pickBestCandidateIndex の件数フォールバックが効かなくなる。
  assert.equal(M.coverageOf(null, ["img1"], ["dng"], ["jpg"]), -1);
});

test("pickBestCandidateIndex: coverage 最大を選ぶ(件数最大とは限らない)", () => {
  // 実測セッション相当: References(jpg のみ・294)/ Denoised(dng のみ)/ All Images(614)。
  // 肝: 件数を先に見る実装や、タイブレークで coverage 非同値を潰さない実装だと
  // All Images(添字 2)を返して FAIL する(変異検出)。
  const candidates = [
    candidate("References", 294, 0),
    candidate("Denoised", 22, 3),
    candidate("All Images", 614, 0),
  ];
  assert.equal(M.pickBestCandidateIndex(candidates), 1);
});

test("pickBestCandidateIndex: coverage 同値は variant 数最大でタイブレークする", () => {
  const candidates = [
    candidate("Five Stars", 252, 5),
    candidate("All Images", 614, 5),
    candidate("Selects", 148, 2),
  ];
  assert.equal(M.pickBestCandidateIndex(candidates), 1);
});

test("pickBestCandidateIndex: coverage が全 0 なら件数最大(coverage 導入前と同じ選定)", () => {
  const candidates = [
    candidate("Selects", 148, 0),
    candidate("All Images", 614, 0),
    candidate("Capture", 146, 0),
  ];
  assert.equal(M.pickBestCandidateIndex(candidates), 1);
});

test("pickBestCandidateIndex: 検査が全滅(coverage 全 -1)でも件数最大で選ぶ", () => {
  // 肝: 一括読みが使えない環境でも coverage 導入前の選定へ落ちる。フォールバックを外すと
  // -1 が返り「切替先を決められません」で止まって FAIL する(変異検出)。
  const candidates = [candidate("Selects", 148, -1), candidate("All Images", 614, -1)];
  assert.equal(M.pickBestCandidateIndex(candidates), 1);
});

test("pickBestCandidateIndex: coverage 最大の候補が件数を読めなくても選ぶ", () => {
  // 肝: 件数の番兵 -1 だけを理由に、検査できた候補を候補ごと捨てない。
  const candidates = [candidate("All Images", 614, 0), candidate("Broken", -1, 4)];
  assert.equal(M.pickBestCandidateIndex(candidates), 1);
});

test("pickBestCandidateIndex: 候補なし / 全滅は -1、完全同値は先勝ち", () => {
  assert.equal(M.pickBestCandidateIndex([]), -1);
  assert.equal(M.pickBestCandidateIndex([candidate("X", -1, -1), candidate("Y", -1, -1)]), -1);
  assert.equal(M.pickBestCandidateIndex([candidate("A", 10, 2), candidate("B", 10, 2)]), 0);
});

test("pickBestCandidateIndex: coverage が全 0 で件数も全滅なら -1(診断契約を維持する)", () => {
  // 肝: 「どのコレクションも件数を読めなければ『切替先のコレクションを決められません』で
  // throw する」という現行の診断契約を coverage 導入で静かに壊さない。coverage 0 は
  // 「同居が 1 件も無い」であって選ぶ根拠にはならないので、件数も読めなければ選定を諦める。
  // coverage が 1 以上なら件数不明でも選ぶ(その対照は「coverage 最大の候補が件数を
  // 読めなくても選ぶ」が持つ)。
  assert.equal(M.pickBestCandidateIndex([candidate("A", -1, 0), candidate("B", -1, 0)]), -1);
});

// ensureWorkingCollection が pickBestCandidateIndex を実際に呼んでいることの配線テスト。
// タスク 9 が callableSpecifier 化した fakeCollection の第 4 / 第 5 引数(names / imageNames)で
// その候補の一括読みが返す variant 名と parentImage 名を与える。この 2 引数を省略した候補
// (タスク 9 の characterization テスト 4 件)は一括読みが undefined を返すので
// readCollectionContents が null -> coverage -1 になり、件数フォールバックで従来と同じ選定になる。
test("ensureWorkingCollection: 件数最大ではなく coverage 最大のコレクションへ切り替える", () => {
  // References 相当: 参照 JPEG だけが並ぶ大きなコレクション(294 件・対象の DNG は居ない)。
  // Denoised 相当: 対象の DNG と同名 JPEG が同居する小さなコレクション(22 件)。
  // 肝: pickBestCandidateIndex(candidates) を件数最大へ戻すと References(添字 0)へ
  // 切り替わって FAIL する(変異検出)。
  const references = fakeCollection("11", "References", 294, ["IMG1234"], ["IMG1234.jpg"]);
  const denoised = fakeCollection(
    "13",
    "Denoised",
    22,
    ["IMG1234", "IMG1234"],
    ["IMG1234.dng", "IMG1234.jpg"],
  );
  const { C1, doc, calls } = fakeCollectionsDoc([references, denoised], { currentId: "3" });
  M.ensureWorkingCollection(C1, [WORK_ITEM]);
  assert.equal(doc.currentCollection, denoised);
  assert.deepEqual(calls.selected, ["V_TARGET"]);
});

// collectionSwitchVerdict: コレクション切替の判定を 3 値で返す純粋関数。早期 return(既に
// 切替先を見ている)の判定と、切替後の着地検証の両方がこの 1 本を読む。判定規則を 2 本の関数へ
// 分けると片方だけ緩む drift が起きるため、規則をここで pin する。
test("collectionSwitchVerdict: id が一致すれば ok", () => {
  assert.equal(M.collectionSwitchVerdict("8", "8"), "ok");
  // セッション標準のお気に入りは連番でなく語彙の id を持つ(trash / selects / output / capture)。
  assert.equal(M.collectionSwitchVerdict("selects", "selects"), "ok");
});

test("collectionSwitchVerdict: id が異なれば mismatch", () => {
  // 肝: 一致判定を常に "ok" へ倒す変異でここが FAIL する(変異検出)。
  assert.equal(M.collectionSwitchVerdict("8", "11"), "mismatch");
  assert.equal(M.collectionSwitchVerdict("11", "8"), "mismatch");
});

test("collectionSwitchVerdict: どちらかが空文字なら unverified(mismatch より優先)", () => {
  // 肝 1: 空文字ガードを落とすと ("", "") が "ok" になり、id をどちらも読めない状態で
  //       早期 return が誤発火する(切替せずに処理へ入る)。
  assert.equal(M.collectionSwitchVerdict("", ""), "unverified");
  // 肝 2: ガードを || から && へ緩めると片側だけ空のときに "mismatch" になり、
  //       「id を読めないだけ」で切替を失敗として止めてしまう(変異検出)。
  assert.equal(M.collectionSwitchVerdict("8", ""), "unverified");
  assert.equal(M.collectionSwitchVerdict("", "8"), "unverified");
});

// ============ ensureWorkingCollection への配線(collectionSwitchVerdict)============
// fake はタスク 9 が追加した fakeCollection / fakeCollectionsDoc / WORK_ITEM をそのまま使う
// (新しい fake を作らない)。この fake はコレクションの中身を読めないので coverage は全候補で
// 同点になり、pickBestCandidateIndex は件数フォールバックで件数最大(添字 1)を選ぶ。
// landingId を渡さない場合、切替代入後の doc.currentCollection は代入した値そのものになり
// 呼び出せない(= 着地 id を読めない)ので、着地検証は unverified になる。

test("ensureWorkingCollection: currentId を読めなくても切替へ進み、着地 id 不明でも止めない", () => {
  // 肝 1: 早期 return を === "ok" から !== "mismatch" へ緩めると、id を読めない環境で
  //       切替せずに処理へ入る。切替代入が起きず currentCollection が fake の getter 関数の
  //       ままになるのでここが FAIL する(変異検出)。
  // 肝 2: 着地検証を === "mismatch" から !== "ok" へ緩めると、着地 id を読めないこの経路で
  //       throw してしまい、ここが「コレクションの切替が着地しませんでした」で FAIL する。
  const cols = [fakeCollection("3", "Capture", 146), fakeCollection("8", "All Images", 614)];
  const { C1, doc, calls } = fakeCollectionsDoc(cols, { currentId: "" });
  M.ensureWorkingCollection(C1, [WORK_ITEM]);
  assert.equal(doc.currentCollection, cols[1]);
  // 着地 id が読めなくても select 安全弁まで到達する(id を読めないこと自体は失敗ではない)。
  assert.deepEqual(calls.selected, ["V_TARGET"]);
});

test("ensureWorkingCollection: 切替後の id が期待と違えば候補一覧を添えて throw する", () => {
  // 肝: landedId を読み直さず currentId を使い回すと、文面の id が着地後の 99 ではなく
  //     切替前の 3 になってここが FAIL する(変異検出)。
  const cols = [fakeCollection("3", "Capture", 146), fakeCollection("8", "All Images", 614)];
  const { C1, calls } = fakeCollectionsDoc(cols, { currentId: "3", landingId: "99" });
  assert.throws(
    () => M.ensureWorkingCollection(C1, [WORK_ITEM]),
    (e) => {
      assert.match(e.message, /^コレクションの切替が着地しませんでした。/);
      assert.match(e.message, /切替先「All Images」\(id=8\)/);
      assert.match(e.message, /現在のコレクションは id=99 です/);
      assert.match(e.message, /候補: Capture\(146\), All Images\(614\)$/);
      return true;
    },
  );
  // 着地検証は select 安全弁より前で止める(誤ったコレクションで対象に触らない)。
  assert.deepEqual(calls.selected, []);
});
