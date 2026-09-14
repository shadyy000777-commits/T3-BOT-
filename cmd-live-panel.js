const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { postLivePanel } = require('./live-panel-handlers');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('live-panel')
    .setDescription("Post a live-updating panel of every group's fill status and match times")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    await postLivePanel(interaction);
    await interaction.reply({ content: '✅ Live panel posted.', flags: MessageFlags.Ephemeral });
  },
};
