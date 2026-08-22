import {
  ChannelType,
  type Client,
  type GuildMember,
  type TextBasedChannel,
} from "discord.js";
import { buildNeutralEmbed, buildSuccessEmbed } from "../ui/embeds";
import { getPrimaryServerId } from "../../serverRegistry";
import { getServerRuntimeContext } from "../../serverRuntime";


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

async function resolveMemberFeedChannel(client: Client, serverId = getPrimaryServerId()) {
  const config = getServerRuntimeContext(serverId).discord;
  if (config.memberFeedEnabled === false || !config.memberFeedChannelId) return null;

  try {
    const channel = await client.channels.fetch(config.memberFeedChannelId);
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

async function sendMemberFeedEmbed(client: Client, embed: ReturnType<typeof buildSuccessEmbed>, serverId = getPrimaryServerId()) {
  const channel = await resolveMemberFeedChannel(client, serverId);
  if (!channel) return;

  try {
    await channel.send({ embeds: [embed] });
  } catch (err: any) {
    console.error("❌ erro ao enviar member feed:", err?.message || err);
  }
}

export function registerMemberFeed(client: Client, serverId = getPrimaryServerId()) {
  const runtime = getServerRuntimeContext(serverId);
  if (runtime.discord.memberFeedEnabled === false) {
    console.log(`👥 member feed desativado para ${serverId}`);
    return;
  }

  if (!runtime.discord.memberFeedChannelId) {
    console.log(`👥 member feed ignorado para ${serverId}: canal não configurado`);
    return;
  }

  client.on("guildMemberAdd", async (member) => {
    if (runtime.discord.guildId && member.guild.id !== runtime.discord.guildId) return;
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

    await sendMemberFeedEmbed(client, embed, serverId);
  });

  client.on("guildMemberRemove", async (member) => {
    if (runtime.discord.guildId && member.guild.id !== runtime.discord.guildId) return;
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

    await sendMemberFeedEmbed(client, embed, serverId);
  });

  console.log("👥 member feed ativo");
}
