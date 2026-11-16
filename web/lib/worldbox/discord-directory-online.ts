// Discord チャンネルディレクトリの読み取り（bot_kv）。
// 書き手は Bot（core/general/circulation/worldbox_discord.py）で、
// Web は読むだけ。未公開のギルドは null（= Discord 側の準備待ち）。
import { kvGet } from "../bot-api";
import { parseDiscordDirectory, type DiscordDirectory } from "./discord-directory";

export const WORLDBOX_DISCORD_DIRECTORY_NAMESPACE = "worldbox_discord_directory";

export async function loadDiscordDirectory(guildId: string): Promise<DiscordDirectory | null> {
  try {
    const raw = await kvGet(WORLDBOX_DISCORD_DIRECTORY_NAMESPACE, guildId);
    if (raw === null) return null;
    const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parseDiscordDirectory(parsed);
  } catch {
    return null;
  }
}
