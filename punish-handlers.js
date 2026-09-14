const {
  EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, PermissionFlagsBits, MessageFlags,
} = require('discord.js');
const { getGuildStore, saveGuildStore, listGuildIds } = require('./storage');
const { groupDisplayName } = require('./group-schedule');
const { getRound, getRoundOneTeams, roundLabel } = require('./rounds');
const { refreshLivePanel } = require('./live-panel-handlers');
const { refreshSlotList } = require('./slotlist-handlers');

// Punishing a team doesn't Discord-ban them — it gives them a role that
// blocks the Register button (checked from registration-handlers.js) for a
// fixed window, on top of immediately clearing them out of whichever
// group/round they were in. The role comes off automatically once the
// window elapses (see startScrimsBanExpiry) — nobody has to remember to
// lift it by hand.
const SCRIMS_BAN_DURATION_MS = 2 * 24 * 60 * 60 * 1000; // 2 days
const SCRIMS_BAN_ROLE_NAME = 'Scrims Ban';

function hasManageGuild(interaction) {
  return interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);
}

function sourceLabel(roundNum, letter) {
  return roundNum === 1 ? groupDisplayName(letter) : roundLabel(roundNum);
}

function parseSourceTeams(store, roundNum, letter) {
  return roundNum === 1 ? getRoundOneTeams(store, letter) : getRound(store, roundNum).teams;
}

async function getOrCreateScrimsBanRole(interaction, store) {
  if (!store.settings) store.settings = {};
  const existing = store.settings.scrimsBanRoleId
    ? interaction.guild.roles.cache.get(store.settings.scrimsBanRoleId)
    : null;
  if (existing) return existing;

  const role = await interaction.guild.roles.create({
    name: SCRIMS_BAN_ROLE_NAME,
    color: 0x2C2F33,
    mentionable: false,
    reason: 'Auto-created for punishing teams (blocks registration for 2 days)',
  });
  store.settings.scrimsBanRoleId = role.id;
  saveGuildStore(interaction.guildId, store);
  return role;
}

// Returns the ban's expiry timestamp (ms) if `userId` is currently banned,
// or null if they're clear to register — clearing the entry automatically
// once it's expired rather than leaving it to linger in storage.
function getScrimsBanExpiry(store, userId) {
  const bans = store.settings && store.settings.scrimsBans;
  if (!bans || !bans[userId]) return null;
  if (bans[userId] <= Date.now()) {
    delete bans[userId];
    return null;
  }
  return bans[userId];
}

// Polls periodically and removes the Scrims Ban role (+ tracking entry)
// from anyone whose 2-day window has elapsed.
function startScrimsBanExpiry(client, intervalMs = 15 * 60 * 1000) {
  setInterval(async () => {
    for (const guildId of listGuildIds()) {
      const store = getGuildStore(guildId);
      const bans = store.settings && store.settings.scrimsBans;
      if (!bans || !Object.keys(bans).length) continue;

      const roleId = store.settings.scrimsBanRoleId;
      const now = Date.now();
      let changed = false;

      for (const [userId, expiresAt] of Object.entries(bans)) {
        if (expiresAt > now) continue;
        changed = true;
        delete bans[userId];

        if (roleId) {
          try {
            const guild = await client.guilds.fetch(guildId);
            const member = await guild.members.fetch(userId);
            if (member.roles.cache.has(roleId)) await member.roles.remove(roleId, 'Scrims ban expired (2 days)');
          } catch (err) {
            // Member left the server, or the role's gone — nothing more to do.
          }
        }
      }

      if (changed) saveGuildStore(guildId, store);
    }
  }, intervalMs);
}

// Builds the "pick team(s) to punish" select menu for one group (Round 1)
// or one round's pool (Round 2+). Returns { error } instead of a payload
// when there's nothing that can be shown.
function buildPunishSelectPayload(store, roundNum, letter) {
  const label = sourceLabel(roundNum, letter);
  const teams = parseSourceTeams(store, roundNum, letter);

  if (!teams.length) {
    return { error: `❌ ${label} has no registered teams.` };
  }
  if (teams.length > 25) {
    return { error: `❌ ${label} has ${teams.length} teams — Discord select menus cap at 25 options.` };
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`t3_punish_select:${roundNum}:${letter || '_'}`)
    .setPlaceholder(`Select team(s) to punish from ${label}`)
    .setMinValues(1)
    .setMaxValues(teams.length)
    .addOptions(teams.map(t => ({ label: t.team.slice(0, 100), value: t.ownerId })));

  const embed = new EmbedBuilder()
    .setTitle(`🔨 Punish Teams — ${label}`)
    .setColor(0xED4245)
    .setDescription(
      'Select every team whose whole roster should be punished, then confirm. ' +
      `They'll be removed from ${roundNum === 1 ? 'their group' : 'this round'} and blocked from registering again for 2 days.`
    );

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] };
}

async function handlePunishButton(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }
  const [, roundStr, letterRaw] = interaction.customId.split(':');
  const roundNum = parseInt(roundStr, 10);
  const letter = letterRaw === '_' || letterRaw === undefined ? null : letterRaw;

  const store = getGuildStore(interaction.guildId);
  const payload = buildPunishSelectPayload(store, roundNum, letter);
  if (payload.error) {
    return interaction.reply({ content: payload.error, flags: MessageFlags.Ephemeral });
  }
  await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

// Removes a team from wherever it currently is (Round 1 slot, or a Round
// 2+ pool) and strips its group/round role from every roster member.
// Never throws — a cleanup hiccup shouldn't block the rest of the batch.
async function removeTeamFromPlay(interaction, store, roundNum, letter, team) {
  const targets = new Set([team.ownerId, ...(team.playerIds || [])].filter(Boolean));

  if (roundNum === 1) {
    const groupRoleId = store.settings.groupRoles && store.settings.groupRoles[letter];
    for (const userId of targets) {
      if (!groupRoleId) continue;
      try {
        const member = await interaction.guild.members.fetch(userId);
        if (member.roles.cache.has(groupRoleId)) await member.roles.remove(groupRoleId);
      } catch (err) { /* left the server, or missing permission — nothing more to do */ }
    }
    if (store.scrim && store.scrim.slots) {
      for (const [slotNum, slot] of Object.entries(store.scrim.slots)) {
        if (slot.userId === team.ownerId) delete store.scrim.slots[slotNum];
      }
    }
    if (store.registrations) delete store.registrations[team.ownerId];
  } else {
    const round = getRound(store, roundNum);
    const idx = round.teams.findIndex(t => t.ownerId === team.ownerId);
    if (idx !== -1) round.teams.splice(idx, 1);
    for (const userId of targets) {
      if (!round.roleId) continue;
      try {
        const member = await interaction.guild.members.fetch(userId);
        if (member.roles.cache.has(round.roleId)) await member.roles.remove(round.roleId);
      } catch (err) { /* left the server, or missing permission — nothing more to do */ }
    }
  }
}

async function postPunishmentLog(interaction, store, roundNum, letter, entries, expiresAt) {
  if (!entries.length) return;
  const logChannelId = store.settings && store.settings.logChannelId;
  if (!logChannelId) return;
  const logChannel = interaction.guild.channels.cache.get(logChannelId);
  if (!logChannel) return;

  const lines = entries.map(e => `• **${e.team}** — Owner <@${e.ownerId}>`).join('\n');
  const embed = new EmbedBuilder()
    .setTitle(`🔨 Teams Punished — ${sourceLabel(roundNum, letter)}`)
    .setColor(0xED4245)
    .setDescription(
      `${lines}\n\n**${SCRIMS_BAN_ROLE_NAME}** given — registration blocked until <t:${Math.floor(expiresAt / 1000)}:F> (<t:${Math.floor(expiresAt / 1000)}:R>).\n` +
      `Punished by <@${interaction.user.id}>`
    )
    .setTimestamp();

  try {
    await logChannel.send({ embeds: [embed] });
  } catch (err) {
    console.error('Failed to post punishment to log channel:', err);
  }
}

async function handlePunishSelect(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }

  const [, roundStr, letterRaw] = interaction.customId.split(':');
  const roundNum = parseInt(roundStr, 10);
  const letter = letterRaw === '_' || letterRaw === undefined ? null : letterRaw;

  const store = getGuildStore(interaction.guildId);
  const teams = parseSourceTeams(store, roundNum, letter);
  const label = sourceLabel(roundNum, letter);

  const botMember = interaction.guild.members.me;
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return interaction.update({ content: '❌ I need the **Manage Roles** permission to punish teams.', embeds: [], components: [] });
  }

  // Giving/removing roles per account can take longer than the 3-second
  // interaction ack window, so acknowledge first and edit once it's done.
  await interaction.deferUpdate();

  let scrimsBanRole;
  try {
    scrimsBanRole = await getOrCreateScrimsBanRole(interaction, store);
  } catch (err) {
    return interaction.editReply({ content: `❌ Couldn't create/find the **${SCRIMS_BAN_ROLE_NAME}** role: ${err.message}`, embeds: [], components: [] });
  }
  if (scrimsBanRole.position >= botMember.roles.highest.position) {
    return interaction.editReply({ content: `❌ My highest role is below **${scrimsBanRole.name}** — move my role above it so I can assign it.`, embeds: [], components: [] });
  }

  const selectedOwnerIds = new Set(interaction.values);
  const selectedTeams = teams.filter(t => selectedOwnerIds.has(t.ownerId));
  if (!selectedTeams.length) {
    return interaction.editReply({ content: `❌ ${label} no longer has any of the selected teams.`, embeds: [], components: [] });
  }

  if (!store.settings.scrimsBans) store.settings.scrimsBans = {};
  const expiresAt = Date.now() + SCRIMS_BAN_DURATION_MS;

  const punished = [];
  const failed = [];
  const logEntries = [];

  for (const team of selectedTeams) {
    const targets = new Set([team.ownerId, ...(team.playerIds || [])].filter(Boolean));
    for (const userId of targets) {
      try {
        const member = await interaction.guild.members.fetch(userId);
        await member.roles.add(scrimsBanRole.id);
        store.settings.scrimsBans[userId] = expiresAt;
        punished.push(userId);
      } catch (err) {
        failed.push(userId);
      }
    }
    await removeTeamFromPlay(interaction, store, roundNum, letter, team);
    logEntries.push({ team: team.team, ownerId: team.ownerId });
  }

  saveGuildStore(interaction.guildId, store);
  await refreshLivePanel(interaction.client, interaction.guildId);
  await refreshSlotList(interaction.client, interaction.guildId, roundNum, letter);
  await postPunishmentLog(interaction, store, roundNum, letter, logEntries, expiresAt);

  const expiryStamp = `<t:${Math.floor(expiresAt / 1000)}:R>`;
  const summary =
    `🔨 Punished **${selectedTeams.map(t => t.team).join(', ')}** — gave **${SCRIMS_BAN_ROLE_NAME}** to **${punished.length}** account(s). ` +
    `They can't register again until it lifts automatically ${expiryStamp}.` +
    (failed.length ? `\n⚠️ Failed for ${failed.length}: ${failed.map(id => `<@${id}>`).join(', ')} (left the server, or I'm missing permissions).` : '');

  await interaction.editReply({ content: summary, embeds: [], components: [] });
}

module.exports = {
  SCRIMS_BAN_ROLE_NAME,
  buildPunishSelectPayload,
  handlePunishButton,
  handlePunishSelect,
  getScrimsBanExpiry,
  startScrimsBanExpiry,
};
