import {
  Client,
  GatewayIntentBits,
  TextBasedChannel,
  EmbedBuilder,
} from "discord.js";
import fs from "fs";

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const MESSAGE_FILE_GLOBAL = "message_global.json";
const MESSAGE_FILE_DAILY = "message_daily.json";
const MESSAGE_FILE_WEEKLY = "message_weekly.json";

let discordLoopRunning = false;

export async function startDiscordBot() {
  if (!process.env.DISCORD_TOKEN) {
    console.error("❌ DISCORD_TOKEN não definido");
    return;
  }

  client.once("ready", async () => {
    console.log("🤖 Discord conectado");

    const globalChannel = (await client.channels.fetch(
      process.env.DISCORD_CHANNEL_ID!,
    )) as TextBasedChannel;

    const dailyChannel = (await client.channels.fetch(
      process.env.DISCORD_CHANNEL_DAILY_ID!,
    )) as TextBasedChannel;

    const weeklyChannel = (await client.channels.fetch(
      process.env.DISCORD_CHANNEL_WEEKLY_ID!,
    )) as TextBasedChannel;

    const CATEGORY_ID = process.env.DISCORD_ONLINE_CHANNEL_ID!;

    function padEnd(str: string, size: number) {
      return str.length >= size ? str : str + " ".repeat(size - str.length);
    }

    function padStart(str: string, size: number) {
      return str.length >= size ? str : " ".repeat(size - str.length) + str;
    }

    function getRank(i: number) {
      if (i === 0) return "🥇";
      if (i === 1) return "🥈";
      if (i === 2) return "🥉";

      const nums = ["4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
      return nums[i - 3] || `${i + 1}️⃣`;
    }

    function formatLeaderboardEmbed(players: any[], title: string) {
      const embed = new EmbedBuilder().setColor("#FF00AA");

      const timestamp = Math.floor(Date.now() / 1000);

      if (!players.length) {
        embed.setDescription(
          `\n${title}\n\nSem dados ainda...\n\n⏱️ Atualizado <t:${timestamp}:R>`,
        );
        return embed;
      }

      const maxName = Math.min(
        Math.max(...players.map((p) => p.name.length)),
        18,
      );

      const maxKillsLength = Math.max(
        ...players.map((p) => `${p.kills} kills`.length),
      );

      const KD_WIDTH = 8;

      let description = `${title}\n\n`;

      players.slice(0, 10).forEach((p, i) => {
        const rank = getRank(i);

        const trimmedName =
          p.name.length > maxName ? p.name.slice(0, maxName - 1) + "…" : p.name;

        const name = padEnd(trimmedName, maxName);

        const killsText = `${p.kills} kills`;
        const kills = padStart(killsText, maxKillsLength);

        const kd =
          p.deaths > 0 ? (p.kills / p.deaths).toFixed(2) : p.kills.toFixed(2);

        const kdText = `K/D ${kd}`;
        const kdFormatted = padStart(kdText, KD_WIDTH);

        description += `${rank} \`${name}\` \`${kills}\` \`${kdFormatted}\`\n\n`;
      });

      description += `⏱️ Atualizado <t:${timestamp}:R>`;

      embed.setDescription(description);

      return embed;
    }

    function getState() {
      try {
        return JSON.parse(fs.readFileSync("state.json", "utf-8"));
      } catch {
        return {};
      }
    }

    function getOnlineCount(): number {
      const state = getState();
      return Object.keys(state.onlinePlayers || {}).length;
    }

    async function updateOnlineCount() {
      try {
        const count = getOnlineCount();

        const category = await client.channels.fetch(CATEGORY_ID);

        if (!category || !("setName" in category)) return;

        const MAX_PLAYERS = 10;

        let newName = `━━━〔 PLAYERS ONLINE: ${count}/${MAX_PLAYERS} 〕━━━`;

        if (count >= 5) {
          newName = `━━━〔 PLAYERS ONLINE: ${count}/${MAX_PLAYERS} 🔥 〕━━━`;
        }

        if ((category as any).name === newName) return;

        await (category as any).setName(newName);

        console.log(`🟢 Categoria atualizada: ${count}`);
      } catch (err) {
        console.error("❌ erro ao atualizar categoria online", err);
      }
    }

    function mapPlayers(obj: any) {
      return Object.entries(obj || {})
        .map(([name, d]: any) => ({ name, ...d }))
        .sort((a, b) => b.kills - a.kills);
    }

    async function sendOrEdit(channel: any, file: string, embed: any) {
      let messageId: string | null = null;

      if (fs.existsSync(file)) {
        try {
          messageId = JSON.parse(fs.readFileSync(file, "utf-8")).id;
        } catch {
          messageId = null;
        }
      }

      let message;

      if (messageId) {
        try {
          message = await channel.messages.fetch(messageId);
        } catch {
          message = null;
        }
      }

      if (message) {
        await message.edit({ embeds: [embed] });
      } else {
        const newMsg = await channel.send({ embeds: [embed] });
        fs.writeFileSync(file, JSON.stringify({ id: newMsg.id }, null, 2));
      }
    }

    async function updateLeaderboard() {
      if (discordLoopRunning) return;
      discordLoopRunning = true;

      try {
        const state = getState();

        const globalPlayers = mapPlayers(state.players);
        const dailyPlayers = mapPlayers(state.dailyPlayers);
        const weeklyPlayers = mapPlayers(state.weeklyPlayers);

        await sendOrEdit(
          globalChannel,
          MESSAGE_FILE_GLOBAL,
          formatLeaderboardEmbed(globalPlayers, "🏆 **LEADERBOARD GERAL** 🏆"),
        );

        await sendOrEdit(
          dailyChannel,
          MESSAGE_FILE_DAILY,
          formatLeaderboardEmbed(dailyPlayers, "🌅 **LEADERBOARD DO DIA** 🌅"),
        );

        await sendOrEdit(
          weeklyChannel,
          MESSAGE_FILE_WEEKLY,
          formatLeaderboardEmbed(
            weeklyPlayers,
            "📆 **LEADERBOARD SEMANAL** 📆",
          ),
        );

        await updateOnlineCount();

        console.log("🏆 leaderboards atualizados");
      } catch (err) {
        console.error("❌ erro ao atualizar leaderboard", err);
      } finally {
        discordLoopRunning = false;
      }
    }

    let lastOnlineCount = -1;
    let lastUpdateTime = 0;

    async function dynamicUpdateLoop() {
      try {
        const count = getOnlineCount();
        const now = Date.now();

        let shouldUpdate = false;

        if (count !== lastOnlineCount) {
          shouldUpdate = true;
          lastOnlineCount = count;
        }

        if (now - lastUpdateTime > 2 * 60 * 1000) {
          shouldUpdate = true;
        }

        if (shouldUpdate) {
          await updateLeaderboard();
          lastUpdateTime = now;
        }
      } catch (err) {
        console.error("❌ erro no loop Discord:", err);
      }
    }

    await updateLeaderboard();

    setInterval(
      () => {
        dynamicUpdateLoop();
      },
      2 * 60 * 1000,
    );
  });

  try {
    await client.login(process.env.DISCORD_TOKEN);
    console.log("✅ login Discord OK");
  } catch (err) {
    console.error("❌ erro ao logar no Discord:", err);
  }
}
