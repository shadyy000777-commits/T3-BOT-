const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { getGuildStore, saveGuildStore } = require('./storage');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('clear-t3-role')
    .setDescription('Clear the required role — registration closes until a new one is set')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const store = getGuildStore(interaction.guildId);
    if (!store.settings) store.settings = {};
    store.settings.requiredRoleId = null;
    saveGuildStore(interaction.guildId, store);

    await interaction.reply({
      content: '✅ Required role cleared — registration is now **closed** until a new required role is set (there\'s no "open to everyone" mode).',
      flags: MessageFlags.Ephemeral,
    });
  },
};
