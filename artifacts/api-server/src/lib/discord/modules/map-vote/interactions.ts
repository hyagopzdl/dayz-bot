import { Routes } from "discord.js";
import crypto from "node:crypto";
import { setPlayerLocale } from "../../../playerLinks";
import {
  buildMapVoteExplanationPayload,
  buildMapVoteLanguagePromptPayload,
  buildMapVotePollContent,
  buildMapVotePollQuestion,
  getMapVoteServerName,
  type MapVoteLocale,
} from "./ui";

export type MapVoteInteractionContext = {
  getState: () => Promise<any>;
  saveState: (state: any) => Promise<void>;
};

function normalizeMapVoteLocale(locale?: string | null): MapVoteLocale {
  if (locale === "pt" || locale === "pt-BR" || locale === "pt_BR") return "pt";
  if (locale === "es" || locale === "es-ES" || locale === "es_ES" || locale === "es-LA") return "es";
  return "en";
}

function ensureMapVoteUserLocales(state: any) {
  state.mapVoteUserLocales = state.mapVoteUserLocales || {};
  return state.mapVoteUserLocales as Record<string, { locale: MapVoteLocale; updatedAt: string }>;
}

function getMapRotationState(state: any) {
  state.mapRotation = state.mapRotation && typeof state.mapRotation === "object" ? state.mapRotation : {};
  state.mapRotation.zones = Array.isArray(state.mapRotation.zones) ? state.mapRotation.zones : [];
  state.mapRotation.settings = state.mapRotation.settings && typeof state.mapRotation.settings === "object" ? state.mapRotation.settings : {};
  return state.mapRotation;
}

function nextWeekdayDate(day: unknown, time: unknown, from = new Date()) {
  const weekdays: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  const targetDay = weekdays[String(day || "sunday")] ?? 0;
  const [hourRaw, minuteRaw] = String(time || "23:59").split(":");
  const hour = Math.max(0, Math.min(23, Number(hourRaw || 0)));
  const minute = Math.max(0, Math.min(59, Number(minuteRaw || 0)));
  const next = new Date(from);
  next.setHours(hour, minute, 0, 0);
  const diff = (targetDay - next.getDay() + 7) % 7;
  next.setDate(next.getDate() + diff);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 7);
  return next;
}

async function activePollMessageExists(client: any, activePoll: any) {
  const channelId = String(activePoll?.channelId || "").trim();
  const messageId = String(activePoll?.messageId || "").trim();
  if (!channelId || !messageId) return false;

  try {
    const route = Routes.channelMessage(channelId, messageId) as `/${string}`;
    await client.rest.get(route);
    return true;
  } catch {
    return false;
  }
}

async function ensureMapVotePoll(interaction: any, state: any): Promise<{ created: boolean; reason?: string }> {
  const rotation = getMapRotationState(state);
  const client = interaction.client;

  if (rotation.activePoll?.messageId) {
    const exists = await activePollMessageExists(client, rotation.activePoll);
    if (exists) return { created: false, reason: "active_poll_exists" };
    rotation.activePoll = undefined;
  }

  const settings = rotation.settings || {};
  const channelId = String(settings.pollChannelId || interaction.channelId || "").trim();
  if (!channelId) return { created: false, reason: "Configure o canal da enquete em Spawn Zones > Settings." };

  const zones = (Array.isArray(rotation.zones) ? rotation.zones : [])
    .filter((zone: any) => zone?.enabled !== false && Array.isArray(zone?.points) && zone.points.length > 0)
    .slice(0, 10);
  if (zones.length < 2) return { created: false, reason: "Crie pelo menos 2 zonas habilitadas com pontos para gerar a enquete." };

  const closeAt = nextWeekdayDate(settings.pollCloseDay, settings.pollCloseTime);
  const durationHours = Math.max(1, Math.min(168, Math.ceil((closeAt.getTime() - Date.now()) / 36e5)));
  const question = String(settings.pollQuestion || buildMapVotePollQuestion()).trim() || buildMapVotePollQuestion();

  const body = {
    content: buildMapVotePollContent(),
    poll: {
      question: { text: question },
      answers: zones.map((zone: any) => ({ poll_media: { text: String(zone.name || "Zona") } })),
      duration: durationHours,
      allow_multiselect: false,
      layout_type: 1,
    },
    allowed_mentions: { parse: [] },
  };

  const route = Routes.channelMessages(channelId) as `/${string}`;
  const message = (await client.rest.post(route, { body })) as any;
  const messageId = String(message?.id || "");
  if (!messageId) return { created: false, reason: "Discord não retornou o ID da mensagem da enquete." };

  rotation.settings = { ...settings, pollChannelId: channelId };
  rotation.activePoll = {
    id: crypto.randomUUID(),
    channelId,
    messageId,
    question,
    status: "active",
    createdAt: new Date().toISOString(),
    closesAt: closeAt.toISOString(),
    options: zones.map((zone: any, index: number) => ({ zoneId: String(zone.id || ""), name: String(zone.name || "Zona"), answerId: index + 1, votes: 0 })),
    totalVotes: 0,
    rawUrl: `https://discord.com/channels/${process.env.DISCORD_SERVER_ID || process.env.DISCORD_GUILD_ID || "@me"}/${channelId}/${messageId}`,
  };

  return { created: true };
}

async function safeReply(interaction: any, payload: any) {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload);
    return;
  }
  await interaction.reply(payload);
}

async function safeFollowUp(interaction: any, payload: any) {
  try {
    if (interaction.followUp) await interaction.followUp(payload);
  } catch {
    // Ignore follow-up failures. The language selection itself already succeeded.
  }
}

export async function handleMapVoteComponentInteraction(interaction: any, ctx: MapVoteInteractionContext) {
  if (!interaction.isButton?.()) return false;

  if (interaction.customId === "map-vote-start") {
    await safeReply(interaction, buildMapVoteLanguagePromptPayload());
    return true;
  }

  if (String(interaction.customId || "").startsWith("map-vote-language:")) {
    const locale = normalizeMapVoteLocale(String(interaction.customId || "").split(":")[1]);
    const state = await ctx.getState();
    const preferences = ensureMapVoteUserLocales(state);
    preferences[interaction.user.id] = { locale, updatedAt: new Date().toISOString() };

    try {
      setPlayerLocale(state, interaction.user.id, locale);
    } catch {
      // The map-vote flow can be used before /link. Store the map-vote preference even if no link exists yet.
    }

    const playerLabel = interaction.user?.id ? `<@${interaction.user.id}>` : interaction.user?.username;
    await safeReply(interaction, buildMapVoteExplanationPayload(locale, {
      playerLabel,
      serverName: getMapVoteServerName(),
    }));

    try {
      const pollResult = await ensureMapVotePoll(interaction, state);
      await ctx.saveState(state);
      if (!pollResult.created && pollResult.reason && pollResult.reason !== "active_poll_exists") {
        await safeFollowUp(interaction, { content: `⚠️ ${pollResult.reason}`, ephemeral: true });
      }
      return true;
    } catch (err) {
      await ctx.saveState(state);
      await safeFollowUp(interaction, {
        content: `⚠️ ${String((err as Error)?.message || err).slice(0, 1500)}`,
        ephemeral: true,
      });
      return true;
    }

    return true;
  }

  return false;
}
