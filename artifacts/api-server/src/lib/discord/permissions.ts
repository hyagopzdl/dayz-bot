import { PermissionsBitField } from "discord.js";

export async function assertAdmin(interaction: any) {
  if (
    !interaction.memberPermissions?.has(
      PermissionsBitField.Flags.Administrator,
    )
  ) {
    const message = "❌ Only administrators can use this command.";

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message);
    } else {
      await interaction.reply({
        content: message,
        ephemeral: true,
      });
    }

    return false;
  }

  return true;
}
