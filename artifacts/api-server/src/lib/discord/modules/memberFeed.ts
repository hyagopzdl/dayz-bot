import {
  ChannelType,
  type Client,
  type GuildMember,
  type TextBasedChannel,
} from "discord.js";
import { buildNeutralEmbed, buildSuccessEmbed } from "../ui/embeds";

const MEMBER_FEED_ENABLED = process.env.DISCORD_MEMBER_FEED_ENABLED !== "false";
const MEMBER_FEED_CHANNEL_ID = process.env.DISCORD_MEMBER_FEED_CHANNEL_ID;

function formatDiscordTimestamp(date: Date | null | undefined, style: "f" | "R" = "f") {
  if (!date) return "Unknown";
  return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}

function formatUser(member: GuildMember) {
  return `${member.user.tag} (${member.user.id})`;
}

function isSendableTextChannel(channel: TextBasedChannel | null): channel is TextBasedChannel {
  return Boolean(channel && "send" in channel && typeof channel.send === "function");
}

async function resolveMemberFeedChannel(client: Client) {
  if (!MEMBER_FEED_ENABLED || !MEMBER_FEED_CHANNEL_ID) return null;

  try {
    const channel = await client.channels.fetch(MEMBER_FEED_CHANNEL_ID);
    if (!channel || !isSendableTextChannel(channel as TextBasedChannel)) return null;

    if (
      "type" in channel &&
      channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement
    ) {
      return null;
    }

    return channel;
  } catch (err: any) {
    console.error("❌ erro ao resolver canal do member feed:", err?.message || err);
    return null;
  }
}

async function sendMemberFeedEmbed(client: Client, embed: ReturnType<typeof buildSuccessEmbed>) {
  const channel = await resolveMemberFeedChannel(client);
  if (!channel) return;

  try {
    await channel.send({ embeds: [embed] });
  } catch (err: any) {
    console.error("❌ erro ao enviar member feed:", err?.message || err);
  }
}

export function registerMemberFeed(client: Client) {
  if (!MEMBER_FEED_ENABLED) {
    console.log("👥 member feed desativado por DISCORD_MEMBER_FEED_ENABLED=false");
    return;
  }

  if (!MEMBER_FEED_CHANNEL_ID) {
    console.log("👥 member feed ignorado: DISCORD_MEMBER_FEED_CHANNEL_ID não definido");
    return;
  }

  client.on("guildMemberAdd", async (member) => {
    const embed = buildSuccessEmbed({
      title: "🟢 Member joined",
      description: [
        `**User:** ${member}`,
        `**Username:** ${formatUser(member)}`,
        `**Account created:** ${formatDiscordTimestamp(member.user.createdAt)} (${formatDiscordTimestamp(member.user.createdAt, "R")})`,
        `**Joined server:** ${formatDiscordTimestamp(member.joinedAt ?? new Date())}`,
      ].join("\n"),
      footerSuffix: "member-feed",
    });

    await sendMemberFeedEmbed(client, embed);
  });

  client.on("guildMemberRemove", async (member) => {
    const embed = buildNeutralEmbed({
      title: "🔴 Member left",
      description: [
        `**User:** ${member.user.tag}`,
        `**ID:** ${member.user.id}`,
        `**Account created:** ${formatDiscordTimestamp(member.user.createdAt)} (${formatDiscordTimestamp(member.user.createdAt, "R")})`,
        `**Joined server:** ${formatDiscordTimestamp(member.joinedAt)}`,
        `**Left server:** ${formatDiscordTimestamp(new Date())}`,
      ].join("\n"),
      footerSuffix: "member-feed",
    });

    await sendMemberFeedEmbed(client, embed);
  });

  console.log("👥 member feed ativo");
}
