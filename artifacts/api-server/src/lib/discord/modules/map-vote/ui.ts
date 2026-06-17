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

export function getMapVoteServerName(value?: string | null) {
  return String(value || process.env.ADMIN_PANEL_SERVER_NAME || process.env.SERVER_NAME || "DayZ Server").trim() || "DayZ Server";
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

export function buildMapVotePublicWelcomePayload(serverNameInput?: string | null, options: { periodLabel?: string } = {}) {
  const serverName = getMapVoteServerName(serverNameInput);
  const periodText = options.periodLabel ? `\n\n🗓️ Rotation period / Período da rotação / Período de rotación: **${options.periodLabel}**` : "";
  const embed = buildSystemEmbed({
    title: `🗳️ Map Vote · ${serverName}`,
    description: [
      "**WELCOME  /  BOAS-VINDAS  /  BIENVENIDO**",
      "",
      "━━━〔 🇺🇸 〕━━━",
      "",
      "🎯 Vote in the active poll below to choose the server's next spawn/deathmatch zone.",
      "",
      "⏳ Voting ends on Sunday at 23:59, and the zone with the most votes will start after Monday's 00:00 reset.",
      "",
      "━━━〔 🇧🇷 〕━━━",
      "",
      "🎯 Vote na enquete ativa abaixo para escolher a próxima zona de spawn/deathmatch do servidor.",
      "",
      "⏳ A votação termina domingo às 23:59, e a zona com mais votos começará após o reset de segunda-feira às 00:00.",
      "",
      "━━━〔 🇪🇸 〕━━━",
      "",
      "🎯 Vota en la encuesta activa de abajo para elegir la próxima zona de spawn/deathmatch del servidor.",
      "",
      "⏳ La votación termina el domingo a las 23:59, y la zona con más votos comenzará después del reinicio del lunes a las 00:00.",
      periodText,
    ].join("\n"),
    footerSuffix: null,
    timestamp: false,
  });

  return {
    content: "",
    embeds: [embed],
    components: [],
    allowed_mentions: { parse: [] },
  };
}

export function buildMapVoteLanguagePromptPayload(serverNameInput?: string | null) {
  const serverName = getMapVoteServerName(serverNameInput);
  const embed = buildSystemEmbed({
    title: `👋 Welcome to ${serverName}`,
    description: [
      "To get started, choose your language below.",
      "",
      `🇧🇷 Bem-vindo ao **${serverName}**. Para começar, escolha seu idioma abaixo.`,
      "",
      `🇪🇸 Bienvenido a **${serverName}**. Para empezar, elige tu idioma abajo.`,
    ].join("\n"),
    footerSuffix: "map-vote",
  });

  return {
    embeds: [embed],
    components: [languageButtons()],
    ephemeral: true,
    allowed_mentions: { parse: [] },
  };
}

type ExplanationOptions = {
  playerLabel?: string | null;
  serverName?: string | null;
};

function playerGreeting(locale: MapVoteLocale, playerLabel?: string | null, serverName?: string | null) {
  const player = String(playerLabel || "").trim();
  const server = getMapVoteServerName(serverName);

  if (locale === "pt") return player ? `Olá, ${player}! Bem-vindo ao **${server}**.` : `Bem-vindo ao **${server}**.`;
  if (locale === "es") return player ? `¡Hola, ${player}! Bienvenido a **${server}**.` : `Bienvenido a **${server}**.`;
  return player ? `Hi, ${player}! Welcome to **${server}**.` : `Welcome to **${server}**.`;
}

const explanationCopy: Record<MapVoteLocale, { title: string; lines: string[] }> = {
  en: {
    title: "🗺️ Next Week Arena Vote",
    lines: [
      "Every week, the community chooses the next server arena.",
      "",
      "Vote in the public poll below to choose the next **spawn/deathmatch zone**.",
      "Voting closes every **Sunday at 11:59 PM**, and the winning arena goes live after the **Monday 12:00 AM reset**.",
      "",
      "✅ One vote per player",
      "🔁 New vote every week",
      "🎯 Your vote decides the next arena",
    ],
  },
  pt: {
    title: "🗺️ Votação da Arena da Próxima Semana",
    lines: [
      "Toda semana a comunidade escolhe a próxima arena do servidor.",
      "",
      "Vote na enquete pública abaixo para escolher a próxima **zona de spawn/deathmatch**.",
      "A votação encerra todo **domingo às 23:59**, e a arena vencedora entra no **reset de segunda às 00:00**.",
      "",
      "✅ Um voto por player",
      "🔁 Nova votação toda semana",
      "🎯 Seu voto decide a próxima arena",
    ],
  },
  es: {
    title: "🗺️ Votación de la Arena de la Próxima Semana",
    lines: [
      "Cada semana la comunidad elige la próxima arena del servidor.",
      "",
      "Vota en la encuesta pública de abajo para elegir la próxima **zona de spawn/deathmatch**.",
      "La votación termina todos los **domingos a las 23:59**, y la arena ganadora entra después del **reinicio del lunes a las 00:00**.",
      "",
      "✅ Un voto por jugador",
      "🔁 Nueva votación cada semana",
      "🎯 Tu voto decide la próxima arena",
    ],
  },
};

export function buildMapVoteExplanationPayload(locale?: string | null, options: ExplanationOptions = {}) {
  const normalized = normalizeMapVoteLocale(locale);
  const copy = explanationCopy[normalized];
  const embed = buildSuccessEmbed({
    title: copy.title,
    description: [playerGreeting(normalized, options.playerLabel, options.serverName), "", ...copy.lines].join("\n"),
    footerSuffix: "map-vote",
  });

  return {
    embeds: [embed],
    components: [],
    ephemeral: true,
    allowed_mentions: { parse: [] },
  };
}

export function buildMapVotePollQuestion() {
  return "Which arena do you want to play next week?";
}

export function buildMapVotePollOptionText(zone: { id?: unknown; name?: unknown }, currentZoneId?: string | null) {
  const name = String(zone?.name || "Arena").trim() || "Arena";
  return String(zone?.id || "") === String(currentZoneId || "") ? `${name} [Actual]` : name;
}

export function buildMapVotePollContent() {
  return "";
}
