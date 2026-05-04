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

// 🔥 arquivos separados
const MESSAGE_FILE_GLOBAL = "message_global.json";
const MESSAGE_FILE_DAILY = "message_daily.json";
const MESSAGE_FILE_WEEKLY = "message_weekly.json";

export async function startDiscordBot(getLeaderboard: () => any) {
  if (!process.env.DISCORD_TOKEN) {
    console.error("❌ DISCORD_TOKEN não definido");
    return;
  }

  client.on("ready", async () => {
    console.log("🤖 Discord conectado");

    // 🔥 canais separados
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

      if (!players.length) {
        embed.setDescription(`
${title}

Sem dados ainda...
        `);
        return embed;
      }

      const maxName = Math.max(...players.map((p) => p.name.length)) + 2;

      let description = `${title}\n\n`;

      players.slice(0, 10).forEach((p, i) => {
        const rank = getRank(i);

        const name = padEnd(p.name, maxName);
        const kills = padStart(String(p.kills), 5);
        const kd =
          p.deaths > 0 ? (p.kills / p.deaths).toFixed(2) : p.kills.toFixed(2);

        description += `${rank} \`${name}\` \`${kills} kills\` \`K/D ${kd}\`\n`;
      });

      const timestamp = Math.floor(Date.now() / 1000);
      description += `\n\n⏱️ Atualizado <t:${timestamp}:R>`;

      embed.setDescription(description);

      return embed;
    }

    async function updateOnlineCount() {
      try {
        const state = JSON.parse(fs.readFileSync("state.json", "utf-8"));
        const onlinePlayers = state.onlinePlayers || {};
        const count = Object.keys(onlinePlayers).length;

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
      return Object.entries(obj)
        .map(([name, d]: any) => ({ name, ...d }))
        .sort((a, b) => b.kills - a.kills);
    }

    async function sendOrEdit(channel: any, file: string, embed: any) {
      let messageId: string | null = null;

      if (fs.existsSync(file)) {
        messageId = JSON.parse(fs.readFileSync(file, "utf-8")).id;
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
        fs.writeFileSync(file, JSON.stringify({ id: newMsg.id }));
      }
    }

    async function updateLeaderboard() {
      try {
        const data = getLeaderboard();

        const globalPlayers = mapPlayers(data.global);
        const dailyPlayers = mapPlayers(data.daily);
        const weeklyPlayers = mapPlayers(data.weekly);

        const globalEmbed = formatLeaderboardEmbed(
          globalPlayers,
          "🏆 **LEADERBOARD GERAL** 🏆",
        );

        const dailyEmbed = formatLeaderboardEmbed(
          dailyPlayers,
          "🌅 **LEADERBOARD DO DIA** 🌅",
        );

        const weeklyEmbed = formatLeaderboardEmbed(
          weeklyPlayers,
          "📆 **LEADERBOARD SEMANAL** 📆",
        );

        await sendOrEdit(globalChannel, MESSAGE_FILE_GLOBAL, globalEmbed);
        await sendOrEdit(dailyChannel, MESSAGE_FILE_DAILY, dailyEmbed);
        await sendOrEdit(weeklyChannel, MESSAGE_FILE_WEEKLY, weeklyEmbed);

        await updateOnlineCount();

        console.log("🏆 leaderboards atualizados");
      } catch (err) {
        console.error("❌ erro ao atualizar leaderboard", err);
      }
    }

    async function getOnlineCount(): Promise<number> {
      try {
        const state = JSON.parse(fs.readFileSync("state.json", "utf-8"));
        const onlinePlayers = state.onlinePlayers || {};
        return Object.keys(onlinePlayers).length;
      } catch {
        return 0;
      }
    }

    let lastOnlineCount = -1;

    async function dynamicUpdateLoop() {
      const count = await getOnlineCount();

      if (count !== lastOnlineCount) {
        console.log(`🔄 mudança detectada: ${lastOnlineCount} → ${count}`);
        await updateLeaderboard();
        lastOnlineCount = count;
      } else {
        console.log("⏭️ sem mudança, pulando update");
      }

      let delay = 5 * 60 * 1000;

      if (count === 0) delay = 20 * 60 * 1000;
      else if (count === 1) delay = 15 * 60 * 1000;
      else delay = 5 * 60 * 1000;

      console.log(`⏱️ próximo update em ${delay / 1000}s (${count} online)`);

      setTimeout(dynamicUpdateLoop, delay);
    }

    await updateLeaderboard();
    dynamicUpdateLoop();
  });

  try {
    await client.login(process.env.DISCORD_TOKEN);
    console.log("✅ login Discord OK");
  } catch (err) {
    console.error("❌ erro ao logar no Discord:", err);
  }
}
