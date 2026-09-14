// Holds in-progress "Register" data between the 3 modal steps.
// A user's data lives here only until they finish step 3 (at which point
// it's written to storage.js and cleared) or it expires unfinished.
//
// This is intentionally in-memory only — if the bot restarts mid-registration
// the user just clicks "Register" again and starts over. Nothing is saved to
// data.json until every required field across all 3 steps is present.

const pending = new Map();
const TTL_MS = 15 * 60 * 1000; // 15 minutes to finish the form

function startPending(userId, guildId, mode = 'create', original = null) {
  clearPending(userId);
  const entry = {
    guildId,
    mode,        // 'create' (fresh registration) or 'edit' (updating an existing one)
    original,    // snapshot of the existing record, used to prefill edit modals
    data: {},
    timer: setTimeout(() => pending.delete(userId), TTL_MS),
  };
  pending.set(userId, entry);
  return entry;
}

function getPending(userId) {
  return pending.get(userId) || null;
}

function updatePending(userId, fields) {
  const entry = pending.get(userId);
  if (!entry) return null;
  Object.assign(entry.data, fields);
  return entry;
}

function clearPending(userId) {
  const entry = pending.get(userId);
  if (entry && entry.timer) clearTimeout(entry.timer);
  pending.delete(userId);
}

module.exports = { startPending, getPending, updatePending, clearPending };
