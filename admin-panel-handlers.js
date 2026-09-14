const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, ChannelType,
  ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags, PermissionFlagsBits,
} = require('discord.js');
const { getGuildStore, saveGuildStore } = require('./storage');
const { getGroupsPerDay } = require('./group-schedule');
const { getMaxRounds, setMaxRounds, roundLabel, MAX_ROUND } = require('./rounds');
const { buildRegistrationPanelPayload } = require('./registration-handlers');
const { postLivePanel, refreshLivePanel } = require('./live-panel-handlers');
const { buildGroupSchedulePanelPayload, buildDailyScheduleModal } = require('./group-schedule-handlers');

function hasManageGuild(interaction) {
  return interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);
}

// One panel covering every setting that otherwise needs its own slash
// command — posted once via /admin-panel and reused from then on; every
// button/select here just calls the same logic the standalone commands do.
function buildAdminPanelPayload(store) {
  const groupsPerDay = getGroupsPerDay(store.scrim);
  const maxRounds = getMaxRounds(store);
  const logChannelId = store.settings && store.settings.logChannelId;
  const requiredRoleId = store.settings && store.settings.requiredRoleId;

  const embed = new EmbedBuilder()
    .setTitle('🛠️ T3 Scrims — Admin Panel')
    .setColor(0x5865F2)
    .addFields(
      { name: 'Log channel', value: logChannelId ? `<#${logChannelId}>` : '_not set_', inline: true },
      { name: 'Required role', value: requiredRoleId ? `<@&${requiredRoleId}>` : '_none set — registration closed_', inline: true },
      { name: 'Groups per day', value: String(groupsPerDay), inline: true },
      { name: 'Max rounds', value: String(maxRounds), inline: true },
    )
    .setFooter({ text: 'Only members with Manage Server can use these controls.' });

  const postRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('admin_post_reg_panel').setLabel('Post Registration Panel').setEmoji('📋').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('admin_post_live_panel').setLabel('Post Live Panel').setEmoji('📡').setStyle(ButtonStyle.Success),
  );

  const logChannelRow = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId('admin_log_channel_select')
      .setPlaceholder('Set the log channel')
      .addChannelTypes(ChannelType.GuildText)
  );

  const roleRow = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder()
      .setCustomId('admin_role_select')
      .setPlaceholder('Set the role required to register')
  );

  const settingsRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('admin_clear_role').setLabel('Clear Required Role').setEmoji('🚫').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('admin_set_groups_per_day').setLabel('Set Groups Per Day').setEmoji('🔢').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('admin_set_max_rounds').setLabel('Set Max Rounds').setEmoji('🏆').setStyle(ButtonStyle.Secondary),
  );

  const scheduleRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('admin_edit_daily_schedule').setLabel('Edit Daily Schedule').setEmoji('🗓️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('admin_group_schedule').setLabel('Group Schedule (per-position)').setEmoji('📅').setStyle(ButtonStyle.Primary),
  );

  return { embeds: [embed], components: [postRow, logChannelRow, roleRow, settingsRow, scheduleRow] };
}

// Re-renders the panel message in place after a setting changes, so the
// summary fields at the top (log channel, role, groups/day) stay accurate
// without needing to re-run /admin-panel.
async function refreshAdminPanelMessage(interaction, store) {
  try {
    await interaction.message.edit(buildAdminPanelPayload(store));
  } catch (err) {
    console.error('Failed to refresh admin panel message:', err.message);
  }
}

async function handlePostRegPanel(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }
  const select = new ChannelSelectMenuBuilder()
    .setCustomId('admin_post_reg_panel_channel_select')
    .setPlaceholder('Pick a channel to post the registration panel in')
    .addChannelTypes(ChannelType.GuildText);

  await interaction.reply({
    content: 'Where should the registration panel be posted?',
    components: [new ActionRowBuilder().addComponents(select)],
    flags: MessageFlags.Ephemeral,
  });
}

async function handlePostRegPanelChannelSelect(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }
  const channel = interaction.channels.first();
  await channel.send(buildRegistrationPanelPayload());
  await interaction.update({ content: `✅ Registration panel posted in ${channel}.`, components: [] });
}

async function handlePostLivePanel(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }
  const select = new ChannelSelectMenuBuilder()
    .setCustomId('admin_post_live_panel_channel_select')
    .setPlaceholder('Pick a channel to post the live panel in')
    .addChannelTypes(ChannelType.GuildText);

  await interaction.reply({
    content: 'Where should the live panel be posted?',
    components: [new ActionRowBuilder().addComponents(select)],
    flags: MessageFlags.Ephemeral,
  });
}

async function handlePostLivePanelChannelSelect(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }
  const channel = interaction.channels.first();
  await postLivePanel(interaction, channel);
  await interaction.update({ content: `✅ Live panel posted in ${channel}.`, components: [] });
}

async function handleLogChannelSelect(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }
  const channel = interaction.channels.first();
  const store = getGuildStore(interaction.guildId);
  if (!store.settings) store.settings = {};
  store.settings.logChannelId = channel.id;
  saveGuildStore(interaction.guildId, store);

  await refreshAdminPanelMessage(interaction, store);
  await interaction.reply({ content: `✅ Registered team submissions will now be posted to ${channel}.`, flags: MessageFlags.Ephemeral });
}

async function handleRoleSelect(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }
  const role = interaction.roles.first();
  const store = getGuildStore(interaction.guildId);
  if (!store.settings) store.settings = {};
  store.settings.requiredRoleId = role.id;
  saveGuildStore(interaction.guildId, store);

  await refreshAdminPanelMessage(interaction, store);
  await interaction.reply({ content: `✅ Only members with ${role} can now register for T3 Scrims.`, flags: MessageFlags.Ephemeral });
}

async function handleClearRole(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }
  const store = getGuildStore(interaction.guildId);
  if (!store.settings) store.settings = {};
  store.settings.requiredRoleId = null;
  saveGuildStore(interaction.guildId, store);

  await refreshAdminPanelMessage(interaction, store);
  await interaction.reply({ content: '✅ Required role cleared — registration is now **closed** until a new required role is set (there\'s no "open to everyone" mode).', flags: MessageFlags.Ephemeral });
}

function buildGroupsPerDayModal(store) {
  return new ModalBuilder()
    .setCustomId('admin_groups_per_day_modal')
    .setTitle('Set Groups Per Day')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('count')
          .setLabel('How many groups should play per day? (1-25)')
          .setStyle(TextInputStyle.Short)
          .setValue(String(getGroupsPerDay(store.scrim)))
          .setRequired(true)
          .setMaxLength(2)
      )
    );
}

async function handleSetGroupsPerDayButton(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }
  const store = getGuildStore(interaction.guildId);
  await interaction.showModal(buildGroupsPerDayModal(store));
}

async function handleGroupsPerDayModalSubmit(interaction) {
  const raw = interaction.fields.getTextInputValue('count').trim();
  const count = parseInt(raw, 10);
  if (!Number.isInteger(count) || count < 1 || count > 25) {
    return interaction.reply({ content: `❌ "${raw}" isn't valid — enter a whole number from 1 to 25.`, flags: MessageFlags.Ephemeral });
  }

  const store = getGuildStore(interaction.guildId);
  const previous = getGroupsPerDay(store.scrim);
  store.scrim.groupsPerDay = count;
  saveGuildStore(interaction.guildId, store);

  let note = '';
  if (count > previous) {
    note += `\n⚠️ New time slots (positions ${previous + 1}-${count}) have no match times set yet — use **Group Schedule (per-position)** to set them.`;
  }
  if (count !== 2) {
    note += '\nℹ️ **Edit Daily Schedule** only works when the count is exactly 2 — use **Group Schedule (per-position)** otherwise.';
  }

  await interaction.reply({
    content: `✅ Groups per day changed from **${previous}** to **${count}**.${note}`,
    flags: MessageFlags.Ephemeral,
  });

  await refreshLivePanel(interaction.client, interaction.guildId);
}

async function handleEditDailyScheduleButton(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }
  const store = getGuildStore(interaction.guildId);
  const groupsPerDay = getGroupsPerDay(store.scrim);

  if (groupsPerDay !== 2) {
    return interaction.reply({
      content: `❌ This only works with exactly 2 groups/day (currently ${groupsPerDay}). Use **Group Schedule (per-position)** instead.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.showModal(buildDailyScheduleModal(store));
}

async function handleGroupScheduleButton(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }
  const store = getGuildStore(interaction.guildId);
  await interaction.reply({ ...buildGroupSchedulePanelPayload(store), flags: MessageFlags.Ephemeral });
}

function buildMaxRoundsModal(store) {
  return new ModalBuilder()
    .setCustomId('admin_max_rounds_modal')
    .setTitle('Set Max Rounds')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('count')
          .setLabel(`Total rounds, incl. Round 1 (1-${MAX_ROUND})`)
          .setStyle(TextInputStyle.Short)
          .setValue(String(getMaxRounds(store)))
          .setRequired(true)
          .setMaxLength(2)
      )
    );
}

async function handleSetMaxRoundsButton(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }
  const store = getGuildStore(interaction.guildId);
  await interaction.showModal(buildMaxRoundsModal(store));
}

async function handleMaxRoundsModalSubmit(interaction) {
  const raw = interaction.fields.getTextInputValue('count').trim();
  const count = parseInt(raw, 10);
  if (!Number.isInteger(count) || count < 1 || count > MAX_ROUND) {
    return interaction.reply({ content: `❌ "${raw}" isn't valid — enter a whole number from 1 to ${MAX_ROUND}.`, flags: MessageFlags.Ephemeral });
  }

  const store = getGuildStore(interaction.guildId);
  const previous = getMaxRounds(store);
  setMaxRounds(store, count);
  saveGuildStore(interaction.guildId, store);

  const finalRoundLabel = count === 1 ? 'Round 1 (each group)' : roundLabel(count);
  await interaction.reply({
    content: `✅ Max rounds changed from **${previous}** to **${count}**. **${finalRoundLabel}** is now the final round.`,
    flags: MessageFlags.Ephemeral,
  });

  await refreshAdminPanelMessage(interaction, store);
}

module.exports = {
  buildAdminPanelPayload,
  handlePostRegPanel,
  handlePostRegPanelChannelSelect,
  handlePostLivePanel,
  handlePostLivePanelChannelSelect,
  handleLogChannelSelect,
  handleRoleSelect,
  handleClearRole,
  handleSetGroupsPerDayButton,
  handleGroupsPerDayModalSubmit,
  handleEditDailyScheduleButton,
  handleGroupScheduleButton,
  handleSetMaxRoundsButton,
  handleMaxRoundsModalSubmit,
};
