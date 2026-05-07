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

const KILLFEED_PAGE_SIZE = 9;
const KILLFEED_MESSAGE_PREFIX = "message_killfeed_page_";

const BOT_NAME = "PZ's DayZ Bot";

const BOT_ICON =
  "https://media.discordapp.net/attachments/1501806293583659048/1501806438178099211/pzbot.png?ex=69fd69bd&is=69fc183d&hm=470c5555d05e0657d935ca7cba8d701475c15185ebcd6e6c549c9b945787ee6b&=&format=webp&quality=lossless&width=1526&height=1526";

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

    function formatDate(dateString?: string) {
      if (!dateString) return "Unknown";

      const date = new Date(`${dateString}T00:00:00`);

      return new Intl.DateTimeFormat("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      }).format(date);
    }

    function getRelativeDays(dateString?: string) {
      if (!dateString) return "Unknown";

      const start = new Date(`${dateString}T00:00:00`).getTime();
      const now = Date.now();

      const days = Math.max(
        0,
        Math.floor((now - start) / (1000 * 60 * 60 * 24)),
      );

      if (days === 0) return "today";
      if (days === 1) return "1 day ago";

      return `${days} days ago`;
    }

    function getNextDailyResetTimestamp() {
      const now = new Date();
      const next = new Date(now);

      next.setUTCHours(3, 0, 0, 0);

      if (next.getTime() <= now.getTime()) {
        next.setUTCDate(next.getUTCDate() + 1);
      }

      return Math.floor(next.getTime() / 1000);
    }

    function getNextWeeklyResetTimestamp() {
      const now = new Date();
      const next = new Date(now);

      next.setUTCHours(3, 0, 0, 0);

      const currentDay = next.getUTCDay();
      const daysUntilMonday = currentDay === 1 ? 7 : (8 - currentDay) % 7;

      next.setUTCDate(next.getUTCDate() + daysUntilMonday);

      return Math.floor(next.getTime() / 1000);
    }

    function getDailyResetTime() {
      const ts = getNextDailyResetTimestamp();
      return `Resets <t:${ts}:R> • <t:${ts}:t>`;
    }

    function getWeeklyResetTime() {
      const ts = getNextWeeklyResetTimestamp();
      return `Resets <t:${ts}:R> • <t:${ts}:F>`;
    }

    function buildHeader(emoji: string, title: string, subtitle: string) {
      return `\u200B\n${emoji} **${title}**\n${subtitle}\n\u200B\n`;
    }

    function buildFooter() {
      const timestamp = Math.floor(Date.now() / 1000);
      return `\n\n⏱️ Updated <t:${timestamp}:R>`;
    }

    function createBaseEmbed(color: string, withAuthor = true) {
      const embed = new EmbedBuilder().setColor(color);

      if (withAuthor) {
        embed.setAuthor({
          name: BOT_NAME,
          iconURL: BOT_ICON,
        });
      }

      return embed;
    }

    function resetRankings() {
      const state = getState();
      const today = new Date().toISOString().slice(0, 10);

      state.players = {};
      state.dailyPlayers = {};
      state.weeklyPlayers = {};
      state.killFeedEvents = [];

      state.globalStartedAt = today;
      state.dailyStartedAt = today;
      state.weeklyStartedAt = today;

      state.files = state.files || {};
      state.recentEventIds = state.recentEventIds || [];
      state.onlinePlayers = state.onlinePlayers || {};

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

    function formatLeaderboardEmbed(
      players: any[],
      options: {
        emoji: string;
        title: string;
        subtitle: string;
        color: string;
      },
    ) {
      const embed = createBaseEmbed(options.color);

      if (!players.length) {
        embed.setDescription(
          buildHeader(options.emoji, options.title, options.subtitle) +
            `**No data available yet**\nStart playing and claim the top spot!` +
            buildFooter(),
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

      let description = buildHeader(
        options.emoji,
        options.title,
        options.subtitle,
      );

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

      description += buildFooter();

      embed.setDescription(description);

      return embed;
    }

    function formatOnlineListEmbed(state: any) {
      const players = getOnlinePlayerNames(state);
      const embed = createBaseEmbed("#00FF88");

      if (!players.length) {
        embed.setDescription(
          buildHeader("🟢", "Players Online", "Live server activity") +
            `**No players online**\nThe server is currently quiet.` +
            buildFooter(),
        );

        return embed;
      }

      const list = players.map((name) => `• ${name}`).join("\n");

      embed.setDescription(
        buildHeader(
          "🟢",
          "Players Online",
          `${players.length}/10 survivors currently connected`,
        ) +
          `${list}` +
          buildFooter(),
      );

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

    function createKillFeedHeaderEmbed(eventsCount: number) {
      return createBaseEmbed("#FF3333").setDescription(
        buildHeader(
          "🔫",
          "Kill Feed",
          `${eventsCount} recent kill${eventsCount === 1 ? "" : "s"} detected`,
        ) + `Tracking the latest PvP activity across the server.`,
      );
    }

    function createKillFeedEmptyEmbed() {
      return createBaseEmbed("#FF3333").setDescription(
        buildHeader("🔫", "Kill Feed", "Live PvP activity") +
          `**No recent kills**\nKill someone and keep the feed alive!`,
      );
    }

    function formatKillFeedEmbed(event: any) {
      const killer = event.killer || "Unknown";
      const victim = event.victim || "Unknown";
      const weapon = formatWeapon(event.weapon);

      return createBaseEmbed("#FF3333", false).setDescription(
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
          } catch {}
        }
      } catch {}

      try {
        fs.unlinkSync(file);
      } catch {}
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
          return;
        }

        await (category as any).setName(newName);
      } catch (err) {
        console.error("❌ erro ao atualizar categoria online", err);
      }
    }

    async function updateOnlineList(state: any) {
      if (!onlineListChannel) {
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
        return;
      }

      const events = [...(state.killFeedEvents || [])].reverse();

      if (!events.length) {
        await sendOrEdit(killfeedChannel, killfeedPageFile(0), [
          createKillFeedEmptyEmbed(),
        ]);

        await deleteExtraKillFeedPages(killfeedChannel, 1);

        return;
      }

      const pages = chunkArray(events, KILLFEED_PAGE_SIZE);

      for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
        const embeds = pages[pageIndex].map(formatKillFeedEmbed);

        if (pageIndex === 0) {
          embeds.unshift(createKillFeedHeaderEmbed(events.length));
        }

        await sendOrEdit(killfeedChannel, killfeedPageFile(pageIndex), embeds);
      }

      await deleteExtraKillFeedPages(killfeedChannel, pages.length);

      const freshState = getState();
      freshState.killFeedEvents = [];
      saveState(freshState);
    }

    async function updateLeaderboard() {
      if (discordLoopRunning) {
        return;
      }

      discordLoopRunning = true;

      try {
        const state = getState();

        if (!state.globalStartedAt) {
          state.globalStartedAt =
            state.lastDailyReset ||
            state.lastWeeklyReset ||
            new Date().toISOString().slice(0, 10);

          saveState(state);
        }

        const globalPlayers = mapPlayers(state.players);
        const dailyPlayers = mapPlayers(state.dailyPlayers);
        const weeklyPlayers = mapPlayers(state.weeklyPlayers);

        await sendOrEdit(
          globalChannel,
          MESSAGE_FILE_GLOBAL,
          formatLeaderboardEmbed(globalPlayers, {
            emoji: "🏆",
            title: "General Ranking",
            subtitle: `Count started on ${formatDate(
              state.globalStartedAt,
            )} (${getRelativeDays(state.globalStartedAt)})`,
            color: "#FFD700",
          }),
        );

        await sendOrEdit(
          dailyChannel,
          MESSAGE_FILE_DAILY,
          formatLeaderboardEmbed(dailyPlayers, {
            emoji: "🌅",
            title: "Daily Ranking",
            subtitle: getDailyResetTime(),
            color: "#FF00AA",
          }),
        );

        await sendOrEdit(
          weeklyChannel,
          MESSAGE_FILE_WEEKLY,
          formatLeaderboardEmbed(weeklyPlayers, {
            emoji: "📆",
            title: "Weekly Ranking",
            subtitle: getWeeklyResetTime(),
            color: "#0099FF",
          }),
        );

        await updateOnlineCount();
        await updateOnlineList(state);
        await updateKillFeed(state);
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
          description: "Reset all rankings without reprocessing old logs.",
          defaultMemberPermissions:
            PermissionsBitField.Flags.Administrator.toString(),
          dmPermission: false,
        };

        if (process.env.DISCORD_SERVER_ID) {
          const guild = await client.guilds.fetch(
            process.env.DISCORD_SERVER_ID,
          );

          await guild.commands.create(command);
        } else {
          await client.application?.commands.create(command);
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
            content: "❌ Only administrators can use this command.",
            ephemeral: true,
          });

          return;
        }

        await interaction.deferReply({ ephemeral: true });

        resetRankings();
        await updateLeaderboard();

        await interaction.editReply("✅ Rankings successfully reset.");
      } catch (err) {
        console.error("❌ erro no /reset-ranking:", err);

        if (interaction.deferred || interaction.replied) {
          await interaction.editReply("❌ Failed to reset rankings.");
        } else {
          await interaction.reply({
            content: "❌ Failed to reset rankings.",
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
