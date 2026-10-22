# AGO Coder 実装計画

## 目的

ダッシュボードから、OpenCodeの操作感を参考にしたエージェント型コーディング画面へ移動できるようにする。モデル実行はLogfareのサーバー側API経由に限定し、ブラウザへAPIキーを公開しない。

## デザイン

- **Design Movement**: OpenCodeのターミナル的な密度とIDEワークスペースの分割レイアウトを、AGOBOTの白地・青緑アクセントへ翻訳する。
- **Core Principles**: 状態が常に見える、操作を止めない、Plan/Buildを明確に分ける、危険操作は許可を明示する。
- **Color Philosophy**: 白と薄い灰色を作業面、濃いインク色をコード面、青緑を実行可能な状態、琥珀色を確認待ちに使う。
- **Layout Paradigm**: 左にセッション/ファイル文脈、中央に会話と作業ログ、右にモデル・権限・差分のインスペクターを置くワークスペース型。
- **Signature Elements**: セッションの状態ドット、Plan/Buildモード切替、実行ログの折りたたみ行。
- **Interaction Philosophy**: まず計画を見せ、Buildでは何を実行しているかを逐次表示する。権限はAllow/Ask/Denyで可視化する。
- **Typography**: UIは既存の日本語フォント、ログとモデル名は等幅フォント。
- **Brand Essence**: AGOBOTをDiscordボットから、作業を前へ進めるエージェントへ広げる。

## 実装範囲

- `/dashboard`にAGO Coderカードを追加。
- `/coder`にクライアントUIを追加。
- `/api/coder/run`でLogfare Chat Completionsをサーバー側から呼び出す。
- `/login`とDiscord OAuth開始・コールバックAPIを追加。
- ルートマニフェストを更新。
- GitHubコネクタは未設定時の案内を画面とドキュメントへ追加する。認証情報はコードやブラウザへ埋め込まない。
