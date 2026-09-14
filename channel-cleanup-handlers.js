const { getGuildStore, saveGuildStore } = require('./storage');

// Discord doesn't cascade anything when an admin manually deletes one of
// this bot's auto-created group/round lobby channels — the role it was
// scoped to would otherwise be left behind forever (still assigned to
// every team in it), and storage would keep pointing at a channel that no
// longer exists (so e.g. "already created" checks would silently think a
// dead channel is still fine). This listens for every channel deletion
// and, if it matches a tracked group/round channel, deletes the matching
// role too and cleans up every stored reference to both.
//
// Mirrors the old bot's manual "Delete Group" button, just triggered
// automatically by the channel actually disappearing instead of a
// separate confirm step. Like that button, it never touches
// scrim.slots/registrations or a round's teams array — registered teams
// stay on record even after their channel/role are gone.
async function handleChannelDeleted(channel) {
  if (!channel.guild) return; // DM channel or similar — nothing to clean up
  const guildId = channel.guild.id;
  const store = getGuildStore(guildId);
  if (!store.settings) store.settings = {};
  let changed = false;

  async function deleteRole(roleId, reason) {
    if (!roleId) return;
    const role = channel.guild.roles.cache.get(roleId);
    if (!role) return;
    try {
      await role.delete(reason);
    } catch (err) {
      console.error(`[channel-cleanup] Failed to delete role ${roleId} in guild ${guildId}: ${err.code ?? ''} ${err.message}`);
    }
  }

  // --- Round 1 group channels ---
  const groupChannels = store.settings.groupChannels;
  if (groupChannels) {
    const letter = Object.keys(groupChannels).find(l => groupChannels[l] === channel.id);
    if (letter) {
      changed = true;
      const roleId = store.settings.groupRoles && store.settings.groupRoles[letter];
      await deleteRole(roleId, `Group channel deleted (Group ${letter}) — cleaning up its role`);

      delete groupChannels[letter];
      if (store.settings.groupRoles) delete store.settings.groupRoles[letter];
      if (store.settings.slotListMessages) delete store.settings.slotListMessages[`1:${letter}`];
      if (store.settings.autoGroupChannelIds) {
        store.settings.autoGroupChannelIds = store.settings.autoGroupChannelIds.filter(id => id !== channel.id);
      }
      if (roleId && store.settings.autoGroupRoleIds) {
        store.settings.autoGroupRoleIds = store.settings.autoGroupRoleIds.filter(id => id !== roleId);
      }
    }
  }

  // --- Round 2+ pool channels ---
  if (store.rounds) {
    for (const [roundNum, round] of Object.entries(store.rounds)) {
      if (round.channelId === channel.id) {
        changed = true;
        await deleteRole(round.roleId, `Round channel deleted (Round ${roundNum}) — cleaning up its role`);
        round.channelId = null;
        round.roleId = null;
        if (store.settings.slotListMessages) delete store.settings.slotListMessages[roundNum];
      }
    }
  }

  if (changed) saveGuildStore(guildId, store);
}

module.exports = { handleChannelDeleted };
