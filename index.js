const config = require("./config.json");
const Discord = require("discord.js");
const {
	REST,
	Routes
} = require('discord.js');
const rest = new REST({
	version: '10'
}).setToken(config.discord.token);
const fs = require("fs");
const path = require("path");
const colors = require("colors");

const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("./database.db");

// If database table doesnt exist, create it
// two tables, one for per-guild settings, one for keeping track of temp voice channels
// guild_settings: guild_id text, voice_category_id text, creation_channel_id text, max_temp_channels integer, max_per_user integer
// temp_channels: channel_id text, guild_id text, creator_id text

db.run(`CREATE TABLE IF NOT EXISTS guild_settings (
	voice_category_id TEXT PRIMARY KEY,
	guild_id TEXT,
	creation_channel_id TEXT
)`);

db.run(`CREATE TABLE IF NOT EXISTS temp_channels (
	channel_id TEXT PRIMARY KEY,
	guild_id TEXT,
	creator_id TEXT
)`);

const client = new Discord.Client({
	intents: [
		"Guilds",
		"GuildVoiceStates"
	]
});

client.on("ready", async () => {
	console.log(`${colors.cyan("[INFO]")} Logged in as ${colors.green(client.user.tag)}`);
	const commands = [
		{
			name: "setup",
			description: "Setup the bot for your server",
			default_member_permissions: 16,
			options: [
				{
					name: "category",
					description: "The category to create the temporary voice channels in",
					type: 7,
					required: true
				}
			]
		}
	]

	console.log(`${colors.cyan("[INFO]")} Started refreshing application (/) commands.`);
	await rest.put(
		Routes.applicationCommands(client.user.id), {
		body: commands
	}
	);
	console.log(`${colors.cyan("[INFO]")} Successfully reloaded application (/) commands.`);
})

client.on("interactionCreate", async (interaction) => {
	if (!interaction.isCommand()) return;
	const command = interaction.commandName;
	switch (command) {
		case "setup": // Initial and post-setup configuration
			// Check if the channel is already set up, if so and no settings are provided, tell the user to specify settings to update, use channel id, not guild.
			// If the channel is not set up, set it up with the provided settings or default settings
			const guild_id = interaction.guild.id;
			const voice_category_id = interaction.options.getChannel("category");
			// Check that voice_category_id is a category
			if (voice_category_id.type !== Discord.ChannelType.GuildCategory) {
				return interaction.reply({
					content: "The channel you selected is not a category! Please select a category to set up the temporary voice channels in.",
					ephemeral: true
				})
			}
			db.get("SELECT * FROM guild_settings WHERE voice_category_id = ?", voice_category_id.id, (err, row) => {
				if (err) {
					console.error(err);
					interaction.reply({
						content: "An error occurred while setting up the channel. Please try again later.",
						ephemeral: true
					});
				}
				if (row) { // Channel already set up, update settings
					// get channel info
					const voice_category = interaction.guild.channels.cache.get(row.voice_category_id);
					// Do a quick check to see if the creation channel still exists, if not, create and update the field for it
					if (!interaction.guild.channels.cache.get(row.creation_channel_id)) {
						interaction.guild.channels.create({
							name: "Create a Channel",
							type: Discord.ChannelType.GuildVoice,
							parent: voice_category_id.id
						}).then((channel) => {
							db.run("UPDATE guild_settings SET creation_channel_id = ? WHERE voice_category_id = ?", channel.id, voice_category_id.id, (err) => {
								if (err) {
									console.error(err);
									interaction.reply({
										content: "An error occurred while updating the channel settings. Please try again later.",
										ephemeral: true
									});
								}
								return interaction.reply({
									content: "Successfully updated the temporary voice channels.",
									ephemeral: true
								});
							});
						}).catch((err) => {
							console.error(err);
							interaction.reply({
								content: "An error occurred while updating the channel settings. Please try again later.",
								ephemeral: true
							});
						});
					}

					return interaction.reply({
						content: `The temporary voice channels are already set up in ${voice_category.name}.`,
						ephemeral: true
					});
				} else {
					// Channel not set up, set up channel (make a voice channel in the category called "Create a Channel", then set up the settings)

					// Create the channel
					interaction.guild.channels.create({
						name: "Create a Channel",
						type: Discord.ChannelType.GuildVoice,
						parent: voice_category_id.id
					}).then((channel) => {
						// Set up the settings
						db.run("INSERT INTO guild_settings (voice_category_id, guild_id, creation_channel_id) VALUES (?, ?, ?)", voice_category_id.id, guild_id, channel.id, (err) => {
							if (err) {
								console.error(err);
								interaction.reply({
									content: "An error occurred while setting up the channel. Please try again later.",
									ephemeral: true
								});
							}
							interaction.reply({
								content: `Successfully set up the temporary voice channels in ${voice_category_id.name}.`,
								ephemeral: true
							});
						});
					}).catch((err) => {
						console.error(err);
						interaction.reply({
							content: "An error occurred while setting up the channel. Please try again later.",
							ephemeral: true
						});
					});
				}

			});

			break;
	}
});

client.on("voiceStateUpdate", async (oldState, newState) => {
	// Handle creation
	// Check if the user is in a creation channel, if so make a new channel, name format is temp #<tempchannel count for guild>, then move them there
	if (newState.channel) {
		db.get("SELECT * FROM guild_settings WHERE creation_channel_id = ?", newState.channel.id, (err, row) => {
			if (err) {
				console.error(err);
			}
			if (row) {
				// User is in a creation channel
				const guild = newState.guild.id;
				const creator = newState.member.id;
				// Get the number of temp channels in a guild
				db.get("SELECT COUNT(*) FROM temp_channels WHERE guild_id = ?", guild, (err, row2) => {
					if (err) {
						console.error(err);
					}
					const temp_channel_count = row2["COUNT(*)"];
					// Create a new channel
					newState.guild.channels.create({
						name: `Temp #${temp_channel_count + 1}`,
						type: Discord.ChannelType.GuildVoice,
						parent: row.voice_category_id
					}).then((channel) => {
						channel.send({
							embeds: [
								{
									color: 0xff0000,
									title: "Temporary Voice Channel",
									description: `This is a temporary voice channel created by ${newState.member.user}.\nThis voice channel and the messages within will be deleted when the channel is empty!`,
								}
							]
						});
						// Move the user to the new channel
						newState.setChannel(channel);
						// Update the database
						db.run("INSERT INTO temp_channels (channel_id, guild_id, creator_id) VALUES (?, ?, ?)", channel.id, guild, creator, (err) => {
							if (err) {
								console.error(err);
							}
						});
					}).catch((err) => {
						console.error(err);
					});
				});
			}
		});
	}
	// Handle deletion
	// Check if the user left a temp channel, if they were the last person in the channel, delete it
	if (oldState.channel) {
		db.get("SELECT * FROM temp_channels WHERE channel_id = ?", oldState.channel.id, (err, row) => {
			if (err) {
				console.error(err);
			}
			if (row) {
				// User left a temp channel
				const channel = oldState.channel;
				// Check if the user was the last person in the channel
				if (!channel.members || channel.members.size === 0) {
					// Delete the channel
					channel.delete();
					// Update the database
					db.run("DELETE FROM temp_channels WHERE channel_id = ?", channel.id , (err) => {
						if (err) {
							console.error(err);
						}
					});
				}
			}
		});
	}
});

// Lets actually handle exceptions now
process.on('unhandledRejection', (error) => {
	// Log a full error with line number
	console.log(`${colors.red("[ERROR]")} ${error}`);
});

process.on('uncaughtException', (error) => {
	// Log a full error with line number
	console.log(`${colors.red("[ERROR]")} ${error}`);
});

client.login(config.discord.token)