export async function deferEphemeral(interaction: any) {
  if (interaction.deferred || interaction.replied) return true;

  try {
    await interaction.deferReply({ ephemeral: true });
    return true;
  } catch (err: any) {
    console.error(
      "❌ erro ao deferir interaction:",
      err?.code || err?.status || err?.message || err,
    );
    return false;
  }
}

export async function respondEphemeral(interaction: any, content: any) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(content);
      return;
    }

    await interaction.reply({
      ...(typeof content === "string" ? { content } : content),
      ephemeral: true,
    });
  } catch (err: any) {
    const code = err?.code || err?.status || err?.message || err;
    console.error("❌ erro respondendo interaction com segurança:", code);
  }
}
