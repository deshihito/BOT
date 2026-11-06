import discord
from core.game import game_panels, game_restore
from discord.ext import commands

from core import autoplay, party_ranking

party_ranking.register("uno")
import random
import asyncio
import logging

logger = logging.getLogger("cogs.uno")

SELECT_LIMIT = 25          # Discord のセレクトメニューの選択肢の上限
TURN_TIMEOUT = 180.0       # 手番の制限時間（秒）。過ぎたら自動で1枚引いてパス
COLOR_TIMEOUT = 30.0       # ワイルドの色選びの制限時間（秒）。過ぎたら自動で色を決める
COLORS = ['赤', '青', '黄', '緑']

# ==========================================
# 1. UNOのゲームロジック・データ管理クラス
# ==========================================
class UnoGame:
    def __init__(self, channel_id, host_id):
        self.channel_id = channel_id
        self.host_id = host_id
        self.players = []           # プレイヤーIDのリスト
        self.hands = {}             # {player_id: [カード文字列のリスト]}
        self.deck = []              # 山札
        self.discard_pile = []      # 捨て札
        self.current_player_idx = 0
        self.direction = 1          # 1: 正順, -1: 逆順
        self.is_started = False
        self.current_color = None   # ワイルド等で変更された現在指定されている色

        # 内部処理用
        self.active_panel_message = None  # 現在アクティブなコントロールパネルのDiscordメッセージ
        self.uno_declared = False         # 現ターンでUNO宣言が成功したか
        self.waiting_for_uno = False      # UNO宣言の猶予時間中か
        self.active_view = None           # 現在操作を受け付けているビュー（古いビューの時間切れを無視するため）
        self.timeout_streak = 0           # 時間切れが連続した回数（全員分続いたら放置とみなして終了）

        # プラスカード累積用
        self.pending_draw_count = 0       # 累積しているドロー枚数
        self.active_plus_type = None      # 現在累積中のカードタイプ ("+2" または "Wild+4")

    def setup_deck(self):
        colors = ['赤', '青', '黄', '緑']
        numbers = [str(i) for i in range(10)] + ['Skip', 'Reverse', '+2']
        specials = ['Wild', 'Wild+4']

        self.deck = []
        # 通常カードの追加
        for color in colors:
            for num in numbers:
                count = 1 if num == '0' else 2
                for _ in range(count):
                    self.deck.append(f"{color}の{num}")
        # ワイルドカードの追加
        for spec in specials:
            for _ in range(4):
                self.deck.append(spec)

        random.shuffle(self.deck)

    def draw_card(self, player_id, count=1):
        drawn = []
        for _ in range(count):
            if not self.deck:
                if len(self.discard_pile) > 1:
                    top_card = self.discard_pile.pop()
                    self.deck = self.discard_pile.copy()
                    self.discard_pile = [top_card]
                    random.shuffle(self.deck)
                else:
                    break # これ以上引けない
            if self.deck:
                drawn.append(self.deck.pop())
        self.hands[player_id].extend(drawn)
        return drawn

    def get_playable_cards(self, player_id):
        """ルール上、出すことができるカードを絞り込む"""
        hand = self.hands.get(player_id, [])
        playable = []

        if not self.discard_pile:
            return hand.copy()

        top_card = self.discard_pile[-1]

        # プラスカードが累積している場合は、同じプラスカードしか出せない（対抗ルール）
        if self.pending_draw_count > 0 and self.active_plus_type:
            for card in hand:
                if self.active_plus_type == "+2" and "+2" in card:
                    playable.append(card)
                elif self.active_plus_type == "Wild+4" and card == "Wild+4":
                    playable.append(card)
            return playable

        # 通常時の処理
        target_color = self.current_color

        top_color = None
        top_value = None
        if "の" in top_card:
            top_color, top_value = top_card.split("の")

        if target_color is None:
            target_color = top_color

        for card in hand:
            if card in ["Wild", "Wild+4"]:
                playable.append(card)
                continue

            if "の" in card:
                c_color, c_value = card.split("の")
                if c_color == target_color or c_value == top_value:
                    playable.append(card)

        return playable

    def next_turn_idx(self, steps=1):
        """次の手番のインデックスを計算する"""
        n = len(self.players)
        return (self.current_player_idx + self.direction * steps) % n

    def advance_turn(self, steps=1):
        self.current_player_idx = self.next_turn_idx(steps)


# ==========================================
# 2. UI コンポーネント (ボタン・セレクトメニュー)
# ==========================================

class JoinView(discord.ui.View):
    """参加受付用のビューパネル"""
    def __init__(self, game: UnoGame, cog):
        super().__init__(timeout=60.0)
        self.game = game
        self.cog = cog

    @discord.ui.button(label="参加する", style=discord.ButtonStyle.green, custom_id="uno_join_btn")
    async def join(self, interaction: discord.Interaction, button: discord.ui.Button):
        if self.game.is_started:
            return await interaction.response.send_message("既にゲームは開始されています。", ephemeral=True)
        if interaction.user.id in self.game.players:
            return await interaction.response.send_message("既に参加しています！", ephemeral=True)

        self.game.players.append(interaction.user.id)
        self.game.hands[interaction.user.id] = []

        embed = interaction.message.embeds[0]
        players_text = "\n".join([f"* <@{p_id}>" for p_id in self.game.players])
        embed.set_field_at(0, name=f"参加者 ({len(self.game.players)}人)", value=players_text, inline=False)

        await interaction.response.edit_message(embed=embed, view=self)

    @discord.ui.button(label="即時スタート", style=discord.ButtonStyle.blurple, custom_id="uno_force_start_btn")
    async def force_start(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.game.host_id:
            return await interaction.response.send_message("ホスト（部屋を建てた人）だけが即時スタートできます。", ephemeral=True)
        if self.game.is_started or self.cog.games.get(self.game.channel_id) is not self.game:
            return await interaction.response.send_message("この募集は既に開始または終了しています。", ephemeral=True)
        if len(self.game.players) < 2:
            return await interaction.response.send_message("開始するには最低2人のプレイヤーが必要です！", ephemeral=True)

        self.stop()
        await interaction.response.defer()
        await self.cog.start_uno_game(interaction.channel, self.game)

    @discord.ui.button(label="ゲームをキャンセル", style=discord.ButtonStyle.red, custom_id="uno_cancel_btn")
    async def cancel(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.game.host_id:
            return await interaction.response.send_message("ホスト（部屋を建てた人）だけがキャンセルできます。", ephemeral=True)

        self.stop()
        if self.cog.games.get(self.game.channel_id) is self.game:
            del self.cog.games[self.game.channel_id]
            self.cog._clear_snapshot(self.game.channel_id)

        await interaction.response.edit_message(content="[!] ゲームの募集がキャンセルされました。", embed=None, view=None)


class CardSelect(discord.ui.Select):
    """手番プレイヤーがカードを選択するセレクトメニュー"""
    def __init__(self, game: UnoGame, cards: list, cog, include_draw: bool = True, page: int = 1, pages: int = 1, row: int = None):
        self.game = game
        self.cog = cog

        # 値はカード名そのもの（同じカードが2枚あっても選ぶ意味は同じなので1つにまとめてある）
        options = [discord.SelectOption(label=str(card), value=str(card)) for card in cards]

        if include_draw:
            # 累積ペナルティがある場合は「パス」ではなく「累積枚数を引き取る」表記に変える
            if game.pending_draw_count > 0:
                label_text = f"カードを引く (計 {game.pending_draw_count} 枚)"
                value_text = "DRAW_PUNISH"
            else:
                label_text = "山札から1枚引く (パス)"
                value_text = "DRAW_PASS"
            options.append(discord.SelectOption(label=label_text, value=value_text))

        placeholder = "出すカードを選択してください..."
        if pages > 1:
            placeholder += f"（{page}/{pages}）"
        super().__init__(placeholder=placeholder, min_values=1, max_values=1, options=options, row=row)

    async def callback(self, interaction: discord.Interaction):
        current_player_id = self.game.players[self.game.current_player_idx]
        if interaction.user.id != current_player_id:
            return await interaction.response.send_message("あなたの番ではありません！", ephemeral=True)

        selected_card = self.values[0]
        if self.cog.games.get(self.game.channel_id) is not self.game:
            return await interaction.response.send_message("このゲームは既に終了しています。", ephemeral=True)
        if selected_card == "DRAW_PUNISH" and self.game.pending_draw_count <= 0:
            selected_card = "DRAW_PASS"
        elif selected_card == "DRAW_PASS" and self.game.pending_draw_count > 0:
            selected_card = "DRAW_PUNISH"
        if not selected_card.startswith("DRAW_") and selected_card not in self.game.get_playable_cards(current_player_id):
            return await interaction.response.send_message("そのカードは今は出せません。パネルが古い可能性があります。", ephemeral=True)
        await interaction.response.defer()
        self.game.timeout_streak = 0

        # ペナルティ（溜まったプラスカード）を引き受ける処理
        if selected_card == "DRAW_PUNISH":
            count = self.game.pending_draw_count
            self.game.draw_card(current_player_id, count)
            msg = f"[-] <@{current_player_id}> さんは対抗カードがないため、山札から {count} 枚引きました。"

            # 累積状態をリセットして次の人へ
            self.game.pending_draw_count = 0
            self.game.active_plus_type = None
            self.game.advance_turn()
            await self.cog.send_game_panel(interaction.channel, self.game, info_msg=msg)
            return

        # 通常の1枚ドロー（パス）処理
        if selected_card == "DRAW_PASS":
            drawn = self.game.draw_card(current_player_id, 1)
            drawn_str = drawn[0] if drawn else "なし"

            # ワイルドで指定された色は、引いてパスしても引き継ぐ（ここで消すと指定色が失われる）
            playable_now = self.game.get_playable_cards(current_player_id)

            if drawn and drawn[0] in playable_now:
                msg = f"[-] <@{current_player_id}> さんは山札から1枚引きました（{drawn_str}）。出せる状態ですがパスしました。"
            else:
                msg = f"[-] <@{current_player_id}> さんは出せるカードがないため、山札から1枚引きました。"

            self.game.advance_turn()
            await self.cog.send_game_panel(interaction.channel, self.game, info_msg=msg)
            return

        # カードを出す処理
        self.game.hands[current_player_id].remove(selected_card)
        self.game.discard_pile.append(selected_card)
        self.game.current_color = None

        hand_len = len(self.game.hands[current_player_id])
        uno_penalty_check = False

        if hand_len == 1:
            uno_penalty_check = True
            self.game.uno_declared = False
            self.game.waiting_for_uno = True
            asyncio.create_task(self.cog.uno_declaration_timer(interaction.channel, self.game, current_player_id))

        action_msg = f"[+] <@{current_player_id}> さんが [{selected_card}] を出しました！"

        # ワイルドカード（Wild / Wild+4）の処理
        if selected_card in ["Wild", "Wild+4"]:
            if selected_card == "Wild+4":
                self.game.pending_draw_count += 4
                self.game.active_plus_type = "Wild+4"

            view = WildColorView(self.game, selected_card, current_player_id, self.cog, action_msg, uno_penalty_check)
            if self.game.active_panel_message:
                try:
                    await self.game.active_panel_message.delete()
                except discord.NotFound:
                    pass

            if self.game.active_view is not None:
                self.game.active_view.stop()
            self.game.active_view = view
            self.game.active_panel_message = await game_panels.replace(interaction.channel, "party",
                content=f"<@{current_player_id}> さん、次の色を選択してください！（{int(COLOR_TIMEOUT)}秒以内）",
                view=view
            )
            # 色選択待ちもチェックポイントとして保存する（復旧時は色選択から再開）
            self.cog._save_snapshot(self.game, interaction.channel, awaiting_color={
                "player_id": current_player_id,
                "card_type": selected_card,
                "action_msg": action_msg,
                "uno_penalty": uno_penalty_check,
            })
            return

        # 通常カードおよびその他の特殊カード（+2など）の処理
        await self.process_card_effect(selected_card, action_msg)


    async def process_card_effect(self, card: str, base_msg: str):
        """カードの効果処理を行い、次のターンへ移行する"""
        current_player_id = self.game.players[self.game.current_player_idx]

        if len(self.game.hands[current_player_id]) == 0:
            await self.cog.finish_game(self.game.channel_id, current_player_id)
            return

        next_msg = ""

        if "Skip" in card:
            skipped_player = self.game.players[self.game.next_turn_idx(1)]
            next_msg = f"\n[!] <@{skipped_player}> さんのターンがスキップされました！"
            self.game.advance_turn(2)

        elif "Reverse" in card:
            if len(self.game.players) == 2:
                skipped_player = self.game.players[self.game.next_turn_idx(1)]
                next_msg = f"\n[<->] 2人プレイのため、<@{skipped_player}> さんのターンがスキップされました！"
                self.game.advance_turn(2)
            else:
                self.game.direction *= -1
                next_msg = f"\n[<->] 順番が逆回転になりました！"
                self.game.advance_turn(1)

        elif "+2" in card:
            self.game.pending_draw_count += 2
            self.game.active_plus_type = "+2"
            next_msg = f"\n[!] ドロー累積: 計 {self.game.pending_draw_count} 枚！ 次のプレイヤーは [+2] で対抗できます。"
            self.game.advance_turn(1) # 次のプレイヤーへ（出すか引くかの選択を委ねる）

        else:
            self.game.advance_turn(1)

        combined_msg = base_msg + next_msg
        await self.cog.send_game_panel(self.cog.bot.get_channel(self.game.channel_id), self.game, info_msg=combined_msg)


class WildColorView(discord.ui.View):
    """ワイルドカード使用時に色を選ぶボタン群"""
    def __init__(self, game: UnoGame, card_type: str, player_id: int, cog, action_msg: str, uno_penalty: bool):
        super().__init__(timeout=COLOR_TIMEOUT)
        self.chosen = False
        self.game = game
        self.card_type = card_type
        self.player_id = player_id
        self.cog = cog
        self.action_msg = action_msg
        self.uno_penalty = uno_penalty

    async def handle_color_choice(self, interaction: discord.Interaction, color: str):
        if interaction.user.id != self.player_id:
            return await interaction.response.send_message("あなたの選択パネルではありません！", ephemeral=True)
        if self.chosen or self.cog.games.get(self.game.channel_id) is not self.game:
            return await interaction.response.send_message("色は既に決まっています。", ephemeral=True)

        await interaction.response.defer()
        self.game.timeout_streak = 0
        await self.apply_color(interaction.channel, color)

    async def apply_color(self, channel, color: str, note: str = ""):
        self.chosen = True
        self.stop()
        self.game.current_color = color

        color_msg = f"\n[Color] 場の色が [{color}] に指定されました！{note}"
        effect_msg = ""

        if self.card_type == "Wild+4":
            effect_msg = f"\n[!] ドロー累積: 計 {self.game.pending_draw_count} 枚！ 次のプレイヤーは [Wild+4] で対抗できます。"

        self.game.advance_turn(1)

        if len(self.game.hands[self.player_id]) == 0:
            await self.cog.finish_game(self.game.channel_id, self.player_id)
            return

        combined_msg = self.action_msg + color_msg + effect_msg
        await self.cog.send_game_panel(channel, self.game, info_msg=combined_msg)

    async def on_timeout(self):
        """色を選ばないまま時間切れになったら、手札に一番多い色を自動で選ぶ"""
        if self.chosen or self.game.active_view is not self or self.cog.games.get(self.game.channel_id) is not self.game:
            return
        self.game.timeout_streak += 1
        hand = self.game.hands.get(self.player_id, [])
        counts = {c: sum(1 for card in hand if card.startswith(f"{c}の")) for c in COLORS}
        color = max(COLORS, key=lambda c: counts[c])
        channel = self.cog.bot.get_channel(self.game.channel_id)
        await self.apply_color(channel, color, note="（時間切れのため自動で選択）")

    @discord.ui.button(label="赤", style=discord.ButtonStyle.danger, custom_id="color_red")
    async def red(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.handle_color_choice(interaction, "赤")

    @discord.ui.button(label="青", style=discord.ButtonStyle.primary, custom_id="color_blue")
    async def blue(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.handle_color_choice(interaction, "青")

    @discord.ui.button(label="黄", style=discord.ButtonStyle.success, custom_id="color_yellow")
    async def yellow(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.handle_color_choice(interaction, "黄")

    @discord.ui.button(label="緑", style=discord.ButtonStyle.secondary, custom_id="color_green")
    async def green(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.handle_color_choice(interaction, "緑")


class GameControlView(discord.ui.View):
    """メインゲーム進行中、手番プレイヤーが使用する操作ビュー"""
    def __init__(self, game: UnoGame, playable_cards: list, cog):
        super().__init__(timeout=TURN_TIMEOUT)
        self.game = game
        self.cog = cog
        self.player_id = game.players[game.current_player_idx]

        # 同じカードは1つにまとめ、25件を超える場合はメニューを分ける（1つ目のメニューに「引く」を入れる）
        unique = list(dict.fromkeys(playable_cards))
        chunks = [unique[:SELECT_LIMIT - 1]]
        rest = unique[SELECT_LIMIT - 1:]
        while rest:
            chunks.append(rest[:SELECT_LIMIT])
            rest = rest[SELECT_LIMIT:]
        chunks = chunks[:4]  # 手札確認ボタンの行を残す（カードは最大54種類なので4行で足りる）
        for i, chunk in enumerate(chunks):
            self.add_item(CardSelect(game, chunk, cog, include_draw=(i == 0), page=i + 1, pages=len(chunks), row=i))

    async def on_timeout(self):
        """手番のプレイヤーが時間内に操作しなかったら、自動で引いてパスする。全員分続いたら放置とみなして終了。"""
        game = self.game
        if game.active_view is not self or self.cog.games.get(game.channel_id) is not game:
            return
        if game.players[game.current_player_idx] != self.player_id:
            return
        channel = self.cog.bot.get_channel(game.channel_id)
        game.timeout_streak += 1
        if game.timeout_streak >= max(2, len(game.players)):
            await self.cog.end_game(game, reason="[!] 操作のない状態が続いたため、UNOゲームを終了しました。")
            return
        if await self.cog.autoplay_turn(channel, game, self.player_id):
            return
        if game.pending_draw_count > 0:
            count = game.pending_draw_count
            game.draw_card(self.player_id, count)
            game.pending_draw_count = 0
            game.active_plus_type = None
            msg = f"[-] <@{self.player_id}> さんが時間切れのため、山札から {count} 枚引いてパスしました。"
        else:
            game.draw_card(self.player_id, 1)
            msg = f"[-] <@{self.player_id}> さんが時間切れのため、山札から1枚引いてパスしました。"
        game.advance_turn()
        await self.cog.send_game_panel(channel, game, info_msg=msg)

    @discord.ui.button(label="手札を確認", style=discord.ButtonStyle.secondary, custom_id="uno_check_hand_btn", row=4)
    async def check_hand(self, interaction: discord.Interaction, button: discord.ui.Button):
        """自分にだけ見えるメッセージで全手札の一覧を表示する"""
        user_hand = self.game.hands.get(interaction.user.id, [])
        if not user_hand:
            return await interaction.response.send_message("あなたはゲームに参加していないか、手札がありません。", ephemeral=True)

        hand_text = " / ".join([f"[{card}]" for card in user_hand])
        await interaction.response.send_message(f"あなたの現在の手札 ({len(user_hand)}枚):\n{hand_text}", ephemeral=True)




    # ==========================================
    # 4. UNO宣言システム (チャットイベント検知)
    # ==========================================
class UnoDeclareView(discord.ui.View):
    def __init__(self, game: UnoGame, player_id: int):
        super().__init__(timeout=5.0)
        self.game = game
        self.player_id = player_id

    @discord.ui.button(label="UNO!", style=discord.ButtonStyle.red)
    async def declare_uno(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.player_id:
            return await interaction.response.send_message(
                "あなたのUNOボタンではありません。",
                ephemeral=True
            )

        self.game.uno_declared = True

        button.disabled = True
        await interaction.response.edit_message(view=self)

        await interaction.followup.send(
            f"[!] <@{self.player_id}> さんの「UNO！」宣言が確認されました！"
        )




# ==========================================
# 3. Discord Bot Cog 本体
# ==========================================
class Uno(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.games = {} # {channel_id: UnoGame}

    async def autoplay_turn(self, channel, game: UnoGame, player_id: int) -> bool:
        """時間切れの手番を core/autoplay で代わりに進める。代打ちがオフなら False（元の「引いてパス」に任せる）。

        選べるのはワイルド以外の出せるカードと「引く」。d1 が使えないときは「引く」（元と同じ動き）。
        """
        playable = [c for c in dict.fromkeys(game.get_playable_cards(player_id)) if c not in ("Wild", "Wild+4")]
        legal = playable + ["DRAW"]
        member = channel.guild.get_member(player_id) if channel is not None and getattr(channel, "guild", None) else None
        name = member.display_name if member else f"<@{player_id}>"
        pending = game.pending_draw_count

        def describe(action):
            if action == "DRAW":
                return f"山札から {pending} 枚引いてパス" if pending > 0 else "山札から1枚引いてパス"
            return f"[{action}] を出"

        result = await autoplay.take_idle_turn(
            None, guild_id=getattr(getattr(channel, "guild", None), "id", None), player_name=name, game=game,
            state={"game": "uno", "hand": list(game.hands.get(player_id, [])),
                   "top": game.discard_pile[-1] if game.discard_pile else None,
                   "color": game.current_color, "pending_draw": pending,
                   "hand_counts": {str(p): len(game.hands.get(p, [])) for p in game.players}},
            legal_actions=legal,
            instructions="UNO の手番です。出すカードか、DRAW（山札から引いてパス）を 1 つ選んでください。",
            describe=describe, fallback="DRAW")
        if result is None:
            return False
        # d1 に聞いている間に誰かが操作していたら何もしない
        if self.games.get(game.channel_id) is not game or game.players[game.current_player_idx] != player_id:
            return True
        card = result.action
        if card != "DRAW" and card in game.get_playable_cards(player_id):
            game.hands[player_id].remove(card)
            game.discard_pile.append(card)
            game.current_color = None
            await CardSelect(game, [card], self).process_card_effect(card, result.notice)
            return True
        if pending > 0:
            game.draw_card(player_id, pending)
            game.pending_draw_count = 0
            game.active_plus_type = None
        else:
            game.draw_card(player_id, 1)
        game.advance_turn()
        await self.send_game_panel(channel, game, info_msg=result.notice)
        return True

    async def uno_declaration_timer(self, channel, game: UnoGame, player_id: int):
        view = UnoDeclareView(game, player_id)
        uno_msg = await game_panels.replace(channel, "party",
            f"<@{player_id}> さん、5秒以内にUNOを宣言してください！",
            view=view
        )

        await asyncio.sleep(5.0)

        try:
            for child in view.children:
                child.disabled = True

            await uno_msg.edit(view=view)
        except Exception:
            logger.debug("UNO: 宣言パネルの無効化に失敗しました", exc_info=True)

        if game.channel_id in self.games and len(game.hands.get(player_id, [])) == 1:
            if not game.uno_declared:
                drawn = game.draw_card(player_id, 1)
                drawn_str = f"（{drawn[0]}）" if drawn else ""

                await channel.send(
                    f"[!] ペナルティ！ <@{player_id}> さんは5秒以内に「UNO」の宣言がなかったため、山札から1枚引きました。{drawn_str}"
                )

                await self.send_game_panel(
                    channel,
                    game,
                    info_msg=f"[!] <@{player_id}> さんにUNO未宣言ペナルティが適用されました。"
                )

            game.waiting_for_uno = False
            game.uno_declared = False

    async def start_recruit(self, interaction: discord.Interaction):
        """募集を始める（/game のハブから呼ぶ）。interaction にはまだ応答していないこと。"""
        channel_id = interaction.channel_id

        if channel_id in self.games:
            return await interaction.response.send_message("[!] このチャンネルでは既にUNOゲームが進行中、または準備中です。", ephemeral=True)

        game = UnoGame(channel_id, interaction.user.id)
        game.players.append(interaction.user.id)
        game.hands[interaction.user.id] = []
        self.games[channel_id] = game

        embed = discord.Embed(
            title="[-] UNO 対戦ルーム",
            description="ゲームを開始するには2人以上のプレイヤーが必要です。\n1分後に自動的にゲームが開始されます。",
            color=discord.Color.gold()
        )
        embed.add_field(name=f"参加者 (1人)", value=f"* <@{interaction.user.id}>", inline=False)

        view = JoinView(game, self)
        await interaction.response.send_message("[+] UNOゲームの募集を開始しました！")
        game.active_panel_message = await game_panels.replace(interaction.channel, "party", embed=embed, view=view)

        await asyncio.sleep(60)
        view.stop()

        # キャンセル・終了後に同じチャンネルで新しく募集が建っていても、それは別のゲームなので触らない
        if self.games.get(channel_id) is game and not game.is_started:
            if len(game.players) >= 2:
                await self.start_uno_game(interaction.channel, game)
            else:
                del self.games[channel_id]
                try:
                    await game.active_panel_message.edit(content="[!] 参加人数が足りなかったため（最低2人）、ゲームの募集を終了しました。", embed=None, view=None)
                except discord.NotFound:
                    pass

    async def force_end(self, interaction: discord.Interaction):
        """/game の UNO 画面の「ゲームを終了」から呼ぶ。参加者・ホスト・管理者のみ（旧 /uno_end と同じ）。"""
        game = self.games.get(interaction.channel_id)
        if game is None:
            return await interaction.response.send_message("[!] このチャンネルで進行中のUNOゲームはありません。", ephemeral=True)
        perms = getattr(interaction.user, "guild_permissions", None)
        is_admin = bool(perms and (perms.administrator or perms.manage_guild))
        if interaction.user.id not in game.players and interaction.user.id != game.host_id and not is_admin:
            return await interaction.response.send_message("[!] UNOを終了できるのは参加者・ホスト・管理者だけです。", ephemeral=True)
        await interaction.response.send_message("[!] UNOゲームを終了します。")
        await self.end_game(game, reason=f"[!] <@{interaction.user.id}> さんがUNOゲームを終了しました。", channel=interaction.channel)

    async def end_game(self, game: UnoGame, reason: str, channel=None):
        """勝敗をつけずにゲームを終了し、チャンネルを空ける"""
        if self.games.get(game.channel_id) is game:
            del self.games[game.channel_id]
            self._clear_snapshot(game.channel_id)
        if game.active_view is not None:
            game.active_view.stop()
            game.active_view = None
        if game.active_panel_message:
            try:
                await game.active_panel_message.delete()
            except discord.HTTPException:
                logger.debug("UNO: 終了時のパネル削除に失敗しました", exc_info=True)
        channel = channel or self.bot.get_channel(game.channel_id)
        if channel is not None:
            await channel.send(reason)

    async def start_uno_game(self, channel, game: UnoGame):
        game.is_started = True
        game.setup_deck()

        for p_id in game.players:
            game.draw_card(p_id, 7)

        first_card = game.deck.pop()
        while first_card in ["Wild", "Wild+4"]:
            game.deck.insert(0, first_card)
            random.shuffle(game.deck)
            first_card = game.deck.pop()

        game.discard_pile.append(first_card)

        if "の" in first_card:
            game.current_color = first_card.split("の")[0]

        start_msg = f"[!] UNOゲームがスタートしました！\n最初の場カードは [{first_card}] です。"
        await self.send_game_panel(channel, game, info_msg=start_msg)

    async def send_game_panel(self, channel, game: UnoGame, info_msg: str = ""):
        """ターン進行用の総合ゲームパネルを送信する"""
        if game.active_panel_message:
            try:
                await game.active_panel_message.delete()
            except discord.NotFound:
                pass

        current_player_id = game.players[game.current_player_idx]
        playable_cards = game.get_playable_cards(current_player_id)

        current_top = game.discard_pile[-1]

        if game.current_color:
            active_color = game.current_color
        elif "の" in current_top:
            active_color = current_top.split("の")[0]
        else:
            # Wild系でcurrent_colorが未設定の場合は前の通常カード色を使う
            active_color = "未設定"

            for card in reversed(game.discard_pile[:-1]):
                if "の" in card:
                    active_color = card.split("の")[0]
                    break

        embed = discord.Embed(
            title="[-] UNO プレイ中",
            description=info_msg if info_msg else "各自カードを選択してゲームを進めてください。",
            color=self.get_embed_color(active_color)
        )
        embed.add_field(name="現在の場のカード", value=f"-> **[{current_top}]**", inline=True)
        embed.add_field(name="指定された色", value=f"Color: **[{active_color}]**", inline=True)

        # 累積がある場合は警告として埋め込みに表示
        if game.pending_draw_count > 0:
            embed.add_field(name="[警告] ドロー累積中", value=f"⚠️ 次の手番は **{game.pending_draw_count}枚** 累積しています！", inline=False)

        order_list = []
        for idx, p_id in enumerate(game.players):
            hand_count = len(game.hands[p_id])
            marker = ">> " if idx == game.current_player_idx else "* "
            order_list.append(f"{marker}<@{p_id}>: 手札 {hand_count}枚")

        embed.add_field(name="プレイヤー順", value="\n".join(order_list), inline=False)
        embed.set_footer(text=f"手番プレイヤーは下のセレクトメニューからカードを選択してください（{int(TURN_TIMEOUT // 60)}分以内。過ぎると自動で1枚引いてパス）。/game の UNO 画面の「ゲームを終了」で終了できます。")

        if game.active_view is not None:
            game.active_view.stop()
        view = GameControlView(game, playable_cards, self)
        game.active_view = view
        game.active_panel_message = await game_panels.replace(channel, "party", embed=embed, view=view)
        # 手番が確定した時点をチェックポイントとして保存する（復旧はここから再開する）
        self._save_snapshot(game, channel)

    # ------------------------------------------------------------------
    # 再起動復旧（core/game/game_restore.py）
    # ------------------------------------------------------------------
    def _save_snapshot(self, game: UnoGame, channel=None, awaiting_color=None) -> None:
        if not game.is_started:
            return
        guild = getattr(channel, "guild", None) if channel is not None else None
        state = {
            "host_id": game.host_id,
            "players": [int(p) for p in game.players],
            "hands": [[int(pid), list(cards)] for pid, cards in game.hands.items()],
            "deck": list(game.deck),
            "discard_pile": list(game.discard_pile),
            "current_player_idx": game.current_player_idx,
            "direction": game.direction,
            "current_color": game.current_color,
            "pending_draw_count": game.pending_draw_count,
            "active_plus_type": game.active_plus_type,
            "timeout_streak": game.timeout_streak,
            "panel_message_id": getattr(game.active_panel_message, "id", None),
            "awaiting_color": awaiting_color,
        }
        game_restore.save_session("uno", game.channel_id,
                                  getattr(guild, "id", None), state)

    def _clear_snapshot(self, channel_id) -> None:
        game_restore.clear_session("uno", channel_id)

    async def restore_after_restart(self) -> None:
        """再起動前に進行中だった UNO を、現在の手番（または色選択）から再開する。"""
        entries = game_restore.session_entries("uno")
        for channel_id, entry in entries.items():
            try:
                restored = await self._restore_session(channel_id, entry)
            except Exception:
                logger.exception("channel %s: UNO の復旧に失敗しました", channel_id)
                restored = False
            if not restored:
                game_restore.clear_session("uno", channel_id)
        game_restore.flush_store()

    async def _restore_session(self, channel_id, entry) -> bool:
        state = entry.get("state")
        if not isinstance(state, dict) or channel_id in self.games:
            return False
        channel = self.bot.get_channel(channel_id)
        if channel is None:
            return False
        players = [int(p) for p in state.get("players") or []]
        discard_pile = list(state.get("discard_pile") or [])
        if len(players) < 2 or not discard_pile:
            return False
        game = UnoGame(channel_id, state.get("host_id"))
        game.is_started = True
        game.players = players
        game.hands = {int(pid): list(cards) for pid, cards in state.get("hands") or []}
        game.deck = list(state.get("deck") or [])
        game.discard_pile = discard_pile
        idx = int(state.get("current_player_idx") or 0)
        game.current_player_idx = idx if 0 <= idx < len(players) else 0
        game.direction = -1 if state.get("direction") == -1 else 1
        game.current_color = state.get("current_color")
        game.pending_draw_count = int(state.get("pending_draw_count") or 0)
        game.active_plus_type = state.get("active_plus_type")
        game.timeout_streak = int(state.get("timeout_streak") or 0)
        game.uno_declared = False
        game.waiting_for_uno = False
        message_id = state.get("panel_message_id")
        fetch = getattr(channel, "fetch_message", None)
        if message_id and callable(fetch):
            try:
                game.active_panel_message = await fetch(message_id)
            except Exception:
                game.active_panel_message = None
        self.games[channel_id] = game
        awaiting = state.get("awaiting_color")
        if isinstance(awaiting, dict) and awaiting.get("player_id") in players:
            view = WildColorView(game, awaiting.get("card_type"), awaiting["player_id"],
                                 self, awaiting.get("action_msg") or "",
                                 bool(awaiting.get("uno_penalty")))
            game.active_view = view
            game.active_panel_message = await game_panels.replace(
                channel, "party",
                content=f"<@{awaiting['player_id']}> さん、次の色を選択してください！（{int(COLOR_TIMEOUT)}秒以内）",
                view=view)
        else:
            await self.send_game_panel(channel, game,
                                       info_msg="再起動から復旧しました。対局を続けます。")
        return True

    def get_embed_color(self, color_name):
        colors = {
            '赤': discord.Color.red(),
            '青': discord.Color.blue(),
            '黄': discord.Color.gold(),
            '緑': discord.Color.green()
        }
        return colors.get(color_name, discord.Color.dark_grey())

    async def finish_game(self, channel_id: int, winner_id: int):
        channel = self.bot.get_channel(channel_id)
        # サーバーごとのランキング（core/party_ranking.py）: 手札を出し切った 1 人が勝ち
        guild = getattr(channel, "guild", None)
        if channel_id in self.games and guild is not None:
            await party_ranking.shared().record_win(guild.id, winner_id, "uno")

        embed = discord.Embed(
            title="[!] UNO ゲーム決着！",
            description=f"*** <@{winner_id}> さんが手札をすべて使い切り、見事勝利しました！ ***",
            color=discord.Color.brand_green()
        )

        if channel_id in self.games:
            game = self.games[channel_id]
            remains = []
            for p_id in game.players:
                if p_id != winner_id:
                    cards_str = ", ".join(game.hands[p_id])
                    remains.append(f"<@{p_id}>: {cards_str} ({len(game.hands[p_id])}枚)")
            if remains:
                embed.add_field(name="他のプレイヤーの残り手札", value="\n".join(remains), inline=False)

            if game.active_view is not None:
                game.active_view.stop()
                game.active_view = None
            if game.active_panel_message:
                try:
                    await game.active_panel_message.delete()
                except discord.NotFound:
                    pass
            del self.games[channel_id]
            self._clear_snapshot(channel_id)

        await channel.send(embed=embed)



async def setup(bot):
    await bot.add_cog(Uno(bot))
