const { getGuildStore } = require('./storage');
const { buildRegisteredLogEmbed } = require('./registration-handlers');

module.exports = {
  name: 'team',
  aliases: ['viewteam'],
  description: "View a specific member's registered team card (usage: !team @user)",

  async execute(message) {
    const targetUser = message.mentions.users.first();
    if (!targetUser) {
      return message.reply('❌ Mention a user to look up — usage: `!team @user`');
    }

    const store = getGuildStore(message.guildId);
    const data = store.registrations && store.registrations[targetUser.id];

    if (!data) {
      return message.reply(`❌ ${targetUser} hasn't registered a team yet.`);
    }

    // Reuses the exact "T3 REGISTRATION — Team Confirmed" card posted to
    // the log channel, so !team shows the same format.
    const embed = buildRegisteredLogEmbed(data, data.teamNumber, targetUser.id, false);

    await message.channel.send({ embeds: [embed] });
  },
};
