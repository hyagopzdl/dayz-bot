import {
  Client,
  GatewayIntentBits,
  TextBasedChannel,
  EmbedBuilder,
  PermissionsBitField,
} from "discord.js";
import fs from "fs";
import path from "path";

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const STATE_FILE = path.resolve(process.cwd(), "state.json");

const MESSAGE_FILE_GLOBAL = "message_global.json";
const MESSAGE_FILE_DAILY = "message_daily.json";
const MESSAGE_FILE_WEEKLY = "message_weekly.json";
const MESSAGE_FILE_ONLINE_LIST = "message_online_list.json";

const KILLFEED_PAGE_SIZE = 10;
const KILLFEED_MESSAGE_PREFIX = "message_killfeed_page_";

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

    const onlineListChannel = process.env.DISCORD_ONLINE_LIST_CHANNEL_ID
      ? ((await client.channels.fetch(
          process.env.DISCORD_ONLINE_LIST_CHANNEL_ID,
        )) as TextBasedChannel)
      : null;

    const killfeedChannel = process.env.DISCORD_KILLFEED_CHANNEL_ID
      ? ((await client.channels.fetch(
          process.env.DISCORD_KILLFEED_CHANNEL_ID,
        )) as TextBasedChannel)
      : null;

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

    function getState() {
      try {
        const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));

        console.log("📊 Discord lendo state:", {
          file: STATE_FILE,
          global: Object.keys(state.players || {}).length,
          daily: Object.keys(state.dailyPlayers || {}).length,
          weekly: Object.keys(state.weeklyPlayers || {}).length,
          online: Object.keys(state.onlinePlayers || {}).length,
          killfeed: (state.killFeedEvents || []).length,
        });

        return state;
      } catch (err) {
        console.error("❌ Discord não conseguiu ler state.json:", err);
        return {};
      }
    }

    function saveState(state: any) {
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      console.log("💾 state salvo pelo Discord");
    }

    function resetRankings() {
      const state = getState();

      state.players = {};
      state.dailyPlayers = {};
      state.weeklyPlayers = {};
      state.killFeedEvents = [];

      state.files = state.files || {};
      state.recentEventIds = state.recentEventIds || [];
      state.onlinePlayers = state.onlinePlayers || {};

      const now = new Date();

      const formatter = new Intl.DateTimeFormat("pt-BR", {
        timeZone: "America/Sao_Paulo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });

      const parts = formatter.formatToParts(now);
      const map: Record<string, string> = {};

      parts.forEach((p) => {
        map[p.type] = p.value;
      });

      state.lastDailyReset = `${map.year}-${map.month}-${map.day}`;
      state.lastWeeklyReset = state.lastWeeklyReset || "";

      saveState(state);
    }

    function getOnlineCount(): number {
      const state = getState();
      return Object.keys(state.onlinePlayers || {}).length;
    }

    function mapPlayers(obj: any) {
      return Object.entries(obj || {})
        .map(([name, d]: any) => ({ name, ...d }))
        .sort((a, b) => b.kills - a.kills);
    }

    function getOnlinePlayerNames(state: any) {
      return Object.keys(state.onlinePlayers || {}).sort((a, b) =>
        a.localeCompare(b),
      );
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

    function formatOnlineListEmbed(state: any) {
      const players = getOnlinePlayerNames(state);
      const timestamp = Math.floor(Date.now() / 1000);

      const embed = new EmbedBuilder()
        .setColor("#00FF88")
        .setTitle(`🟢 PLAYERS ONLINE (${players.length}/10)`);

      if (!players.length) {
        embed.setDescription(
          `Nenhum jogador online no momento.\n\n⏱️ Atualizado <t:${timestamp}:R>`,
        );
        return embed;
      }

      const list = players.map((name) => `• ${name}`).join("\n");

      embed.setDescription(`${list}\n\n⏱️ Atualizado <t:${timestamp}:R>`);

      return embed;
    }

    function chunkArray<T>(items: T[], size: number): T[][] {
      const chunks: T[][] = [];

      for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
      }

      return chunks;
    }

    function killfeedPageFile(pageIndex: number) {
      return `${KILLFEED_MESSAGE_PREFIX}${pageIndex}.json`;
    }

    function formatWeapon(weapon: string | undefined) {
      const clean = weapon?.trim();

      if (!clean || clean.toLowerCase() === "unknown") {
        return "Unknown";
      }

      return clean;
    }

    function formatKillFeedEmbed(event: any) {
      const killer = event.killer || "Unknown";
      const victim = event.victim || "Unknown";
      const weapon = formatWeapon(event.weapon);

      return new EmbedBuilder()
        .setColor("#FF3333")
        .setDescription(
          `**${killer}** \`[${weapon}]\` killed 💀 **${victim}**`,
        );
    }

    async function sendOrEdit(channel: any, file: string, embedOrEmbeds: any) {
      const embeds = Array.isArray(embedOrEmbeds)
        ? embedOrEmbeds
        : [embedOrEmbeds];

      let messageId: string | null = null;

      if (fs.existsSync(file)) {
        try {
          messageId = JSON.parse(fs.readFileSync(file, "utf-8")).id;
        } catch {
          messageId = null;
        }
      }

      let message: any = null;

      if (messageId) {
        try {
          message = await channel.messages.fetch(messageId);
        } catch {
          message = null;
        }
      }

      if (message) {
        await message.edit({ embeds });
        console.log(`✏️ mensagem editada: ${file}`);
        return;
      }

      const newMsg = await channel.send({ embeds });
      fs.writeFileSync(file, JSON.stringify({ id: newMsg.id }, null, 2));

      console.log(`📨 nova mensagem enviada: ${file}`);
    }

    async function deleteMessageByFile(channel: any, file: string) {
      if (!fs.existsSync(file)) return;

      try {
        const messageId = JSON.parse(fs.readFileSync(file, "utf-8")).id;

        if (messageId) {
          try {
            const message = await channel.messages.fetch(messageId);
            await message.delete();
            console.log(`🗑️ mensagem removida: ${file}`);
          } catch {
            console.log(`⚠️ mensagem extra não encontrada no Discord: ${file}`);
          }
        }
      } catch {
        // ignora arquivo inválido
      }

      try {
        fs.unlinkSync(file);
      } catch {
        // ignora erro ao remover arquivo local
      }
    }

    async function deleteExtraKillFeedPages(channel: any, neededPages: number) {
      const files = fs
        .readdirSync(process.cwd())
        .filter(
          (file) =>
            file.startsWith(KILLFEED_MESSAGE_PREFIX) && file.endsWith(".json"),
        );

      for (const file of files) {
        const match = file.match(
          new RegExp(`^${KILLFEED_MESSAGE_PREFIX}(\\d+)\\.json$`),
        );

        if (!match) continue;

        const pageIndex = Number(match[1]);

        if (pageIndex >= neededPages) {
          await deleteMessageByFile(channel, file);
        }
      }
    }

    async function updateOnlineCount() {
      try {
        const count = getOnlineCount();

        const category = await client.channels.fetch(CATEGORY_ID);

        if (!category || !("setName" in category)) {
          console.error("❌ canal/categoria online inválido");
          return;
        }

        const MAX_PLAYERS = 10;

        let newName = `━━━〔 PLAYERS ONLINE: ${count}/${MAX_PLAYERS} 〕━━━`;

        if (count >= 5) {
          newName = `━━━〔 PLAYERS ONLINE: ${count}/${MAX_PLAYERS} 🔥 〕━━━`;
        }

        if ((category as any).name === newName) {
          console.log(`🟢 Categoria já está atualizada: ${newName}`);
          return;
        }

        await (category as any).setName(newName);

        console.log(`🟢 Categoria atualizada: ${newName}`);
      } catch (err) {
        console.error("❌ erro ao atualizar categoria online", err);
      }
    }

    async function updateOnlineList(state: any) {
      if (!onlineListChannel) {
        console.log("⚠️ DISCORD_ONLINE_LIST_CHANNEL_ID não configurado");
        return;
      }

      await sendOrEdit(
        onlineListChannel,
        MESSAGE_FILE_ONLINE_LIST,
        formatOnlineListEmbed(state),
      );
    }

    async function updateKillFeed(state: any) {
      if (!killfeedChannel) {
        console.log("⚠️ DISCORD_KILLFEED_CHANNEL_ID não configurado");
        return;
      }

      const events = [...(state.killFeedEvents || [])].reverse();

      if (!events.length) {
        const emptyEmbed = new EmbedBuilder()
          .setColor("#FF3333")
          .setDescription("Nenhuma kill nova desde a última atualização.");

        await sendOrEdit(killfeedChannel, killfeedPageFile(0), [emptyEmbed]);
        await deleteExtraKillFeedPages(killfeedChannel, 1);
        return;
      }

      const pages = chunkArray(events, KILLFEED_PAGE_SIZE);

      for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
        const embeds = pages[pageIndex].map(formatKillFeedEmbed);

        await sendOrEdit(killfeedChannel, killfeedPageFile(pageIndex), embeds);
      }

      await deleteExtraKillFeedPages(killfeedChannel, pages.length);

      const freshState = getState();
      freshState.killFeedEvents = [];
      saveState(freshState);

      console.log(
        `🧹 killfeed limpo após atualização (${events.length} eventos em ${pages.length} página(s))`,
      );
    }

    async function updateLeaderboard() {
      if (discordLoopRunning) {
        console.log("⏭️ Discord update ignorado: anterior ainda rodando");
        return;
      }

      discordLoopRunning = true;

      try {
        console.log("🔄 Discord tick");

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
        await updateOnlineList(state);
        await updateKillFeed(state);

        console.log("🏆 leaderboards atualizados");
      } catch (err) {
        console.error("❌ erro ao atualizar leaderboard", err);
      } finally {
        discordLoopRunning = false;
      }
    }

    async function registerCommands() {
      try {
        const command = {
          name: "reset-ranking",
          description: "Zera todos os rankings sem reprocessar logs antigos.",
          defaultMemberPermissions:
            PermissionsBitField.Flags.Administrator.toString(),
          dmPermission: false,
        };

        if (process.env.DISCORD_SERVER_ID) {
          const guild = await client.guilds.fetch(
            process.env.DISCORD_SERVER_ID,
          );
          await guild.commands.create(command);
          console.log("✅ comando /reset-ranking registrado no servidor");
        } else {
          await client.application?.commands.create(command);
          console.log("✅ comando /reset-ranking registrado globalmente");
        }
      } catch (err) {
        console.error("❌ erro registrando /reset-ranking:", err);
      }
    }

    client.on("interactionCreate", async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName !== "reset-ranking") return;

      try {
        if (
          !interaction.memberPermissions?.has(
            PermissionsBitField.Flags.Administrator,
          )
        ) {
          await interaction.reply({
            content: "❌ Apenas administradores podem usar este comando.",
            ephemeral: true,
          });
          return;
        }

        await interaction.deferReply({ ephemeral: true });

        resetRankings();
        await updateLeaderboard();

        await interaction.editReply(
          "✅ Rankings zerados com sucesso. Os cursores dos logs foram mantidos para evitar reprocessamento antigo.",
        );
      } catch (err) {
        console.error("❌ erro no /reset-ranking:", err);

        if (interaction.deferred || interaction.replied) {
          await interaction.editReply("❌ Erro ao resetar rankings.");
        } else {
          await interaction.reply({
            content: "❌ Erro ao resetar rankings.",
            ephemeral: true,
          });
        }
      }
    });

    await registerCommands();
    await updateLeaderboard();

    setInterval(
      async () => {
        await updateLeaderboard();
      },
      5 * 60 * 1000,
    );
  });

  try {
    await client.login(process.env.DISCORD_TOKEN);
    console.log("✅ login Discord OK");
  } catch (err) {
    console.error("❌ erro ao logar no Discord:", err);
  }
}
