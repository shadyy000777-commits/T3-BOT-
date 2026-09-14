const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { getGuildStore, saveGuildStore } = require('./storage');
const { refreshLivePanel } = require('./live-panel-handlers');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set-groups-per-day')
    .setDescription('Change how many groups play per real day (currently 2) — applies going forward')
    .addIntegerOption(opt =>
      opt.setName('count')
        .setDescription('How many groups should play per day')
        .setMinValue(1)
        .setMaxValue(25)
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const count = interaction.options.getInteger('count');

    const store = getGuildStore(interaction.guildId);
    const previous = store.scrim.groupsPerDay;
    store.scrim.groupsPerDay = count;
    saveGuildStore(interaction.guildId, store);

    // Regroups already-registered slots into day-batches don't move (slots
    // are still keyed by their absolute group letter), but this changes
    // which day-batch each group falls into and which schedule "position"
    // it now reuses going forward — so today's already-open groups may
    // shift to a different day, and any position past the old count won't
    // have a time set yet.
    let note = '';
    if (count > previous) {
      note += `\n⚠️ New time slots (positions ${previous + 1}-${count}) have no match times set yet — use \`/group-schedule\` to set them.`;
    }
    if (count !== 2) {
      note += '\nℹ️ `/set-daily-schedule` only works when the count is exactly 2 — use `/group-schedule` to set times one at a time instead.';
    }

    await interaction.reply({
      content: `✅ Groups per day changed from **${previous}** to **${count}**. This applies to which groups are grouped into each upcoming match day from now on.${note}`,
      flags: MessageFlags.Ephemeral,
    });

    await refreshLivePanel(interaction.client, interaction.guildId);
  },
};
