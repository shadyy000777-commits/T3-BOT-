const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { getGuildStore } = require('./storage');
const { buildAdminPanelPayload } = require('./admin-panel-handlers');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('admin-panel')
    .setDescription('Post the T3 Scrims admin panel (registration panel, log channel, role, schedule, groups/day)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const store = getGuildStore(interaction.guildId);
    await interaction.channel.send(buildAdminPanelPayload(store));
    await interaction.reply({ content: '✅ Admin panel posted.', flags: MessageFlags.Ephemeral });
  },
};
