const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { getGuildStore, saveGuildStore } = require('./storage');
const { getMaxRounds, setMaxRounds, roundLabel, MAX_ROUND } = require('./rounds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set-max-rounds')
    .setDescription("Set how many rounds the Result button chains through before crowning a winner")
    .addIntegerOption(opt =>
      opt.setName('count')
        .setDescription(`How many rounds total, including Round 1 registration (1-${MAX_ROUND})`)
        .setMinValue(1)
        .setMaxValue(MAX_ROUND)
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const count = interaction.options.getInteger('count');
    const store = getGuildStore(interaction.guildId);
    const previous = getMaxRounds(store);
    setMaxRounds(store, count);
    saveGuildStore(interaction.guildId, store);

    const finalRoundLabel = count === 1 ? 'Round 1 (each group)' : roundLabel(count);
    await interaction.reply({
      content: `✅ Max rounds changed from **${previous}** to **${count}**. **${finalRoundLabel}** is now the final round — its Result button will crown the winner instead of promoting further.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
