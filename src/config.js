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

// Discord role ID to ping when a queue opens for each gamemode. Using IDs
// instead of names avoids any typo/casing mismatch. Right-click a role in
// Discord (Developer Mode must be on) -> Copy Role ID.
const ROLE_PING_IDS = {
  vanilla: "1534543111982813206", // Crystal
  axe: "1534543356699344946",
  sword: "1534543181495013508",
  mace: "1534543231503696032",
  nethop: "1534543281856184490", // Netherite pot
  pot: "1534543463238864956",
  smp: "1534543402035581170",
  uhc: "1545384834975793152",
  cart: "1545385591426781244",
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

module.exports = { GAMEMODE_CHANNELS, GAMEMODES, ROLE_PING_IDS, PERMISSION_ROLE_IDS, TIER_OPTIONS, COOLDOWN_DAYS };
