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

const MESSAGE_FILE = "message.json";

export async function startDiscordBot(getLeaderboard: () => any[]) {
  if (!process.env.DISCORD_TOKEN) {
    console.error("❌ DISCORD_TOKEN não definido");
    return;
  }

  client.on("ready", async () => {
    console.log("🤖 Discord conectado");

    const channel = (await client.channels.fetch(
      process.env.DISCORD_CHANNEL_ID!,
    )) as TextBasedChannel;

    const CATEGORY_ID = process.env.DISCORD_ONLINE_CHANNEL_ID!;

    let messageId: string | null = null;

    if (fs.existsSync(MESSAGE_FILE)) {
      messageId = JSON.parse(fs.readFileSync(MESSAGE_FILE, "utf-8")).id;
    }

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

    function formatLeaderboardEmbed(players: any[]) {
      const embed = new EmbedBuilder().setColor("#FF00AA");

      if (!players.length) {
        embed.setDescription(`
🏆 **Top 10 PvP FaxaDeGaza®** 🏆

Sem dados ainda...
        `);
        return embed;
      }

      const maxName = Math.max(...players.map((p) => p.name.length)) + 2;

      let description = "";
      description += "🏆 **Top 10 PvP FaxaDeGaza®** 🏆\n\n";

      players.slice(0, 10).forEach((p, i) => {
        const rank = getRank(i);

        const name = padEnd(p.name, maxName);
        const kills = padStart(String(p.kills), 5);
        const kd = Number(p.kd).toFixed(2);

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

        const newName = `🟢 Online: ${count}`;

        if ((category as any).name === newName) return;

        await (category as any).setName(newName);

        console.log(`🟢 Categoria atualizada: ${count}`);
      } catch (err) {
        console.error("❌ erro ao atualizar categoria online", err);
      }
    }

    async function updateLeaderboard() {
      try {
        const data = getLeaderboard();
        const embed = formatLeaderboardEmbed(data);

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
          messageId = newMsg.id;

          fs.writeFileSync(MESSAGE_FILE, JSON.stringify({ id: messageId }));
        }

        await updateOnlineCount();

        console.log("🏆 leaderboard atualizado");
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

      if (count === 0) {
        delay = 20 * 60 * 1000;
      } else if (count === 1) {
        delay = 15 * 60 * 1000;
      } else {
        delay = 5 * 60 * 1000;
      }

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
