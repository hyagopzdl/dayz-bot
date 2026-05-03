import { Client, GatewayIntentBits } from "discord.js";

const INTERVAL_MS = 60_000;

export function startBot(getLeaderboard) {
  const token = process.env.DISCORD_TOKEN;
  const channelId = process.env.CHANNEL_ID;

  if (!token || !channelId) {
    console.error(
      "[Bot] Missing DISCORD_TOKEN or CHANNEL_ID environment variables.",
    );
    process.exit(1);
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  let lastMessage = null;

  async function postLeaderboard() {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) {
        console.error("[Bot] Channel not found or not a text channel.");
        return;
      }

      const leaderboard = getLeaderboard();

      if (leaderboard.length === 0) {
        console.log("[Bot] No kills recorded yet, skipping update.");
        return;
      }

      const lines = leaderboard.map(
        (p, i) => `**${i + 1}.** ${p.name} — ${p.kills} kills (${p.kd} KD)`,
      );

      const content = `🏆 **Leaderboard PvP**\n\n${lines.join("\n")}`;

      if (lastMessage) {
        try {
          await lastMessage.edit(content);
          console.log("[Bot] Leaderboard updated.");
          return;
        } catch {
          // Message may have been deleted — send a new one
          lastMessage = null;
        }
      }

      lastMessage = await channel.send(content);
      console.log("[Bot] Leaderboard sent.");
    } catch (err) {
      console.error("[Bot] Error posting leaderboard:", err.message);
    }
  }

  client.once("ready", () => {
    console.log(`[Bot] Logged in as ${client.user.tag}`);
    postLeaderboard();
    setInterval(postLeaderboard, INTERVAL_MS);
  });

  client.login(token);
}
