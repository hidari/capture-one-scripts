// JXA の使用面のみを最小 ambient 宣言する。C1 / System Events の動的ツリーは any 運用。
declare function delay(seconds: number): void;

// ObjC ブリッジ(ネイティブ file I/O 用)。do shell script は C1 のサンドボックスで
// -10004 になるためシェルを介さず書き込む。動的なので any 運用。
declare const $: any;
declare const ObjC: { import(name: string): void; unwrap(x: any): any };

// Capture One / System Events は名前で引く動的ツリーなので any 運用(使用面が動的すぎる)。
// currentApplication や StandardApp(doShellScript 等)は本体で未使用のため宣言しない。
// do shell script は C1 サンドボックスで -10004 になるため型語彙からも外して再導入を招かない。
declare const Application: (name: string) => any;

// Capture One（辞書スクリプティング）の使用面だけ最小宣言。
// currentDocument 等は any 経由で動的アクセスするため、実注釈が効くのは C1Variant のみ。
interface C1Variant {
  name(): string;
  parentImage(): { name(): string };
  selected: boolean;
}
