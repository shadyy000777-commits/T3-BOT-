const { EmbedBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const { getGuildStore, saveGuildStore } = require('./storage');
const {
  groupDisplayName, slotRangeForGroup, localSlotNumber,
} = require('./group-schedule');
const { getRound, roundLabel } = require('./rounds');

function hasManageGuild(interaction) {
  return interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);
}

function sourceLabel(roundNum, letter) {
  return roundNum === 1 ? groupDisplayName(letter) : roundLabel(roundNum);
}

// Key used to remember which message a group/round's published slot list
// lives in, so later registrations/punishments/promotions can edit it in
// place instead of spamming a new post every time something changes.
function slotListKey(roundNum, letter) {
  return roundNum === 1 ? `1:${letter}` : `${roundNum}`;
}

// Round 1: one line per physical slot in the group's range (open or filled).
// Round 2+: a plain numbered list of whoever is currently in that round's
// pool — there's no slot-number concept once teams leave Round 1.
function buildSlotListEmbed(store, roundNum, letter) {
  const label = sourceLabel(roundNum, letter);
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`📋 ${label} — Slot List`)
    .setTimestamp()
    .setFooter({ text: 'Auto-updates as teams register, get punished, or get promoted.' });

  if (roundNum === 1) {
    const scrim = store.scrim;
    if (!scrim) {
      embed.setDescription('No scrim is set up right now.');
      return embed;
    }
    const { start, end } = slotRangeForGroup(letter, scrim.totalSlots);
    const lines = [];
    for (let i = start; i <= end; i++) {
      const slot = scrim.slots[i];
      lines.push(
        slot
          ? `**Slot ${localSlotNumber(i)}** — ${slot.team} (<@${slot.userId}>)`
          : `Slot ${localSlotNumber(i)} — _open_`
      );
    }
    embed.setDescription(lines.join('\n'));
  } else {
    const round = getRound(store, roundNum);
    embed.setDescription(
      round.teams.length
        ? round.teams.map((t, i) => `**${i + 1}.** ${t.team} (<@${t.ownerId}>)`).join('\n')
        : '_No teams promoted into this round yet._'
    );
  }

  return embed;
}

// Posts the slot list the first time; every call after that edits the same
// message in place instead of posting duplicates, so re-clicking "Publish
// Slot List" is always safe.
async function handlePublishButton(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }

  const [, roundStr, letterRaw] = interaction.customId.split(':');
  const roundNum = parseInt(roundStr, 10);
  const letter = letterRaw === '_' || letterRaw === undefined ? null : letterRaw;

  const store = getGuildStore(interaction.guildId);
  const embed = buildSlotListEmbed(store, roundNum, letter);

  if (!store.settings) store.settings = {};
  if (!store.settings.slotListMessages) store.settings.slotListMessages = {};
  const key = slotListKey(roundNum, letter);
  const existing = store.settings.slotListMessages[key];

  if (existing) {
    try {
      const channel = await interaction.guild.channels.fetch(existing.channelId);
      const message = await channel.messages.fetch(existing.messageId);
      await message.edit({ embeds: [embed] });
      return interaction.reply({ content: '✅ Slot list refreshed — it was already published here.', flags: MessageFlags.Ephemeral });
    } catch (err) {
      // Message/channel gone — fall through and post a fresh one below.
    }
  }

  const sent = await interaction.channel.send({ embeds: [embed] });
  store.settings.slotListMessages[key] = { channelId: sent.channel.id, messageId: sent.id };
  saveGuildStore(interaction.guildId, store);

  await interaction.reply({ content: '✅ Slot list published — it\'ll stay live-updated as teams register.', flags: MessageFlags.Ephemeral });
}

// Silently re-renders a published slot list, if one exists, after anything
// that changes who's in a group/round (register, edit, punish, promote).
// Safe to call even when nothing has ever been published for this
// round/letter — it just does nothing in that case.
async function refreshSlotList(client, guildId, roundNum, letter) {
  const store = getGuildStore(guildId);
  const key = slotListKey(roundNum, letter);
  const ref = store.settings && store.settings.slotListMessages && store.settings.slotListMessages[key];
  if (!ref) return;

  try {
    const channel = await client.channels.fetch(ref.channelId);
    const message = await channel.messages.fetch(ref.messageId);
    await message.edit({ embeds: [buildSlotListEmbed(store, roundNum, letter)] });
  } catch (err) {
    console.error(`Failed to refresh slot list (clearing it) for ${slotListKey(roundNum, letter)} in guild ${guildId}:`, err.message);
    delete store.settings.slotListMessages[key];
    saveGuildStore(guildId, store);
  }
}

module.exports = { buildSlotListEmbed, handlePublishButton, refreshSlotList, slotListKey };
