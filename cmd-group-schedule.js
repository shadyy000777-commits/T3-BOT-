const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { getGuildStore } = require('./storage');
const { buildGroupSchedulePanelPayload } = require('./group-schedule-handlers');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('group-schedule')
    .setDescription("Post a panel to change the daily match times and maps")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const store = getGuildStore(interaction.guildId);
    const payload = buildGroupSchedulePanelPayload(store);
    await interaction.channel.send(payload);
    await interaction.reply({ content: '✅ Schedule panel posted.', flags: MessageFlags.Ephemeral });
  },
};
