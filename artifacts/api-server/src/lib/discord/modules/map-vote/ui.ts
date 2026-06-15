import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { buildSystemEmbed, buildSuccessEmbed } from "../../ui/embeds";

export type MapVoteLocale = "en" | "pt" | "es";

export const MAP_VOTE_LANGUAGE_OPTIONS: Array<{ locale: MapVoteLocale; emoji: string; label: string }> = [
  { locale: "en", emoji: "🇺🇸", label: "English" },
  { locale: "pt", emoji: "🇧🇷", label: "Português" },
  { locale: "es", emoji: "🇪🇸", label: "Español" },
];

function normalizeMapVoteLocale(locale?: string | null): MapVoteLocale {
  if (locale === "pt" || locale === "pt-BR" || locale === "pt_BR") return "pt";
  if (locale === "es" || locale === "es-ES" || locale === "es_ES" || locale === "es-LA") return "es";
  return "en";
}

export function buildMapVoteStartCustomId() {
  return "map-vote-start";
}

export function buildMapVoteLanguageCustomId(locale: MapVoteLocale) {
  return `map-vote-language:${locale}`;
}

function languageButtons() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...MAP_VOTE_LANGUAGE_OPTIONS.map((option) =>
      new ButtonBuilder()
        .setCustomId(buildMapVoteLanguageCustomId(option.locale))
        .setEmoji(option.emoji)
        .setLabel(option.label)
        .setStyle(ButtonStyle.Secondary),
    ),
  );
}

export function buildMapVotePublicWelcomePayload() {
  const embed = buildSystemEmbed({
    title: "🗺️ Weekly Arena Vote",
    description: [
      "Welcome to the server. Choose your language below to see how the weekly arena vote works.",
      "",
      "Bem-vindo ao servidor. Escolha seu idioma abaixo para ver como funciona a votação semanal de arena.",
      "",
      "Bienvenido al servidor. Elige tu idioma abajo para ver cómo funciona la votación semanal de arena.",
      "",
      "After you choose a language, this message updates and the active poll is posted below when voting is open.",
    ].join("\n"),
    footerSuffix: "map-vote",
  });

  return {
    content: "",
    embeds: [embed],
    components: [languageButtons()],
    allowed_mentions: { parse: [] },
  };
}

export function buildMapVoteLanguagePromptPayload() {
  const embed = buildSystemEmbed({
    title: "🌐 Choose your language",
    description: [
      "Pick your preferred language for bot messages about the weekly arena vote.",
      "",
      "Escolha seu idioma preferido para as mensagens do bot sobre a votação semanal de arena.",
      "",
      "Elige tu idioma preferido para los mensajes del bot sobre la votación semanal de arena.",
    ].join("\n"),
    footerSuffix: "map-vote",
  });

  return {
    embeds: [embed],
    components: [languageButtons()],
    ephemeral: true,
  };
}

const explanationCopy: Record<MapVoteLocale, { title: string; description: string }> = {
  en: {
    title: "🗺️ Next Week Arena Vote",
    description: [
      "Every week, the community chooses the next deathmatch rotation.",
      "",
      "Vote in the poll below to choose the next **arena/spawn zone**.",
      "Voting closes every **Sunday at 11:59 PM**.",
      "",
      "The winning arena goes live after the **Monday 12:00 AM server reset**, and a new vote starts for the following week.",
      "",
      "✅ One vote per player.\n🔁 New rotation every week.\n🎯 Your vote decides where the next deathmatch happens.",
    ].join("\n"),
  },
  pt: {
    title: "🗺️ Votação da Arena da Próxima Semana",
    description: [
      "Toda semana a comunidade escolhe a próxima rotação do servidor.",
      "",
      "Vote na enquete abaixo para escolher a próxima **arena/zona de spawn**.",
      "A votação encerra todo **domingo às 23:59**.",
      "",
      "A arena vencedora entra no **reset de segunda às 00:00**, e uma nova votação começa para a semana seguinte.",
      "",
      "✅ Um voto por player.\n🔁 Nova rotação toda semana.\n🎯 Seu voto decide onde será o próximo deathmatch.",
    ].join("\n"),
  },
  es: {
    title: "🗺️ Votación de la Arena de la Próxima Semana",
    description: [
      "Cada semana la comunidad elige la próxima rotación del servidor.",
      "",
      "Vota en la encuesta de abajo para elegir la próxima **arena/zona de spawn**.",
      "La votación termina todos los **domingos a las 23:59**.",
      "",
      "La arena ganadora entra después del **reinicio del lunes a las 00:00**, y empieza una nueva votación para la semana siguiente.",
      "",
      "✅ Un voto por jugador.\n🔁 Nueva rotación cada semana.\n🎯 Tu voto decide dónde será el próximo deathmatch.",
    ].join("\n"),
  },
};

export function buildMapVoteExplanationPayload(locale?: string | null) {
  const normalized = normalizeMapVoteLocale(locale);
  const copy = explanationCopy[normalized];
  const embed = buildSuccessEmbed({
    title: copy.title,
    description: copy.description,
    footerSuffix: "map-vote",
  });

  return {
    embeds: [embed],
    components: [],
    allowed_mentions: { parse: [] },
  };
}

export function buildMapVotePollQuestion() {
  return "Next Week Arena / Arena da Próxima Semana / Arena de la Próxima Semana";
}

export function buildMapVotePollContent() {
  return [
    "🗳️ **Next Week Arena / Arena da Próxima Semana / Arena de la Próxima Semana**",
    "Voting closes Sunday 23:59. Winner goes live after Monday 00:00 reset.",
  ].join("\n");
}
