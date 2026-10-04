const { SlashCommandBuilder } = require("discord.js");
const { GAMEMODES, TIER_OPTIONS } = require("./config");

const REGIONS = ["NA", "EU", "AS", "ME", "AU"];

const commands = [
  new SlashCommandBuilder()
    .setName("sendrules")
    .setDescription("Post the server rules embed in the current channel. (Staff only)"),

  new SlashCommandBuilder()
    .setName("poststaffapp")
    .setDescription("Post the staff application embed to the staff-app channel. (Staff only)"),

  new SlashCommandBuilder()
    .setName("posthighrubric")
    .setDescription("Post the high-tier testing rubric in the current channel. (Staff only)"),

  new SlashCommandBuilder()
    .setName("jointesting")
    .setDescription(
      "Join this queue as a tester alongside anyone already testing here. Run this in the queue channel."
    ),

  new SlashCommandBuilder()
    .setName("leavetesting")
    .setDescription(
      "Stop testing this queue. Run this in the queue channel."
    ),

  new SlashCommandBuilder()
    .setName("setupqueues")
    .setDescription(
      "One-time setup: creates missing gamemode/tier roles and tiertest channels, posts queues."
    ),

  new SlashCommandBuilder()
    .setName("resetqueues")
    .setDescription(
      "One-time cleanup: removes duplicate tiertest channels/messages, reposts one clean queue."
    ),

  new SlashCommandBuilder()
    .setName("postverifyinfo")
    .setDescription(
      "Post step-by-step account-linking instructions to the verify-info channel."
    ),

  new SlashCommandBuilder()
    .setName("clearcooldown")
    .setDescription(
      "Clear a player's tier-test cooldown so they can queue again early. Testers/managers/admins only."
    )
    .addUserOption((opt) =>
      opt
        .setName("player")
        .setDescription("The player to clear the cooldown for")
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("gamemode")
        .setDescription("Which gamemode's cooldown to clear")
        .setRequired(true)
        .addChoices(...GAMEMODES.map((gm) => ({ name: gm, value: gm })))
    ),

  new SlashCommandBuilder()
    .setName("settier")
    .setDescription(
      "Manually set a player's tier without going through the queue. Testers/managers/admins only."
    )
    .addStringOption((opt) =>
      opt
        .setName("gamemode")
        .setDescription("Which gamemode")
        .setRequired(true)
        .addChoices(...GAMEMODES.map((gm) => ({ name: gm, value: gm })))
    )
    .addStringOption((opt) =>
      opt
        .setName("tier")
        .setDescription("The tier to set")
        .setRequired(true)
        .addChoices(...TIER_OPTIONS.map((t) => ({ name: t, value: t })))
    )
    .addStringOption((opt) =>
      opt
        .setName("username")
        .setDescription("The player's Minecraft username (skip this if using the 'player' option)")
        .setRequired(false)
    )
    .addUserOption((opt) =>
      opt
        .setName("player")
        .setDescription("Ping a verified player instead of typing their username")
        .setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName("region")
        .setDescription("Region (only needed if this player is new)")
        .setRequired(false)
        .addChoices(...REGIONS.map((r) => ({ name: r, value: r })))
    ),
  new SlashCommandBuilder()
    .setName("removetester")
    .setDescription("Remove a tester from the active testers list for this queue. (Managers only)")
    .addUserOption((opt) =>
      opt.setName("tester").setDescription("The tester to remove").setRequired(true)
    ),
];

module.exports = commands;
