# Components V2 運用メモ（表示モダン化監査 §4.3 の前提作業記録）

監査レポート `ephemeral-embed-v2-audit-2026-11-05` の前提項目 #14〜#16 の調査結果と、
V2 深化に着手する際の不変条件をまとめる。

## #15 V2 標準化 Revert（6bdd0de）の経緯

- 元変更: コミット `5a5c669`「fix: standardize interactive panels on components v2」
  （PR #178、2026-10-21 マージ）。内容は、game のルール/ランキング/レート表示、
  help のコマンド詳細、support の設定画面などを一律 `as_embed_v2()` 化し、
  パネル遷移を無条件に `edit_panel_v2` 経由に統一するものだった。
- Revert: コミット `6bdd0de`（PR #181）。PR #181 の本文は「Reverts deshihito/BOT#178」
  のみで、**理由は PR・コミットメッセージのどちらにも記録されていない**。
  作成からマージまで約11秒で、オーナーが GitHub の Revert 導線で即時判断した形跡がある
  （実機確認で何らかの不具合・表示問題を見て即戻した、と推測されるが根拠はタイミングのみ）。
- Revert の実質的な差分が示すもの: 一律 V2 化が戻され、現在の形
  「**入口が V2 パネル文脈のときだけ `edit_panel_v2` を使い、そうでない入口
  （ショートカット等の通常メッセージ文脈）では従来の embed+View 編集に戻す**」
  という条件分岐（`cogs/game.py` の `hasattr(container, "panel")` 判定、
  `cogs/help.py` の `v2` フラグ等）が残った。つまり戻されたのは V2 そのものではなく
  「文脈を問わない一律適用」だった。
- 教訓（再挑戦時のルール）:
  1. V2 化はパネル単位で絞って入れ、一律標準化はしない。
  2. V2 でない入口（メッセージショートカット等）から到達する画面に、
     文脈確認なしに V2 編集を適用しない。
  3. embed のみの応答を `as_embed_v2()` で包む変更は、対象を個別に選ぶ。

## #16 PR-B / PR-A の不変条件チェックリスト（V2 深化の着手前に毎回確認）

panel_recovery（PR-B、PR #423）と voice_restore（PR-A、PR #419）を壊さないための条件。

- [ ] 固定 custom_id `panel:<root>:<part>` 33件（general 3 / vc 2 / support 3 /
      game 16 / help 9）の文字列を一切変更していない。
- [ ] ネイティブ LayoutView 化した root がある場合、`cogs/panel_recovery.py` の
      `build_panel()` 結果に `as_panel_v2()` を二重に適用しない分岐を用意した
      （ラッパー方式のままの root は無条件で従来通りでよい）。
- [ ] panel_recovery の開き直しは ephemeral のまま維持した
      （公開パネル化した結果表示に操作部品が付く場合は、項目10の
      interaction_check 点検とセットで扱う。ルートパネル自体は公開化しない）。
- [ ] PR-A はスナップショットがメッセージ ID ベース（`core/music/restore.py`）で
      ペイロード非依存であることを確認した。音楽パネルの V2 深化はこの前提の
      範囲では無競合。
- [ ] V2 メッセージに `content` / 従来 `embeds` を同居させていない
      （編集時は `edit_panel_v2` / `edit_message_v2` 経由で旧ペイロードを消す）。

## #14 Pi 実環境の discord.py バージョン

- **未確認**（2026-11-06 時点）。確認には Discord 擬似ターミナルでの
  `pip show discord.py` 等が必要で、本作業の対象外とした。
- リポジトリ側は開発前提に合わせて `requirements.txt` を `discord.py==2.7.1` に
  固定した（項目 #13）。ただし Pi の `update.sh` は pip を実行しないため、
  この固定は Pi 側のパッチ適用までは稼働中 Bot に影響しない。
  実環境が 2.7.1 と乖離していないかは、パッチ適用時に併せて確認すること。

## #17 ローカライズの V2 実地検証（結果）

- `core/localization.py` の `_translate_view` が LayoutView / Container /
  TextDisplay / ActionRow 内ボタンを翻訳できることをテストで確認した
  （`tests/test_localization.py` の `LocalizationV2ViewTest`）。
- 検証で見つけた欠落: `ui.Section` の **accessory**（ボタン等）は走査対象外で
  ラベルが翻訳されなかったため、`_translate_view` の走査に `accessory` を追加した。
- MediaGallery の各 item は `items` 経由で走査され、`description` 属性が
  翻訳対象に含まれる。永続 View（add_view 登録の server_assist 公開パネル）と
  V2 の相性は未検証のため、それらが済むまで当該パネルの V2 化は対象外とする。
