const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { getGuildStore } = require('./storage');
const { getGroupsPerDay } = require('./group-schedule');
const { buildDailyScheduleModal } = require('./group-schedule-handlers');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set-daily-schedule')
    .setDescription("Set both daily groups' match times at once (only works when 2 groups/day are configured)")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const store = getGuildStore(interaction.guildId);
    const groupsPerDay = getGroupsPerDay(store.scrim);

    // Discord modals cap out at 5 fields, which is exactly enough for 2
    // groups' worth of times (4 time-pairs + 1 maps field) — this command
    // can't scale past that. Once groupsPerDay is raised beyond 2, each
    // position has to be set one at a time via /group-schedule instead.
    if (groupsPerDay !== 2) {
      return interaction.reply({
        content: `❌ This command only works with exactly 2 groups/day (currently set to ${groupsPerDay}). Use \`/group-schedule\` to set each day's time slots one at a time instead.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.showModal(buildDailyScheduleModal(store));
  },
};
