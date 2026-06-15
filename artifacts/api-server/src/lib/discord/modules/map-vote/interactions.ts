import { setPlayerLocale } from "../../../playerLinks";
import {
  buildMapVoteExplanationPayload,
  buildMapVoteLanguagePromptPayload,
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

async function safeReply(interaction: any, payload: any) {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload);
    return;
  }
  await interaction.reply(payload);
}

async function safeUpdate(interaction: any, payload: any) {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload);
    return;
  }
  if (interaction.update) {
    await interaction.update(payload);
    return;
  }
  await interaction.reply({ ...payload, ephemeral: true });
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

    await ctx.saveState(state);
    await safeUpdate(interaction, buildMapVoteExplanationPayload(locale));
    return true;
  }

  return false;
}
