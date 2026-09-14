const { EmbedBuilder } = require('discord.js');
const { getGuildStore, saveGuildStore, listGuildIds } = require('./storage');
const {
  groupDisplayName, slotRangeForGroup, getSchedule,
  nextOpenGroupLetters, dayBatchForLetter, dayLabelForBatch,
  formatDDMMYYYY, getGroupsPerDay,
} = require('./group-schedule');

function fillCircle(filled, capacity) {
  if (capacity <= 0) return '⚪';
  const pct = filled / capacity;
  if (pct >= 1) return '<a:836435400498741289:1547663764466180220>';
  if (pct >= 0.9) return '<a:1015007788390416414:1547663721537609849>';
  return '<a:885679180799422574:1547663768702689280>';
}

function dotsBar(filled, capacity) {
  const shown = Math.min(capacity, 20); // keep the bar a sane width even for larger groups
  const filledDots = Math.round((filled / capacity) * shown);
  return '●'.repeat(filledDots) + '○'.repeat(Math.max(0, shown - filledDots));
}

// Registration is open 24/7 and groups keep filling forever, but the live
// panel only ever shows a rolling window of (up to) GROUPS_PER_DAY groups at
// a time. It is a straightforward "next N open groups" list, not a batch
// that has to completely fill before advancing: as soon as a group's result
// is posted (closed), it drops off the front of the window and the next
// group slides in to take its place. So Group 1's result posted flips the
// display from 1,2 straight to 2,3 — it doesn't wait for Group 2 to fill up
// too, and it doesn't wait for a whole calendar day's groups to finish.
function buildLiveGroupsPanel(store) {
  const scrim = store.scrim;
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTimestamp();

  if (!scrim) {
    embed.setTitle('<:4321bgmi:1547674231498612837> Slot Availability').setDescription('No scrim is set up yet.');
    return embed;
  }

  embed.setTitle(`<:4321bgmi:1547674231498612837> ${scrim.scrimName} — Next Match Day`);

  const letters = nextOpenGroupLetters(store);
  if (!letters.length) {
    embed.setDescription('🎉 No upcoming groups left — raise total slots to open more.');
    embed.setFooter({ text: 'Registration OPEN 24/7' });
    return embed;
  }

  // The window can span more than one calendar day once earlier groups
  // close out of step with later ones filling — use whichever day the
  // FIRST group shown belongs to for the header label; it's just a
  // heads-up date, not something registration logic depends on.
  const { relative, dateLabel } = dayLabelForBatch(scrim, dayBatchForLetter(letters[0], getGroupsPerDay(scrim)));

  embed.setDescription(`<a:465d796358514e49874201ce90ea2ce1:1547673912605671444> **${relative}, ${dateLabel}**\nRegistration never closes — keep registering.`);

  for (const letter of letters) {
    const { start, end } = slotRangeForGroup(letter, scrim.totalSlots);
    const capacity = end - start + 1;
    let filled = 0;
    for (let i = start; i <= end; i++) if (scrim.slots[i]) filled++;

    const schedule = getSchedule(store, letter);
    const scheduleLine = schedule
      ? 'IDP: ' + schedule.matches.map((m, i) => `M${i + 1}: ${m.idp} PM`).join(' | ')
      : 'IDP: not set — use `/group-schedule` to add match times';

    const groupDate = formatDDMMYYYY(dayLabelForBatch(scrim, dayBatchForLetter(letter, getGroupsPerDay(scrim))).dayNumber);

    embed.addFields({
      name: `${fillCircle(filled, capacity)} ${groupDisplayName(letter)} (${groupDate})`,
      value: `<a:465d796358514e49874201ce90ea2ce1:1547673912605671444> ${scheduleLine}\n${dotsBar(filled, capacity)} ${filled}/${capacity} filled`,
    });
  }

  embed.setFooter({ text: 'Registration OPEN 24/7 — updates live as teams register' });
  return embed;
}

// Re-renders and edits the standing live panel message, if one has been
// posted via /live-panel. Safe to call after every registration change and
// after schedule edits — silently does nothing if no panel is set up, and
// clears the stored reference if the message/channel was deleted.
async function refreshLivePanel(client, guildId) {
  const store = getGuildStore(guildId);
  const channelId = store.settings && store.settings.livePanelChannelId;
  const messageId = store.settings && store.settings.livePanelMessageId;
  if (!channelId || !messageId) return;

  try {
    const channel = await client.channels.fetch(channelId);
    const message = await channel.messages.fetch(messageId);
    await message.edit({ embeds: [buildLiveGroupsPanel(store)], components: [] });
  } catch (err) {
    // Message or channel is gone — stop trying to refresh it every time.
    console.error('Failed to refresh live panel (clearing it):', err.message);
    store.settings.livePanelChannelId = null;
    store.settings.livePanelMessageId = null;
    saveGuildStore(guildId, store);
  }
}

// Registration is 24/7 with no admin action required to advance to the next
// day's groups, so nothing else naturally triggers a panel refresh right at
// midnight IST if nobody happens to register at that exact moment. This
// polls every few minutes and re-renders any configured live panel so it
// flips over to the new day's batch on its own.
function startLivePanelDayRollover(client, intervalMs = 5 * 60 * 1000) {
  setInterval(async () => {
    for (const guildId of listGuildIds()) {
      const store = getGuildStore(guildId);
      if (store.settings && store.settings.livePanelChannelId && store.settings.livePanelMessageId) {
        await refreshLivePanel(client, guildId);
      }
    }
  }, intervalMs);
}

// Posts the live panel to the given channel (defaults to interaction.channel
// when not specified) and remembers where it lives so refreshLivePanel can
// edit it in place afterward. Shared by /live-panel and the admin panel's
// "Post Live Panel" flow (which lets the admin pick the destination channel).
async function postLivePanel(interaction, channel = interaction.channel) {
  const store = getGuildStore(interaction.guildId);
  const sent = await channel.send({ embeds: [buildLiveGroupsPanel(store)] });

  if (!store.settings) store.settings = {};
  store.settings.livePanelChannelId = sent.channel.id;
  store.settings.livePanelMessageId = sent.id;
  saveGuildStore(interaction.guildId, store);

  return sent;
}

module.exports = { buildLiveGroupsPanel, refreshLivePanel, startLivePanelDayRollover, postLivePanel };
