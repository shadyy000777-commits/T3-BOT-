// Promotion rounds, Round 2 onward. Round 1 isn't stored here at all — it's
// just the existing day-based T3 groups (see group-schedule.js/storage.js),
// read live from scrim.slots.
//
// T3 Scrims is single-round only: Round 1 registration, then that group's
// "Result" button picks the winner directly — there's no promotion into a
// Round 2 pool. getMaxRounds() is pinned to 1 so every group's Result is
// always the final round. The round-2+ machinery below (getRound,
// removeTeamFromRoundOnward, etc.) is dead code with maxRounds fixed at 1,
// but is left in place rather than ripped out in case multi-round scrims
// come back later.
const MAX_ROUND = 10;

function getMaxRounds(_store) {
  return 1;
}

// "T3 ROUND 2", "T3 ROUND 3", ... — the name the user asked for, shown as
// both the role name and (slugified by Discord) the channel name.
function roundLabel(roundNum) {
  return `T3 ROUND ${roundNum}`;
}
function roundChannelName(roundNum) {
  return `T3 Round ${roundNum} Lobby`;
}

// Lazily creates round N's pool the first time it's needed (first team
// promoted into it) — { roleId, channelId, teams: [{team, ownerId,
// playerIds, fromRound, fromGroup}] }.
function getRound(store, roundNum) {
  if (!store.rounds) store.rounds = {};
  if (!store.rounds[roundNum]) store.rounds[roundNum] = { teams: [] };
  return store.rounds[roundNum];
}

function findTeamInRound(store, roundNum, ownerId) {
  const round = store.rounds && store.rounds[roundNum];
  if (!round) return null;
  const idx = round.teams.findIndex(t => t.ownerId === ownerId);
  return idx === -1 ? null : { round, idx, team: round.teams[idx] };
}

// Un-promotes a team from every round from `fromRound` through however many
// rounds are currently configured — used when a Result is re-run and a
// previously-promoted team is no longer selected, so they (and anything
// they'd already been promoted into beyond that) get cleaned up in one go.
async function removeTeamFromRoundOnward(interaction, store, ownerId, playerIds, fromRound) {
  const maxRounds = getMaxRounds(store);
  for (let roundNum = fromRound; roundNum <= maxRounds; roundNum++) {
    const entry = findTeamInRound(store, roundNum, ownerId);
    if (!entry) continue;

    const { round, idx } = entry;
    round.teams.splice(idx, 1);

    // Only the owner (the one who actually registered) ever holds a round
    // role — teammates tagged in the lineup never get one — so only the
    // owner needs the role stripped here.
    if (round.roleId) {
      const member = interaction.guild.members.cache.get(ownerId)
        ?? await interaction.guild.members.fetch(ownerId).catch(() => null);
      if (member) await member.roles.remove(round.roleId).catch(() => {});
    }
  }
}

// Round 1's "teams", read live from the scrim rather than stored
// separately — one entry per filled slot in that group's slot range.
function getRoundOneTeams(store, groupLetter) {
  const gs = require('./group-schedule');
  const scrim = store.scrim;
  if (!scrim) return [];
  const { start, end } = gs.slotRangeForGroup(groupLetter, scrim.totalSlots);
  const teams = [];
  for (let i = start; i <= end; i++) {
    const slot = scrim.slots[i];
    if (slot) teams.push({ team: slot.team, ownerId: slot.userId, playerIds: slot.selectedPlayerIds || [] });
  }
  return teams;
}

module.exports = {
  MAX_ROUND,
  getMaxRounds,
  roundLabel,
  roundChannelName,
  getRound,
  findTeamInRound,
  removeTeamFromRoundOnward,
  getRoundOneTeams,
};
