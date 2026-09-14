const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { buildRegistrationPanelPayload } = require('./registration-handlers');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('t3-panel')
    .setDescription('Post the T3 Scrims registration panel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    // channel.send instead of interaction.reply — no "used /t3-panel"
    // attribution line above a panel players will click for a long time.
    await interaction.channel.send(buildRegistrationPanelPayload());
    await interaction.reply({ content: '✅ Panel posted.', flags: MessageFlags.Ephemeral });
  },
};
