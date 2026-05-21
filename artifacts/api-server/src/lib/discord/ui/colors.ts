export const DISCORD_COLORS = {
  system: 0x2f80ed,
  economy: 0xf2c94c,
  success: 0x22c55e,
  warning: 0xf59e0b,
  danger: 0xef4444,
  neutral: 0x94a3b8,
  shop: 0x57f287,
} as const;

export type DiscordColorTone = keyof typeof DISCORD_COLORS;
