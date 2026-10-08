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

// Every region the bot/website split queues by. A tiertest channel now
// exists per (gamemode, region) pair, e.g. "crystal-tiertest-na" — a
// player/tester's own region (set during verification) decides which one
// they land in automatically.
const REGIONS = ["NA", "EU", "AS", "ME", "AU"];

// Emoji prefixed onto each gamemode's tiertest channel name, e.g.
// "💎-crystal-tiertest". /setupqueues creates (and renames existing
// channels to) this form; a gamemode missing here just keeps its plain name.
const GAMEMODE_EMOJIS = {
  vanilla: "💎",
  axe: "🪓",
  sword: "⚔️",
  mace: "🔨",
  nethop: "🔥",
  pot: "🧪",
  smp: "🌍",
  uhc: "❤️",
  cart: "🛒",
};

// Reverse of GAMEMODE_CHANNELS: gamemode id -> its plain (no-emoji, no
// -region) base channel name, e.g. "crystal-tiertest".
function baseChannelName(gamemode) {
  return Object.entries(GAMEMODE_CHANNELS).find(([, gm]) => gm === gamemode)?.[0];
}

// The channel name /setupqueues actually creates/renames a (gamemode,
// region) tiertest channel to, e.g. regionChannelName("vanilla", "NA") ->
// "💎-crystal-tiertest-na". Returns null if the gamemode isn't known or the
// region isn't one of REGIONS.
function regionChannelName(gamemode, region) {
  const base = baseChannelName(gamemode);
  if (!base || !REGIONS.includes(region)) return null;
  const emoji = GAMEMODE_EMOJIS[gamemode];
  const name = `${base}-${region.toLowerCase()}`;
  return emoji ? `${emoji}-${name}` : name;
}

// Matches a real Discord channel name back to { gamemode, region } by
// trying every known (gamemode, region) combo, with or without the emoji
// prefix. Returns undefined if the name doesn't match any of them (e.g. a
// leftover pre-region channel like "crystal-tiertest").
function parseChannelName(name) {
  for (const gamemode of GAMEMODES) {
    for (const region of REGIONS) {
      if (name === regionChannelName(gamemode, region)) return { gamemode, region };
    }
  }
  return undefined;
}

function gamemodeForChannelName(name) {
  return parseChannelName(name)?.gamemode;
}

function regionForChannelName(name) {
  return parseChannelName(name)?.region;
}

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

// Players with this role are banned from joining queues or opening support
// tickets. Checked before any queue/ticket action is allowed.
const RESTRICTED_ROLE_ID = "1555849744843153451";

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
const GENERAL_CATEGORY_NAME = "General";

// Was "Testing" with 2 channels; renamed/expanded to "Tierlist" with 6.
// OLD_TESTING_CATEGORY_NAME is kept so /setupqueues can find and rename an
// existing "Testing" category from before this change instead of leaving a
// stray duplicate category behind.
const TIERLIST_CATEGORY_NAME = "Tierlist";
const OLD_TESTING_CATEGORY_NAME = "Testing";

// Reference channels /setupqueues creates under TIERLIST_CATEGORY_NAME.
// "ranked-rubric"/"ranked-ruleset"/"punishments" get their info posted
// automatically the first time each is created (same pattern as #verify).
const TIERLIST_CHANNELS = [
  { name: "ranked-rubric" },
  { name: "ranked-ruleset" },
  { name: "punishments" },
  { name: "testing-leaderboard" },
  { name: "high-results" },
  { name: "results" },
];

// "Requests" category: the public entry points for queueing, opening a
// support ticket, and applying to be a tester. All three are read-only
// (locked the same way as tiertest channels) — interaction is via the
// buttons/select menu posted into them, not by typing.
const REQUESTS_CATEGORY_NAME = "Requests";
const REQUEST_TEST_CHANNEL_NAME = "request-test";
const REQUEST_HIGH_TEST_CHANNEL_NAME = "request-high-test";
const REQUEST_SUPPORT_CHANNEL_NAME = "request-support";
const TESTER_APPLICATION_CHANNEL_NAME = "tester-application";

// Staff-only category for reviewing tester applications. Same permission
// pattern as SUPPORT_CATEGORY_NAME (deny @everyone, allow manager/
// moderator/owner) but kept separate since application review is a
// different audience/purpose than support tickets.
const STAFF_CATEGORY_NAME = "Staff";
const TESTER_APP_REVIEW_CHANNEL_NAME = "tester-app-reviews";

// Basic non-gamemode channels /setupqueues creates under GENERAL_CATEGORY_NAME.
// "verify" gets the account-linking info posted into it automatically the
// first time it's created. announcementsOnly denies @everyone Send Messages.
const BASIC_CHANNELS = [
  { name: "announcements", announcementsOnly: true },
  { name: "chat" },
  { name: "commands" },
  { name: "verify" },
];

// Discord's default channels every new server starts with — /setupqueues
// deletes these if found, since they're being replaced by the above.
const DEFAULT_CHANNELS_TO_REMOVE = [
  { name: "general", type: "text" },
  { name: "general", type: "voice" },
];

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

// Economy config
const COIN_REWARDS = {
  TESTED:    50,   // testee earns this when a result is submitted for them
  TESTER:    30,   // tester earns this per completed test
  DAILY:    100,   // /daily claim
  MILESTONE: 200,  // bonus on reaching a new tier milestone (HT3, LT3, HT1, LT1)
};

const MILESTONE_TIERS = new Set(["HT3", "LT3", "HT2", "LT2", "HT1", "LT1"]);

const SHOP_ITEMS = {
  cooldown_remove: { name: "Cooldown Removal",  price: 500,  description: "Remove your active tier-test cooldown for one gamemode." },
  extra_slot:      { name: "Extra Queue Slot",   price: 800,  description: "Buy one extra queue slot (max 2 extra)." },
  vip_role:        { name: "VIP Role",           price: 1500, description: "Get the exclusive VIP cosmetic role." },
};

// Set this to a real role ID to enable the VIP role shop item.
const VIP_ROLE_ID = process.env.VIP_ROLE_ID || "";

module.exports = {
  GAMEMODE_CHANNELS,
  GAMEMODES,
  REGIONS,
  RESTRICTED_ROLE_ID,
  GAMEMODE_EMOJIS,
  GAMEMODE_PING_ROLE_NAMES,
  PERMISSION_ROLE_IDS,
  TIER_OPTIONS,
  COOLDOWN_DAYS,
  SUPPORT_CATEGORY_NAME,
  GENERAL_CATEGORY_NAME,
  TIERLIST_CATEGORY_NAME,
  OLD_TESTING_CATEGORY_NAME,
  TIERLIST_CHANNELS,
  REQUESTS_CATEGORY_NAME,
  REQUEST_TEST_CHANNEL_NAME,
  REQUEST_HIGH_TEST_CHANNEL_NAME,
  REQUEST_SUPPORT_CHANNEL_NAME,
  TESTER_APPLICATION_CHANNEL_NAME,
  STAFF_CATEGORY_NAME,
  TESTER_APP_REVIEW_CHANNEL_NAME,
  BASIC_CHANNELS,
  DEFAULT_CHANNELS_TO_REMOVE,
  tierRoleName,
  queueCategoryName,
  baseChannelName,
  regionChannelName,
  parseChannelName,
  gamemodeForChannelName,
  regionForChannelName,
  COIN_REWARDS,
  MILESTONE_TIERS,
  SHOP_ITEMS,
  VIP_ROLE_ID,
};
