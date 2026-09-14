const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ChannelType, MessageFlags, PermissionFlagsBits,
} = require('discord.js');
const { getGuildStore, saveGuildStore } = require('./storage');
const { groupDisplayName, resolveGroupSchedule } = require('./group-schedule');
const {
  getMaxRounds, roundLabel, roundChannelName, getRound, findTeamInRound,
  removeTeamFromRoundOnward, getRoundOneTeams,
} = require('./rounds');
const { refreshSlotList } = require('./slotlist-handlers');

const MAX_GUILD_ROLES = 250;
const MAX_GUILD_CHANNELS = 500;
const SAFETY_MARGIN = 5;

function hasManageGuild(interaction) {
  return interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);
}

function sourceLabel(roundNum, letter) {
  return roundNum === 1 ? groupDisplayName(letter) : roundLabel(roundNum);
}

// Posted automatically (once) in a Round 1 group's lobby channel when it's
// first created, and in a Round 2+ pool's channel when it's first created —
// the "Result" button is how an admin promotes qualifying teams up to the
// next round, or (on whichever round currently is the last configured one)
// crowns the winner. Whether this round is "final" is computed fresh every
// time the button is actually clicked (see buildQualifySelectPayload), so
// raising Max Rounds later re-opens promotion from a panel that was posted
// back when it looked final.
function buildGroupResultPanelPayload(roundNum, letter) {
  const label = sourceLabel(roundNum, letter);
  const embed = new EmbedBuilder()
    .setTitle(`🛠️ ${label} — Admin Panel`)
    .setColor(0x5865F2)
    .setDescription(
      `**Result** marks this ${roundNum === 1 ? 'group' : 'round'}'s qualifiers and promotes them into **${roundLabel(roundNum + 1)}** ` +
      `(its own role + channel) — or, if this is the last configured round, picks the tournament winner instead.`
    );

  const idPart = roundNum === 1 ? `1:${letter}` : `${roundNum}`;

  const reminderRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`t3_reminder:${idPart}`).setLabel('Match Reminder').setEmoji('⏰').setStyle(ButtonStyle.Secondary)
  );
  const publishRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`t3_publish:${idPart}`).setLabel('Publish Slot List').setEmoji('📤').setStyle(ButtonStyle.Success)
  );
  const rows = [reminderRow, publishRow];

  // "Manage Slot" only makes sense for Round 1 — Round 2+ pools have no
  // per-slot concept to switch between.
  if (roundNum === 1) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`t3_manage:${idPart}`).setLabel('Manage Slot').setEmoji('🔄').setStyle(ButtonStyle.Secondary)
    ));
  }

  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`t3_punish:${idPart}`).setLabel('Punish Team').setEmoji('🔨').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`t3_result:${idPart}`).setLabel('Result').setEmoji('🌟').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`t3_delete:${idPart}`).setLabel('Delete Group').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
  ));

  return { embeds: [embed], components: rows };
}

// Posted publicly in-channel (not ephemeral) so players actually see it —
// pings the group/round role plus its match schedule, when there is one.
// Round 2+ pools have no per-slot schedule of their own, so those just get
// a plain heads-up ping instead.
async function handleReminderButton(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }
  const [, roundStr, letterRaw] = interaction.customId.split(':');
  const roundNum = parseInt(roundStr, 10);
  const letter = letterRaw === '_' || letterRaw === undefined ? null : letterRaw;
  const store = getGuildStore(interaction.guildId);

  const roleId = roundNum === 1
    ? (store.settings.groupRoles && store.settings.groupRoles[letter])
    : (getRound(store, roundNum).roleId);
  const mention = roleId ? `<@&${roleId}>` : '@everyone';

  let scheduleText = 'Match schedule not set yet — ask an admin.';
  if (roundNum === 1) {
    const resolved = resolveGroupSchedule(letter, store);
    if (resolved) {
      scheduleText = resolved.matchesToShow
        .map((m, i) => `⏰ **Match ${i + 1}** — IDP ${m.idp} PM | Start ${m.start} PM | ${m.map}`)
        .join('\n');
    }
  } else {
    scheduleText = 'Get ready — check this channel for the next match details.';
  }

  await interaction.reply({
    content: `📢 ${mention} **Match Reminder** — get ready!\n${scheduleText}\n\nBe online and ready **5 minutes before IDP**. Good luck! 🏆`,
    allowedMentions: roleId ? { roles: [roleId] } : { parse: ['everyone'] },
  });
}

async function postGroupResultPanel(channel, roundNum, letter) {
  await channel.send(buildGroupResultPanelPayload(roundNum, letter));
}

function parseSourceTeams(store, roundNum, letter) {
  return roundNum === 1 ? getRoundOneTeams(store, letter) : getRound(store, roundNum).teams;
}

function buildQualifySelectPayload(store, roundNum, letter) {
  const label = sourceLabel(roundNum, letter);
  const teams = parseSourceTeams(store, roundNum, letter);

  if (!teams.length) {
    return { error: `❌ ${label} has no registered teams yet.` };
  }
  if (teams.length > 25) {
    return { error: `❌ ${label} has ${teams.length} teams — Discord select menus cap at 25 options, so this can't be shown as one list.` };
  }

  const maxRounds = getMaxRounds(store);
  const nextRound = roundNum + 1;
  const isFinalRound = nextRound > maxRounds;

  const winner = store.settings && store.settings.t3Winner;
  const alreadyPromoted = new Set(
    isFinalRound ? [] : teams.filter(t => findTeamInRound(store, nextRound, t.ownerId)).map(t => t.ownerId)
  );

  const select = new StringSelectMenuBuilder()
    .setCustomId(`t3_qualify:${roundNum}:${letter || '_'}`)
    .setPlaceholder(isFinalRound ? `Select the winner from ${label}` : `Select qualifying teams from ${label}`)
    .setMinValues(0)
    .setMaxValues(isFinalRound ? 1 : teams.length)
    .addOptions(teams.map(t => ({
      label: t.team.slice(0, 100),
      value: t.ownerId,
      default: isFinalRound ? (winner && winner.ownerId === t.ownerId) : alreadyPromoted.has(t.ownerId),
    })));

  const embed = new EmbedBuilder()
    .setTitle(isFinalRound ? `🏆 Pick the Winner — ${label}` : `✅ Qualify Teams — ${label}`)
    .setColor(0x5865F2)
    .setDescription(
      isFinalRound
        ? `Select the **one** team that wins — they'll receive the **T3 Scrims Winner** role. This is the final configured round, so no one is promoted further.`
        : `Select every team that qualifies, then confirm — they'll be promoted into **${roundLabel(nextRound)}**. Already-promoted teams are pre-checked.`
    );

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] };
}

async function handleResultButton(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }
  const [, roundStr, letter] = interaction.customId.split(':');
  const roundNum = parseInt(roundStr, 10);
  const store = getGuildStore(interaction.guildId);

  const payload = buildQualifySelectPayload(store, roundNum, letter);
  if (payload.error) {
    return interaction.reply({ content: payload.error, flags: MessageFlags.Ephemeral });
  }
  await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

// Where a group/round's channel + role IDs currently live — Round 1 groups
// keep theirs in store.settings.groupChannels/groupRoles (keyed by letter),
// Round 2+ pools keep theirs on the round object itself.
function groupChannelAndRole(store, roundNum, letter) {
  if (roundNum === 1) {
    return {
      channelId: store.settings.groupChannels && store.settings.groupChannels[letter],
      roleId: store.settings.groupRoles && store.settings.groupRoles[letter],
    };
  }
  const round = getRound(store, roundNum);
  return { channelId: round.channelId, roleId: round.roleId };
}

// Tracks whether Result has ever been submitted for this group/round —
// same gate the old bot used (isGroupClosed) to keep Delete Group from
// being used on a group that's still mid-registration. Set once, the first
// time a Result select menu is submitted for that source; never cleared by
// re-running Result again.
function markResultPosted(store, roundNum, letter) {
  if (roundNum === 1) {
    if (!store.settings.groupResultPosted) store.settings.groupResultPosted = {};
    store.settings.groupResultPosted[letter] = true;
  } else {
    getRound(store, roundNum).resultPosted = true;
  }
}

function isResultPosted(store, roundNum, letter) {
  if (roundNum === 1) {
    return !!(store.settings.groupResultPosted && store.settings.groupResultPosted[letter]);
  }
  const round = store.rounds && store.rounds[roundNum];
  return !!(round && round.resultPosted);
}

// Mirrors the old bot's Delete Group button: asks for confirmation before
// touching anything, same as Punish/Result being gated behind Manage
// Server. Works for a Round 1 group's channel+role or a Round 2+ pool's,
// since this panel is shared between both. Also mirrors the old bot's
// requirement that Result has been posted first — deleting mid-registration
// would yank the channel/role out from under teams still trying to play.
async function handleDeleteButton(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }
  const [, roundStr, letterRaw] = interaction.customId.split(':');
  const roundNum = parseInt(roundStr, 10);
  const letter = letterRaw === '_' || letterRaw === undefined ? null : letterRaw;
  const store = getGuildStore(interaction.guildId);
  const label = sourceLabel(roundNum, letter);

  if (!isResultPosted(store, roundNum, letter)) {
    return interaction.reply({
      content: `❌ Publish **${label}**'s result first (via the **Result** button) before deleting this group.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const { channelId, roleId } = groupChannelAndRole(store, roundNum, letter);
  if (!channelId && !roleId) {
    return interaction.reply({ content: `❌ ${label} doesn't have a channel or role to delete.`, flags: MessageFlags.Ephemeral });
  }

  const idPart = roundNum === 1 ? `1:${letter}` : `${roundNum}`;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`t3_delete_confirm:${idPart}`).setLabel('Yes, delete it').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`t3_delete_cancel:${idPart}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
  return interaction.reply({
    content: `⚠️ Delete **${label}**'s channel and role? This can't be undone — registered teams stay on record, but this channel/role won't come back on its own.`,
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

// Deletes whichever of the channel/role exist and cleans up every stored
// reference to them (header/roster message ids, the auto-created-role/
// channel tracking lists) so nothing points at a now-deleted channel or
// role afterward. Never touches scrim.slots or a round's teams array —
// registered teams stay on record even after their channel/role are gone.
// Deleting the channel here also fires Discord's channelDelete event,
// which channel-cleanup-handlers.js listens for and would try to clean up
// again — that's fine, it's idempotent once storage no longer has these
// ids to match against.
async function handleDeleteConfirmButton(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }
  const [, roundStr, letterRaw] = interaction.customId.split(':');
  const roundNum = parseInt(roundStr, 10);
  const letter = letterRaw === '_' || letterRaw === undefined ? null : letterRaw;
  const store = getGuildStore(interaction.guildId);
  const label = sourceLabel(roundNum, letter);

  await interaction.deferUpdate();

  const { channelId, roleId } = groupChannelAndRole(store, roundNum, letter);
  const deleted = [];
  const failed = [];

  if (channelId) {
    try {
      const channel = interaction.guild.channels.cache.get(channelId);
      if (channel) await channel.delete(`Deleted via Delete Group button (${label})`);
      deleted.push('channel');
    } catch (err) {
      failed.push(`channel (${err.code ?? err.message})`);
    }
  }

  if (roleId) {
    try {
      const role = interaction.guild.roles.cache.get(roleId);
      if (role) await role.delete(`Deleted via Delete Group button (${label})`);
      deleted.push('role');
    } catch (err) {
      failed.push(`role (${err.code ?? err.message})`);
    }
  }

  const freshStore = getGuildStore(interaction.guildId);
  if (roundNum === 1) {
    if (freshStore.settings.groupChannels) delete freshStore.settings.groupChannels[letter];
    if (freshStore.settings.groupRoles) delete freshStore.settings.groupRoles[letter];
    if (freshStore.settings.slotListMessages) delete freshStore.settings.slotListMessages[`1:${letter}`];
    if (freshStore.settings.groupResultPosted) delete freshStore.settings.groupResultPosted[letter];
    if (freshStore.settings.autoGroupChannelIds) {
      freshStore.settings.autoGroupChannelIds = freshStore.settings.autoGroupChannelIds.filter(id => id !== channelId);
    }
    if (roleId && freshStore.settings.autoGroupRoleIds) {
      freshStore.settings.autoGroupRoleIds = freshStore.settings.autoGroupRoleIds.filter(id => id !== roleId);
    }
  } else {
    const round = getRound(freshStore, roundNum);
    round.channelId = null;
    round.roleId = null;
    if (freshStore.settings.slotListMessages) delete freshStore.settings.slotListMessages[roundNum];
  }
  saveGuildStore(interaction.guildId, freshStore);

  const summary = deleted.length
    ? `🗑️ Deleted ${label}'s ${deleted.join(' and ')}.`
    : `❌ Nothing was deleted.`;
  const failureNote = failed.length ? `\n⚠️ Couldn't delete: ${failed.join(', ')}.` : '';

  // The channel this message lived in may itself have just been deleted,
  // so editing the original reply can fail — that's fine, ignore it.
  await interaction.editReply({ content: summary + failureNote, components: [] }).catch(() => {});
}

async function handleDeleteCancelButton(interaction) {
  return interaction.update({ content: '❌ Cancelled — nothing was deleted.', components: [] });
}

// Creates (once per round) that round's role + single pool channel, and
// posts its Result panel. Mirrors giveGroupRole/giveGroupChannel in
// registration-handlers.js but for a single round-wide pool instead of a
// per-group Round-1 channel. Never throws — a role/channel hiccup should
// never block a promotion from being recorded.
async function ensureRoundRoleAndChannel(interaction, store, roundNum) {
  const round = getRound(store, roundNum);
  const botMember = interaction.guild.members.me;

  let role = round.roleId ? interaction.guild.roles.cache.get(round.roleId) : null;
  if (!role) {
    if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
      console.error(`[round-role] Bot is missing "Manage Roles" in guild ${interaction.guildId}.`);
    } else if (interaction.guild.roles.cache.size >= MAX_GUILD_ROLES - SAFETY_MARGIN) {
      console.error(`[round-role] Guild ${interaction.guildId} is at/near the ${MAX_GUILD_ROLES}-role cap — skipping ${roundLabel(roundNum)}.`);
    } else {
      try {
        role = await interaction.guild.roles.create({
          name: roundLabel(roundNum),
          mentionable: false,
          reason: `Auto-created for ${roundLabel(roundNum)} promotions`,
        });
        round.roleId = role.id;
        saveGuildStore(interaction.guildId, store);
      } catch (err) {
        console.error(`[round-role] Failed to create role for ${roundLabel(roundNum)} in guild ${interaction.guildId}: ${err.code ?? ''} ${err.message}`);
      }
    }
  }

  if (!round.channelId || !interaction.guild.channels.cache.get(round.channelId)) {
    if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
      console.error(`[round-channel] Bot is missing "Manage Channels" in guild ${interaction.guildId}.`);
    } else if (interaction.guild.channels.cache.size >= MAX_GUILD_CHANNELS - SAFETY_MARGIN) {
      console.error(`[round-channel] Guild ${interaction.guildId} is at/near the ${MAX_GUILD_CHANNELS}-channel cap — skipping ${roundLabel(roundNum)}.`);
    } else {
      try {
        let category = store.settings.roundsCategoryId
          ? interaction.guild.channels.cache.get(store.settings.roundsCategoryId)
          : null;
        if (!category) {
          category = await interaction.guild.channels.create({
            name: '🏆 T3 Rounds',
            type: ChannelType.GuildCategory,
            reason: 'Auto-created to hold promotion-round pool channels',
          });
          store.settings.roundsCategoryId = category.id;
        }

        const overwrites = [{ id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }];
        if (role) {
          overwrites.push({
            id: role.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
            deny: [
              PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles,
              PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.CreatePrivateThreads,
              PermissionFlagsBits.SendMessagesInThreads,
            ],
          });
        }

        const channel = await interaction.guild.channels.create({
          name: roundChannelName(roundNum),
          type: ChannelType.GuildText,
          parent: category.id,
          permissionOverwrites: overwrites,
          reason: `Auto-created for ${roundLabel(roundNum)}`,
        });
        round.channelId = channel.id;
        saveGuildStore(interaction.guildId, store);

        await postGroupResultPanel(channel, roundNum, null);
      } catch (err) {
        console.error(`[round-channel] Failed to create channel for ${roundLabel(roundNum)} in guild ${interaction.guildId}: ${err.code ?? ''} ${err.message}`);
      }
    }
  }

  return role;
}

async function ensureWinnerRole(interaction, store) {
  if (!store.settings) store.settings = {};
  let role = store.settings.winnerRoleId ? interaction.guild.roles.cache.get(store.settings.winnerRoleId) : null;
  if (role) return role;

  const botMember = interaction.guild.members.me;
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) return null;
  if (interaction.guild.roles.cache.size >= MAX_GUILD_ROLES - SAFETY_MARGIN) return null;

  try {
    role = await interaction.guild.roles.create({
      name: 'T3 Scrims Winner',
      mentionable: false,
      color: 0xFFD700,
      reason: 'Auto-created for the T3 Scrims winner',
    });
    store.settings.winnerRoleId = role.id;
    saveGuildStore(interaction.guildId, store);
  } catch (err) {
    console.error(`[winner-role] Failed to create winner role in guild ${interaction.guildId}: ${err.code ?? ''} ${err.message}`);
    return null;
  }
  return role;
}

// Only the person who actually ran /register (the team owner) gets
// promotion/winner roles — the 4 tagged teammates picked in the player
// select menu never receive a role themselves, since they never went
// through registration.
async function addRoleToTeam(interaction, roleId, ownerId) {
  if (!roleId) return;
  const member = interaction.guild.members.cache.get(ownerId)
    ?? await interaction.guild.members.fetch(ownerId).catch(() => null);
  if (!member) return;
  await member.roles.add(roleId).catch(() => {});
}

async function removeRoleFromTeam(interaction, roleId, ownerId) {
  if (!roleId) return;
  const member = interaction.guild.members.cache.get(ownerId)
    ?? await interaction.guild.members.fetch(ownerId).catch(() => null);
  if (!member) return;
  await member.roles.remove(roleId).catch(() => {});
}

async function handleQualifySelectSubmit(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }

  const [, roundStr, letterRaw] = interaction.customId.split(':');
  const roundNum = parseInt(roundStr, 10);
  const letter = letterRaw === '_' ? null : letterRaw;
  const store = getGuildStore(interaction.guildId);

  const teams = parseSourceTeams(store, roundNum, letter);
  const label = sourceLabel(roundNum, letter);
  if (!teams.length) {
    return interaction.update({ content: `❌ ${label} no longer has any teams.`, embeds: [], components: [] });
  }

  await interaction.deferUpdate();

  markResultPosted(store, roundNum, letter);
  saveGuildStore(interaction.guildId, store);

  const selectedOwnerIds = new Set(interaction.values);
  const selectedTeams = teams.filter(t => selectedOwnerIds.has(t.ownerId));
  const selectedNames = selectedTeams.map(t => t.team);

  const maxRounds = getMaxRounds(store);
  const nextRound = roundNum + 1;
  const isFinalRound = nextRound > maxRounds;

  const lines = [`✅ ${label} picks updated: ${selectedNames.length ? selectedNames.map(t => `**${t}**`).join(', ') : '_none selected_'}`];

  if (!isFinalRound) {
    // Re-running Result cleanly replaces the previous picks: un-promote
    // (cascading through any further rounds they'd already reached) anyone
    // from this source who isn't selected this time.
    for (const t of teams) {
      if (!selectedOwnerIds.has(t.ownerId)) {
        await removeTeamFromRoundOnward(interaction, store, t.ownerId, t.playerIds, nextRound);
      }
    }
    saveGuildStore(interaction.guildId, store);

    const promoted = [];
    for (const t of selectedTeams) {
      if (findTeamInRound(store, nextRound, t.ownerId)) continue; // already promoted, leave as-is

      const role = await ensureRoundRoleAndChannel(interaction, store, nextRound);
      const round = getRound(store, nextRound);
      round.teams.push({ team: t.team, ownerId: t.ownerId, playerIds: t.playerIds, fromRound: roundNum, fromGroup: letter });
      saveGuildStore(interaction.guildId, store);

      await addRoleToTeam(interaction, role ? role.id : round.roleId, t.ownerId);
      promoted.push(`**${t.team}** → ${roundLabel(nextRound)}`);
    }
    if (promoted.length) lines.push(`🏆 ${promoted.join('\n🏆 ')}`);

    // The source's own roster doesn't change (teams stay put, only their
    // promotion status does) — it's the destination round's pool that just
    // gained/lost members, so that's the slot list worth re-rendering.
    await refreshSlotList(interaction.client, interaction.guildId, nextRound, null);
  } else {
    // Final round: select menu caps at 1, so at most one team here.
    const winnerTeam = selectedTeams[0] || null;
    const previousWinner = store.settings && store.settings.t3Winner;

    if (previousWinner && (!winnerTeam || previousWinner.ownerId !== winnerTeam.ownerId) && store.settings.winnerRoleId) {
      await removeRoleFromTeam(interaction, store.settings.winnerRoleId, previousWinner.ownerId);
    }

    if (!store.settings) store.settings = {};
    if (winnerTeam) {
      const role = await ensureWinnerRole(interaction, store);
      store.settings.t3Winner = { team: winnerTeam.team, ownerId: winnerTeam.ownerId, playerIds: winnerTeam.playerIds };
      saveGuildStore(interaction.guildId, store);
      await addRoleToTeam(interaction, role ? role.id : store.settings.winnerRoleId, winnerTeam.ownerId);
      lines.push(`🏆 **${winnerTeam.team}** is crowned the T3 Scrims winner${role ? ` and received the **${role.name}** role` : ''}!`);
    } else {
      store.settings.t3Winner = null;
      saveGuildStore(interaction.guildId, store);
    }
  }

  await interaction.editReply({ content: lines.join('\n'), embeds: [], components: [] });
}

module.exports = {
  postGroupResultPanel,
  handleResultButton,
  handleReminderButton,
  handleQualifySelectSubmit,
  handleDeleteButton,
  handleDeleteConfirmButton,
  handleDeleteCancelButton,
};
