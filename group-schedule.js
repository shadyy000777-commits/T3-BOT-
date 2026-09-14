// Slots 1-5 are reserved and never assigned — the first team gets slot 6.
// From there, each group holds 20 teams (slot 6-25 = Group A, 26-45 = Group B, ...).
const FIRST_ASSIGNABLE_SLOT = 6;
const TEAMS_PER_GROUP = 20;

// Registration is open 24/7 and groups keep incrementing forever, but only
// a configurable number of groups' worth of matches actually get played per
// real calendar day (e.g. with groupsPerDay=2: Groups 1-2 play "today", 3-4
// the day after, 5-6 the day after that, and so on). Change how many via
// /set-groups-per-day — DEFAULT_GROUPS_PER_DAY is only the fallback used
// for a scrim that predates that setting.
const DEFAULT_GROUPS_PER_DAY = 2;

function getGroupsPerDay(scrim) {
  const n = scrim && scrim.groupsPerDay;
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_GROUPS_PER_DAY;
}

// Bijective base-26 letter codes so group letters never run out past 'Z':
// 0->A, 1->B, ..., 25->Z, 26->AA, 27->AB, ... (same scheme spreadsheet
// columns use). This lets a scrim have far more than 26 groups.
function letterForIndex(index) {
  let n = index + 1;
  let code = '';
  while (n > 0) {
    n -= 1;
    code = String.fromCharCode(65 + (n % 26)) + code;
    n = Math.floor(n / 26);
  }
  return code;
}

function indexForLetter(code) {
  let n = 0;
  for (const ch of code) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

function groupLetterForSlot(slotNumber) {
  const index = Math.floor((slotNumber - FIRST_ASSIGNABLE_SLOT) / TEAMS_PER_GROUP);
  return letterForIndex(index);
}

// Groups are tracked internally as letter codes (A, B, ..., Z, AA, AB, ...)
// but shown to players as numbers — "Group A" displays as "Group 1", etc.
function groupDisplayName(letter) {
  return `Group ${indexForLetter(letter) + 1}`;
}

// Slot numbers are tracked internally as one continuously incrementing
// global counter (so every stored key is guaranteed unique — no two teams
// can ever collide on the same key). But a real BGMI custom room only has
// 25 physical slots, so what gets shown to players must wrap back to
// 6-25 for every group instead of climbing past 25 (e.g. global slot 66 in
// Group D should display as slot 6, not 66). This only affects display —
// the underlying global number is still what's used for lookups/uniqueness.
function localSlotNumber(globalSlot) {
  return FIRST_ASSIGNABLE_SLOT + ((globalSlot - FIRST_ASSIGNABLE_SLOT) % TEAMS_PER_GROUP);
}

// Given a group letter, returns the [start, end] scrim-slot range that group
// covers for the current totalSlots (mirrors groupLetterForSlot in reverse).
function slotRangeForGroup(letter, totalSlots) {
  const index = indexForLetter(letter);
  const start = FIRST_ASSIGNABLE_SLOT + index * TEAMS_PER_GROUP;
  const end = Math.min(start + TEAMS_PER_GROUP - 1, totalSlots);
  return { start, end };
}

// Every group that currently has at least one open slot, with a free-slot
// count for each — skips any closed group (result already posted).
function listGroupsWithFreeSlots(scrim) {
  const groups = [];
  for (let index = 0; ; index++) {
    const start = FIRST_ASSIGNABLE_SLOT + index * TEAMS_PER_GROUP;
    if (start > scrim.totalSlots) break;
    const letter = letterForIndex(index);
    if (isGroupClosed(scrim, letter)) continue;
    const end = Math.min(start + TEAMS_PER_GROUP - 1, scrim.totalSlots);
    let freeCount = 0;
    for (let i = start; i <= end; i++) {
      if (!scrim.slots[i]) freeCount++;
    }
    groups.push({ letter, freeCount });
  }
  return groups;
}

// Whether a group's result has already been posted — once true, that group
// is retired for good: no new registrations, no switching into it, and (see
// isDayBatchFull) it counts as done for day-batch progression even though
// its slots were cleared back to empty.
function isGroupClosed(scrim, letter) {
  return !!(scrim && scrim.closedGroups && scrim.closedGroups.includes(letter));
}

function closeGroup(scrim, letter) {
  if (!scrim.closedGroups) scrim.closedGroups = [];
  if (!scrim.closedGroups.includes(letter)) scrim.closedGroups.push(letter);
}

// The next `count` groups the live panel should show, in order — a
// straightforward sliding window over group letters (1, 2, 3, ...) that
// simply skips any closed one. It does NOT wait for a group to be full, and
// does NOT wait for a whole day's worth of groups to finish before
// advancing: the moment Group 1's result is posted (closed), it drops off
// the front and Group 3 slides in to keep the window at `count` groups —
// showing 2, 3. Close Group 2 next and it becomes 3, 4, and so on. Returns
// fewer than `count` letters only once there aren't enough non-closed
// groups left within scrim.totalSlots (raise totalSlots to open more).
function nextOpenGroupLetters(store, count) {
  const scrim = store.scrim;
  const effectiveCount = count ?? getGroupsPerDay(scrim);
  const letters = [];
  for (let index = 0; letters.length < effectiveCount; index++) {
    const start = FIRST_ASSIGNABLE_SLOT + index * TEAMS_PER_GROUP;
    if (start > scrim.totalSlots) break;
    const letter = letterForIndex(index);
    if (isGroupClosed(scrim, letter)) continue;
    if (hasGroupMatchStarted(store, letter)) continue;
    letters.push(letter);
  }
  return letters;
}

// Every group letter that currently exists given totalSlots (A, B, C...),
// regardless of how full each one is.
function activeGroupLetters(totalSlots) {
  const letters = [];
  for (let index = 0; ; index++) {
    const start = FIRST_ASSIGNABLE_SLOT + index * TEAMS_PER_GROUP;
    if (start > totalSlots) break;
    letters.push(letterForIndex(index));
  }
  return letters;
}

// --- Day-batch helpers ---------------------------------------------------
// Which position within its day-batch a group falls into, and which
// day-batch (0-based, 0 = the scrim's first real match day) it belongs to.
// groupsPerDay is passed explicitly (rather than read from a module
// constant) since it's a per-scrim setting that can change over time — see
// getGroupsPerDay above.
function dayPositionForLetter(letter, groupsPerDay) {
  return indexForLetter(letter) % groupsPerDay;
}
function dayBatchForLetter(letter, groupsPerDay) {
  return Math.floor(indexForLetter(letter) / groupsPerDay);
}

// How many day-batches this scrim's totalSlots can support in total.
function totalDayBatches(totalSlots, groupsPerDay) {
  const totalGroups = activeGroupLetters(totalSlots).length;
  return Math.max(1, Math.ceil(totalGroups / groupsPerDay));
}

// The (up to) groupsPerDay group letters that play on a given day-batch index.
function lettersForDayBatch(totalSlots, batchIndex, groupsPerDay) {
  const letters = activeGroupLetters(totalSlots);
  return letters.slice(batchIndex * groupsPerDay, batchIndex * groupsPerDay + groupsPerDay);
}

// Reads the current wall-clock date/time in India Standard Time specifically
// (not the server's local time zone), since this schedule is built around
// IST regardless of where the bot process actually runs.
function getISTParts() {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date()).map(p => [p.type, p.value]));
  return {
    year: parseInt(parts.year, 10),
    month: parseInt(parts.month, 10),
    day: parseInt(parts.day, 10),
    // hour12:false can render midnight as "24" in some engines instead of "00"
    hour: parts.hour === '24' ? 0 : parseInt(parts.hour, 10),
    minute: parseInt(parts.minute, 10),
  };
}

// A simple incrementing day-number (days since the Unix epoch, in IST
// calendar terms) — lets us do "how many days apart" math with plain
// integer subtraction instead of juggling Date objects.
function dayNumberFromParts(year, month, day) {
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}
function todayDayNumber() {
  const { year, month, day } = getISTParts();
  return dayNumberFromParts(year, month, day);
}

// Minutes since midnight, IST — used to compare "now" against a group's
// scheduled Match 1 time (see hasGroupMatchStarted).
function currentISTMinutes() {
  const { hour, minute } = getISTParts();
  return hour * 60 + minute;
}

function formatDateLabelForDayNumber(dayNum) {
  return new Date(dayNum * 86400000).toLocaleDateString('en-US', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
  });
}

// Whether every group in a given day-batch is completely full (all slots in
// every group of that batch taken) — OR closed (result posted; see
// closeGroup). A closed group's slots get cleared back to empty once its
// result is posted, so without this it would look "not full" again and the
// day-batch panel would reopen it for new registrations, which is exactly
// what closing is meant to prevent.
function isDayBatchFull(scrim, batchIndex) {
  const letters = lettersForDayBatch(scrim.totalSlots, batchIndex, getGroupsPerDay(scrim));
  if (letters.length === 0) return false;
  return letters.every((letter) => {
    if (isGroupClosed(scrim, letter)) return true;
    const { start, end } = slotRangeForGroup(letter, scrim.totalSlots);
    for (let i = start; i <= end; i++) {
      if (!scrim.slots[i]) return false;
    }
    return true;
  });
}

// How many real calendar days have passed since the scrim was created,
// clamped to a valid batch index. Batch 0 (Groups 1-2) is "today"'s batch,
// batch 1 (Groups 3-4) is "tomorrow"'s, etc. — one batch per real day.
function elapsedCalendarBatchIndex(scrim) {
  const created = scrim.createdDayNumber ?? todayDayNumber();
  const elapsed = todayDayNumber() - created;
  const maxIndex = totalDayBatches(scrim.totalSlots, getGroupsPerDay(scrim)) - 1;
  return Math.min(Math.max(elapsed, 0), maxIndex);
}

// The day-batch currently open for registration — the first one (starting
// from the scrim's very first match day, batch 0 = Groups 1-2) that isn't
// completely full yet. Groups 1-2 show until every one of them is full,
// then it flips to Groups 3-4 right away — no need to wait for that. But it
// will only ever advance ONE batch ahead of whatever real calendar day it
// actually is: if both Groups 1-2 AND 3-4 fill up on day one, the panel
// holds at Groups 3-4 (shown full) instead of jumping straight to 5-6; it
// only reveals 5-6 once the next calendar day actually arrives.
function currentDayBatchIndex(scrim) {
  const cap = Math.min(elapsedCalendarBatchIndex(scrim) + 1, totalDayBatches(scrim.totalSlots, getGroupsPerDay(scrim)) - 1);
  for (let i = 0; i <= cap; i++) {
    if (!isDayBatchFull(scrim, i)) return i;
  }
  return cap;
}

// Whether there's still a batch open for registration to show on the live
// panel at all — false only once every group this scrim's totalSlots
// currently supports is completely full (raising totalSlots opens more).
// Unlike currentDayBatchIndex this looks across ALL batches, not just the
// calendar-capped window, so it still reports "yes, more to come" even
// while the panel is holding at a full batch waiting for tomorrow.
function hasNextDayBatch(scrim) {
  const maxIndex = totalDayBatches(scrim.totalSlots, getGroupsPerDay(scrim)) - 1;
  for (let i = 0; i <= maxIndex; i++) {
    if (!isDayBatchFull(scrim, i)) return true;
  }
  return false;
}

// The day-batch to actually display on the live panel — the batch currently
// open for registration.
function nextDayBatchIndex(scrim) {
  return currentDayBatchIndex(scrim);
}

// "Today" / "Tomorrow" / an actual weekday+date, for whichever day-batch is
// being described — shared by the live panel and matchScheduleLines so the
// wording always agrees.
function dayLabelForBatch(scrim, batchIndex) {
  const batchDayNumber = (scrim.createdDayNumber ?? todayDayNumber()) + batchIndex;
  const diff = batchDayNumber - todayDayNumber();
  const dateLabel = formatDateLabelForDayNumber(batchDayNumber);
  const relative = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : dateLabel;
  return { dayNumber: batchDayNumber, dateLabel, relative };
}

// --- Match-time schedule (per day-position, not per absolute group) ------
// Only groupsPerDay groups play per real day, and every day follows the
// same daily structure, so match times are set once per position-in-the-day
// (1st group of the day, 2nd group of the day, ...) via the group schedule
// panel, rather than once per individual group letter — otherwise a
// 1000-group scrim would need 1000 separate schedule entries.
const DAILY_TIMES = [
  { matches: [{ idp: '12:54', start: '01:00', map: 'Erangel' }, { idp: '01:34', start: '01:40', map: 'Miramar' }] },
  { matches: [{ idp: '01:04', start: '01:10', map: 'Rondo' }, { idp: '01:44', start: '01:50', map: 'Erangel' }] },
];

// An admin-set schedule always wins over the default table for that
// day-position — this is what makes the schedule editable live instead of
// requiring a code change. Positions beyond DAILY_TIMES' length (i.e. once
// groupsPerDay has been raised past 2) have no built-in default — an admin
// must set one via /group-schedule before that position's groups get a
// schedule.
function getScheduleForPosition(store, position) {
  const custom = store.settings && store.settings.groupSchedule && store.settings.groupSchedule[position];
  return custom || DAILY_TIMES[position] || null;
}
function getSchedule(store, letter) {
  return getScheduleForPosition(store, dayPositionForLetter(letter, getGroupsPerDay(store.scrim)));
}
function setSchedule(store, position, schedule) {
  if (!store.settings.groupSchedule) store.settings.groupSchedule = {};
  store.settings.groupSchedule[position] = schedule;
}

// All schedule times are 12-hour-clock without AM/PM, and this bot's scrims
// run in a single stretch through the afternoon daily — so hour 12 stays as
// noon (PM) and hours 1-11 are treated as PM (add 12).
function parseMatchMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  const hour24 = h === 12 ? 12 : h + 12;
  return hour24 * 60 + m;
}

// Whether a group's Match 1 has already started (or its whole match day has
// already passed) — used to stop offering a group for new registration once
// it's effectively too late to join, even if it never filled up and its
// result was never posted. A group whose day-batch is a past calendar day
// counts as started outright; a group scheduled for today is checked against
// its Match 1 IDP time; a group scheduled for a future day hasn't started.
function hasGroupMatchStarted(store, letter) {
  const scrim = store && store.scrim;
  if (!scrim) return false;

  const batchDayNumber = (scrim.createdDayNumber ?? todayDayNumber()) + dayBatchForLetter(letter, getGroupsPerDay(scrim));
  const today = todayDayNumber();
  if (batchDayNumber < today) return true;
  if (batchDayNumber > today) return false;

  const schedule = getSchedule(store, letter);
  if (!schedule || !schedule.matches || !schedule.matches.length) return false;
  return currentISTMinutes() >= parseMatchMinutes(schedule.matches[0].idp);
}

// The match schedule + day info for a specific group letter — used by the
// registration confirmation message.
function resolveGroupSchedule(letter, store) {
  const schedule = getSchedule(store, letter);
  if (!schedule || !store.scrim) return null;

  const batchIndex = dayBatchForLetter(letter, getGroupsPerDay(store.scrim));
  const { dateLabel, relative } = dayLabelForBatch(store.scrim, batchIndex);

  return { schedule, dayLabel: relative, dateLabel, matchesToShow: schedule.matches };
}

function matchScheduleLines(letter, store) {
  const resolved = resolveGroupSchedule(letter, store);
  if (!resolved) {
    return '🗓️ **Match Schedule** — not set yet for this group, check pinned messages or ask an admin.';
  }

  const { dayLabel, dateLabel, matchesToShow } = resolved;

  const lines = matchesToShow
    .map((m, i) => `🗓️ **Match ${i + 1}** — IDP ${m.idp} PM | Start ${m.start} PM | ${m.map}`)
    .join('\n');

  // dayLabel is only "Today"/"Tomorrow" for the next two calendar days —
  // beyond that it already equals dateLabel (both the full weekday+date),
  // so showing both would print the same date twice.
  const heading = dayLabel === dateLabel ? dateLabel : `${dayLabel}, ${dateLabel}`;
  return `📅 **${heading}**\n${lines}`;
}

// Short one-line match-time summary for a group, used as select-menu
// option description text (not the full multi-line matchScheduleLines).
// DD-MM-YYYY, matching the date format used on the detailed registration
// card (dayNumber is days-since-epoch, same value dayLabelForBatch uses
// internally).
function formatDDMMYYYY(dayNumber) {
  const d = new Date(dayNumber * 86400000);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

function groupTimeSummary(letter, store) {
  const schedule = getSchedule(store, letter);
  if (!schedule) return 'Schedule not set yet';
  return schedule.matches.map(m => `${m.start} PM`).join(' & ');
}

module.exports = {
  FIRST_ASSIGNABLE_SLOT,
  TEAMS_PER_GROUP,
  DEFAULT_GROUPS_PER_DAY,
  getGroupsPerDay,
  letterForIndex,
  indexForLetter,
  groupLetterForSlot,
  groupDisplayName,
  localSlotNumber,
  slotRangeForGroup,
  listGroupsWithFreeSlots,
  isGroupClosed,
  closeGroup,
  nextOpenGroupLetters,
  activeGroupLetters,
  dayPositionForLetter,
  dayBatchForLetter,
  totalDayBatches,
  lettersForDayBatch,
  todayDayNumber,
  currentISTMinutes,
  hasGroupMatchStarted,
  isDayBatchFull,
  currentDayBatchIndex,
  hasNextDayBatch,
  nextDayBatchIndex,
  dayLabelForBatch,
  parseMatchMinutes,
  getScheduleForPosition,
  getSchedule,
  setSchedule,
  resolveGroupSchedule,
  matchScheduleLines,
  groupTimeSummary,
  formatDDMMYYYY,
};
