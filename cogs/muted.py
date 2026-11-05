import logging

import discord
from discord.ext import commands, tasks
from discord import app_commands
from datetime import datetime, timedelta, timezone

from core.storage import KVStore

logger = logging.getLogger(__name__)

NAMESPACE = "muted"


def parse_guild(value) -> tuple[dict[int, datetime], int | None]:
    """保存データ（1 サーバー分）を {user_id: 期限}, 管理ロールID に戻す。"""
    mutes: dict[int, datetime] = {}
    if not isinstance(value, dict):
        return mutes, None
    for user_id, text in (value.get("mutes") or {}).items():
        try:
            expire = datetime.fromisoformat(text)
            if expire.tzinfo is None:
                expire = expire.replace(tzinfo=timezone.utc)
            mutes[int(user_id)] = expire
        except (TypeError, ValueError):
            logger.warning("ミュートの保存データを読み飛ばしました: %r", (user_id, text))
    role_id = value.get("admin_role_id")
    try:
        role_id = int(role_id) if role_id is not None else None
    except (TypeError, ValueError):
        role_id = None
    return mutes, role_id


class Muted(commands.Cog):
    """ミュートの期限と管理ロールは core/storage.py（Supabase の bot_kv、namespace "muted"）に、
    サーバーごとに 1 件 {"mutes": {user_id: 期限}, "admin_role_id": ロールID} で保存する。"""

    def __init__(self, bot, store: KVStore | None = None):
        self.bot = bot
        self.store = store or KVStore(NAMESPACE)
        self.mute_tasks: dict[tuple[int, int], datetime] = {}
        self.admin_roles: dict[int, int] = {}
        # まずローカルの控えを読む（Supabase からは Bot の準備ができてから読み直す）
        self._apply(self.store.load_local())
        self.embed_color = 0xFFFFFF
        self.check_mute_expiry.start()

    def cog_unload(self):
        self.check_mute_expiry.cancel()

    def _apply(self, data: dict, *, replace: bool = True) -> None:
        if replace:
            self.mute_tasks.clear()
            self.admin_roles.clear()
        for key, value in data.items():
            try:
                guild_id = int(key)
            except (TypeError, ValueError):
                continue
            mutes, role_id = parse_guild(value)
            for user_id, expire in mutes.items():
                self.mute_tasks[(guild_id, user_id)] = expire
            if role_id is not None:
                self.admin_roles[guild_id] = role_id

    def guild_value(self, guild_id: int) -> dict:
        mutes = {str(uid): expire.isoformat() for (gid, uid), expire in sorted(self.mute_tasks.items()) if gid == guild_id}
        value = {}
        if mutes:
            value["mutes"] = mutes
        if guild_id in self.admin_roles:
            value["admin_role_id"] = self.admin_roles[guild_id]
        return value

    async def save(self, guild_id: int) -> None:
        """1 サーバー分を保存する（何も無くなったら消す）。"""
        value = self.guild_value(guild_id)
        if value:
            await self.store.set(str(guild_id), value)
        else:
            await self.store.delete(str(guild_id))

    async def load_remote(self) -> None:
        """Supabase から読み直す。ローカルにしかないサーバーの分は Supabase にも書いておく。"""
        local_guilds = {gid for gid, _ in self.mute_tasks} | set(self.admin_roles)
        local_only_values = {}
        remote = await self.store.load_all()
        remote_guilds = set()
        for key in remote:
            try:
                remote_guilds.add(int(key))
            except (TypeError, ValueError):
                pass
        for gid in local_guilds - remote_guilds:
            local_only_values[gid] = self.guild_value(gid)
        self._apply(remote)
        for gid, value in local_only_values.items():
            self._apply({str(gid): value}, replace=False)
            await self.save(gid)

    async def is_admin_role(self, interaction: discord.Interaction) -> bool:
        allowed_role_id = self.admin_roles.get(interaction.guild_id)
        if interaction.user.guild_permissions.administrator:
            return True
        if allowed_role_id and any(role.id == allowed_role_id for role in interaction.user.roles):
            return True
        
        embed = discord.Embed(description="管理ロールが設定されていないか、権限がありません。管理者による `/support` のパネルから「Muted設定」 の設定が必要です。", color=self.embed_color)
        await interaction.response.send_message(embed=embed, ephemeral=True)
        return False

    async def get_or_create_muted_role(self, guild: discord.Guild):
        role = discord.utils.get(guild.roles, name="Muted")
        if role: return role, False
        role = await guild.create_role(name="Muted", reason="Muted管理用自動生成", color=discord.Color.dark_grey())
        return role, True

    @tasks.loop(minutes=1)
    async def check_mute_expiry(self):
        try:
            await self.unmute_expired()
        except Exception:
            # ここで例外が出てもループは止めない（以前は止まったまま二度と解除されなかった）
            logger.exception("ミュート解除の確認に失敗しました")

    @check_mute_expiry.before_loop
    async def before_check_mute_expiry(self):
        wait = getattr(self.bot, "wait_until_ready", None)
        if wait is not None:
            await wait()
        try:
            await self.load_remote()
        except Exception:
            logger.exception("ミュートの保存データを読み直せませんでした（ローカルの控えで続けます）")

    async def unmute_expired(self, now: datetime | None = None) -> list[tuple[int, int]]:
        """期限が過ぎたミュートを解除する。解除（または記録を削除）した (guild_id, user_id) を返す。"""
        now = now or datetime.now(timezone.utc)
        done = []
        # remove_roles を待っている間に /muted で増減しても壊れないよう、先に写しを取る
        for key, expire_time in list(self.mute_tasks.items()):
            if now < expire_time:
                continue
            try:
                if await self._unmute(*key):
                    done.append(key)
            except Exception:
                logger.exception("ミュート解除に失敗しました: guild=%s user=%s", *key)
                continue
            # 待っている間に延長された場合は消さない
            if key in done and self.mute_tasks.get(key) == expire_time:
                del self.mute_tasks[key]
        for guild_id in sorted({gid for gid, _ in done}):
            await self.save(guild_id)
        return done

    async def _unmute(self, guild_id: int, user_id: int) -> bool:
        """1 人分を解除する。True なら記録を消してよい、False なら次の確認でやり直す。"""
        guild = self.bot.get_guild(guild_id)
        if guild is None:
            # 起動直後でまだ見えないだけかもしれないので、Bot の準備ができてからだけ諦める
            is_ready = getattr(self.bot, "is_ready", None)
            return bool(is_ready and is_ready())
        member = guild.get_member(user_id)
        role = discord.utils.get(guild.roles, name="Muted")
        if member is None or role is None:
            return True  # サーバーを抜けた・ロールが消えた
        try:
            await member.remove_roles(role, reason="ミュートの期限切れ")
        except discord.Forbidden:
            logger.warning("権限がないためミュートを解除できませんでした: guild=%s user=%s", guild_id, user_id)
            return True
        except discord.HTTPException:
            logger.warning("ミュート解除に失敗しました（次の確認でやり直します）: guild=%s user=%s", guild_id, user_id,
                           exc_info=True)
            return False
        return True

    # --- セレクトメニュー ---
    class MuteSettingView(discord.ui.View):
        def __init__(self, cog):
            super().__init__(timeout=60) # 1分でメニューを無効化
            self.cog = cog

        @discord.ui.select(
            placeholder="操作を選択（一度選択すると終了します）",
            options=[
                discord.SelectOption(label="権限同期", value="link", description="全チャンネルを発言不可に設定"),
                discord.SelectOption(label="非表示切替", value="hide_toggle", description="全チャンネルの表示/非表示を反転"),
            ]
        )
        async def select_callback(self, interaction: discord.Interaction, select: discord.ui.Select):
            await interaction.response.defer(ephemeral=True)
            role, _ = await self.cog.get_or_create_muted_role(interaction.guild)
            embed = discord.Embed(color=self.cog.embed_color)

            if select.values[0] == "link":
                success, error = 0, 0
                for ch in interaction.guild.channels:
                    try:
                        await ch.set_permissions(role, send_messages=False, add_reactions=False, connect=False)
                        success += 1
                    except Exception:
                        logger.debug("Muted: チャンネルの権限同期に失敗しました", exc_info=True)
                        error += 1
                embed.description = f"同期完了 (成功: {success} / 失敗: {error})"

            elif select.values[0] == "hide_toggle":
                # 最初のチャンネルの状態を見て、非表示にするか元に戻すか決める
                target_ch = interaction.guild.text_channels[0]
                current_overwrite = target_ch.overwrites_for(role)
                
                # 現在「見えない」設定なら、設定をクリア(None)して見えるようにする
                # 現在「見える」または「未設定」なら、Falseにして見えないようにする
                is_hidden = (current_overwrite.view_channel == False)
                new_view_state = None if is_hidden else False

                for ch in interaction.guild.text_channels:
                    try:
                        await ch.set_permissions(role, view_channel=new_view_state, send_messages=False)
                    except Exception:
                        logger.debug("Muted: チャンネルの非表示設定に失敗しました", exc_info=True)
                        continue
                
                embed.description = "非表示設定を解除しました。" if is_hidden else "全てのチャンネルを非表示にしました。"

            # 選択されたらメニューを削除して、二度押しできないようにする
            await interaction.edit_original_response(embed=embed, view=None)
            self.stop() # Viewのループを止める

    # --- メインコマンド ---
    async def muted_setting(
        self, 
        interaction: discord.Interaction, 
        target: discord.Member = None, 
        minutes: int = None, 
        admin_role: discord.Role = None,
        isolation_channel: discord.TextChannel = None
    ):
        # 1. 管理ロール設定
        if admin_role:
            if not interaction.user.guild_permissions.manage_roles:
                embed = discord.Embed(description="権限が不足しています。", color=self.embed_color)
                return await interaction.response.send_message(embed=embed, ephemeral=True)
            self.admin_roles[interaction.guild_id] = admin_role.id
            await self.save(interaction.guild_id)
            embed = discord.Embed(description=f"管理ロールを {admin_role.mention} に設定しました。", color=self.embed_color)
            return await interaction.response.send_message(embed=embed, ephemeral=True)

        # 権限チェック
        if not await self.is_admin_role(interaction): return

        # 2. 個別付与 (実行後、再度使うにはコマンドを打ち直す)
        if target and minutes:
            role, _ = await self.get_or_create_muted_role(interaction.guild)
            await target.add_roles(role)
            self.mute_tasks[(interaction.guild_id, target.id)] = datetime.now(timezone.utc) + timedelta(minutes=minutes)
            await self.save(interaction.guild_id)
            embed = discord.Embed(description=f"{target.display_name} を {minutes}分間 Mutedにしました。", color=self.embed_color)
            return await interaction.response.send_message(embed=embed, ephemeral=True)

        # 3. 隔離設定
        if isolation_channel:
            await interaction.response.defer(ephemeral=True)
            role, _ = await self.get_or_create_muted_role(interaction.guild)
            for ch in interaction.guild.text_channels:
                try:
                    is_target = (ch.id == isolation_channel.id)
                    await ch.set_permissions(role, view_channel=is_target, send_messages=is_target)
                except Exception:
                    logger.debug("Muted: 隔離用チャンネルの権限設定に失敗しました", exc_info=True)
                    continue
            embed = discord.Embed(description=f"{isolation_channel.mention} 以外を非表示にしました。", color=self.embed_color)
            return await interaction.followup.send(embed=embed, ephemeral=True)

        # 4. 引数なし：メニュー表示（一度使うと消える）
        embed = discord.Embed(title="Muted システム設定", description="メニューを選択してください。一度実行すると終了します。", color=self.embed_color)
        await interaction.response.send_message(embed=embed, view=self.MuteSettingView(self), ephemeral=True)

async def setup(bot):
    await bot.add_cog(Muted(bot))
