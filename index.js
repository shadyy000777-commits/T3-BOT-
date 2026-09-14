require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Collection, MessageFlags, REST, Routes, ActivityType } = require('discord.js');
const {
  handleRegisterButton, handleEditButton, handleStep1Submit, handleRetryStep1,
  handleStep2Button, handleStep2Submit, handleRetryStep2,
  handleStep3Button, handleStep3Submit, handleRetryStep3, handleSelectPlayers,
} = require('./registration-handlers');
const { startLivePanelDayRollover } = require('./live-panel-handlers');
const {
  handleGroupScheduleSelect, handleGroupScheduleModalSubmit, handleDailyScheduleModalSubmit,
} = require('./group-schedule-handlers');
const {
  handlePostRegPanel, handlePostRegPanelChannelSelect,
  handlePostLivePanel, handlePostLivePanelChannelSelect,
  handleLogChannelSelect, handleRoleSelect,
  handleClearRole, handleSetGroupsPerDayButton, handleGroupsPerDayModalSubmit,
  handleEditDailyScheduleButton, handleGroupScheduleButton,
  handleSetMaxRoundsButton, handleMaxRoundsModalSubmit,
} = require('./admin-panel-handlers');
const {
  handleResultButton, handleReminderButton, handleQualifySelectSubmit,
  handleDeleteButton, handleDeleteConfirmButton, handleDeleteCancelButton,
} = require('./round-promotion-handlers');
const { handlePublishButton } = require('./slotlist-handlers');
const {
  handlePunishButton, handlePunishSelect, startScrimsBanExpiry,
} = require('./punish-handlers');
const { handleManageSlotButton, handleManageSlotGroupSelect } = require('./manage-slot-handlers');
const { handleChannelDeleted } = require('./channel-cleanup-handlers');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});
client.commands = new Collection();
client.prefixCommands = new Collection();

// All slash command files live in this same folder, named cmd-*.js
const commandFiles = fs.readdirSync(__dirname).filter(f => f.startsWith('cmd-') && f.endsWith('.js'));
for (const file of commandFiles) {
  const command = require(path.join(__dirname, file));
  client.commands.set(command.data.name, command);
}

// Prefix (!command) files live here too, named pcmd-*.js
const prefixCommandFiles = fs.readdirSync(__dirname).filter(f => f.startsWith('pcmd-') && f.endsWith('.js'));
for (const file of prefixCommandFiles) {
  const command = require(path.join(__dirname, file));
  client.prefixCommands.set(command.name, command);
  for (const alias of command.aliases || []) {
    client.prefixCommands.set(alias, command);
  }
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Loaded ${client.commands.size} commands.`);
  console.log(`Currently in ${client.guilds.cache.size} server(s).`);

  client.user.setPresence({
    activities: [{
      name: 'Custom Status', // required by the library but not displayed for Custom type
      state: '📋 T3 Scrims Registration', // <-- edit this to whatever text you want shown
      type: ActivityType.Custom,
    }],
    status: 'online',
  });

  // Keeps any posted live panel's "next match day" flipping over on its own
  // at midnight IST, even if nobody happens to register right at that moment.
  startLivePanelDayRollover(client);

  // Auto-lifts the Scrims Ban role (see punish-handlers.js) 2 days after a
  // punished team was given it, so nobody has to remember to unpunish them.
  startScrimsBanExpiry(client);

  // Register slash commands with Discord on every startup, so a platform
  // that only runs `npm start` still gets commands registered — you don't
  // have to separately run `npm run deploy`. Skipped if CLIENT_ID isn't set.
  if (process.env.CLIENT_ID) {
    const commandData = client.commands.map(c => c.data.toJSON());
    const rest = new REST().setToken(process.env.DISCORD_TOKEN);
    try {
      for (const guild of client.guilds.cache.values()) {
        await rest.put(
          Routes.applicationGuildCommands(process.env.CLIENT_ID, guild.id),
          { body: commandData }
        );
      }
      console.log('Slash commands registered for all current servers.');
    } catch (err) {
      console.error('Failed to auto-register slash commands on startup:', err);
    }
  }
});

client.on('channelDelete', (channel) => {
  handleChannelDeleted(channel).catch(err =>
    console.error('Failed to clean up after channel deletion:', err)
  );
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guildId) return;
  const PREFIX = '!';
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const commandName = args.shift().toLowerCase();
  const command = client.prefixCommands.get(commandName);
  if (!command) return;

  try {
    await command.execute(message, args);
  } catch (err) {
    console.error(`Error running prefix command ${commandName}:`, err);
    await message.reply('❌ Something went wrong running that command.').catch(() => {});
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) return;
      await command.execute(interaction);
    } else if (interaction.isButton()) {
      if (interaction.customId === 't3reg_start') {
        await handleRegisterButton(interaction);
      } else if (interaction.customId === 't3reg_edit_start') {
        await handleEditButton(interaction);
      } else if (interaction.customId === 't3reg_continue_2') {
        await handleStep2Button(interaction);
      } else if (interaction.customId === 't3reg_continue_3') {
        await handleStep3Button(interaction);
      } else if (interaction.customId === 't3reg_retry_step1') {
        await handleRetryStep1(interaction);
      } else if (interaction.customId === 't3reg_retry_step2') {
        await handleRetryStep2(interaction);
      } else if (interaction.customId === 't3reg_retry_step3') {
        await handleRetryStep3(interaction);
      } else if (interaction.customId === 'admin_post_reg_panel') {
        await handlePostRegPanel(interaction);
      } else if (interaction.customId === 'admin_post_live_panel') {
        await handlePostLivePanel(interaction);
      } else if (interaction.customId === 'admin_clear_role') {
        await handleClearRole(interaction);
      } else if (interaction.customId === 'admin_set_groups_per_day') {
        await handleSetGroupsPerDayButton(interaction);
      } else if (interaction.customId === 'admin_edit_daily_schedule') {
        await handleEditDailyScheduleButton(interaction);
      } else if (interaction.customId === 'admin_group_schedule') {
        await handleGroupScheduleButton(interaction);
      } else if (interaction.customId === 'admin_set_max_rounds') {
        await handleSetMaxRoundsButton(interaction);
      } else if (interaction.customId.startsWith('t3_result:')) {
        await handleResultButton(interaction);
      } else if (interaction.customId.startsWith('t3_reminder:')) {
        await handleReminderButton(interaction);
      } else if (interaction.customId.startsWith('t3_publish:')) {
        await handlePublishButton(interaction);
      } else if (interaction.customId.startsWith('t3_manage:')) {
        await handleManageSlotButton(interaction);
      } else if (interaction.customId.startsWith('t3_punish:')) {
        await handlePunishButton(interaction);
      } else if (interaction.customId.startsWith('t3_delete_confirm:')) {
        await handleDeleteConfirmButton(interaction);
      } else if (interaction.customId.startsWith('t3_delete_cancel:')) {
        await handleDeleteCancelButton(interaction);
      } else if (interaction.customId.startsWith('t3_delete:')) {
        await handleDeleteButton(interaction);
      }
    } else if (interaction.isUserSelectMenu()) {
      if (interaction.customId === 't3reg_select_players') {
        await handleSelectPlayers(interaction);
      }
    } else if (interaction.isChannelSelectMenu()) {
      if (interaction.customId === 'admin_log_channel_select') {
        await handleLogChannelSelect(interaction);
      } else if (interaction.customId === 'admin_post_reg_panel_channel_select') {
        await handlePostRegPanelChannelSelect(interaction);
      } else if (interaction.customId === 'admin_post_live_panel_channel_select') {
        await handlePostLivePanelChannelSelect(interaction);
      }
    } else if (interaction.isRoleSelectMenu()) {
      if (interaction.customId === 'admin_role_select') {
        await handleRoleSelect(interaction);
      }
    } else if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'group_schedule_select') {
        await handleGroupScheduleSelect(interaction);
      } else if (interaction.customId.startsWith('t3_qualify:')) {
        await handleQualifySelectSubmit(interaction);
      } else if (interaction.customId.startsWith('t3_punish_select:')) {
        await handlePunishSelect(interaction);
      } else if (interaction.customId === 't3_manage_group_select') {
        await handleManageSlotGroupSelect(interaction);
      }
    } else if (interaction.isModalSubmit()) {
      if (interaction.customId === 't3reg_step1') await handleStep1Submit(interaction);
      else if (interaction.customId === 't3reg_step2') await handleStep2Submit(interaction);
      else if (interaction.customId === 't3reg_step3') await handleStep3Submit(interaction);
      else if (interaction.customId.startsWith('group_schedule_modal:')) await handleGroupScheduleModalSubmit(interaction);
      else if (interaction.customId === 'daily_schedule_modal') await handleDailyScheduleModalSubmit(interaction);
      else if (interaction.customId === 'admin_groups_per_day_modal') await handleGroupsPerDayModalSubmit(interaction);
      else if (interaction.customId === 'admin_max_rounds_modal') await handleMaxRoundsModalSubmit(interaction);
    }
  } catch (err) {
    console.error(`Error handling interaction (${interaction.type}):`, err);
    const payload = { content: '❌ Something went wrong. Please try again.', flags: MessageFlags.Ephemeral };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload).catch(() => {});
    } else if (interaction.isRepliable()) {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error('Failed to log in to Discord:', err);
  process.exit(1);
});

client.on('error', (err) => console.error('Discord client error:', err));
client.on('shardError', (err) => console.error('Discord shard error:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
