# assets/fonts

MIQ（引用画像）や各種画像描画で使うフォントを置くフォルダです。
同梱フォントの一覧とライセンスは `licenses/` フォルダに入っています。

## 使い方

1. フォントファイル（`.ttf` / `.otf` / `.ttc`）をこのフォルダに入れます。
2. Bot を再起動します。
3. `/general` → 引用画像 (MIQ) → MIQ設定のフォント選択に、入れたフォントが出ます。

コードを変更する必要はありません。ファイル名がそのまま選択肢の表示名になります。
フォントを追加した場合は、そのフォントのライセンスファイルも
`licenses/` に一緒に置いてください。

## 注意

- パスは小文字の `assets/fonts/` です。`Assets/`（大文字）とは別物です。
- 日本語に対応していないフォントは、□ 防止のため選択肢に出ません。
- フォントが1つも見つからない場合は、リポジトリ同梱の `font.ttf`
  （Hachi Maru Pop）がフォールバックとして使われます。

## 同梱フォントとライセンス

- 18フォント（Bruno Ace SC / Castoro Titling / Dancing Script /
  Dela Gothic One / Dot Gothic 16 / Exo 2 / Hachi Maru Pop /
  Inconsolata / M PLUS Rounded 1c / Noto Color Emoji / Poltawski Nowy /
  Rampart One / Reggae One / RocknRoll One / Vina Sans / Yuji Syuku /
  Yusei Magic / Zen Old Mincho）は SIL Open Font License 1.1 です。
  各フォントの著作権表示とライセンス全文は `licenses/<フォント名>-OFL.txt`
  にあります。リポジトリ直下の `font.ttf` は Hachi Maru Pop で、
  `licenses/HachiMaruPop-Regular-OFL.txt` がそのライセンスです。
- JiyunoTsubasa（自由の翼フォント）は旧 M+ FONT LICENSE 準拠です。
  条件は `licenses/JiyunoTsubasa-LICENSE.txt` を見てください。
