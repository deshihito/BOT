import asyncio
import os
import pty
import discord
from discord.ext import commands

ALLOWED_USER_IDS = {
    1320705325686587408,
    1000302102473613373,
}
TARGET_DIR = os.path.expanduser("~/BOT")

async def run_interactive_terminal(bot, thread, cmd, is_normal_mode=False):
    # ノーマルモードの場合は事前処理なし、それ以外はcd & venvを自動適用
    if is_normal_mode:
        full_command = cmd
    else:
        full_command = f"cd {TARGET_DIR} && source venv/bin/activate && {cmd}"

    master, slave = pty.openpty()
    os.set_blocking(master, False)

    try:
        process = await asyncio.create_subprocess_shell(
            full_command,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            executable="/bin/bash"
        )
        os.close(slave)

        input_queue = asyncio.Queue()

        def check_message(m):
            return m.channel.id == thread.id and m.author.id in ALLOWED_USER_IDS

        async def listen_messages():
            while True:
                try:
                    msg = await bot.wait_for("message", check=check_message)
                    await input_queue.put(msg.content.strip())
                except asyncio.CancelledError:
                    break

        async def read_output():
            output_buffer = ""
            while True:
                try:
                    try:
                        data = os.read(master, 1024)
                    except (BlockingIOError, OSError):
                        data = None

                    if data:
                        output_buffer += data.decode("utf-8", errors="replace")

                    if output_buffer and not data:
                        text_to_send = output_buffer
                        output_buffer = ""
                        if len(text_to_send.strip()) > 0:
                            if len(text_to_send) > 1900:
                                text_to_send = text_to_send[-1900:]
                            await thread.send(f"```bash\n{text_to_send}\n```")

                    if process.returncode is not None and not data:
                        break

                    await asyncio.sleep(0.2)
                except asyncio.CancelledError:
                    break

        async def handle_input():
            while True:
                user_input = await input_queue.get()
                if user_input.lower() == "cancel":
                    try:
                        process.kill()
                    except ProcessLookupError:
                        pass
                    await thread.send("プロセスの実行を強制終了しました。")
                    break
                try:
                    os.write(master, (user_input + "\n").encode("utf-8"))
                except OSError:
                    break

        mode_name = "ノーマルモード" if is_normal_mode else "仮想環境モード (自動cd & venv)"
        await thread.send(f"実行開始 [{mode_name}]: `{cmd}`\nキャンセルする場合は `cancel` と送信してください。")

        listener_task = asyncio.create_task(listen_messages())
        reader_task = asyncio.create_task(read_output())
        writer_task = asyncio.create_task(handle_input())

        await process.wait()
        await asyncio.sleep(0.5)

        listener_task.cancel()
        reader_task.cancel()
        writer_task.cancel()

        await thread.send("処理が終了しました。")

    finally:
        try:
            os.close(master)
        except OSError:
            pass

class TerminalModal(discord.ui.Modal, title="対話ターミナル実行"):
    def __init__(self, is_normal_mode: bool):
        super().__init__()
        self.is_normal_mode = is_normal_mode

    command_input = discord.ui.TextInput(
        label="実行コマンド",
        style=discord.TextStyle.paragraph,
        placeholder="sudo certbot や python main.py など",
        required=True
    )

    async def on_submit(self, interaction: discord.Interaction):
        if interaction.user.id not in ALLOWED_USER_IDS:
            await interaction.response.send_message("実行権限がありません。", ephemeral=True)
            return

        await interaction.response.defer(thinking=True)
        cmd = self.command_input.value

        if isinstance(interaction.channel, discord.TextChannel):
            prefix = "norm" if self.is_normal_mode else "venv"
            thread = await interaction.channel.create_thread(
                name=f"{prefix}-{cmd[:15]}".replace(" ", "-"),
                auto_archive_duration=60
            )
        else:
            await interaction.followup.send("テキストチャンネル内で実行してください。", ephemeral=True)
            return

        await interaction.followup.send(f"スレッドを作成しました: {thread.mention}")
        asyncio.create_task(run_interactive_terminal(interaction.client, thread, cmd, self.is_normal_mode))

class TerminalView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)

    @discord.ui.button(label="BOTディレクトリ (venv)", style=discord.ButtonStyle.primary, custom_id="terminal_send_button_venv")
    async def open_modal_venv(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id not in ALLOWED_USER_IDS:
            await interaction.response.send_message("実行権限がありません。", ephemeral=True)
            return
        await interaction.response.send_modal(TerminalModal(is_normal_mode=False))

    @discord.ui.button(label="ノーマルターミナル", style=discord.ButtonStyle.secondary, custom_id="terminal_send_button_normal")
    async def open_modal_normal(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id not in ALLOWED_USER_IDS:
            await interaction.response.send_message("実行権限がありません。", ephemeral=True)
            return
        await interaction.response.send_modal(TerminalModal(is_normal_mode=True))

class TerminalCog(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    @commands.command(name="terminal")
    async def send_panel(self, ctx):
        if ctx.author.id not in ALLOWED_USER_IDS:
            return
        
        embed = discord.Embed(
            title="ラズパイ 擬似ターミナル (対話対応)",
            description=(
                "実行モードを選択してボタンを押してください。\n"
                "• **BOTディレクトリ (venv)**: `~/BOT` へ移動し `venv` を有効化して実行\n"
                "• **ノーマルターミナル**: 事前処理なしでそのまま実行\n\n"
                "実行時に作成されるスレッド内で入力応答が可能です。"
            ),
            color=discord.Color.blue()
        )
        await ctx.send(embed=embed, view=TerminalView())

    @commands.command(name="guild")
    async def guild_list(self, ctx):
        """Bot が入っているサーバーの名前を全部表示する（ALLOWED_USER_IDS の人だけ）。"""
        if ctx.author.id not in ALLOWED_USER_IDS:
            return
        for chunk in guild_list_messages(self.bot.guilds):
            await ctx.send(chunk, allowed_mentions=discord.AllowedMentions.none())


def guild_list_messages(guilds, limit: int = 1900) -> list[str]:
    """サーバー一覧を、Discord の 1 メッセージの文字数制限に収まるように分けて返す。"""
    guilds = sorted(guilds, key=lambda g: (-(g.member_count or 0), g.name))
    lines = [f"{i}. {g.name}（{g.member_count or 0} 人 / ID {g.id}）" for i, g in enumerate(guilds, 1)]
    chunks, cur = [], f"導入サーバー: {len(guilds)} 件"
    for line in lines:
        if len(cur) + 1 + len(line) > limit:
            chunks.append(cur)
            cur = line
        else:
            cur += "\n" + line
    chunks.append(cur)
    return chunks


async def setup(bot):
    await bot.add_cog(TerminalCog(bot))
