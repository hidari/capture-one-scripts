// JXA の使用面のみを最小 ambient 宣言する。C1 / System Events の動的ツリーは any 運用。
declare function delay(seconds: number): void;

// ObjC ブリッジ(ネイティブ file I/O 用)。do shell script は C1 のサンドボックスで
// -10004 になるためシェルを介さず書き込む。動的なので any 運用。
declare const $: any;
declare const ObjC: { import(name: string): void };

interface StandardApp {
  includeStandardAdditions: boolean;
  doShellScript(cmd: string): string;
  displayDialog(
    text: string,
    opts?: { withTitle?: string; buttons?: string[]; defaultButton?: string },
  ): unknown;
  activate(): void;
  systemAttribute(name: string): string;
}

declare const Application: {
  currentApplication(): StandardApp;
  // Capture One / System Events は動的ツリー。使用面だけ最小 interface に絞る。
  (name: string): any;
};

// Capture One（辞書スクリプティング）の使用面だけ最小宣言。
// currentDocument 等は any 経由で動的アクセスするため、実注釈が効くのは C1Variant のみ。
interface C1Variant {
  name(): string;
  parentImage(): { name(): string };
  selected: boolean;
}
