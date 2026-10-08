const { SlashCommandBuilder } = require("discord.js");
const { GAMEMODES, TIER_OPTIONS, SHOP_ITEMS } = require("./config");

const REGIONS = ["NA", "EU", "AS", "ME", "AU"];

const commands = [
  new SlashCommandBuilder()
    .setName("util")
    .setDescription("Staff utility commands.")
    .addStringOption((opt) =>
      opt
        .setName("action")
        .setDescription("Which utility to run")
        .setRequired(true)
        .addChoices(
          { name: "sendrules",         value: "sendrules" },
          { name: "postverifyinfo",    value: "postverifyinfo" },
          { name: "poststaffapp",      value: "poststaffapp" },
          { name: "posthighrubric",    value: "posthighrubric" },
          { name: "postmediaapp",      value: "postmediaapp" },
          { name: "posthightestpanel", value: "posthightestpanel" },
          { name: "setupqueues",       value: "setupqueues" },
          { name: "resetqueues",       value: "resetqueues" },
          { name: "removetester",      value: "removetester" }
        )
    )
    .addUserOption((opt) =>
      opt
        .setName("tester")
        .setDescription("Tester to remove (only for removetester action)")
        .setRequired(false)
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
    .setName("coins")
    .setDescription("Check your coin balance (or another player's).")
    .addUserOption((opt) =>
      opt.setName("player").setDescription("Player to check (leave blank for yourself)").setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("daily")
    .setDescription("Claim your daily coin reward."),

  new SlashCommandBuilder()
    .setName("shop")
    .setDescription("View the coin shop."),

  new SlashCommandBuilder()
    .setName("buy")
    .setDescription("Buy an item from the coin shop.")
    .addStringOption((opt) =>
      opt.setName("item").setDescription("Item to buy").setRequired(true)
        .addChoices(
          ...Object.entries(SHOP_ITEMS).map(([k, v]) => ({ name: `${v.name} (${v.price} coins)`, value: k }))
        )
    )
    .addStringOption((opt) =>
      opt.setName("gamemode").setDescription("Gamemode (required for cooldown_remove)").setRequired(false)
        .addChoices(...GAMEMODES.map((gm) => ({ name: gm, value: gm })))
    ),

  new SlashCommandBuilder()
    .setName("punish")
    .setDescription("Restrict a user from queues and tickets. (Managers only)")
    .addUserOption((opt) =>
      opt.setName("user").setDescription("The user to restrict").setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName("duration").setDescription("How long the restriction lasts (e.g. 1 week, permanent)").setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName("reason").setDescription("Reason for the restriction").setRequired(true)
    ),
];

module.exports = commands;
