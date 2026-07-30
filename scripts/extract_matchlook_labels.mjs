#!/usr/bin/env node
// Capture One のアプリバンドルから Match Look メニュー項目のラベルを全言語ぶん抽出する。
// CONFIG.matchLookLabels へ貼れる TypeScript 断片を標準出力へ書く。
// 使い方: node scripts/extract_matchlook_labels.mjs [/path/to/Capture One.app]
//
// 抽出元は各 <lang>.lproj/COLocalizedStrings.strings。キーは言語非依存で、
// C1 のキーボードショートカットエディタ用の文字列がメニュー項目のラベルと一致する
// (ja は現行 CONFIG と、en は実機メニューと一致することを実測で確認済み)。

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const APP = process.argv[2] || "/Applications/Capture One.app";
const RES = join(APP, "Contents", "Resources");

const KEYS = {
  setReference: "SET_AI_COLOR_GRADE_REFERENCE_COMMAND",
  apply: "APPLY_AI_COLOR_GRADE_COMMAND",
};

// "KEY" = "値"; の行だけを拾う。コメント行と空行は無視される。
const LINE = /^"([A-Z0-9_]+)"\s*=\s*"(.*)";\s*$/;

function collect() {
  let dirs;
  try {
    dirs = readdirSync(RES);
  } catch (e) {
    throw new Error("Capture One のリソースを読めません: " + RES);
  }
  const lprojs = dirs.filter((d) => d.endsWith(".lproj")).sort();
  // en を先頭へ置く(既定言語を候補の先頭にし、英語 UI での照合を最短にする)。
  const ordered = lprojs
    .filter((d) => d === "en.lproj")
    .concat(lprojs.filter((d) => d !== "en.lproj"));

  const out = { setReference: [], apply: [] };
  const seen = { setReference: new Set(), apply: new Set() };
  for (const dir of ordered) {
    const path = join(RES, dir, "COLocalizedStrings.strings");
    if (!existsSync(path)) continue;
    for (const raw of readFileSync(path, "utf8").split("\n")) {
      const m = LINE.exec(raw.trim());
      if (!m) continue;
      if (!m[2]) continue; // 空値("")はメニュー項目名になり得ないため候補に含めない
      for (const field of Object.keys(KEYS)) {
        if (m[1] !== KEYS[field]) continue;
        if (seen[field].has(m[2])) continue;
        seen[field].add(m[2]);
        out[field].push(m[2]);
      }
    }
  }
  return out;
}

function emit(labels) {
  const fmt = (list) => list.map((s) => "      " + JSON.stringify(s) + ",").join("\n");
  return [
    "  matchLookLabels: {",
    "    setReference: [",
    fmt(labels.setReference),
    "    ],",
    "    apply: [",
    fmt(labels.apply),
    "    ],",
    "  },",
  ].join("\n");
}

const labels = collect();
if (!labels.setReference.length || !labels.apply.length) {
  console.error(
    "ラベルを抽出できませんでした。C1 のバージョンでキー名が変わった可能性があります: " +
      Object.values(KEYS).join(" / "),
  );
  process.exit(1);
}
console.log(emit(labels));
