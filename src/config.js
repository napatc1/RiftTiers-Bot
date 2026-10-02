// Maps each tiertest channel name to the gamemode it tests.
// The bot only sets up a queue in channels listed here.
const GAMEMODE_CHANNELS = {
  "crystal-tiertest": "vanilla",
  "axe-tiertest": "axe",
  "sword-tiertest": "sword",
  "mace-tiertest": "mace",
  "netherite-pot-tiertest": "nethop",
  "pot-tiertest": "pot",
  "smp-tiertest": "smp",
  "uhc-tiertest": "uhc",
  "cart-tiertest": "cart",
};

// Every gamemode id the bot knows about (should match the values above).
const GAMEMODES = [
  "vanilla", "axe", "sword", "mace", "nethop", "pot", "smp", "uhc", "cart",
];

// Discord role to ping when a queue opens for each gamemode, matched by
// NAME rather than a hardcoded ID. This means the role just has to exist
// (under this exact name) on whichever server the bot is running on —
// nothing to copy/paste when moving servers. /setupqueues creates any of
// these that are missing.
const GAMEMODE_PING_ROLE_NAMES = {
  vanilla: "Crystal",
  axe: "Axe",
  sword: "Sword",
  mace: "Mace",
  nethop: "NethOP",
  pot: "Pot",
  smp: "SMP",
  uhc: "UHC",
  cart: "Cart",
};

// Discord role IDs that grant website permissions. Kept separate from the
// gamemode ping roles above. The bot syncs these onto each player's
// `profiles` row in Supabase so the website knows who can do what.
const PERMISSION_ROLE_IDS = {
  manager: "1555515918069530664",
  seniorTester: "1555516077666996325",
  tester: "1555516030082879569",
  moderator: "1555516390822252654",
  owner: "1555516243388399636",
};

// Tiers a tester can assign, best to worst. Matches tiers.js on the website.
const TIER_OPTIONS = [
  "HT1", "LT1", "HT2", "LT2", "HT3", "LT3", "HT4", "LT4", "HT5", "LT5",
];

// How long a player must wait after being tested before they can queue
// again for the same gamemode.
const COOLDOWN_DAYS = 3;

// Category names /setupqueues and the realtime sync organize channels
// under. Matched by name, same as the ping/tier roles above. Each gamemode
// gets its own category (e.g. "UHC Test") rather than sharing one, via
// queueCategoryName() below.
const SUPPORT_CATEGORY_NAME = "Support Tickets";

// Builds the Discord role name for a (gamemode, tier) pair, e.g.
// tierRoleName("vanilla", "LT5") -> "Crystal LT5", tierRoleName("uhc", "HT4")
// -> "UHC HT4". Used both to create the role and to find/remove a player's
// previous tier role in the same gamemode.
function tierRoleName(gamemode, tier) {
  const display = GAMEMODE_PING_ROLE_NAMES[gamemode] || gamemode;
  return `${display} ${tier}`;
}

// Builds the per-gamemode category name its queue channel lives under, e.g.
// queueCategoryName("uhc") -> "UHC Test", queueCategoryName("vanilla") ->
// "Crystal Test".
function queueCategoryName(gamemode) {
  const display = GAMEMODE_PING_ROLE_NAMES[gamemode] || gamemode;
  return `${display} Test`;
}

module.exports = {
  GAMEMODE_CHANNELS,
  GAMEMODES,
  GAMEMODE_PING_ROLE_NAMES,
  PERMISSION_ROLE_IDS,
  TIER_OPTIONS,
  COOLDOWN_DAYS,
  SUPPORT_CATEGORY_NAME,
  tierRoleName,
  queueCategoryName,
};
