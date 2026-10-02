const { SlashCommandBuilder } = require("discord.js");
const { GAMEMODES, TIER_OPTIONS } = require("./config");

const REGIONS = ["NA", "EU", "AS", "ME", "AU"];

const commands = [
  new SlashCommandBuilder()
    .setName("postqueue")
    .setDescription(
      "Post the tier-test queue message in this channel (run once per channel)."
    ),

  new SlashCommandBuilder()
    .setName("verify")
    .setDescription("Link your Discord account to your Minecraft username.")
    .addStringOption((opt) =>
      opt
        .setName("username")
        .setDescription("Your Minecraft username")
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("platform")
        .setDescription("Your account type")
        .setRequired(true)
        .addChoices(
          { name: "Bedrock", value: "bedrock" },
          { name: "Premium", value: "premium" },
          { name: "Cracked", value: "cracked" }
        )
    ),

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
    .setName("backfilllogs")
    .setDescription(
      "One-time: rebuild the website's test log from results channel history."
    ),

  new SlashCommandBuilder()
    .setName("setupqueues")
    .setDescription(
      "One-time setup: creates missing gamemode/tier roles and tiertest channels, posts queues."
    ),

  new SlashCommandBuilder()
    .setName("postverifyinfo")
    .setDescription(
      "Post step-by-step account-linking instructions to the verify-info channel."
    ),

  new SlashCommandBuilder()
    .setName("posthighqueue")
    .setDescription(
      "Post a HIGH tier-test queue (LT3 and above only) in this channel."
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
];

module.exports = commands;
