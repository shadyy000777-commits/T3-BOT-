const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const { getGuildStore, saveGuildStore } = require('./storage');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set-log-channel')
    .setDescription('Choose the channel where registered team submissions get posted')
    .addChannelOption(opt =>
      opt.setName('channel')
        .setDescription('The channel to post registered submissions to')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const channel = interaction.options.getChannel('channel');

    const store = getGuildStore(interaction.guildId);
    if (!store.settings) store.settings = {};
    store.settings.logChannelId = channel.id;
    saveGuildStore(interaction.guildId, store);

    await interaction.reply({
      content: `✅ Registered team submissions will now be posted to ${channel}.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
