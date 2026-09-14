const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags,
  UserSelectMenuBuilder, ChannelType, PermissionFlagsBits,
} = require('discord.js');
const { getGuildStore, saveGuildStore } = require('./storage');
const { startPending, getPending, updatePending, clearPending } = require('./pending-registrations');
const { buildStep1Modal, buildStep2Modal, buildStep3Modal } = require('./registration-modals');
const {
  FIRST_ASSIGNABLE_SLOT, groupLetterForSlot, groupDisplayName, localSlotNumber,
  isGroupClosed, hasGroupMatchStarted, matchScheduleLines, indexForLetter,
} = require('./group-schedule');
const { refreshLivePanel } = require('./live-panel-handlers');
const { refreshSlotList } = require('./slotlist-handlers');
const { postGroupResultPanel } = require('./round-promotion-handlers');
const { getScrimsBanExpiry } = require('./punish-handlers');

const MAX_GUILD_ROLES = 250;
const MAX_GUILD_CHANNELS = 500;
const SAFETY_MARGIN = 5;

// "T3 Lobby 1", "T3 Lobby 2", ... — Discord lowercases/hyphenates text
// channel names automatically, so this reliably ends up as t3-lobby-1,
// t3-lobby-2, etc. in the channel list.
function groupChannelName(letter) {
  return `T3 Lobby ${indexForLetter(letter) + 1}`;
}

// "T3 GROUP 1", "T3 GROUP 2", ... — the role name shown in the server's
// role list and member list, separate from groupDisplayName ("Group 1"),
// which is still used in embeds/messages.
function groupRoleName(letter) {
  return `T3 GROUP ${indexForLetter(letter) + 1}`;
}

const WHATSAPP_RE = /^\+?[0-9]{7,15}$/;
const UID_RE = /^[0-9]{5,12}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// "IGN - UID" — captures everything up to the last " - " as the name, and
// requires the trailing part to look like a UID (digits only).
const P5_COMBINED_RE = /^(.+?)\s*-\s*([0-9]{5,12})$/;

// The "T3 SCRIMS REGISTRATION" panel embed + buttons — posted by /t3-panel
// and by the admin panel's "Post Registration Panel" button.
function buildRegistrationPanelPayload() {
  const embed = new EmbedBuilder()
    .setTitle('📋 T3 SCRIMS REGISTRATION')
    .setColor(0xF5A623)
    .setDescription(
      'Ready to enter the lobby? Register your squad and lock your spot before the slots run out!\n\n' +
      '**REGISTRATION STEPS**\n\n' +
      '① Press **Register** below\n' +
      '② Add your Team Details\n' +
      '③ Select your 4 playing members\n' +
      '④ Submit & secure your slot\n\n' +
      'Every field is required\n\n' +
      '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n' +
      '**T3 SCRIMS**'
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('t3reg_start')
      .setLabel('Register')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('t3reg_edit_start')
      .setLabel('Edit')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row] };
}

const RESTART_HINT = 'Click **Register** again to restart — no partial data is saved.';

// Assigns a completed registration the next free scrim slot, skipping any
// group that's closed (result posted) or whose Match 1 has already started.
// Mutates store.scrim.slots in place on success — caller saves afterward.
// Returns { assigned, group } or { error }.
function assignSlot(store, userId, data) {
  const scrim = store.scrim;
  if (!scrim) {
    return { error: null }; // no scrim configured yet — registration itself still succeeds
  }

  let assigned = null;
  for (let i = FIRST_ASSIGNABLE_SLOT; i <= scrim.totalSlots; i++) {
    const groupLetter = groupLetterForSlot(i);
    if (isGroupClosed(scrim, groupLetter)) continue;
    if (hasGroupMatchStarted(store, groupLetter)) continue;
    if (!scrim.slots[i]) { assigned = i; break; }
  }
  if (assigned === null) {
    return { error: '⚠️ All slots are currently full, but your registration has still been saved.' };
  }

  const group = groupLetterForSlot(assigned);

  scrim.slots[assigned] = {
    team: data.team_name,
    ownerName: data.owner_name,
    whatsapp: data.whatsapp,
    players: [1, 2, 3, 4].map(n => `${data[`p${n}_ign`]} (${data[`p${n}_uid`]})`),
    userId,
    selectedPlayerIds: data.selectedPlayerIds || [],
    registeredAt: new Date().toISOString(),
    slotNumber: assigned,
    group,
  };

  return { assigned, group };
}

// Creates (once per group, reused after) a role named "Group N" scoped to
// that group, and adds it to the registering player (interaction.user —
// there's no interaction from the other 4 lineup members to grant a role
// to, so only the owner who ran Register gets it, same as the original
// bot). Never throws — a role hiccup should never block registration.
async function giveGroupRole(interaction, store, groupLetter) {
  if (!store.settings) store.settings = {};
  if (!store.settings.groupRoles) store.settings.groupRoles = {};
  if (!store.settings.autoGroupRoleIds) store.settings.autoGroupRoleIds = [];
  const groupRoles = store.settings.groupRoles;

  const botMember = interaction.guild.members.me;
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    console.error(`[group-role] Bot is missing the "Manage Roles" permission in guild ${interaction.guildId}.`);
    return null;
  }

  let role = groupRoles[groupLetter] ? interaction.guild.roles.cache.get(groupRoles[groupLetter]) : null;

  if (!role) {
    if (interaction.guild.roles.cache.size >= MAX_GUILD_ROLES - SAFETY_MARGIN) {
      console.error(`[group-role] Guild ${interaction.guildId} is at/near Discord's ${MAX_GUILD_ROLES}-role cap — skipping auto-create for ${groupDisplayName(groupLetter)}.`);
      return null;
    }
    try {
      role = await interaction.guild.roles.create({
        name: groupRoleName(groupLetter),
        mentionable: false,
        reason: `Auto-created for ${groupDisplayName(groupLetter)} registration`,
      });
      groupRoles[groupLetter] = role.id;
      store.settings.autoGroupRoleIds.push(role.id);
      saveGuildStore(interaction.guildId, store);
    } catch (err) {
      console.error(`[group-role] Failed to auto-create role for ${groupDisplayName(groupLetter)} in guild ${interaction.guildId}: ${err.code ?? ''} ${err.message}`);
      return null;
    }
  }

  // The group channel just needs the role to exist to scope its
  // permissions to — it doesn't care about role hierarchy, so this can
  // happen regardless of whether the position check below passes.
  await giveGroupChannel(interaction, store, groupLetter, role.id);

  if (role.position >= botMember.roles.highest.position) {
    console.error(`[group-role] Bot's highest role is below "${role.name}" (${role.id}) in guild ${interaction.guildId} — move the bot's role above it.`);
    return role;
  }

  try {
    const member = interaction.member ?? await interaction.guild.members.fetch(interaction.user.id);
    if (!member.roles.cache.has(role.id)) {
      await member.roles.add(role.id);
    }
  } catch (err) {
    console.error(`[group-role] Failed to add group role for ${interaction.user.id} in guild ${interaction.guildId}: ${err.code ?? ''} ${err.message}`);
  }

  return role;
}

// Creates (once per group) a private text channel scoped to that group's
// role — @everyone can't see it, only players holding the group's role (and
// admins/roles that already bypass channel overwrites) can. Starts
// read-only for that role (can view/read history, but not type or attach
// anything) — an admin has to run !open to unlock sending messages and
// files, giving them control over when a group's chat actually goes live.
// Mirrors giveGroupRole: skipped if a channel was already created for this
// group. Never throws — a channel hiccup should never block registration.
async function giveGroupChannel(interaction, store, groupLetter, roleId) {
  if (!roleId) return;
  if (!store.settings) store.settings = {};
  if (!store.settings.groupChannels) store.settings.groupChannels = {};
  if (!store.settings.autoGroupChannelIds) store.settings.autoGroupChannelIds = [];
  const groupChannels = store.settings.groupChannels;

  const existingId = groupChannels[groupLetter];
  if (existingId && interaction.guild.channels.cache.get(existingId)) return; // already made

  const botMember = interaction.guild.members.me;
  if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
    console.error(`[group-channel] Bot is missing the "Manage Channels" permission in guild ${interaction.guildId}.`);
    return;
  }

  if (interaction.guild.channels.cache.size >= MAX_GUILD_CHANNELS - SAFETY_MARGIN) {
    console.error(`[group-channel] Guild ${interaction.guildId} is at/near Discord's ${MAX_GUILD_CHANNELS}-channel cap — skipping auto-create for ${groupDisplayName(groupLetter)}.`);
    return;
  }

  try {
    let category = store.settings.groupChannelsCategoryId
      ? interaction.guild.channels.cache.get(store.settings.groupChannelsCategoryId)
      : null;

    if (!category) {
      category = await interaction.guild.channels.create({
        name: '🏆 T3 Lobbies',
        type: ChannelType.GuildCategory,
        reason: 'Auto-created to hold per-group T3 lobby channels',
      });
      store.settings.groupChannelsCategoryId = category.id;
    }

    const channel = await interaction.guild.channels.create({
      name: groupChannelName(groupLetter),
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: [
        { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: roleId,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
          // Locked by default — nobody in the group can type, attach files,
          // or create/post in a thread until an admin runs !open. Thread
          // perms have to be denied explicitly too — otherwise denying just
          // SendMessages flips Discord into "threads only" mode for this
          // role, which is a bypass around the lock, not an actual lock.
          deny: [
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.CreatePublicThreads,
            PermissionFlagsBits.CreatePrivateThreads,
            PermissionFlagsBits.SendMessagesInThreads,
          ],
        },
      ],
      reason: `Auto-created for ${groupDisplayName(groupLetter)} registration`,
    });

    groupChannels[groupLetter] = channel.id;
    store.settings.autoGroupChannelIds.push(channel.id);
    saveGuildStore(interaction.guildId, store);

    // Posts the "Result" admin panel in the group's own channel, so an
    // admin can promote qualifiers into T3 ROUND 2 (or crown the winner if
    // Max Rounds is set to 1) straight from there — see round-promotion-handlers.js.
    await postGroupResultPanel(channel, 1, groupLetter).catch(err =>
      console.error(`[group-channel] Failed to post Result panel for ${groupDisplayName(groupLetter)}: ${err.message}`)
    );
  } catch (err) {
    console.error(`[group-channel] Failed to auto-create channel for ${groupDisplayName(groupLetter)} in guild ${interaction.guildId}: ${err.code ?? ''} ${err.message}`);
  }
}

function continueRow(customId, label) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(customId)
      .setLabel(label)
      .setStyle(ButtonStyle.Primary)
  );
}

// Discord doesn't let a bot write custom error text inside a modal itself —
// the closest real equivalent: keep whatever they already typed, show the
// error as a normal reply, and give them a button that reopens the SAME
// modal pre-filled with their last attempt, so they only need to fix the
// one wrong field instead of retyping everything.
function retryRow(customId, label) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(customId)
      .setLabel(label)
      .setStyle(ButtonStyle.Danger)
  );
}

// Mandatory picker shown after all 5 players' details are entered: the team
// owner picks 4 real Discord members from the server (Discord's native
// member picker) as the confirmed playing lineup.
function buildPlayerSelectRow() {
  const menu = new UserSelectMenuBuilder()
    .setCustomId('t3reg_select_players')
    .setPlaceholder('Select the 4 players who will play')
    .setMinValues(4)
    .setMaxValues(4);

  return new ActionRowBuilder().addComponents(menu);
}

// Ephemeral confirmation shown to the player themselves right after they submit.
function buildRegisteredEmbed(data, isEdit) {
  const playerFields = [1, 2, 3, 4, 5]
    .filter(n => n < 5 || data.p5_ign) // Player 5 is optional — omit the field entirely if not filled in
    .map(n => {
      const key = `p${n}`;
      return { name: `Player ${n}`, value: `${data[`${key}_ign`]} (${data[`${key}_uid`]})` };
    });

  const lineupLine = (data.selectedPlayerIds || []).map(id => `<@${id}>`).join(' ') || '_not selected_';

  return new EmbedBuilder()
    .setTitle(isEdit ? `✏️ ${data.team_name} — Details Updated` : `✅ ${data.team_name} — Registered`)
    .setColor(isEdit ? 0x5865F2 : 0x57F287)
    .addFields(
      { name: 'Team Name', value: data.team_name, inline: true },
      { name: 'Team Owner Full Name', value: data.owner_name, inline: true },
      { name: 'City', value: data.city, inline: true },
      { name: 'WhatsApp Contact Number', value: data.whatsapp, inline: true },
      { name: 'Team Owner Email', value: data.owner_email, inline: true },
      ...playerFields,
      { name: 'Playing Lineup', value: lineupLine },
      { name: 'Team Registered Date', value: new Date(data.registeredDate).toUTCString() },
    );
}

// Posted to the configured log channel (/set-log-channel) — the full detail
// card. Also reused by !team for the on-demand admin lookup.
function buildRegisteredLogEmbed(data, teamNumber, ownerId, isEdit) {
  const playerLines = [1, 2, 3, 4, 5]
    .filter(n => n < 5 || data.p5_ign) // Player 5 is optional — omit the line entirely if not filled in
    .map(n => {
      const key = `p${n}`;
      return `🔹 \`${data[`${key}_ign`]}\` / ${data[`${key}_uid`]}`;
    })
    .join('\n');

  const lineupLine = (data.selectedPlayerIds || []).map(id => `<@${id}>`).join(' ') || '_not selected_';

  return new EmbedBuilder()
    .setTitle(isEdit ? '🔄 T3 REGISTRATION UPDATED' : '<:4321bgmi:1547674231498612837> T3 REGISTRATION — Team Confirmed')
    .setColor(isEdit ? 0x5865F2 : 0xF5A623)
    .setDescription(
      `<:4321bgmi:1547674231498612837> ${teamNumber} : **TEAM ${data.team_name}**\n` +
      `<:591324redneonownercrown:1547675533649645678> Owner - <@${ownerId}>\n` +
      `<a:836435400498741289:1547663764466180220> City - ${data.city}\n` +
      (data.group ? `🎮 ${groupDisplayName(data.group)} — Slot ${localSlotNumber(data.slotNumber)}\n\n` : '\n') +
      `<a:1037776333327052890:1547681613901471836> **Players (IGN/UID)**\n${playerLines}\n\n` +
      `<:7578whatsapp:1547663758296621126> WhatsApp: ${data.whatsapp}\n` +
      `<:919881goldmail:1547663770904567808> ${data.owner_email}\n\n` +
      `<a:450144discord:1547663739443220541> **Playing Lineup -** ${lineupLine}`
    )
    .setFooter({
      text: isEdit
        ? `Updated ${new Date().toUTCString()}`
        : `Registered ${new Date(data.registeredDate).toUTCString()}`,
    });
}

// Only members holding the role configured via /set-t3-role may register.
// If no role is configured, registration is open to everyone (unrestricted).
// Registration only ever works when an admin has actually set a required
// role via /set-t3-role (or the admin panel's role select) — there's no
// "wide open" fallback. No role configured means registration is closed,
// not open to everyone.
async function hasRequiredRole(interaction, store) {
  const roleId = store.settings && store.settings.requiredRoleId;
  if (!roleId) return false;
  const member = interaction.member ?? await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  return !!member && member.roles.cache.has(roleId);
}

// --- Step 0a: "Register" button pressed (fresh registration) ---
async function handleRegisterButton(interaction) {
  const store = getGuildStore(interaction.guildId);

  if (!(await hasRequiredRole(interaction, store))) {
    const roleId = store.settings && store.settings.requiredRoleId;
    const role = roleId ? interaction.guild.roles.cache.get(roleId) : null;
    return interaction.reply({
      content: roleId
        ? `❌ You need the ${role ? role.toString() : 'required'} role to register for T3 Scrims.`
        : '❌ Registration isn\'t open yet — an admin needs to set a required role first.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const existing = store.registrations && store.registrations[interaction.user.id];

  if (existing) {
    return interaction.reply({
      content: `❌ You've already registered team **${existing.team_name}**. Use the **Edit** button to update your details instead.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const banExpiry = getScrimsBanExpiry(store, interaction.user.id);
  if (banExpiry) {
    return interaction.reply({
      content: `❌ You've been punished and can't register again until <t:${Math.floor(banExpiry / 1000)}:F> (<t:${Math.floor(banExpiry / 1000)}:R>).`,
      flags: MessageFlags.Ephemeral,
    });
  }

  startPending(interaction.user.id, interaction.guildId, 'create');
  await interaction.showModal(buildStep1Modal());
}

// --- Step 0b: "Edit" button pressed (update an existing registration) ---
async function handleEditButton(interaction) {
  const store = getGuildStore(interaction.guildId);
  const existing = store.registrations && store.registrations[interaction.user.id];

  if (!existing) {
    return interaction.reply({
      content: "❌ You haven't registered yet — click **Register** first.",
      flags: MessageFlags.Ephemeral,
    });
  }

  startPending(interaction.user.id, interaction.guildId, 'edit', existing);
  await interaction.showModal(buildStep1Modal(existing));
}

// --- Step 1/3 submitted: team name, owner, whatsapp, email, city ---
async function handleStep1Submit(interaction) {
  const team_name = interaction.fields.getTextInputValue('team_name').trim();
  const owner_name = interaction.fields.getTextInputValue('owner_name').trim();
  const whatsapp = interaction.fields.getTextInputValue('whatsapp').trim();
  const owner_email = interaction.fields.getTextInputValue('owner_email').trim();
  const city = interaction.fields.getTextInputValue('city').trim();

  // Keep whatever they typed (valid or not) so a retry can prefill it —
  // this needs a pending entry to exist even on the very first step.
  if (!getPending(interaction.user.id)) startPending(interaction.user.id, interaction.guildId, 'create');
  updatePending(interaction.user.id, { team_name, owner_name, whatsapp, owner_email, city });

  if (!WHATSAPP_RE.test(whatsapp)) {
    return interaction.reply({
      content: "❌ That WhatsApp number doesn't look valid (digits only, 7-15 digits, optional leading +). Tap **Try Again** to fix it — your other answers are kept.",
      components: [retryRow('t3reg_retry_step1', 'Try Again')],
      flags: MessageFlags.Ephemeral,
    });
  }
  if (!EMAIL_RE.test(owner_email)) {
    return interaction.reply({
      content: "❌ That email address doesn't look valid. Tap **Try Again** to fix it — your other answers are kept.",
      components: [retryRow('t3reg_retry_step1', 'Try Again')],
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.reply({
    content: '✅ Step 1 saved. Continue to enter Player 1 and Player 2 details.',
    components: [continueRow('t3reg_continue_2', 'Continue to Players 1 & 2')],
    flags: MessageFlags.Ephemeral,
  });
}

// "Try Again" after a Step 1 validation error — reopens Step 1's modal
// prefilled with everything they already typed, including the bad field.
async function handleRetryStep1(interaction) {
  const pending = getPending(interaction.user.id);
  if (!pending) {
    return interaction.reply({
      content: `❌ Your registration session expired or was interrupted. ${RESTART_HINT}`,
      flags: MessageFlags.Ephemeral,
    });
  }
  await interaction.showModal(buildStep1Modal(pending.data));
}

// Modal submissions cannot reliably open the next modal directly on every Discord client.
// Use an explicit component interaction so the next modal always opens.
async function handleStep2Button(interaction) {
  const pending = getPending(interaction.user.id);
  if (!pending) {
    return interaction.reply({
      content: `❌ Your registration session expired or was interrupted. ${RESTART_HINT}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.showModal(buildStep2Modal(pending.original));
}

// --- Step 2/3 submitted: player 1 (ign+uid), player 2 (ign+uid) ---
async function handleStep2Submit(interaction) {
  const pending = getPending(interaction.user.id);
  if (!pending) {
    return interaction.reply({
      content: `❌ Your registration session expired or was interrupted. ${RESTART_HINT}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const p1_ign = interaction.fields.getTextInputValue('p1_ign').trim();
  const p1_uid = interaction.fields.getTextInputValue('p1_uid').trim();
  const p2_ign = interaction.fields.getTextInputValue('p2_ign').trim();
  const p2_uid = interaction.fields.getTextInputValue('p2_uid').trim();

  // Keep whatever they typed (valid or not) so a retry can prefill it.
  updatePending(interaction.user.id, { p1_ign, p1_uid, p2_ign, p2_uid });

  for (const [label, uid] of [['Player 1', p1_uid], ['Player 2', p2_uid]]) {
    if (!UID_RE.test(uid)) {
      return interaction.reply({
        content: `❌ ${label}'s Game UID must be numbers only (5-12 digits). Tap **Try Again** to fix it — your other answers are kept.`,
        components: [retryRow('t3reg_retry_step2', 'Try Again')],
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  await interaction.reply({
    content: '✅ Step 2 saved. Continue to enter Player 3, Player 4 and Player 5 details.',
    components: [continueRow('t3reg_continue_3', 'Continue to Player 3, 4 & 5')],
    flags: MessageFlags.Ephemeral,
  });
}

// "Try Again" after a Step 2 validation error — reopens Step 2's modal
// prefilled with everything they already typed, including the bad field.
async function handleRetryStep2(interaction) {
  const pending = getPending(interaction.user.id);
  if (!pending) {
    return interaction.reply({
      content: `❌ Your registration session expired or was interrupted. ${RESTART_HINT}`,
      flags: MessageFlags.Ephemeral,
    });
  }
  await interaction.showModal(buildStep2Modal(pending.data));
}

async function handleStep3Button(interaction) {
  const pending = getPending(interaction.user.id);
  if (!pending) {
    return interaction.reply({
      content: `❌ Your registration session expired or was interrupted. ${RESTART_HINT}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.showModal(buildStep3Modal(pending.original));
}

// --- Step 3/3 submitted: player 3 uid, players 4 and 5 -> ask which 4 play ---
async function handleStep3Submit(interaction) {
  const pendingEntry = getPending(interaction.user.id);
  if (!pendingEntry) {
    return interaction.reply({
      content: `❌ Your registration session expired or was interrupted. ${RESTART_HINT}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const p3_ign = interaction.fields.getTextInputValue('p3_ign').trim();
  const p3_uid = interaction.fields.getTextInputValue('p3_uid').trim();
  const p4_ign = interaction.fields.getTextInputValue('p4_ign').trim();
  const p4_uid = interaction.fields.getTextInputValue('p4_uid').trim();
  const p5_combined = interaction.fields.getTextInputValue('p5_combined').trim();

  // Keep whatever they typed (valid or not) so a retry can prefill it.
  updatePending(interaction.user.id, { p3_ign, p3_uid, p4_ign, p4_uid, p5_combined });

  for (const [label, uid] of [['Player 3', p3_uid], ['Player 4', p4_uid]]) {
    if (!UID_RE.test(uid)) {
      return interaction.reply({
        content: `❌ ${label}'s Game UID must be numbers only (5-12 digits). Tap **Try Again** to fix it — your other answers are kept.`,
        components: [retryRow('t3reg_retry_step3', 'Try Again')],
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  const p5Match = p5_combined ? P5_COMBINED_RE.exec(p5_combined) : null;
  if (p5_combined && !p5Match) {
    return interaction.reply({
      content: '❌ Player 5 must be in the format **IGN - UID** (e.g. `ProGamer123 - 5123456789`), or left blank if there is no Player 5. Tap **Try Again** to fix it — your other answers are kept.',
      components: [retryRow('t3reg_retry_step3', 'Try Again')],
      flags: MessageFlags.Ephemeral,
    });
  }
  const p5_ign = p5Match ? p5Match[1].trim() : '';
  const p5_uid = p5Match ? p5Match[2].trim() : '';
  updatePending(interaction.user.id, { p5_ign, p5_uid });

  const entry = getPending(interaction.user.id);

  // Belt-and-suspenders: every field except Player 5 is `required` on its
  // modal, so this should never actually be missing anything — but if a
  // step was somehow skipped, refuse to continue with a half-filled
  // registration. Player 5 is optional and deliberately excluded here.
  const requiredFields = [
    'team_name', 'owner_name', 'whatsapp', 'owner_email', 'city',
    'p1_ign', 'p1_uid', 'p2_ign', 'p2_uid', 'p3_ign', 'p3_uid', 'p4_ign', 'p4_uid',
  ];
  const missing = requiredFields.filter(f => !entry.data[f]);
  if (missing.length) {
    clearPending(interaction.user.id);
    return interaction.reply({
      content: `❌ Registration incomplete — some details were missing. ${RESTART_HINT}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.reply({
    content: '✅ Step 3 saved. Last step — select the **4 players from this server** who will play:',
    components: [buildPlayerSelectRow()],
    flags: MessageFlags.Ephemeral,
  });
}

// "Try Again" after a Step 3 validation error — reopens Step 3's modal
// prefilled with everything they already typed, including the bad field.
async function handleRetryStep3(interaction) {
  const pending = getPending(interaction.user.id);
  if (!pending) {
    return interaction.reply({
      content: `❌ Your registration session expired or was interrupted. ${RESTART_HINT}`,
      flags: MessageFlags.Ephemeral,
    });
  }
  await interaction.showModal(buildStep3Modal(pending.data));
}

// --- Final step: pick 4 real Discord members as the playing lineup -> finalize and save ---
async function handleSelectPlayers(interaction) {
  const pendingEntry = getPending(interaction.user.id);
  if (!pendingEntry) {
    return interaction.reply({
      content: `❌ Your registration session expired or was interrupted. ${RESTART_HINT}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const selectedIds = interaction.values;
  const isEdit = pendingEntry.mode === 'edit';

  // Reject bot accounts — UserSelectMenu has no built-in "humans only"
  // filter, so this has to be checked after the fact.
  const bots = selectedIds.filter(id => interaction.users.get(id)?.bot);
  if (bots.length) {
    return interaction.update({
      content: `❌ Bots can't be selected as players: ${bots.map(id => `<@${id}>`).join(', ')}. Select 4 real players from the server.`,
      components: [buildPlayerSelectRow()],
    });
  }

  // Reject players already locked into another team's lineup. When
  // editing, skip the caller's own existing record so re-picking the same
  // players (or swapping just one) doesn't falsely flag as a conflict.
  const store = getGuildStore(interaction.guildId);
  const takenBy = new Map(); // playerId -> team name that already has them
  if (store.registrations) {
    for (const [ownerId, record] of Object.entries(store.registrations)) {
      if (isEdit && ownerId === interaction.user.id) continue;
      for (const pid of record.selectedPlayerIds || []) {
        if (!takenBy.has(pid)) takenBy.set(pid, record.team_name);
      }
    }
  }
  const conflicts = selectedIds.filter(id => takenBy.has(id));
  if (conflicts.length) {
    const list = conflicts.map(id => `<@${id}> (already in **${takenBy.get(id)}**)`).join(', ');
    return interaction.update({
      content: `❌ These players are already selected in another team's lineup: ${list}. Pick different players.`,
      components: [buildPlayerSelectRow()],
    });
  }

  const data = { ...pendingEntry.data, selectedPlayerIds: selectedIds };

  if (!store.registrations) store.registrations = {};
  if (!store.settings) store.settings = {};

  const existingRecord = store.registrations[interaction.user.id];

  if (!isEdit && existingRecord) {
    // Belt-and-suspenders: handleRegisterButton already blocks this, but guard
    // against a race (e.g. two rapid submissions) from double-creating.
    clearPending(interaction.user.id);
    return interaction.reply({
      content: `❌ You've already registered team **${existingRecord.team_name}**. Use **Edit** to update your details instead.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  let teamNumber;
  let slotWarning = null;
  if (isEdit && existingRecord) {
    teamNumber = existingRecord.teamNumber;
    data.registeredDate = existingRecord.registeredDate; // keep original registration date
    // Keep the slot/group already assigned on the original registration —
    // editing details shouldn't bump a team out of its group or re-roll a
    // new slot. If the original registration somehow never got a slot
    // (e.g. all slots were full at the time), try to assign one now.
    if (existingRecord.slotNumber && store.scrim && store.scrim.slots[existingRecord.slotNumber]) {
      data.slotNumber = existingRecord.slotNumber;
      data.group = existingRecord.group;
      // Refresh the stored slot with the edited details so the group's
      // roster reflects the latest info.
      store.scrim.slots[existingRecord.slotNumber] = {
        ...store.scrim.slots[existingRecord.slotNumber],
        team: data.team_name,
        ownerName: data.owner_name,
        whatsapp: data.whatsapp,
        players: [1, 2, 3, 4].map(n => `${data[`p${n}_ign`]} (${data[`p${n}_uid`]})`),
        selectedPlayerIds: data.selectedPlayerIds || [],
      };
    } else {
      const result = assignSlot(store, interaction.user.id, data);
      if (result.error) slotWarning = result.error;
      else { data.slotNumber = result.assigned; data.group = result.group; }
    }
  } else {
    teamNumber = (store.settings.teamCounter || 0) + 1;
    store.settings.teamCounter = teamNumber;
    data.registeredDate = new Date().toISOString();

    const result = assignSlot(store, interaction.user.id, data);
    if (result.error) slotWarning = result.error;
    else { data.slotNumber = result.assigned; data.group = result.group; }
  }
  data.teamNumber = teamNumber;

  store.registrations[interaction.user.id] = data;
  saveGuildStore(interaction.guildId, store);
  clearPending(interaction.user.id);

  // Auto-creates (once per group) that group's role + private lobby channel,
  // and grants the registering player the role — see giveGroupRole above.
  if (data.group) {
    await giveGroupRole(interaction, store, data.group);
  }

  const confirmedEmbed = buildRegisteredEmbed(data, isEdit);
  if (data.group) {
    const channelId = store.settings.groupChannels && store.settings.groupChannels[data.group];
    confirmedEmbed.addFields({
      name: 'Slot & Group',
      value: `${groupDisplayName(data.group)} — Slot ${localSlotNumber(data.slotNumber)}\n${matchScheduleLines(data.group, store)}` +
        (channelId ? `\n🔒 Your lobby: <#${channelId}> (locked until an admin runs \`!open\`)` : ''),
    });
  } else if (slotWarning) {
    confirmedEmbed.addFields({ name: 'Slot & Group', value: slotWarning });
  }

  // Post the full detail card to the configured log channel, if one was set.
  const logChannelId = store.settings.logChannelId;
  if (logChannelId) {
    const logChannel = interaction.guild.channels.cache.get(logChannelId);
    if (logChannel) {
      try {
        await logChannel.send({ embeds: [buildRegisteredLogEmbed(data, teamNumber, interaction.user.id, isEdit)] });
      } catch (err) {
        console.error('Failed to post registration to log channel:', err);
        // Don't block the user's confirmation just because the log post failed
        // (e.g. channel deleted, bot missing permissions).
      }
    } else {
      console.error(`[log-channel] Configured logChannelId ${logChannelId} no longer exists in guild ${interaction.guildId} — re-run /set-log-channel.`);
    }
  }

  await interaction.update({
    content: null,
    embeds: [confirmedEmbed],
    components: [],
  });

  // Keep the standing live panel (if one is posted) in sync with the new
  // slot fill count right away, rather than waiting for the 5-minute
  // day-rollover poll to catch up.
  await refreshLivePanel(interaction.client, interaction.guildId);
  if (data.group) {
    await refreshSlotList(interaction.client, interaction.guildId, 1, data.group);
  }
}

module.exports = {
  buildRegisteredLogEmbed,
  buildRegistrationPanelPayload,
  hasRequiredRole,
  giveGroupRole,
  handleRegisterButton,
  handleEditButton,
  handleStep1Submit,
  handleRetryStep1,
  handleStep2Button,
  handleStep2Submit,
  handleRetryStep2,
  handleStep3Button,
  handleStep3Submit,
  handleRetryStep3,
  handleSelectPlayers,
};
