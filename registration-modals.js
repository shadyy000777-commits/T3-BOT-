const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');

// Discord caps modals at 5 text inputs, and registration needs 15 data points total
// (team name, owner name, whatsapp, owner email, city, + 5 players x [ign, uid]),
// so the form is split across 3 modals shown back-to-back: 5 + 4 + 5 fields.
// Step 2 covers Player 1 & 2 (ign+uid each = 4 fields). Step 3 covers Player 3
// (ign+uid) and Player 4 (ign+uid) = 4 fields, plus Player 5 combined into a
// single "IGN - UID" field to stay within the 5-field cap = 5 fields total.
// "Team registered date" is NOT asked here — it's stamped automatically
// with the server time when step 3 is submitted.
//
// Each builder takes an optional `prefill` object (an existing registration
// record) so the "Edit" flow can show a player's current answers instead of
// blank fields — used for editing, left undefined for a fresh registration.

function row(input) {
  return new ActionRowBuilder().addComponents(input);
}

function field(input, prefill, key) {
  if (prefill && prefill[key] !== undefined && prefill[key] !== null) {
    input.setValue(String(prefill[key]));
  }
  return input;
}

function buildStep1Modal(prefill) {
  const modal = new ModalBuilder().setCustomId('t3reg_step1').setTitle('T3 Registration - Step 1/3');

  const team = field(new TextInputBuilder()
    .setCustomId('team_name').setLabel('Team Name')
    .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(50), prefill, 'team_name');

  const owner = field(new TextInputBuilder()
    .setCustomId('owner_name').setLabel('Team Owner Full Name')
    .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(60), prefill, 'owner_name');

  const whatsapp = field(new TextInputBuilder()
    .setCustomId('whatsapp').setLabel('WhatsApp Contact Number')
    .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(15)
    .setPlaceholder('e.g. 919876543210'), prefill, 'whatsapp');

  const email = field(new TextInputBuilder()
    .setCustomId('owner_email').setLabel('Team Owner Email')
    .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80)
    .setPlaceholder('e.g. name@example.com'), prefill, 'owner_email');

  const city = field(new TextInputBuilder()
    .setCustomId('city').setLabel('City')
    .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(50), prefill, 'city');

  modal.addComponents(row(team), row(owner), row(whatsapp), row(email), row(city));
  return modal;
}

function buildStep2Modal(prefill) {
  const modal = new ModalBuilder().setCustomId('t3reg_step2').setTitle('T3 Registration - Step 2/3');

  const p1ign = field(new TextInputBuilder()
    .setCustomId('p1_ign').setLabel('Player 1 - In-Game Name')
    .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(30), prefill, 'p1_ign');

  const p1uid = field(new TextInputBuilder()
    .setCustomId('p1_uid').setLabel('Player 1 - Game UID')
    .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(15)
    .setPlaceholder('Numbers only, e.g. 5123456789'), prefill, 'p1_uid');

  const p2ign = field(new TextInputBuilder()
    .setCustomId('p2_ign').setLabel('Player 2 - In-Game Name')
    .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(30), prefill, 'p2_ign');

  const p2uid = field(new TextInputBuilder()
    .setCustomId('p2_uid').setLabel('Player 2 - Game UID')
    .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(15), prefill, 'p2_uid');

  modal.addComponents(row(p1ign), row(p1uid), row(p2ign), row(p2uid));
  return modal;
}

function buildStep3Modal(prefill) {
  const modal = new ModalBuilder().setCustomId('t3reg_step3').setTitle('T3 Registration - Step 3/3');

  const p3ign = field(new TextInputBuilder()
    .setCustomId('p3_ign').setLabel('Player 3 - In-Game Name')
    .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(30), prefill, 'p3_ign');

  const p3uid = field(new TextInputBuilder()
    .setCustomId('p3_uid').setLabel('Player 3 - Game UID')
    .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(15), prefill, 'p3_uid');

  const p4ign = field(new TextInputBuilder()
    .setCustomId('p4_ign').setLabel('Player 4 - In-Game Name')
    .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(30), prefill, 'p4_ign');

  const p4uid = field(new TextInputBuilder()
    .setCustomId('p4_uid').setLabel('Player 4 - Game UID')
    .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(15), prefill, 'p4_uid');

  // Player 5 combined into one field: "IGN - UID". Optional — some teams
  // play as a 4-stack, so leaving this blank is allowed; if filled in, it
  // still has to match the "IGN - UID" format.
  const p5PrefillValue = prefill && prefill.p5_combined !== undefined
    ? prefill.p5_combined
    : (prefill && prefill.p5_ign ? `${prefill.p5_ign} - ${prefill.p5_uid}` : undefined);

  const p5combined = new TextInputBuilder()
    .setCustomId('p5_combined').setLabel('Player 5 - In-Game Name & UID (optional)')
    .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(80)
    .setPlaceholder('e.g. ProGamer123 - 5123456789 (leave blank if none)');
  if (p5PrefillValue) p5combined.setValue(String(p5PrefillValue));

  modal.addComponents(row(p3ign), row(p3uid), row(p4ign), row(p4uid), row(p5combined));
  return modal;
}

module.exports = { buildStep1Modal, buildStep2Modal, buildStep3Modal };
