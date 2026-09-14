const {
  EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags, PermissionFlagsBits,
} = require('discord.js');
const { getGuildStore, saveGuildStore } = require('./storage');
const { getScheduleForPosition, setSchedule, getGroupsPerDay } = require('./group-schedule');
const { refreshLivePanel } = require('./live-panel-handlers');

const TIME_RE = /^([1-9]|1[0-2]):([0-5][0-9])$/; // 12-hour clock, no AM/PM (matches, e.g., "2:34")

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Position labels are generated on demand from however many groups/day are
// currently configured (see /set-groups-per-day) rather than a fixed list —
// so the select menu always has exactly as many options as there are daily
// time slots to set.
function positionLabel(position) {
  return `${ordinal(position + 1)} match of the day`;
}

function padTime(hour, minute) {
  return `${String(hour).padStart(2, '0')}:${minute}`;
}

// Only groupsPerDay time slots exist — every group reuses one of them based
// on its position in its day-batch, so admins set the schedule once per
// position rather than once per (potentially 1000+) individual group.
function buildGroupSchedulePanelPayload(store) {
  const groupsPerDay = getGroupsPerDay(store.scrim);

  const embed = new EmbedBuilder()
    .setTitle('🗓️ Daily Match Schedule')
    .setColor(0x5865F2)
    .setDescription(
      `Every real match day runs the same ${groupsPerDay} time slot${groupsPerDay === 1 ? '' : 's'} — set each one below. ` +
      `Whichever ${groupsPerDay} group${groupsPerDay === 1 ? '' : 's'} ${groupsPerDay === 1 ? 'is' : 'are'} up on a given day automatically use${groupsPerDay === 1 ? 's' : ''} these times.`
    );

  const select = new StringSelectMenuBuilder()
    .setCustomId('group_schedule_select')
    .setPlaceholder('Choose a time slot to edit')
    .addOptions(
      Array.from({ length: groupsPerDay }, (_, position) => ({ label: positionLabel(position), value: String(position) }))
    );

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] };
}

function buildScheduleModal(position, store) {
  const existing = getScheduleForPosition(store, position);
  const m1 = existing ? existing.matches[0] : null;
  const m2 = existing ? existing.matches[1] : null;

  return new ModalBuilder()
    .setCustomId(`group_schedule_modal:${position}`)
    .setTitle(`${positionLabel(position)} Schedule`)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('m1idp').setLabel('Match 1 IDP time (e.g. 2:34)').setStyle(TextInputStyle.Short)
          .setValue(m1 ? m1.idp : '').setRequired(true).setMaxLength(5)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('m1start').setLabel('Match 1 Start time (e.g. 2:40)').setStyle(TextInputStyle.Short)
          .setValue(m1 ? m1.start : '').setRequired(true).setMaxLength(5)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('m2idp').setLabel('Match 2 IDP time (e.g. 3:14)').setStyle(TextInputStyle.Short)
          .setValue(m2 ? m2.idp : '').setRequired(true).setMaxLength(5)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('m2start').setLabel('Match 2 Start time (e.g. 3:20)').setStyle(TextInputStyle.Short)
          .setValue(m2 ? m2.start : '').setRequired(true).setMaxLength(5)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('maps').setLabel('Maps (comma-separated, Match 1, Match 2)').setStyle(TextInputStyle.Short)
          .setValue(m1 && m2 ? `${m1.map}, ${m2.map}` : '').setPlaceholder('Erangel, Miramar').setRequired(true).setMaxLength(60)
      ),
    );
}

function hasManageGuild(interaction) {
  return interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);
}

async function handleGroupScheduleSelect(interaction) {
  if (!hasManageGuild(interaction)) {
    return interaction.reply({ content: '❌ You need the **Manage Server** permission to do that.', flags: MessageFlags.Ephemeral });
  }
  const store = getGuildStore(interaction.guildId);
  const position = parseInt(interaction.values[0], 10);
  return interaction.showModal(buildScheduleModal(position, store));
}

async function handleGroupScheduleModalSubmit(interaction) {
  const [, positionRaw] = interaction.customId.split(':');
  const position = parseInt(positionRaw, 10);
  const store = getGuildStore(interaction.guildId);
  if (!store.settings) store.settings = {};

  const m1idp = interaction.fields.getTextInputValue('m1idp').trim();
  const m1start = interaction.fields.getTextInputValue('m1start').trim();
  const m2idp = interaction.fields.getTextInputValue('m2idp').trim();
  const m2start = interaction.fields.getTextInputValue('m2start').trim();
  const mapsRaw = interaction.fields.getTextInputValue('maps').trim();

  for (const [label, value] of [['Match 1 IDP', m1idp], ['Match 1 Start', m1start], ['Match 2 IDP', m2idp], ['Match 2 Start', m2start]]) {
    if (!TIME_RE.test(value)) {
      return interaction.reply({ content: `❌ "${value}" isn't a valid time for **${label}**. Use H:MM on a 12-hour clock, e.g. \`2:34\`.`, flags: MessageFlags.Ephemeral });
    }
  }

  const maps = mapsRaw.split(',').map(m => m.trim()).filter(Boolean);
  if (maps.length < 1) {
    return interaction.reply({ content: '❌ Add at least one map.', flags: MessageFlags.Ephemeral });
  }
  const map1 = maps[0];
  const map2 = maps[1] || maps[0];

  const normalize = (t) => { const [h, m] = t.split(':'); return padTime(parseInt(h, 10), m); };

  setSchedule(store, position, {
    matches: [
      { idp: normalize(m1idp), start: normalize(m1start), map: map1 },
      { idp: normalize(m2idp), start: normalize(m2start), map: map2 },
    ],
  });
  saveGuildStore(interaction.guildId, store);

  await interaction.reply({
    content: `✅ ${positionLabel(position)} schedule updated:\nMatch 1 — IDP ${normalize(m1idp)} PM, Start ${normalize(m1start)} PM, ${map1}\nMatch 2 — IDP ${normalize(m2idp)} PM, Start ${normalize(m2start)} PM, ${map2}`,
    flags: MessageFlags.Ephemeral,
  });

  await refreshLivePanel(interaction.client, interaction.guildId);
}

// Combined "IDP - Start" time-pair regex, e.g. "12:54 - 1:00"
const TIME_PAIR_RE = /^([1-9]|1[0-2]):([0-5][0-9])\s*-\s*([1-9]|1[0-2]):([0-5][0-9])$/;

// One modal that sets BOTH daily time slots (Group 1 and Group 2 of every
// day) at once, instead of picking one position at a time via the select
// menu above. Whatever's set here becomes the standing daily schedule —
// every future day's 2 groups reuse it automatically, same as /group-schedule.
function buildDailyScheduleModal(store) {
  const pos0 = getScheduleForPosition(store, 0);
  const pos1 = getScheduleForPosition(store, 1);
  const pairStr = (sched, i) => sched ? `${sched.matches[i].idp} - ${sched.matches[i].start}` : '';
  const mapsStr = (sched) => sched ? `${sched.matches[0].map}, ${sched.matches[1].map}` : '';

  return new ModalBuilder()
    .setCustomId('daily_schedule_modal')
    .setTitle('Daily Scrims Schedule (Both Groups)')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('g1m1').setLabel("Group 1 - Match 1 (IDP - Start)").setStyle(TextInputStyle.Short)
          .setValue(pairStr(pos0, 0)).setPlaceholder('12:54 - 1:00').setRequired(true).setMaxLength(15)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('g1m2').setLabel("Group 1 - Match 2 (IDP - Start)").setStyle(TextInputStyle.Short)
          .setValue(pairStr(pos0, 1)).setPlaceholder('1:34 - 1:40').setRequired(true).setMaxLength(15)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('g2m1').setLabel("Group 2 - Match 1 (IDP - Start)").setStyle(TextInputStyle.Short)
          .setValue(pairStr(pos1, 0)).setPlaceholder('1:04 - 1:10').setRequired(true).setMaxLength(15)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('g2m2').setLabel("Group 2 - Match 2 (IDP - Start)").setStyle(TextInputStyle.Short)
          .setValue(pairStr(pos1, 1)).setPlaceholder('1:44 - 1:50').setRequired(true).setMaxLength(15)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('maps').setLabel('Maps: G1M1, G1M2, G2M1, G2M2').setStyle(TextInputStyle.Short)
          .setValue([mapsStr(pos0), mapsStr(pos1)].filter(Boolean).join(', '))
          .setPlaceholder('Erangel, Miramar, Rondo, Erangel').setRequired(true).setMaxLength(100)
      ),
    );
}

async function handleDailyScheduleModalSubmit(interaction) {
  const store = getGuildStore(interaction.guildId);
  if (!store.settings) store.settings = {};

  const g1m1 = interaction.fields.getTextInputValue('g1m1').trim();
  const g1m2 = interaction.fields.getTextInputValue('g1m2').trim();
  const g2m1 = interaction.fields.getTextInputValue('g2m1').trim();
  const g2m2 = interaction.fields.getTextInputValue('g2m2').trim();
  const mapsRaw = interaction.fields.getTextInputValue('maps').trim();

  for (const [label, value] of [['Group 1 Match 1', g1m1], ['Group 1 Match 2', g1m2], ['Group 2 Match 1', g2m1], ['Group 2 Match 2', g2m2]]) {
    if (!TIME_PAIR_RE.test(value)) {
      return interaction.reply({
        content: `❌ "${value}" isn't valid for **${label}**. Use \`IDP - Start\` on a 12-hour clock, e.g. \`12:54 - 1:00\`.`,
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  const maps = mapsRaw.split(',').map(m => m.trim()).filter(Boolean);
  if (maps.length < 4) {
    return interaction.reply({
      content: '❌ Give 4 maps, comma-separated, in order: Group 1 Match 1, Group 1 Match 2, Group 2 Match 1, Group 2 Match 2.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const normalize = (t) => { const [h, m] = t.split(':'); return padTime(parseInt(h, 10), m); };
  const parsePair = (pairStr) => {
    const [, idpH, idpM, startH, startM] = TIME_PAIR_RE.exec(pairStr);
    return { idp: normalize(`${idpH}:${idpM}`), start: normalize(`${startH}:${startM}`) };
  };

  const g1m1Pair = parsePair(g1m1);
  const g1m2Pair = parsePair(g1m2);
  const g2m1Pair = parsePair(g2m1);
  const g2m2Pair = parsePair(g2m2);

  setSchedule(store, 0, {
    matches: [{ ...g1m1Pair, map: maps[0] }, { ...g1m2Pair, map: maps[1] }],
  });
  setSchedule(store, 1, {
    matches: [{ ...g2m1Pair, map: maps[2] }, { ...g2m2Pair, map: maps[3] }],
  });
  saveGuildStore(interaction.guildId, store);

  await interaction.reply({
    content:
      `✅ Daily scrims schedule updated — this now applies to **every day's** 2 groups:\n\n` +
      `**Group 1** — M1: IDP ${g1m1Pair.idp} PM / Start ${g1m1Pair.start} PM / ${maps[0]}\n` +
      `                M2: IDP ${g1m2Pair.idp} PM / Start ${g1m2Pair.start} PM / ${maps[1]}\n` +
      `**Group 2** — M1: IDP ${g2m1Pair.idp} PM / Start ${g2m1Pair.start} PM / ${maps[2]}\n` +
      `                M2: IDP ${g2m2Pair.idp} PM / Start ${g2m2Pair.start} PM / ${maps[3]}`,
    flags: MessageFlags.Ephemeral,
  });

  await refreshLivePanel(interaction.client, interaction.guildId);
}

module.exports = {
  buildGroupSchedulePanelPayload, handleGroupScheduleSelect, handleGroupScheduleModalSubmit,
  buildDailyScheduleModal, handleDailyScheduleModalSubmit,
};
