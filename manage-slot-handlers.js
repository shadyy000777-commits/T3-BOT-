const { ActionRowBuilder, StringSelectMenuBuilder, MessageFlags } = require('discord.js');
const { getGuildStore, saveGuildStore } = require('./storage');
const {
  groupDisplayName, localSlotNumber, slotRangeForGroup, isGroupClosed,
  listGroupsWithFreeSlots, groupTimeSummary, hasGroupMatchStarted,
  dayBatchForLetter, dayLabelForBatch, formatDDMMYYYY, getGroupsPerDay,
  currentDayBatchIndex, lettersForDayBatch,
} = require('./group-schedule');
const { giveGroupRole } = require('./registration-handlers');
const { refreshLivePanel } = require('./live-panel-handlers');
const { refreshSlotList } = require('./slotlist-handlers');

// "Manage Slot" is deliberately open to any registered player, not admin
// gated — it lets whoever's already registered move themselves into a
// different currently-open group (e.g. a different match time), the same
// way the standalone Register flow assigns a slot, just re-run manually.
// Only applies to Round 1 groups — Round 2+ pools have no per-slot concept
// to move between.
async function handleManageSlotButton(interaction) {
  const store = getGuildStore(interaction.guildId);
  const scrim = store.scrim;
  if (!scrim) {
    return interaction.reply({ content: '❌ No scrim is set up right now.', flags: MessageFlags.Ephemeral });
  }

  const already = store.registrations && store.registrations[interaction.user.id];
  if (!already || !already.group) {
    return interaction.reply({
      content: '❌ You need to register your team first — use the registration panel\'s **Register** button, then you can manage your slot.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // Today's currently-open batch, PLUS the next batch after it — so a
  // player isn't limited to only "today's" groups when picking somewhere
  // to switch. Groups further out than that stay hidden until their own
  // batch actually opens, same as everywhere else in the bot.
  const groupsPerDay = getGroupsPerDay(scrim);
  const currentBatch = currentDayBatchIndex(scrim);
  const visibleLetters = new Set(
    [
      ...lettersForDayBatch(scrim.totalSlots, currentBatch, groupsPerDay),
      ...lettersForDayBatch(scrim.totalSlots, currentBatch + 1, groupsPerDay),
    ].filter(letter => !hasGroupMatchStarted(store, letter))
  );

  const options = listGroupsWithFreeSlots(scrim)
    .filter(g => g.freeCount > 0 && g.letter !== already.group && visibleLetters.has(g.letter))
    .slice(0, 25)
    .map(g => ({
      label: `${groupDisplayName(g.letter)} — ${groupTimeSummary(g.letter, store)} (${formatDDMMYYYY(dayLabelForBatch(scrim, dayBatchForLetter(g.letter, getGroupsPerDay(scrim))).dayNumber)})`,
      description: `${g.freeCount} slot(s) free`,
      value: g.letter,
    }));

  if (!options.length) {
    return interaction.reply({
      content: "❌ No other currently-open group (today or tomorrow) has a free slot to switch into right now.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId('t3_manage_group_select')
    .setPlaceholder('Pick a group to switch into')
    .addOptions(options);

  await interaction.reply({
    content: `You're currently in **${groupDisplayName(already.group)}** (Slot ${localSlotNumber(already.slotNumber)}). Pick a different group below to switch your match time:`,
    components: [new ActionRowBuilder().addComponents(menu)],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleManageSlotGroupSelect(interaction) {
  const store = getGuildStore(interaction.guildId);
  const scrim = store.scrim;
  const newGroup = interaction.values[0];

  if (!scrim) {
    return interaction.update({ content: '❌ No scrim is set up right now.', components: [] });
  }

  const already = store.registrations && store.registrations[interaction.user.id];
  if (!already || !already.group) {
    return interaction.update({ content: "❌ You're not currently registered for this scrim.", components: [] });
  }
  if (already.group === newGroup) {
    return interaction.update({ content: `You're already in ${groupDisplayName(newGroup)}.`, components: [] });
  }
  if (isGroupClosed(scrim, newGroup)) {
    return interaction.update({
      content: `❌ ${groupDisplayName(newGroup)}'s result has already been posted, so it's closed — run **Manage Slot** again to pick a currently open group.`,
      components: [],
    });
  }

  const range = slotRangeForGroup(newGroup, scrim.totalSlots);
  let newSlotNumber = null;
  for (let i = range.start; i <= range.end; i++) {
    if (!scrim.slots[i]) { newSlotNumber = i; break; }
  }
  if (newSlotNumber === null) {
    return interaction.update({
      content: `❌ ${groupDisplayName(newGroup)} just filled up — run **Manage Slot** again to pick another group.`,
      components: [],
    });
  }

  const oldGroup = already.group;
  const oldSlotNumber = already.slotNumber;
  const teamData = scrim.slots[oldSlotNumber];

  if (teamData) delete scrim.slots[oldSlotNumber];
  scrim.slots[newSlotNumber] = {
    ...(teamData || {}),
    team: already.team_name,
    ownerName: already.owner_name,
    whatsapp: already.whatsapp,
    players: teamData ? teamData.players : undefined,
    userId: interaction.user.id,
    selectedPlayerIds: already.selectedPlayerIds || [],
    registeredAt: teamData ? teamData.registeredAt : new Date().toISOString(),
    slotNumber: newSlotNumber,
    group: newGroup,
  };

  already.slotNumber = newSlotNumber;
  already.group = newGroup;
  saveGuildStore(interaction.guildId, store);

  // Removes the old group's role and creates/adds the new group's role +
  // channel — mirrors what happens automatically on first registration.
  try {
    const oldRoleId = store.settings.groupRoles && store.settings.groupRoles[oldGroup];
    if (oldRoleId) {
      const member = interaction.member ?? await interaction.guild.members.fetch(interaction.user.id);
      if (member.roles.cache.has(oldRoleId)) await member.roles.remove(oldRoleId);
    }
  } catch (err) {
    console.error(`Failed to remove old group role while managing slot for ${interaction.user.id}:`, err.message);
  }
  await giveGroupRole(interaction, store, newGroup);

  await refreshLivePanel(interaction.client, interaction.guildId);
  await refreshSlotList(interaction.client, interaction.guildId, 1, oldGroup);
  await refreshSlotList(interaction.client, interaction.guildId, 1, newGroup);

  await interaction.update({
    content: `✅ You're now in **${groupDisplayName(newGroup)}** — Slot ${localSlotNumber(newSlotNumber)}.`,
    components: [],
  });
}

module.exports = { handleManageSlotButton, handleManageSlotGroupSelect };
