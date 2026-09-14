const fs = require('fs');
const path = require('path');
const { todayDayNumber, DEFAULT_GROUPS_PER_DAY } = require('./group-schedule');

// DATA_DIR is a manual override (e.g. a Railway volume mount path) so
// data.json survives redeploys. Falls back to this folder for local dev.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');

// Registration is open 24/7 and groups keep incrementing forever, so this is
// sized generously (1000 groups' worth) so it never needs to be manually
// resized.
const DEFAULT_TOTAL_SLOTS = 20000;

function defaultScrim() {
  return {
    scrimName: 'T3 Scrims', totalSlots: DEFAULT_TOTAL_SLOTS, slots: {},
    createdDayNumber: todayDayNumber(), groupsPerDay: DEFAULT_GROUPS_PER_DAY,
  };
}

// Per-guild data shape:
// {
//   "<guildId>": {
//     registrations: { "<userId>": { team_name, owner_name, whatsapp, owner_email,
//       p1_ign, p1_uid, ..., p5_ign, p5_uid, selectedPlayerIds, registeredDate, teamNumber } },
//     scrim: { scrimName, totalSlots, slots: { "<slotNumber>": {...} }, createdDayNumber, closedGroups: [] },
//     settings: { logChannelId: "<channelId>" | null, requiredRoleId: "<roleId>" | null, teamCounter: <number>,
//       livePanelChannelId, livePanelMessageId, groupSchedule: { "<position>": { matches: [...] } } }
//   }
// }

function loadAll() {
  if (!fs.existsSync(DATA_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    console.error('Failed to parse data.json, starting fresh:', err);
    return {};
  }
}

function saveAll(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function getGuildStore(guildId) {
  const all = loadAll();
  if (!all[guildId]) {
    all[guildId] = { registrations: {}, scrim: defaultScrim(), settings: {} };
    saveAll(all);
  }
  if (all[guildId].registrations === undefined) all[guildId].registrations = {};
  if (!all[guildId].scrim) all[guildId].scrim = defaultScrim();
  if (!Number.isInteger(all[guildId].scrim.groupsPerDay) || all[guildId].scrim.groupsPerDay < 1) {
    all[guildId].scrim.groupsPerDay = DEFAULT_GROUPS_PER_DAY; // backfill for scrims saved before this setting existed
  }
  if (all[guildId].settings === undefined) all[guildId].settings = {};
  return all[guildId];
}

function saveGuildStore(guildId, guildData) {
  const all = loadAll();
  all[guildId] = guildData;
  saveAll(all);
}

function listGuildIds() {
  return Object.keys(loadAll());
}

module.exports = { getGuildStore, saveGuildStore, listGuildIds, loadAll, saveAll };

