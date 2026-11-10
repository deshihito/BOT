import discord
from discord.ext import commands
from discord import app_commands
import asyncio
import io
import logging
import config
import os
import traceback
from core.support.api_client import APIError
from core.support.api_retry import run_with_retry
from core.game.game import prison as prison_core
from core.general.user_names import resolve_display_names
from core.leaderboard_image import (
    BoardRow, fetch_avatar_bytes, fmt_int, render_leaderboard_png,
)

COIN_BOARD_FILENAME = "coin_leaderboard.png"
ASSET_BOARD_FILENAME = "asset_leaderboard.png"
COIN_ACCENT = (217, 164, 32)
ASSET_ACCENT = (13, 148, 136)

logger = logging.getLogger(__name__)

COIN_SETTER_USER_ID = 1320705325686587408
NEW_USER_BALANCE = 10  # まだ行がないユーザーに最初に渡す残高
# 残高を書き換えるときに、ほかの処理と同時に更新されて食い違った場合の再試行回数
BALANCE_UPDATE_ATTEMPTS = 5
INSUFFICIENT = object()  # 残高不足を表す目印

# アゴのコイン（web/public/img/coin.png と同じ画像）。埋め込みのサムネイルに添付ファイルとして付ける。
COIN_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))), "Assets", "COIN.png")
COIN_FILENAME = "coin.png"
COIN_COLOR = 0xf1c40f


def fetch_all_balances() -> dict:
    """全ユーザーの残高をページング取得する（資産ランキング用、sweep2 GEN-25 で集約）。"""
    balances: dict[str, int] = {}
    offset = 0
    while True:
        response = (config.db_api.table("users")
                    .select("user_id, balance")
                    .range(offset, offset + 999).execute())
        rows = response.data or []
        for row in rows:
            balances[str(row["user_id"])] = int(row.get("balance") or 0)
        if len(rows) < 1000:
            return balances
        offset += 1000


def compute_asset_ranking(balances: dict, token_balances: dict,
                          rate: float, limit: int = 10) -> list[dict]:
    """総合資産ランキング（S6-6）: 残高＋トークン時価の合算で並べる。

    balances: {user_id: AGO残高}、token_balances: {user_id: 保有AGA数}、
    rate: 現在レート（1 AGA = rate AGO）。トークン時価は小数切り捨て。
    アイテムの売却額は含めない（仕様どおり）。
    """
    user_ids = set(balances) | set(token_balances)
    rows = []
    for uid in user_ids:
        balance = int(balances.get(uid) or 0)
        tokens = float(token_balances.get(uid) or 0.0)
        token_value = int(tokens * float(rate))
        rows.append({
            "user_id": str(uid),
            "balance": balance,
            "token_value": token_value,
            "total": balance + token_value,
        })
    rows.sort(key=lambda row: (-row["total"], row["user_id"]))
    return rows[: max(0, int(limit))]


def coin_embed(title: str, description: str | None = None) -> tuple[discord.Embed, dict]:
    """コインのサムネイル付きの埋め込みと、send に渡す追加の引数（file）を返す。

    画像が無い環境では、サムネイルなしの埋め込みだけを返す。
    """
    embed = discord.Embed(title=title, description=description, color=COIN_COLOR)
    if not os.path.exists(COIN_PATH):
        return embed, {}
    embed.set_thumbnail(url=f"attachment://{COIN_FILENAME}")
    return embed, {"file": discord.File(COIN_PATH, filename=COIN_FILENAME)}


async def read_user_balance(user_id, balance_reader, *, missing_balance: int) -> int:
    """残高の読み取り（行が無いユーザーは missing_balance。行は作らない）。

    balance_reader が注入されていればそちらを優先する（テスト・集約用）。
    """
    if balance_reader is not None:
        return int(balance_reader(str(user_id)))

    def _read() -> int | None:
        response = config.db_api.table("users").select("balance") \
            .eq("user_id", str(user_id)).execute()
        if not response.data:
            return None
        return int(response.data[0].get("balance") or 0)

    balance = await asyncio.to_thread(_read)
    return int(missing_balance) if balance is None else balance

class WalletCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @commands.command(name="coin")
    async def set_coin(self, ctx: commands.Context, amount: int):
        """指定された管理者だけが !coin <数値> で残高を直接設定できる。"""
        if ctx.author.id != COIN_SETTER_USER_ID:
            await ctx.send("このコマンドを実行する権限がありません。")
            return
        if amount < 0:
            await ctx.send("コインは0以上の数値で指定してください。")
            return
        user_id = str(ctx.author.id)
        try:
            current = config.db_api.table("users").select("balance").eq("user_id", user_id).execute()
            old_balance = int(current.data[0].get("balance") or 0) if current.data else 0
            if current.data:
                updated = (config.db_api.table("users").update({"balance": amount})
                           .eq("user_id", user_id).eq("balance", old_balance).execute())
            else:
                updated = config.db_api.table("users").insert({"user_id": user_id, "balance": amount, "debt": 0}).execute()
            if not updated.data:
                raise RuntimeError("残高を更新できませんでした。")
            delta = amount - old_balance
            config.db_api.table("transaction_history").insert({
                "sender_id": "SYSTEM_ADMIN",
                "receiver_id": user_id,
                "amount": abs(delta),
                "reason": f"admin_coin_set_to_{amount}",
            }).execute()
            await ctx.send(f"コインを **{amount:,} AGO** に設定しました（変更: {delta:+,} AGO）。")
        except Exception:
            traceback.print_exc()
            await ctx.send("コイン設定中にエラーが発生しました。")

    async def user_status(self, interaction: discord.Interaction, target: discord.User | None = None):
        await interaction.response.defer()
        target = target or interaction.user
        user_id = str(target.id)

        try:
            response = config.db_api.table("users").select("balance, debt").eq("user_id", user_id).execute()
            data = response.data

            if not data:
                config.db_api.table("users").insert({"user_id": user_id, "balance": 10, "debt": 0}).execute()
                balance = 10
                debt = 0
            else:
                balance = data[0]["balance"]
                debt = data[0].get("debt", 0)

            embed, extra = coin_embed("プレイヤー情報", f"{target.mention} さんの現在のステータスです。")
            embed.add_field(name="保有コイン", value=f"{int(balance or 0):,} AGO", inline=True)
            # 借金額は不利益情報なので本人以外には出さない（sweep2 GEN-02）。
            if target.id == interaction.user.id:
                embed.add_field(name="借金額", value=f"{int(debt or 0):,} AGO", inline=True)

            fujo = self.bot.get_cog("FujoSurvival")
            if fujo is not None and hasattr(fujo, "status_embed_for"):
                try:
                    survival = await fujo.status_embed_for(target)
                except Exception:
                    logger.exception("user_status: failed to load survival status user=%s", target.id)
                    survival = None
                if survival is not None:
                    for field in survival.fields:
                        embed.add_field(name=field.name, value=field.value, inline=field.inline)

            # 自分のステータスは本人のみ（借金額を含むため、sweep2 GEN-02）。
            await interaction.followup.send(embed=embed, ephemeral=target.id == interaction.user.id, **extra)

        except Exception as e:
            print("\n=== [WALLET COMMAND ERROR START] ===")
            traceback.print_exc()
            print("=== [WALLET COMMAND ERROR END] ===\n")
            await interaction.followup.send("データの取得中にエラーが発生しました。時間をおいて再試行してください。", ephemeral=True)

    async def pay(self, interaction: discord.Interaction, receiver: discord.User, amount: int):
        # E-8a: モーダルを開いた時点の dispatch チェックだけでは
        # TOCTOU（開いた後に逮捕される）を通すため、実行直前に
        # prison を再チェックする（他の execute_* と同型の二層防御）。
        blocked = prison_core.block_message(str(interaction.user.id))
        if blocked:
            await interaction.response.send_message(blocked, ephemeral=True)
            return
        if amount <= 0:
            await interaction.response.send_message(PAY_MIN_AMOUNT, ephemeral=True)
            return
        if receiver.id == interaction.user.id:
            await interaction.response.send_message(PAY_TO_SELF, ephemeral=True)
            return
        if receiver.bot:
            await interaction.response.send_message(PAY_TO_BOT, ephemeral=True)
            return

        # 途中の案内は本人にだけ見せる。送金できたときの完了通知だけを全体に出す。
        await interaction.response.defer(ephemeral=True, thinking=True)

        sender_id = str(interaction.user.id)
        receiver_id = str(receiver.id)

        # 1回のDBトランザクションで送金できる新しい環境を優先する。
        # RPCがまだ適用されていない環境では、後段のCASフォールバックを使う。
        try:
            atomic_balance = await self._transfer_atomic(sender_id, receiver_id, amount)
        except APIError as exc:
            if exc.code in {"RPC_NOT_ALLOWED", "42883"}:
                logger.warning("pay: transfer_coins RPC is unavailable; using legacy fallback: %s", exc)
                atomic_balance = None
            else:
                logger.exception("pay: transfer result is uncertain; refusing legacy fallback sender=%s receiver=%s amount=%s", sender_id, receiver_id, amount)
                await interaction.followup.send(
                    "送金結果を確認できません。二重送金を防ぐため再処理を中止しました。残高を確認し、解決しない場合は管理者に連絡してください。",
                    ephemeral=True,
                )
                return
        except Exception:
            logger.exception("pay: 原子送金RPCに失敗 sender=%s receiver=%s amount=%s", sender_id, receiver_id, amount)
            await interaction.followup.send(
                "送金結果を確認できません。二重送金を防ぐため再処理を中止しました。残高を確認し、解決しない場合は管理者に連絡してください。",
                ephemeral=True,
            )
            return
        if atomic_balance is not None:
            mine, extra = coin_embed("送金しました", f"{receiver.mention} に **{amount:,} AGO** を送りました。")
            mine.add_field(name="あなたの残高", value=f"{atomic_balance:,} AGO", inline=True)
            await interaction.followup.send(embed=mine, ephemeral=True, **extra)
            embed, extra = coin_embed(
                "送金完了", f"{interaction.user.mention} さんが {receiver.mention} に **{amount:,} AGO** コインを送金しました。")
            # 自分のステータスは本人のみ（借金額を含むため、sweep2 GEN-02）。
            await interaction.followup.send(embed=embed, ephemeral=target.id == interaction.user.id, **extra)
            return

        # 旧スキーマ用: 送り手の残高を減らす（CASで競合時は読み直す）
        try:
            debit = await self._change_balance(sender_id, -amount, require_funds=True)
        except Exception:
            logger.exception("pay: 送り手の残高更新に失敗 sender=%s receiver=%s amount=%s", sender_id, receiver_id, amount)
            debit = None
        if debit is INSUFFICIENT:
            await interaction.followup.send("残高が不足しているため、送金できません。", ephemeral=True)
            return
        if debit is None:
            await interaction.followup.send(
                "送金処理中にエラーが発生しました。残高は変わっていません。時間を置いて再度お試しください。", ephemeral=True)
            return

        # 2. 受け手の残高を増やす。失敗したら送り手に返金する。
        try:
            credit = await self._change_balance(receiver_id, amount, create_with=NEW_USER_BALANCE)
        except Exception:
            logger.exception("pay: 受け手の残高更新に失敗 sender=%s receiver=%s amount=%s", sender_id, receiver_id, amount)
            credit = None
        if credit is None:
            try:
                refund = await self._change_balance(sender_id, amount)
            except Exception:
                logger.exception("pay: 返金処理で例外 sender=%s amount=%s", sender_id, amount)
                refund = None
            if refund is None:
                logger.critical(
                    "pay: 返金に失敗しました。手動で戻してください: sender=%s receiver=%s amount=%s "
                    "（送り手から %s AGO を引いたまま、受け手には入っていません）",
                    sender_id, receiver_id, amount, amount)
                await interaction.followup.send(
                    f"送金に失敗し、{amount:,} AGO の返金もできませんでした。"
                    "お手数ですが管理者に連絡してください（記録は残してあります）。",
                    ephemeral=True,
                )
                return
            await interaction.followup.send(
                "送金処理中にエラーが発生したため、送金を取り消しました。残高は元に戻っています。", ephemeral=True)
            return

        try:
            await asyncio.to_thread(lambda: config.db_api.table("transaction_history").insert({
                "sender_id": sender_id,
                "receiver_id": receiver_id,
                "amount": amount,
                "reason": "送金"
            }).execute())
        except Exception:
            # 送金自体は終わっているので、履歴だけ残せなかったことを記録する。
            logger.exception("pay: 送金履歴の記録に失敗 sender=%s receiver=%s amount=%s", sender_id, receiver_id, amount)

        mine, extra = coin_embed("送金しました", f"{receiver.mention} に **{amount:,} AGO** を送りました。")
        mine.add_field(name="あなたの残高", value=f"{debit:,} AGO", inline=True)
        await interaction.followup.send(embed=mine, ephemeral=True, **extra)
        embed, extra = coin_embed(
            "送金完了", f"{interaction.user.mention} さんが {receiver.mention} に **{amount:,} AGO** コインを送金しました。")
        await interaction.followup.send(embed=embed, **extra)

    async def _change_balance(self, user_id: str, delta: int, *, require_funds: bool = False,
                              create_with: int | None = None):
        """残高に delta を足す。読んだ残高から変わっていないときだけ書き込み、変わっていたら読み直す。

        成功したら新しい残高、残高不足なら INSUFFICIENT、やり直しても書き込めなければ None を返す。
        create_with を指定すると、行がないユーザーをその残高で作ってから delta を足す。
        """
        for _ in range(BALANCE_UPDATE_ATTEMPTS):
            current = await asyncio.to_thread(
                lambda: config.db_api.table("users").select("balance").eq("user_id", user_id).execute())
            if not current.data:
                if require_funds:
                    return INSUFFICIENT
                if create_with is None:
                    return None
                new_balance = create_with + delta
                try:
                    inserted = await asyncio.to_thread(lambda: config.db_api.table("users").insert(
                        {"user_id": user_id, "balance": new_balance, "debt": 0}).execute())
                except Exception:
                    # 同時に別の処理が行を作った場合など。読み直してやり直す。
                    logger.warning("pay: ユーザー行の作成に失敗、読み直します user=%s", user_id, exc_info=True)
                    continue
                if inserted.data:
                    return new_balance
                continue
            old_balance = int(current.data[0].get("balance") or 0)
            new_balance = old_balance + delta
            if require_funds and new_balance < 0:
                return INSUFFICIENT
            updated = await asyncio.to_thread(
                lambda: config.db_api.table("users").update({"balance": new_balance})
                .eq("user_id", user_id).eq("balance", old_balance).execute())
            if updated.data:
                return new_balance
        return None

    async def _transfer_atomic(self, sender_id: str, receiver_id: str, amount: int):
        """transfer_coins RPCを呼ぶ。RPC未適用ならNoneを返して旧実装へ委譲する。

        RPCが返す ``NULL`` は、テスト用クライアントまたは旧環境の「関数なし」を
        表すため成功扱いにしない。実DBの関数は送金後の送り手残高(bigint)を返す。
        """
        def _call():
            response = run_with_retry(lambda: config.db_api.rpc("transfer_coins", {
                "p_sender_id": sender_id,
                "p_receiver_id": receiver_id,
                "p_amount": int(amount),
                "p_new_user_balance": NEW_USER_BALANCE,
            }).execute())
            data = response.data
            if data is None:
                raise APIError("transfer_coins returned no balance", code="RPC_INVALID_RESPONSE", status_code=502)
            if isinstance(data, list):
                data = data[0] if data else None
            if isinstance(data, dict):
                data = data.get("balance")
            if data is None:
                raise APIError("transfer_coins returned no balance", code="RPC_INVALID_RESPONSE", status_code=502)
            return int(data)

        return await asyncio.to_thread(_call)

    async def leaderboard(self, interaction: discord.Interaction,
                          category: app_commands.Choice[str] | None = None,
                          scope: app_commands.Choice[str] | None = None,
                          *, slowest: bool = False):
        await interaction.response.defer()
        selected = category.value if category else "coin"
        if selected == "asset":
            await self._asset_leaderboard(interaction)
            return
        if selected in {"bump", "up"}:
            rta = self.bot.get_cog("BumpRta")
            if rta is None:
                await interaction.followup.send("RTAランキング機能は現在利用できません。", ephemeral=True)
                return
            await rta.leaderboard(interaction, scope.value if scope else "local", slowest=slowest)
            return
        if selected == "sokunuke":
            rta = self.bot.get_cog("SokuNukeRta")
            if rta is None:
                await interaction.followup.send("即抜けRTAランキング機能は現在利用できません。", ephemeral=True)
                return
            await rta.leaderboard(interaction, scope.value if scope else "local")
            return
        try:
            response = await asyncio.to_thread(
                lambda: config.db_api.table("users").select("user_id, balance")
                .order("balance", desc=True).limit(10).execute())
            data = response.data or []
            if not data:
                await interaction.followup.send("まだランキングに載っている人がいません。")
                return

            # ランキングは全サーバー横断のため、メンションだと「不明のユーザー」に
            # なる。氏名は通常表記で解決する（core/general/user_names.py）。
            names = await resolve_display_names(
                self.bot, [int(record["user_id"]) for record in data])
            rows = []
            for record in data:
                user_id = int(record["user_id"])
                rows.append(BoardRow(
                    user_id=user_id,
                    name=names.get(user_id, ""),
                    value=f"{fmt_int(record.get('balance') or 0)} AGO"))
            avatars = await fetch_avatar_bytes(
                self.bot, [row.user_id for row in rows])
            png = await asyncio.to_thread(
                render_leaderboard_png,
                title="コイン保有ランキング", sections=[(None, rows)],
                accent=COIN_ACCENT, avatars=avatars,
                cache_namespace="coin-leaderboard")
            embed = discord.Embed(title="コイン保有ランキング（TOP 10）", color=0xf1c40f)
            embed.set_image(url=f"attachment://{COIN_BOARD_FILENAME}")
            await interaction.followup.send(
                embed=embed,
                file=discord.File(io.BytesIO(png), filename=COIN_BOARD_FILENAME))
        except Exception:
            traceback.print_exc()
            await interaction.followup.send("ランキングの取得中にエラーが発生しました。", ephemeral=True)

    async def _asset_leaderboard(self, interaction: discord.Interaction):
        """総合資産ランキング（S6-6）: 残高＋トークン時価（保有数×現在レート）。"""
        try:
            balances = await asyncio.to_thread(fetch_all_balances)
            token_balances: dict[str, float] = {}
            rate = 0.0
            market_cog = self.bot.get_cog("MarketCog")
            if market_cog is not None:
                snapshot = market_cog.store.snapshot()
                rate = float(snapshot.get("rate") or 0.0)
                token_balances = {
                    str(uid): float(amount)
                    for uid, amount in (snapshot.get("balances") or {}).items()
                }
            ranking = compute_asset_ranking(balances, token_balances, rate)
            if not ranking:
                await interaction.followup.send("まだランキングに載っている人がいません。")
                return
            names = await resolve_display_names(
                self.bot, [int(row["user_id"]) for row in ranking])
            rows = []
            for row in ranking:
                user_id = int(row["user_id"])
                rows.append(BoardRow(
                    user_id=user_id,
                    name=names.get(user_id, ""),
                    value=f"{fmt_int(row['total'])} AGO",
                    sub=(f"コイン {fmt_int(row['balance'])}"
                         f"＋トークン {fmt_int(row['token_value'])}")))
            avatars = await fetch_avatar_bytes(
                self.bot, [row.user_id for row in rows])
            png = await asyncio.to_thread(
                render_leaderboard_png,
                title="総合資産ランキング", sections=[(None, rows)],
                accent=ASSET_ACCENT, avatars=avatars,
                cache_namespace="asset-leaderboard")
            embed = discord.Embed(title="総合資産ランキング（TOP 10）", color=0xf1c40f)
            embed.set_image(url=f"attachment://{ASSET_BOARD_FILENAME}")
            await interaction.followup.send(
                embed=embed,
                file=discord.File(io.BytesIO(png), filename=ASSET_BOARD_FILENAME))
        except Exception:
            traceback.print_exc()
            await interaction.followup.send("ランキングの取得中にエラーが発生しました。", ephemeral=True)

async def setup(bot: commands.Bot):
    await bot.add_cog(WalletCog(bot))
