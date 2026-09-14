const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { getGuildStore, saveGuildStore } = require('./storage');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set-t3-role')
    .setDescription('Choose the role required to register for T3 Scrims (leave unset to allow everyone)')
    .addRoleOption(opt =>
      opt.setName('role')
        .setDescription('The role players must have to click Register')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const role = interaction.options.getRole('role');

    const store = getGuildStore(interaction.guildId);
    if (!store.settings) store.settings = {};
    store.settings.requiredRoleId = role.id;
    saveGuildStore(interaction.guildId, store);

    await interaction.reply({
      content: `✅ Only members with ${role} can now register for T3 Scrims.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
