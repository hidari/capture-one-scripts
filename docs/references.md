# References

## 実装関連
1. Capture One → Scripts → Open Scripting Dictionary で開ける辞書そのもの。
   - 今インストールしてる版に対して、クラス・プロパティ・コマンドが「scripting に露出しているか」は正確に確認できる（ただし辞書にあっても実際は動かないコマンドがある。動くかどうかは実機／公式フォーラムで要確認）。
   - 「未確認」だった Match Look やセッションの selects プロパティは、この辞書を全走査して確定済み（Match Look コマンドは無し / selects・trash・path は有り）。
   - Script Editorの Window → Library からCapture Oneを選んでも同じ辞書が見られます。
2. Capture One公式の [Scripting for Capture One / Workflow Automation with AppleScript](https://support.captureone.com/hc/en-us/articles/360002681418-Scripting-for-Capture-One)
   - 辞書の開き方、スクリプトの登録手順、新機能で追加されたコマンド（EXIF撮影日時の読み書きなど）の告知（JXAにも対応と明記）
3. 公式コミュニティの[スクリプティング用フォーラム](https://support.captureone.com/hc/en-us/community/topics/360000616838-Development-and-Automation-Workflows-Scripting)
   - 実運用のQ&Aや、辞書に載ってても実際は動かないコマンドの報告などが拾えて、ハマったときの一次情報として役立つ
4. [Ben Liddleの入門シリーズ](https://b-liddle.medium.com/getting-started-with-automating-capture-one-7870f2151d63)
   - 「Capture Oneは.scptをAS/JXA/AS-ObjCで実行できる」と明言していて、3言語を意識して書いてる数少ない資料
   - （同内容がこちらにも）https://shootmachine.co/2021/01/07/get-started-with-applescript/
5. [Late Night Software（DTコーディングシリーズ）](https://latenightsw.com/dt-coding-series-part-3-getting-started-with-applescript-for-capture-one/)
   - メタデータ入力やファイルリスト化など、実務的な例が中心のAppleScript入門
6. [alexonrawの無料スクリプト集＆解説](https://alexonraw.com/free-capture-one-scripts/)
   - 辞書の読み方や登録手順が画像付きで丁寧です。
7. [emorydunnのCaptureOneScripts](https://github.com/emorydunn/CaptureOneScripts)（GitHub）
   - 実際に動くAppleScript群で、バリアント選択・リネーム・アーカイブ移動あたりの書き方の参考に
   - ASですがJXAに翻訳する土台として優秀です。

## JXA向けの一般リファレンス

Capture One側のJXA専用ドキュメントはかなり薄いので、JXAの書き方自体はこっちで補う.

1. [JXA Cookbook](https://github.com/JXA-Cookbook/JXA-Cookbook/wiki)が定番
   - System Events操作・シェル連携・ObjCブリッジ・スクリプトのライブラリ化などが揃っている
2. Apple公式のMac Automation Scripting Guide / AppleScript Language Guide
   - 概念（Apple Event、オブジェクト指定の考え方）を押さえる
   - ASベースだが、辞書の読み解きに効く

使い分けとしては、「何ができるか（コマンド名・プロパティ名）」は必ずアプリ内辞書で確定させて、「JXAでどう書くか」はJXA Cookbook、という二本立てが実用的。
