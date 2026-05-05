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

export async function startDiscordBot(getLeaderboard: () => any) {
  if (!process.env.DISCORD_TOKEN) return;

  client.once("clientReady", async () => {
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

    function mapPlayers(obj: any) {
      return Object.entries(obj)
        .map(([name, d]: any) => ({ name, ...d }))
        .sort((a, b) => b.kills - a.kills);
    }

    function format(players: any[], title: string) {
      const embed = new EmbedBuilder().setColor("#FF00AA");

      if (!players.length) {
        embed.setDescription(`${title}\n\nSem dados ainda...`);
        return embed;
      }

      let desc = `${title}\n\n`;

      players.slice(0, 10).forEach((p, i) => {
        const kd =
          p.deaths > 0 ? (p.kills / p.deaths).toFixed(2) : p.kills.toFixed(2);

        desc += `${i + 1}. ${p.name} — ${p.kills} kills — K/D ${kd}\n`;
      });

      const ts = Math.floor(Date.now() / 1000);
      desc += `\n⏱️ Atualizado <t:${ts}:R>`;

      embed.setDescription(desc);
      return embed;
    }

    async function sendOrEdit(channel: any, file: string, embed: any) {
      let id: string | null = null;

      if (fs.existsSync(file)) {
        id = JSON.parse(fs.readFileSync(file, "utf-8")).id;
      }

      let msg;

      if (id) {
        try {
          msg = await channel.messages.fetch(id);
        } catch {
          msg = null;
        }
      }

      if (msg) {
        await msg.edit({ embeds: [embed] });
      } else {
        const newMsg = await channel.send({ embeds: [embed] });
        fs.writeFileSync(file, JSON.stringify({ id: newMsg.id }));
      }
    }

    async function update() {
      const data = getLeaderboard();

      await sendOrEdit(
        globalChannel,
        MESSAGE_FILE_GLOBAL,
        format(mapPlayers(data.global), "🏆 GERAL"),
      );

      await sendOrEdit(
        dailyChannel,
        MESSAGE_FILE_DAILY,
        format(mapPlayers(data.daily), "🌅 DIÁRIO"),
      );

      await sendOrEdit(
        weeklyChannel,
        MESSAGE_FILE_WEEKLY,
        format(mapPlayers(data.weekly), "📆 SEMANAL"),
      );

      console.log("🏆 atualizado");
    }

    async function loop() {
      await update();

      setTimeout(loop, 5 * 60 * 1000); // sempre atualiza
    }

    await update();
    loop();
  });

  await client.login(process.env.DISCORD_TOKEN);
}
