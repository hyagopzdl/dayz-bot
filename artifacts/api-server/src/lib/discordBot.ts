import { Client, GatewayIntentBits, TextBasedChannel } from "discord.js";
import fs from "fs";

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const MESSAGE_FILE = "message.json";

export async function startDiscordBot(getLeaderboard: () => any[]) {
  await client.login(process.env.DISCORD_TOKEN);

  client.once("clientReady", async () => {
    console.log("🤖 Discord conectado");

    const channel = (await client.channels.fetch(
      process.env.DISCORD_CHANNEL_ID!,
    )) as TextBasedChannel;

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

    function formatLeaderboard(players: any[]) {
      if (!players.length) {
        return "\n\n🏆 **Top 10 PvP FaxaDeGaza®** 🏆\n\n\nSem dados ainda...\n";
      }

      const maxName = Math.max(...players.map((p) => p.name.length)) + 2;

      let msg = "";

      // topo
      msg += "\n\n";

      // título
      msg += "🏆 **Top 10 PvP FaxaDeGaza®** 🏆\n\n\n";

      players.slice(0, 10).forEach((p, i) => {
        const rank = getRank(i);

        const name = padEnd(p.name, maxName);
        const kills = padStart(String(p.kills), 5);
        const kd = Number(p.kd).toFixed(2);

        msg += `${rank} \`${name}\` \`${kills} kills\` \`  K/D ${kd}\`\n\n`;
      });

      // data
      const now = new Date();
      const formatted =
        now.toLocaleDateString("pt-BR") +
        " " +
        now.toLocaleTimeString("pt-BR", {
          hour: "2-digit",
          minute: "2-digit",
        });

      msg += `\nAtualizado em \`${formatted}\`\n`;

      return msg;
    }

    async function updateLeaderboard() {
      try {
        const data = getLeaderboard();

        const content = formatLeaderboard(data);

        let message;

        if (messageId) {
          try {
            message = await channel.messages.fetch(messageId);
          } catch {
            message = null;
          }
        }

        if (message) {
          await message.edit(content);
        } else {
          const newMsg = await channel.send(content);
          messageId = newMsg.id;

          fs.writeFileSync(MESSAGE_FILE, JSON.stringify({ id: messageId }));
        }

        console.log("🏆 leaderboard atualizado");
      } catch (err) {
        console.error("❌ erro ao atualizar leaderboard", err);
      }
    }

    // 🔥 primeira execução imediata
    await updateLeaderboard();

    // 🔁 atualiza a cada 60s
    setInterval(updateLeaderboard, 60 * 1000);
  });
}
