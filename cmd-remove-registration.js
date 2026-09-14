const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { getGuildStore, saveGuildStore } = require('./storage');
const { clearPending } = require('./pending-registrations');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('remove-registration')
    .setDescription("Remove a player's team registration so they can register again")
    .addUserOption(opt =>
      opt.setName('user')
        .setDescription('The player whose registration should be removed')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const target = interaction.options.getUser('user');

    const store = getGuildStore(interaction.guildId);
    const existing = store.registrations && store.registrations[target.id];

    if (!existing) {
      return interaction.reply({
        content: `❌ ${target} doesn't have a saved registration.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    delete store.registrations[target.id];
    saveGuildStore(interaction.guildId, store);

    // In case they're mid-way through the 3-step form right now, clear that too
    // so a stale in-progress session can't finish and re-save after removal.
    clearPending(target.id);

    await interaction.reply({
      content: `✅ Removed the registration for team **${existing.team_name}** (${target}). They can now run \`/t3-panel\` again.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
