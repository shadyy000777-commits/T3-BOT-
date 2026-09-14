require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');

const commands = [];
const commandFiles = fs.readdirSync(__dirname).filter(f => f.startsWith('cmd-') && f.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(path.join(__dirname, file));
  commands.push(command.data.toJSON());
}

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log(`Registering ${commands.length} slash commands...`);
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('Slash commands registered for your server. They should appear immediately.');
  } catch (err) {
    console.error(err);
  }
})();
