// Promotion rounds, Round 2 onward. Round 1 isn't stored here at all — it's
// just the existing day-based T3 groups (see group-schedule.js/storage.js),
// read live from scrim.slots. Every round from 2 up is a single pool (one
// role, one channel) that every qualifying team from the previous round
// gets funneled into — not split into multiple same-round groups the way
// Round 1 registration is. An admin picks who advances out of each pool via
// that round's "Result" button, all the way up to maxRounds.
const MAX_ROUND = 10;
const DEFAULT_MAX_ROUNDS = 2; // Round 1 registration + one promotion round, same default as the original bot

function getMaxRounds(store) {
  const n = store.settings && store.settings.maxRounds;
  return Math.min(Math.max(Number.isInteger(n) ? n : DEFAULT_MAX_ROUNDS, 1), MAX_ROUND);
}

function setMaxRounds(store, n) {
  if (!store.settings) store.settings = {};
  store.settings.maxRounds = Math.min(Math.max(n, 1), MAX_ROUND);
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
  DEFAULT_MAX_ROUNDS,
  getMaxRounds,
  setMaxRounds,
  roundLabel,
  roundChannelName,
  getRound,
  findTeamInRound,
  removeTeamFromRoundOnward,
  getRoundOneTeams,
};
