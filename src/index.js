console.log("[startup] index.js starting...");
require("dotenv").config();

// Keep-alive HTTP server so Render's free tier doesn't spin the process
// down. UptimeRobot (or any monitor) should ping this every 5 minutes.
require("http").createServer((req, res) => res.end("OK")).listen(process.env.PORT || 3000);
const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionsBitField,
  ChannelType,
  REST,
  Routes,
  Partials,
  StringSelectMenuBuilder,
} = require("discord.js");
const commands = require("./commands");
const {
  GAMEMODE_CHANNELS,
  GAMEMODES,
  REGIONS,
  TIER_OPTIONS,
  COOLDOWN_DAYS,
  GAMEMODE_PING_ROLE_NAMES,
  PERMISSION_ROLE_IDS,
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
  RESTRICTED_ROLE_ID,
} = require("./config");
const {
  supabase,
  ensurePlayerForDiscordUser,
  syncProfileRoles,
  getPlayerRowByUsername,
  setPlayerTier,
  getPlayer,
  getCooldownUntil,
  setCooldown,
  clearCooldown,
  setVerifiedUsername,
  getVerifiedUsername,
  getVerifiedPlatform,
  setLiveTest,
  clearLiveTest,
  logTestResult,
  joinQueue,
  leaveQueue,
  popNext,
  getQueueCount,
  formatQueue,
  isQueueClosed,
  setQueueClosed,
  getQueueLocked,
  setQueueLocked,
  getQueueLastOpenedAt,
  addQueueTester,
  removeQueueTester,
  getQueueTesterIds,
  setActiveTesting,
  getActiveTesting,
  getActiveTestingByTicket,
  clearActiveTestingByTicket,
  setQueueMessage,
  getQueueMessage,
  deleteQueueMessage,
  loadQueueMessages,
  createSupportTicketFromDiscord,
  closeSupportTicketFromDiscord,
  createTesterApplication,
  getTesterApplication,
  setTesterApplicationReviewMessage,
  decideTesterApplication,
} = require("./supabase");
const {
  initRealtimeSync,
  handleTicketChannelMessage,
  handleTicketChannelMessageEdit,
  handleTicketChannelMessageDelete,
} = require("./realtime-sync");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  // Lets messageUpdate/messageDelete still fire (as partials) for messages
  // that fell out of the cache, so edits/deletes keep mirroring to the
  // website even for older ticket messages.
  partials: [Partials.Message, Partials.Channel],
});

// ---------- helpers ----------

const testerRoleNames = (process.env.TESTER_ROLE_NAMES || "Tester")
  .split(",")
  .map((r) => r.trim().toLowerCase());

const managerRoleNames = (process.env.MANAGER_ROLE_NAMES || "Manager")
  .split(",")
  .map((r) => r.trim().toLowerCase());

function isRestricted(member) {
  return member.roles.cache.has(RESTRICTED_ROLE_ID);
}

function isTester(member) {
  return member.roles.cache.some((r) =>
    testerRoleNames.includes(r.name.toLowerCase())
  );
}

// Testers, managers, and anyone with real admin/manage-server power can
// clear cooldowns. This is deliberately broader than isTester().
function canManageCooldowns(member) {
  return (
    isTester(member) ||
    member.roles.cache.some((r) => managerRoleNames.includes(r.name.toLowerCase())) ||
    member.permissions.has(PermissionsBitField.Flags.Administrator) ||
    member.permissions.has(PermissionsBitField.Flags.ManageGuild)
  );
}

const COOLDOWN_MS = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

function formatRemaining(ms) {
  const hours = Math.ceil(ms / (60 * 60 * 1000));
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.ceil(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

function getTesterRoles(guild) {
  return guild.roles.cache.filter((r) =>
    testerRoleNames.includes(r.name.toLowerCase())
  );
}

function getManagerRoles(guild) {
  return guild.roles.cache.filter((r) =>
    managerRoleNames.includes(r.name.toLowerCase())
  );
}

// Every role that should be able to type in a tiertest channel: testers,
// senior testers, managers, moderators, owners (by the fixed permission IDs
// in config.js, when that role exists on this server) plus anything matched
// by name via TESTER_ROLE_NAMES/MANAGER_ROLE_NAMES, plus the bot's own
// role(s) so it can keep posting queue messages once @everyone is denied.
function testerAndUpRoleIds(guild) {
  const ids = new Set();
  for (const roleId of Object.values(PERMISSION_ROLE_IDS)) {
    if (roleId && guild.roles.cache.has(roleId)) ids.add(roleId);
  }
  for (const role of getTesterRoles(guild).values()) ids.add(role.id);
  for (const role of getManagerRoles(guild).values()) ids.add(role.id);
  const botMember = guild.members.me;
  if (botMember) {
    for (const role of botMember.roles.cache.values()) {
      if (role.id !== guild.roles.everyone.id) ids.add(role.id);
    }
  }
  return ids;
}

// Locks a tiertest channel down to read-only for everyone except
// testers/managers/mods/owners (and the bot) — players can still see the
// queue and use the buttons, they just can't type in it.
async function lockChannelToTesters(guild, channel) {
  await channel.permissionOverwrites
    .edit(guild.roles.everyone.id, { SendMessages: false })
    .catch(() => {});
  for (const roleId of testerAndUpRoleIds(guild)) {
    await channel.permissionOverwrites.edit(roleId, { SendMessages: true }).catch(() => {});
  }
}

// @everyone only actually pings when it's in a message's plain content, not
// inside an embed, so this is sent as a normal message rather than an
// embed. commandsChannel is a Channel object (or null, if #commands
// somehow isn't around) — mentioned so players know where to chat instead.
function buildWaitingListMessage(gamemodeDisplay, commandsChannel) {
  const commandsMention = commandsChannel ? `<#${commandsChannel.id}>` : "#commands";
  return `@everyone
**__${gamemodeDisplay} Tier Test__**

Being in the waitlist simply means that you are waiting to be tested at some point, it does not mean you are immediately going to be tested right away. Please be patient!

The queue is what you join once you are ready to actually test. When a tester for this region becomes available, the queue card here will update with a **Join Queue** button. This is meant for players readily available to log on for their evaluation test.

If no testers are available, the queue card here will show **No Testers Online** with no join button at all. You'll be pinged here the moment a tester opens it back up.

After a tester has marked themselves as unavailable with no other testers active, the queue will be closed. If you were in the queue, your queue position will not be saved. You can still enter the queue again like normal whenever a tester becomes available.

This channel is read-only — use the buttons on the queue card to join/leave, and chat in ${commandsMention} instead.`;
}

function buildVerifyInfoEmbed() {
  return new EmbedBuilder()
    .setTitle("Link your account to RyftTiers")
    .setDescription(
      "Verification is done entirely on the website — no bot commands needed.\n\n" +
        "**1. Log into the website**\nOpen the RyftTiers website and click **Login with Discord** in the top-right corner.\n\n" +
        "**2. Link your Minecraft username**\nHead to the **Verify** tab and enter your IGN and platform (Bedrock/Premium/Cracked). This tells us which Minecraft account is yours so testers can see it and your tier shows up correctly on the leaderboard.\n\n" +
        "Once both steps are done, you can join a tiertest queue from Discord **or** the website — they're the same queue."
    )
    .setColor(0x3fa0f5);
}

// General tier-testing rubric/rules, modeled on the common MCTiers-style
// conventions (10-tier scale split into High/Low bands, result based on
// the single best performance, retest cooldown). Edit this to taste or
// paste in your own exact wording — it's only posted automatically the
// first time #testing-rubric is created.
function buildTestingRubricEmbed() {
  return new EmbedBuilder()
    .setTitle("Tier Testing Rubric")
    .setColor(0x3fa0f5)
    .setDescription(
      "Every gamemode uses the same 10-tier scale, from best to worst:\n" +
        "**HT1, LT1, HT2, LT2, HT3, LT3, HT4, LT4, HT5, LT5**\n\n" +
        "`HT` = High Tier, `LT` = Low Tier. Landing in the High band of a tier means you're a clear, consistent threat at that level; Low means you can hang in that tier but aren't dominant there.\n\n" +
        "**How a test works**\n" +
        "• Join the queue for the gamemode you want tested and wait for a tester to pull you into a private ticket.\n" +
        "• You'll play a set against the tester (or a proxy at the tester's discretion). Your tier is based on your **best performance shown**, not an average — one great game can outweigh a few rough ones.\n" +
        "• The tester judges on mechanics (combo/hit consistency, movement, aim), decision-making (when to engage/disengage, resource/potion usage), and overall game sense versus the standard expected at each tier.\n" +
        "• The tester submits your result and a tier role is assigned automatically. You can see your tier on the website leaderboard.\n\n" +
        `**Retesting**\nAfter a result, you're on a ${COOLDOWN_DAYS}-day cooldown before you can queue again for that same gamemode, so testers aren't re-testing the same players back-to-back. Staff can lift this early for a good reason — ask in a ticket.\n\n` +
        "**Conduct**\nBe respectful to your tester and anyone else in the ticket. Stream-sniping, cheating, smurfing to dodge a known result, or being abusive toward staff will get your test cancelled and can lead to a ban from testing entirely."
    );
}

// Rules/conduct side of testing — separate from the rubric (how tiers are
// judged). Edit to taste; posted automatically the first time
// #ranked-ruleset is created.
function buildTestingRulesetEmbed() {
  return new EmbedBuilder()
    .setTitle("Ranked Testing Ruleset")
    .setColor(0x3fa0f5)
    .setDescription(
      "**Before you queue**\n" +
        "• You must be verified (website's **Verify** tab) before you can join any queue.\n" +
        `• You're on a ${COOLDOWN_DAYS}-day cooldown after each result for that gamemode — you can't be retested sooner unless staff lifts it.\n` +
        "• Only queue in the region you'll actually be able to play on. Testers match you to testers in your set region.\n\n" +
        "**During a test**\n" +
        "• Be on time once pulled into a ticket — testers can cancel a no-show after a few minutes.\n" +
        "• No alternate accounts, stream-sniping, or outside help during the test.\n" +
        "• Play your honest best. Sandbagging to get an easier tier, or smurfing to avoid a known result, voids the test.\n" +
        "• Listen to the tester's calls — if you disagree, raise it respectfully after the test or open a ticket, not mid-game.\n\n" +
        "**After a test**\n" +
        "• Your tier is posted automatically once the tester submits a result.\n" +
        "• Think a result was wrong? Open an **Appeal a tier** ticket with your reasoning.\n\n" +
        "Breaking these rules can get a test voided, cancel your current cooldown exemption, or lead to a testing ban — see #punishments."
    );
}

// Punishment/escalation reference for testing-rule violations. Edit to
// taste; posted automatically the first time #punishments is created.
function buildPunishmentsEmbed() {
  return new EmbedBuilder()
    .setTitle("Testing Punishments")
    .setColor(0xe05a5a)
    .setDescription(
      "Violations of #ranked-ruleset are handled case by case by staff, but as a general guide:\n\n" +
        "**Minor** _(being disrespectful to a tester, wasting a tester's time, minor sandbagging)_\n" +
        "→ Warning, and the test may be voided.\n\n" +
        "**Major** _(cheating, using an alt to dodge a result, stream-sniping)_\n" +
        "→ Test voided, temporary testing ban (duration at staff discretion).\n\n" +
        "**Severe** _(repeat offenses, abusive behavior toward staff/testers)_\n" +
        "→ Permanent testing ban, possible server ban.\n\n" +
        "Disagree with a punishment? Open an **Appeal a tier** or **Help** ticket and explain your case."
    );
}

// ---------- requests: queue picker, open-a-ticket, tester application ----------

function buildRequestTestEmbed() {
  return new EmbedBuilder()
    .setAuthor({ name: "RyftTiers", iconURL: client.user ? client.user.displayAvatarURL() : undefined })
    .setTitle("Request a Tier Test")
    .setColor(0xffd54a)
    .setDescription(
      "Pick a gamemode below and I'll point you to its queue channel. You'll join the actual queue from there — this is just the signpost.\n\n" +
        "Make sure you've verified first (website **Verify** tab) — you can't join a queue until you have."
    );
}

function buildRequestTestSelect() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("request_test_gamemode")
      .setPlaceholder("Choose a gamemode...")
      .addOptions(
        Object.entries(GAMEMODE_CHANNELS).map(([channelName, gamemode]) => ({
          label: GAMEMODE_PING_ROLE_NAMES[gamemode] || gamemode,
          value: channelName,
        }))
      )
  );
}

function buildRequestSupportEmbed() {
  return new EmbedBuilder()
    .setAuthor({ name: "RyftTiers", iconURL: client.user ? client.user.displayAvatarURL() : undefined })
    .setTitle("Support Tickets")
    .setColor(0x3fa0f5)
    .setDescription(
      "Need help, want to report a player, or appeal a tier? Click **Open Ticket** below.\n\n" +
        "You'll pick a category and fill in a couple of details — a private ticket channel gets created just for you and staff, and it's also mirrored on the website under **Support**."
    );
}

function buildOpenTicketButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("request_open_ticket").setLabel("Open Ticket").setStyle(ButtonStyle.Primary)
  );
}

function buildRequestHighTestEmbed() {
  return new EmbedBuilder()
    .setAuthor({ name: "RyftTiers", iconURL: client.user ? client.user.displayAvatarURL() : undefined })
    .setTitle("Request a High Tier Test")
    .setColor(0xff8c3f)
    .setDescription(
      "Already **LT3 or better**? Click **Request High Test** below to open a ticket — staff will set up your test from there.\n\n" +
        "Make sure you've verified first (website **Verify** tab)."
    );
}

function buildRequestHighTestButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ticket_cat_hightest").setLabel("Request High Test").setStyle(ButtonStyle.Primary)
  );
}

function buildTicketCategoryButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ticket_cat_help").setLabel("Help").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ticket_cat_report").setLabel("Report a player").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ticket_cat_appeal").setLabel("Appeal a tier").setStyle(ButtonStyle.Secondary)
  );
}

const TICKET_CATEGORY_LABELS = {
  help: "Help",
  report: "Report a player",
  appeal: "Appeal a tier",
  hightest: "High Tier Test Request",
};

function buildTicketModal(category) {
  const label = TICKET_CATEGORY_LABELS[category];
  const isHighTest = category === "hightest";

  const subjectInput = new TextInputBuilder()
    .setCustomId("subject")
    .setLabel(isHighTest ? "Which gamemode?" : "Short summary")
    .setStyle(TextInputStyle.Short)
    .setMaxLength(100)
    .setRequired(true);
  if (isHighTest) subjectInput.setPlaceholder("e.g. UHC");

  const detailsInput = new TextInputBuilder()
    .setCustomId("details")
    .setLabel(isHighTest ? "Your IGN and current tier" : "Explain what's going on")
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(1000)
    .setRequired(true);

  return new ModalBuilder()
    .setCustomId(`ticket_modal_${category}`)
    .setTitle(`New Ticket — ${label}`)
    .addComponents(
      new ActionRowBuilder().addComponents(subjectInput),
      new ActionRowBuilder().addComponents(detailsInput)
    );
}

function buildTesterApplicationEmbed() {
  return new EmbedBuilder()
    .setAuthor({ name: "RyftTiers", iconURL: client.user ? client.user.displayAvatarURL() : undefined })
    .setTitle("Apply to Become a Tester")
    .setColor(0x6cc3ff)
    .setDescription(
      "Testers run tier tests and keep the queues moving — if you're experienced, reliable, and know the rubric, click **Apply** below.\n\n" +
        "You'll be asked for your IGN, region, your testing/PvP experience, and your availability. Staff reviews every application — you'll be DM'd either way.\n\n" +
        "**Please provide authentic information.** A dishonest application will be denied."
    );
}

function buildApplyButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("tester_apply").setLabel("Apply").setStyle(ButtonStyle.Success)
  );
}

function buildTesterApplicationModal() {
  return new ModalBuilder()
    .setCustomId("tester_apply_modal")
    .setTitle("Tester Application")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("ign").setLabel("Minecraft IGN").setStyle(TextInputStyle.Short).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("region").setLabel("Region (NA/EU/AS/ME/AU)").setStyle(TextInputStyle.Short).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("experience")
          .setLabel("Your PvP/testing experience")
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(1000)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("availability")
          .setLabel("Availability (days/times, timezone)")
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(500)
          .setRequired(true)
      )
    );
}

function buildApplicationReviewEmbed(app, statusLine = "") {
  return new EmbedBuilder()
    .setTitle("Tester Application")
    .setColor(statusLine ? (statusLine.includes("Accepted") ? 0x4ade80 : 0xe05a5a) : 0x6cc3ff)
    .setDescription(
      `**Applicant:** <@${app.discord_id}>\n` +
        `**IGN:** ${app.ign}\n` +
        `**Region:** ${app.region}\n\n` +
        `**Experience**\n${app.experience}\n\n` +
        `**Availability**\n${app.availability}` +
        statusLine
    );
}

const APP_REVIEW_CHANNEL_ID = "1555554767210811442";

function buildApplicationReviewButtons(type, applicationId) {
  // type: "tester" | "staff"
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`app_accept_${type}_${applicationId}`).setLabel("Accept").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`app_deny_${type}_${applicationId}`).setLabel("Deny + Notes").setStyle(ButtonStyle.Danger)
  );
}

// Managers/admins only — granting the Tester role is a bigger call than
// the tester/manager-or-up checks used elsewhere (canManageCooldowns).
function canReviewApplications(member) {
  return (
    member.roles.cache.some((r) => managerRoleNames.includes(r.name.toLowerCase())) ||
    member.permissions.has(PermissionsBitField.Flags.Administrator) ||
    member.permissions.has(PermissionsBitField.Flags.ManageGuild)
  );
}

// ---------- website role sync ----------
// Keeps each player's `profiles` row in Supabase in sync with their Discord
// roles, so the website knows who's a tester/senior tester/manager/
// moderator/owner. Runs on startup, on every role change, and on a timer as
// a safety net for people who log into the website after roles were synced.

function computeRoleFlags(member) {
  const has = (roleId) => member.roles.cache.has(roleId);
  const isSeniorTester = has(PERMISSION_ROLE_IDS.seniorTester);
  return {
    isTester: isSeniorTester || has(PERMISSION_ROLE_IDS.tester),
    isSeniorTester,
    isManager: has(PERMISSION_ROLE_IDS.manager),
    isModerator: has(PERMISSION_ROLE_IDS.moderator),
    isOwner: has(PERMISSION_ROLE_IDS.owner),
  };
}

async function syncMemberRoles(member) {
  if (!member || member.user?.bot) return;
  try {
    await syncProfileRoles(member.id, computeRoleFlags(member));
  } catch (err) {
    console.error(`[roles] failed to sync ${member.id}:`, err.message);
  }
}

async function syncAllGuildMemberRoles(guild) {
  const members = await guild.members.fetch();
  for (const member of members.values()) {
    await syncMemberRoles(member);
  }
}

// A player must already be tiered LT3 or better (index <= this) in the
// gamemode to join its high queue. Untested players, or anyone HT4 or
// worse, can't join.
const HIGH_QUEUE_MAX_INDEX = TIER_OPTIONS.indexOf("LT3");

// Finds the configured role for a gamemode by ID and returns a pingable
// mention string, or empty string if not configured/found.
function getRolePing(guild, gamemode) {
  const roleName = GAMEMODE_PING_ROLE_NAMES[gamemode];
  if (!roleName) return "";
  const role = guild.roles.cache.find((r) => r.name.toLowerCase() === roleName.toLowerCase());
  return role ? `<@&${role.id}> ` : "";
}

// queueKey is "<gamemode>:<region>" for a normal queue (e.g. "vanilla:NA"),
// or "<gamemode>:<region>:high" for that region's high queue. These are the
// same Supabase tables the website's Testing tab reads/writes, so a queue
// joined here shows up there too (and vice versa). The region is baked into
// the key itself (derived from the channel's own name) rather than stored
// as mutable state — every tiertest channel pins exactly one region.
function regionFromQueueKey(queueKey) {
  return queueKey.split(":")[1];
}

async function activeTestersBlock(queueKey) {
  const testers = await getQueueTesterIds(queueKey);
  const active = getActiveTesting(queueKey);

  let block = "";
  if (active) {
    block += `**Testing:** <@${active.testeeId}>\n`;
  }
  if (testers.length > 0) {
    block += `**Active Testers:**\n${testers.map((id, i) => `${i + 1}. <@${id}>`).join("\n")}\n`;
  }
  return block ? block + "\n" : "";
}

// Discord timestamp markup, e.g. "<t:1700000000:F> (<t:1700000000:R>)" ->
// renders as a full date/time plus a "3 hours ago"-style relative label,
// both in the viewer's own timezone automatically.
function discordTimestamp(isoString) {
  if (!isoString) return null;
  const unix = Math.floor(new Date(isoString).getTime() / 1000);
  return `<t:${unix}:F> (<t:${unix}:R>)`;
}

// Same idea but without the relative "(3 hours ago)" suffix — just a clean
// absolute date/time, for the closed-queue card.
function absoluteTimestamp(isoString) {
  if (!isoString) return null;
  const unix = Math.floor(new Date(isoString).getTime() / 1000);
  return `<t:${unix}:F>`;
}

// Branded little header used on both queue embeds, closed or open.
function queueAuthor(gamemode, region) {
  const display = GAMEMODE_PING_ROLE_NAMES[gamemode] || gamemode.toUpperCase();
  return {
    name: `RyftTiers — ${display} Tier Test${region ? ` (${region})` : ""}`,
    iconURL: client.user ? client.user.displayAvatarURL() : undefined,
  };
}

// "No Testers Online" card shown in place of the queue list while closed —
// styled after MCTiers' closed-queue embed: a branded header, a bold
// heading, a short friendly explanation, and a clean last-session date.
async function closedCardDescription(queueKey) {
  const lastOpenedAt = await getQueueLastOpenedAt(queueKey);
  const ts = absoluteTimestamp(lastOpenedAt);
  return (
    "**No Testers Online**\n" +
    "No testers are available for this gamemode right now. You'll be pinged here the moment a tester opens the queue — check back later!\n\n" +
    `**Last testing session:** ${ts || "Hasn't been opened yet."}`
  );
}

async function buildQueueEmbed(queueKey, gamemode) {
  const region = regionFromQueueKey(queueKey);
  const [closed, locked, count, testersBlock, queueText] = await Promise.all([
    isQueueClosed(queueKey),
    getQueueLocked(queueKey),
    getQueueCount(queueKey),
    activeTestersBlock(queueKey),
    formatQueue(queueKey),
  ]);
  const embed = new EmbedBuilder()
    .setAuthor(queueAuthor(gamemode, region))
    .setColor(closed ? 0x555555 : locked ? 0xff8a3d : 0xffd54a);
  if (closed) {
    return embed.setDescription(await closedCardDescription(queueKey));
  }
  return embed
    .setTitle(`${gamemode.toUpperCase()} ${region} Queue (${count})${locked ? " — LOCKED" : ""}`)
    .setDescription(
      (locked ? "_Locked — not accepting new joins right now._\n\n" : "") + testersBlock + queueText
    );
}

async function buildHighQueueEmbed(highKey, gamemode) {
  const region = regionFromQueueKey(highKey);
  const [closed, locked, count, testersBlock, queueText] = await Promise.all([
    isQueueClosed(highKey),
    getQueueLocked(highKey),
    getQueueCount(highKey),
    activeTestersBlock(highKey),
    formatQueue(highKey),
  ]);
  const embed = new EmbedBuilder()
    .setAuthor(queueAuthor(gamemode, region))
    .setColor(closed ? 0x555555 : locked ? 0xff8a3d : 0xff8a3d);
  if (closed) {
    return embed.setDescription(await closedCardDescription(highKey));
  }
  return embed
    .setTitle(`${gamemode.toUpperCase()} ${region} HIGH Queue (${count})${locked ? " — LOCKED" : ""}`)
    .setDescription(
      (locked ? "_Locked — not accepting new joins right now._\n\n" : "") +
        testersBlock +
        `Only players already tiered **LT3 or better** in ${gamemode.toUpperCase()} can join.\n\n${queueText}`
    );
}

// Main queue message. Closed: a single "Open Queue" button (testers only).
// Open: Join/Leave on one row, Next/Lock/Close (testers only) on another.
// Returns an array of action rows, ready to pass straight as `components`.
async function buildQueueButtons(queueKey) {
  const closed = await isQueueClosed(queueKey);
  if (closed) {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("queue_open").setLabel("Open Queue").setStyle(ButtonStyle.Success)
      ),
    ];
  }
  const locked = await getQueueLocked(queueKey);
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("queue_join")
        .setLabel("Join Queue")
        .setStyle(ButtonStyle.Success)
        .setDisabled(locked),
      new ButtonBuilder().setCustomId("queue_leave").setLabel("Leave Queue").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("queue_next").setLabel("Next/Pull (Tester Only)").setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("queue_toggle_lock")
        .setLabel(locked ? "Unlock Queue" : "Lock Queue")
        .setStyle(locked ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("queue_close").setLabel("Close Queue").setStyle(ButtonStyle.Danger)
    ),
  ];
}

async function buildHighQueueButtons(highKey) {
  const closed = await isQueueClosed(highKey);
  if (closed) {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("highqueue_open").setLabel("Open Queue").setStyle(ButtonStyle.Success)
      ),
    ];
  }
  const locked = await getQueueLocked(highKey);
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("highqueue_join")
        .setLabel("Join High Queue")
        .setStyle(ButtonStyle.Success)
        .setDisabled(locked),
      new ButtonBuilder().setCustomId("highqueue_leave").setLabel("Leave Queue").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("highqueue_next").setLabel("Next/Pull (Tester Only)").setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("highqueue_toggle_lock")
        .setLabel(locked ? "Unlock Queue" : "Lock Queue")
        .setStyle(locked ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("highqueue_close").setLabel("Close Queue").setStyle(ButtonStyle.Danger)
    ),
  ];
}

function buildTicketButtons(gamemode, testeeId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ticket_submit_${gamemode}_${testeeId}`)
      .setLabel("Submit Result")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("ticket_close")
      .setLabel("Close Without Saving")
      .setStyle(ButtonStyle.Secondary)
  );
}

async function refreshQueueMessage(interaction, queueKey, gamemode) {
  await interaction.message.edit({
    embeds: [await buildQueueEmbed(queueKey, gamemode)],
    components: await buildQueueButtons(queueKey),
  });
}

async function refreshHighQueueMessage(interaction, highKey, gamemode) {
  await interaction.message.edit({
    embeds: [await buildHighQueueEmbed(highKey, gamemode)],
    components: await buildHighQueueButtons(highKey),
  });
}

// Keys the bot recently wrote to queue_closed itself (open/close from
// Discord). Suppresses the realtime echo for 2 s so the bot doesn't
// re-post the card a second time via onQueueStateChange.
const realtimeSuppressUntil = new Map();

function suppressRealtimeFor(queueKey, ms = 2000) {
  realtimeSuppressUntil.set(queueKey, Date.now() + ms);
}

function isRealtimeSuppressed(queueKey) {
  const until = realtimeSuppressUntil.get(queueKey);
  if (!until) return false;
  if (Date.now() < until) return true;
  realtimeSuppressUntil.delete(queueKey);
  return false;
}

// Deletes whatever message is currently tracked for this queue (if any) and
// posts a brand-new one reflecting its current state, instead of editing in
// place. Used for the open <-> closed transition so the card resurfaces at
// the bottom of the channel and can carry a ping as part of the same
// message (rather than a separate ping message). `content` is the optional
// text (role ping, etc.) sent alongside the embed.
async function postFreshQueueMessage(channel, queueKey, gamemode, { isHigh = false, content = "" } = {}) {
  const info = getQueueMessage(queueKey);
  if (info) {
    try {
      const oldChannel = await channel.guild.channels.fetch(info.channelId).catch(() => null);
      const oldMessage = oldChannel ? await oldChannel.messages.fetch(info.messageId).catch(() => null) : null;
      if (oldMessage) await oldMessage.delete().catch(() => {});
    } catch (err) {
      console.error("[postFreshQueueMessage] couldn't delete old message:", err.message);
    }
  }
  const embed = isHigh ? await buildHighQueueEmbed(queueKey, gamemode) : await buildQueueEmbed(queueKey, gamemode);
  const components = isHigh ? await buildHighQueueButtons(queueKey) : await buildQueueButtons(queueKey);
  const newMessage = await channel.send({
    content: content || undefined,
    embeds: [embed],
    components,
  });
  await setQueueMessage(queueKey, channel.id, newMessage.id);
  return newMessage;
}

// Called when a ticket closes (result submitted or cancelled). Clears the
// "currently testing" state and refreshes the original queue message so it
// stops showing this session. Returns the removed info (or null) in case
// the caller needs it, e.g. to log a completed result.
async function clearActiveTestingAndRefresh(guild, ticketChannelId) {
  const info = clearActiveTestingByTicket(ticketChannelId);
  await clearLiveTest(ticketChannelId);
  if (!info) return null;
  try {
    const queueChannel = await guild.channels.fetch(info.queueChannelId);
    const queueMessage = await queueChannel.messages.fetch(info.queueMessageId);
    if (info.isHigh) {
      const highKey = `${info.gamemode}:high`;
      await queueMessage.edit({
        embeds: [await buildHighQueueEmbed(highKey, info.gamemode)],
        components: await buildHighQueueButtons(highKey),
      });
    } else {
      await queueMessage.edit({
        embeds: [await buildQueueEmbed(info.gamemode, info.gamemode)],
        components: await buildQueueButtons(info.gamemode),
      });
    }
  } catch (err) {
    console.error("Couldn't refresh queue message after ticket closed:", err.message);
  }
  return info;
}

// Sanitizes a name into something valid for a Discord channel name.
function slugify(str) {
  return (
    str
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "player"
  );
}

// For the website's live/recent test displays: prefer the verified
// Minecraft username (so mc-heads.net shows a real head), falling back to
// their Discord username if they haven't run /verify.
async function resolveDisplayName(guild, discordUserId) {
  const verified = await getVerifiedUsername(discordUserId);
  if (verified) return verified;
  const member = await guild.members.fetch(discordUserId).catch(() => null);
  return member ? member.user.username : discordUserId;
}

// Creates a private channel visible only to the claiming tester(s) with the
// Tester role, the testee, and the tester who claimed them. Server owners
// and anyone with Administrator automatically bypass overwrites, so they
// always have access without needing an explicit entry.
async function createTicketChannel(guild, sourceChannel, gamemode, testerMember, testeeId, { isHigh = false } = {}) {
  const testeeMember = await guild.members.fetch(testeeId).catch(() => null);
  const testerRoles = getTesterRoles(guild);

  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionsBitField.Flags.ViewChannel],
    },
    {
      id: testerMember.id,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
      ],
    },
    ...testerRoles.map((role) => ({
      id: role.id,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
      ],
    })),
  ];

  if (testeeMember) {
    overwrites.push({
      id: testeeMember.id,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
      ],
    });
  }

  // High queue tickets go in their own "High Tests" category — find it or create it.
  let parentId = sourceChannel.parentId || null;
  if (isHigh) {
    const HIGH_TESTS_CATEGORY = "High Tests";
    let highCat = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name === HIGH_TESTS_CATEGORY
    );
    if (!highCat) {
      highCat = await guild.channels.create({
        name: HIGH_TESTS_CATEGORY,
        type: ChannelType.GuildCategory,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
          ...testerRoles.map((role) => ({
            id: role.id,
            allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory],
          })),
        ],
      });
    }
    parentId = highCat.id;
  }

  const channel = await guild.channels.create({
    name: `ticket-${gamemode}-${slugify(testeeMember ? testeeMember.user.username : testeeId)}`,
    type: ChannelType.GuildText,
    parent: parentId,
    permissionOverwrites: overwrites,
  });

  const testeeUsername = await getVerifiedUsername(testeeId);
  const testeePlatform = await getVerifiedPlatform(testeeId);
  const testeeRecord = testeeUsername ? await getPlayer(testeeUsername) : null;
  const platformLabel = { bedrock: "Bedrock", premium: "Premium", cracked: "Cracked" }[testeePlatform] || "Unknown";
  const testeeInfoLine = testeeUsername
    ? `**IGN:** ${testeeUsername} (${platformLabel})\n**Region:** ${testeeRecord?.region || "Unverified/new"}\n`
    : `**IGN:** Not verified — ask them to verify on the website\n`;

  await channel.send({
    content: `<@${testeeId}> <@${testerMember.id}>`,
    embeds: [
      new EmbedBuilder()
        .setTitle(`${gamemode.toUpperCase()} test in progress`)
        .setDescription(
          `Tester: <@${testerMember.id}>\nTestee: <@${testeeId}>\n${testeeInfoLine}\nWhen the test is done, click **Submit Result** to save the tier and close this ticket. Only testers and the testee can see this channel.\n\n_This ticket closes automatically after 2 hours if left open._`
        )
        .setColor(0xffd54a),
    ],
    components: [buildTicketButtons(gamemode, testeeId)],
  });

  // Safety net: auto-close after 2 hours if nobody submitted a result or
  // manually closed it. Checks the channel still exists first, so this is
  // a harmless no-op if the ticket was already closed normally.
  setTimeout(async () => {
    try {
      const stillExists = await guild.channels.fetch(channel.id).catch(() => null);
      if (!stillExists) return;
      await channel
        .send({ content: "This ticket has been open for 2 hours with no result submitted — closing it automatically." })
        .catch(() => {});
      await clearActiveTestingAndRefresh(guild, channel.id);
      await channel.delete().catch((err) => console.error("Failed to auto-delete stale ticket:", err.message));
    } catch (err) {
      console.error("Error during ticket auto-close:", err.message);
    }
  }, 2 * 60 * 60 * 1000);

  return channel;
}

// Discord caps a single message at 2000 characters — /setupqueues and
// /resetqueues now cover up to 45 channels (9 gamemodes × 5 regions) and
// can easily produce a longer report than that. Splits on line breaks so a
// single entry is never cut mid-sentence, sending the first chunk as the
// reply and the rest as ephemeral follow-ups.
async function replyChunked(interaction, text, { isFollowUp = false } = {}) {
  const lines = (text || "Nothing to report.").split("\n");
  const chunks = [];
  let current = "";
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > 1900 && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  if (chunks.length === 0) chunks.push("Nothing to report.");

  for (let i = 0; i < chunks.length; i++) {
    if (i === 0 && !isFollowUp) {
      await interaction.editReply({ content: chunks[i] });
    } else {
      await interaction.followUp({ content: chunks[i], ephemeral: true });
    }
  }
}

// ---------- high-results helpers ----------

const HIGH_RESULTS_CHANNEL_ID = "1555554734880985102";

// Tiers ordered best→worst. "Higher than LT3" means index < index of LT3.
const TIER_ORDER = ["HT1", "LT1", "HT2", "LT2", "HT3", "LT3", "HT4", "LT4", "HT5", "LT5"];
function isHighTier(tier) {
  const idx = TIER_ORDER.indexOf(tier);
  const lt3Idx = TIER_ORDER.indexOf("LT3");
  return idx !== -1 && idx < lt3Idx; // HT1/LT1/HT2/LT2/HT3
}

// Builds a fight-results section string for the high-results embed.
// fightResultsRaw: multi-line string like "Won 4-3 vs. PlayerA\nLost 1-4 vs. PlayerB"
// Returns an array of { heading, lines } groups based on detected tier prefixes,
// or a flat list if no tier grouping is found.
function parseFightSections(fightResultsRaw) {
  if (!fightResultsRaw) return [];
  const lines = fightResultsRaw.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines;
}

// Posts a result to the high-results channel.
async function postHighResult(guild, { username, discordId, gamemode, previousTier, tier, region, fightResultsRaw, testerTag, isManual }) {
  const channel = await guild.channels.fetch(HIGH_RESULTS_CHANNEL_ID).catch(() => null);
  if (!channel) return;

  const passed = isHighTier(tier);
  const changeText = previousTier ? `${previousTier} → ${tier}` : `Untested → ${tier}`;
  const status = passed ? `Promoted to **${tier}**` : `Failed **${tier}**`;
  const statusVerb = passed ? "✅ Passed" : "❌ Failed";

  // Header line (plain message above embed, matching the format in the screenshot)
  const playerMention = discordId ? `<@${discordId}>` : `**${username}**`;
  const headerLine = `${playerMention} **| ${gamemode.toUpperCase()} - ${statusVerb} ${tier}**${isManual ? " *(manual)*" : ""}`;

  // Build embed description
  let desc = `**Player:** ${username}\n**Region:** ${region}\n**Result:** ${changeText}\n`;
  if (testerTag) desc += `**Tested by:** ${testerTag}\n`;

  const fightLines = parseFightSections(fightResultsRaw);
  if (fightLines.length > 0) {
    desc += `\n**Fights:**\n${fightLines.map((l) => `> ${l}`).join("\n")}`;
  }

  const color = passed ? 0x4ade80 : 0xf87171;

  await channel.send({
    content: headerLine,
    embeds: [
      new EmbedBuilder()
        .setDescription(desc)
        .setColor(color)
        .setTimestamp(),
    ],
  });
}

// ---------- interactions ----------

client.on("interactionCreate", async (interaction) => {
 try {

  // /sendrules — posts the server rules embed in the current channel
  if (interaction.isChatInputCommand() && interaction.commandName === "sendrules") {
    if (!canManageCooldowns(interaction.member)) {
      return interaction.reply({ content: "Only staff can use this command.", ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    const rulesEmbed = new EmbedBuilder()
      .setTitle("⟡ RYFTTIERS")
      .setDescription(
        "# ᴛɪᴇʀʟɪsᴛ • ᴊᴀᴠᴀ • ʙᴇᴅʀᴏᴄᴋ • ᴄʀᴀᴄᴋᴇᴅ\n\n" +
        "**«01 ┃ RESPECT»**\nNo harassment • racism • NSFW • toxicity\n\n" +
        "**«02 ┃ TESTING»**\nNo cheating • autoclickers • scripts\nDon't interfere with tests\n\n" +
        "**«03 ┃ RESULTS»**\nNo fake tiers • impersonation • result manipulation\n\n" +
        "**«04 ┃ TESTERS»**\nStay fair and unbiased\nNo boosting or lowering players\n\n" +
        "**«05 ┃ CHAT»**\nNo spam • advertising • unnecessary pings\n\n" +
        "**«06 ┃ STAFF»**\nFollow staff instructions\nAppeals go through the proper system\n\n" +
        "━━━━━━━━━━━━━━━━━━━━\n\n" +
        "-# ⚔️ PLAY FAIR • EARN YOUR TIER ⚔️"
      )
      .setColor(0x2f7fd6);
    await interaction.channel.send({ embeds: [rulesEmbed] });
    return interaction.editReply({ content: "Rules posted!" });
  }

  // /poststaffapp — posts a staff application form embed with an Apply button
  if (interaction.isChatInputCommand() && interaction.commandName === "poststaffapp") {
    if (!canManageCooldowns(interaction.member)) {
      return interaction.reply({ content: "Only staff can use this command.", ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });

    const STAFF_APP_CHANNEL_ID = "1555835615700852766";
    const staffAppChannel = await interaction.guild.channels.fetch(STAFF_APP_CHANNEL_ID).catch(() => null);
    if (!staffAppChannel) {
      return interaction.editReply({ content: "Couldn't find the staff application channel." });
    }

    const staffAppEmbed = new EmbedBuilder()
      .setTitle("Apply to Join the Staff Team")
      .setColor(0x2f7fd6)
      .setDescription(
        "Staff members help keep RyftTiers fair and running smoothly — moderating the server, overseeing tests, and making sure the tier system stays clean. If you're active, trustworthy, and know the server well, click **Apply** below.\n\n" +
        "You'll be asked for your IGN, region, why you want to be staff, any previous moderation experience, and your availability. Staff reviews every application — you'll be contacted either way.\n\n" +
        "**Please be honest.** A dishonest application will be denied."
      );

    const applyButton = new ButtonBuilder()
      .setCustomId("staff_apply")
      .setLabel("Apply")
      .setStyle(ButtonStyle.Primary);

    await staffAppChannel.send({
      embeds: [staffAppEmbed],
      components: [new ActionRowBuilder().addComponents(applyButton)],
    });

    return interaction.editReply({ content: "Staff application posted!" });
  }

  // /posthighrubric — posts the high-tier testing rubric to the current channel
  if (interaction.isChatInputCommand() && interaction.commandName === "posthighrubric") {
    if (!canManageCooldowns(interaction.member)) {
      return interaction.reply({ content: "Only staff can use this command.", ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });

    const rubricEmbed = new EmbedBuilder()
      .setTitle("⟡ RYFTTIERS — High Tier Testing Rubric")
      .setColor(0x2f7fd6)
      .setDescription(
        "## <:HT1:1361861674780459141> Testing for HT1\n" +
        "- **Phase 1:** Beat two LT2 opponents\n" +
        "- **Phase 2:** Beat two HT2 opponents\n" +
        "- **Phase 3:** Beat two opponents in the same Tier as you\n" +
        "- **Phase 4:** Beat the HT1 Player. If successful, you will steal their title.\n\n" +

        "## <:LT1:1361861656912593077> Testing for LT1\n" +
        "- **Phase 1:** Beat two LT2 opponents\n" +
        "- **Phase 2:** Beat two opponents in the same Tier as you\n" +
        "- **Phase 3:** Achieve an equal or better overall score against 2 players in the Tier you are testing for. You must get a minimum of 3 rounds on each opponent.\n\n" +

        "## <:HT2:1361861639166755017> Testing for LT2/HT2\n" +
        "- **Phase 1:** Beat two opponents in the same Tier as you\n" +
        "- **Phase 2:** Achieve an equal or better overall score against 2 players in the Tier you are testing for. You must get a minimum of 3 rounds on each opponent.\n\n" +

        "## <:HT3:1361861590961356891> Testing for HT3\n" +
        "- **Phase 1:** If you beat an evaluation tester 3-1 or better, you will be guaranteed a chance to test for HT3. With any other score, the tester decides whether you may test for HT3 or not.\n" +
        "- **Phase 2:** You will be paired against a HT3 opponent, who you must beat in a First to 3 in order to receive HT3.\n\n" +

        "## ❓ Missing opponents?\n" +
        "- Replace each missing opponent with 2 lower tiered opponents.\n" +
        "- If you are missing an opponent from your region, you will fight cross-regionally with ping equalization.\n" +
        "- \"Equalized\" Ping must be within 20ms and within the same tick-range. A tick-range is 50ms, meaning a 99ms player vs. a 101ms player is not considered equalized.\n\n" +

        "## <:x_:1361861572846420038> Failed Tests\n" +
        "- Failing a Tier Test will result in a 30 day cooldown\n" +
        "- Failing a T2+ Tier Test to an opponent who ranks up within 10 days of your test in a condition that you might have otherwise passed will result in the test being re-opened.\n" +
        "  - For example, If you are testing for HT2 and lose 3-4 to a LT2 who passes HT2, your test will be re-opened counting them as a HT2 instead."
      );

    await interaction.channel.send({ embeds: [rubricEmbed] });
    return interaction.editReply({ content: "High tier rubric posted!" });
  }

  // /setupqueues — one-time setup: creates any missing tiertest channels
  // and posts a fresh queue message in every channel that doesn't already
  // have one tracked. Safe to re-run after adding a new gamemode to
  // GAMEMODE_CHANNELS — it only touches what's missing.
  if (interaction.isChatInputCommand() && interaction.commandName === "setupqueues") {
    if (!canManageCooldowns(interaction.member)) {
      return interaction.reply({ content: "Only testers, managers, or admins can do that.", ephemeral: true });
    }
    const botMember = interaction.guild.members.me;
    const missingPerms = [];
    if (!botMember.permissions.has(PermissionsBitField.Flags.ManageChannels)) missingPerms.push("Manage Channels");
    if (!botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) missingPerms.push("Manage Roles");
    if (!botMember.permissions.has(PermissionsBitField.Flags.MentionEveryone)) missingPerms.push("Mention @everyone, @here, and All Roles");
    if (missingPerms.length) {
      return interaction.reply({
        content: `I need the **${missingPerms.join("** and **")}** permission(s) to set this up. Grant them to my role and try again.`,
        ephemeral: true,
      });
    }

    await interaction.deferReply({ ephemeral: true });

    // Ping roles first — channels below ping them immediately once posted.
    const rolesCreated = [];
    for (const roleName of Object.values(GAMEMODE_PING_ROLE_NAMES)) {
      const exists = interaction.guild.roles.cache.find(
        (r) => r.name.toLowerCase() === roleName.toLowerCase()
      );
      if (!exists) {
        await interaction.guild.roles.create({ name: roleName, mentionable: true });
        rolesCreated.push(roleName);
      }
    }

    // Tier roles — one per (gamemode, tier) pair, e.g. "Crystal LT5",
    // "UHC HT4". submit_result / /settier assign these automatically from
    // then on (see assignTierRole in realtime-sync.js); this just makes
    // sure every role exists up front.
    let tierRolesCreatedCount = 0;
    for (const gamemode of GAMEMODES) {
      for (const tier of TIER_OPTIONS) {
        const name = tierRoleName(gamemode, tier);
        const exists = interaction.guild.roles.cache.find(
          (r) => r.name.toLowerCase() === name.toLowerCase()
        );
        if (!exists) {
          await interaction.guild.roles.create({ name, mentionable: false });
          tierRolesCreatedCount++;
        }
      }
    }

    // Basic server channels (announcements/chat/commands/verify) under one
    // shared "General" category. The verify-info embed is posted
    // automatically the moment #verify is actually created, not on every
    // re-run.
    let generalCategory = interaction.guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === GENERAL_CATEGORY_NAME.toLowerCase()
    );
    if (!generalCategory) {
      generalCategory = await interaction.guild.channels.create({
        name: GENERAL_CATEGORY_NAME,
        type: ChannelType.GuildCategory,
      });
    }

    const basicCreated = [];
    const basicChannelsByName = {};
    for (const spec of BASIC_CHANNELS) {
      let channel = interaction.guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildText && c.name === spec.name
      );
      let justCreated = false;
      if (!channel) {
        const overwrites = spec.announcementsOnly
          ? [{ id: interaction.guild.roles.everyone.id, deny: [PermissionsBitField.Flags.SendMessages] }]
          : [];
        channel = await interaction.guild.channels.create({
          name: spec.name,
          type: ChannelType.GuildText,
          parent: generalCategory.id,
          permissionOverwrites: overwrites,
        });
        basicCreated.push(spec.name);
        justCreated = true;
      } else if (channel.parentId !== generalCategory.id) {
        await channel.setParent(generalCategory.id, { lockPermissions: false }).catch(() => {});
      }
      basicChannelsByName[spec.name] = channel;

      if (spec.name === "verify" && justCreated) {
        await channel.send({ embeds: [buildVerifyInfoEmbed()] }).catch(() => {});
      }
    }
    const commandsChannel = basicChannelsByName.commands || null;

    // "Tierlist" category: reference channels (rubric, ruleset, punishments,
    // leaderboard, results) separate from the per-gamemode queue categories.
    // Migrates an existing "Testing" category from before this was renamed/
    // expanded, instead of leaving a stray duplicate behind.
    let tierlistCategory = interaction.guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === TIERLIST_CATEGORY_NAME.toLowerCase()
    );
    if (!tierlistCategory) {
      const oldCategory = interaction.guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === OLD_TESTING_CATEGORY_NAME.toLowerCase()
      );
      if (oldCategory) {
        tierlistCategory = await oldCategory.setName(TIERLIST_CATEGORY_NAME);
      } else {
        tierlistCategory = await interaction.guild.channels.create({
          name: TIERLIST_CATEGORY_NAME,
          type: ChannelType.GuildCategory,
        });
      }
    }
    const tierlistCreated = [];
    for (const spec of TIERLIST_CHANNELS) {
      let channel = interaction.guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildText && c.name === spec.name
      );
      let justCreated = false;
      if (!channel) {
        channel = await interaction.guild.channels.create({
          name: spec.name,
          type: ChannelType.GuildText,
          parent: tierlistCategory.id,
        });
        tierlistCreated.push(spec.name);
        justCreated = true;
      } else if (channel.parentId !== tierlistCategory.id) {
        await channel.setParent(tierlistCategory.id, { lockPermissions: false }).catch(() => {});
      }
      if (justCreated) {
        if (spec.name === "ranked-rubric") await channel.send({ embeds: [buildTestingRubricEmbed()] }).catch(() => {});
        if (spec.name === "ranked-ruleset") await channel.send({ embeds: [buildTestingRulesetEmbed()] }).catch(() => {});
        if (spec.name === "punishments") await channel.send({ embeds: [buildPunishmentsEmbed()] }).catch(() => {});
      }
    }

    // "Requests" category: public read-only entry points (queue picker,
    // open-a-ticket, tester application) — each posts its embed/button(s)
    // once, the first time that channel is created.
    let requestsCategory = interaction.guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === REQUESTS_CATEGORY_NAME.toLowerCase()
    );
    if (!requestsCategory) {
      requestsCategory = await interaction.guild.channels.create({
        name: REQUESTS_CATEGORY_NAME,
        type: ChannelType.GuildCategory,
      });
    }
    const requestsCreated = [];
    const requestChannelSpecs = [
      { name: REQUEST_TEST_CHANNEL_NAME, post: async (ch) => ch.send({ embeds: [buildRequestTestEmbed()], components: [buildRequestTestSelect()] }) },
      { name: REQUEST_HIGH_TEST_CHANNEL_NAME, post: async (ch) => ch.send({ embeds: [buildRequestHighTestEmbed()], components: [buildRequestHighTestButton()] }) },
      { name: REQUEST_SUPPORT_CHANNEL_NAME, post: async (ch) => ch.send({ embeds: [buildRequestSupportEmbed()], components: [buildOpenTicketButton()] }) },
      { name: TESTER_APPLICATION_CHANNEL_NAME, post: async (ch) => ch.send({ embeds: [buildTesterApplicationEmbed()], components: [buildApplyButton()] }) },
    ];
    for (const spec of requestChannelSpecs) {
      let channel = interaction.guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildText && c.name === spec.name
      );
      let justCreated = false;
      if (!channel) {
        channel = await interaction.guild.channels.create({
          name: spec.name,
          type: ChannelType.GuildText,
          parent: requestsCategory.id,
        });
        requestsCreated.push(spec.name);
        justCreated = true;
      } else if (channel.parentId !== requestsCategory.id) {
        await channel.setParent(requestsCategory.id, { lockPermissions: false }).catch(() => {});
      }
      // Read-only, same as tiertest channels — interact via the posted
      // button/select menu, not by typing.
      await lockChannelToTesters(interaction.guild, channel);
      if (justCreated) await spec.post(channel).catch(() => {});
    }

    // "Staff" category: private review channel for tester applications.
    let staffCategory = interaction.guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === STAFF_CATEGORY_NAME.toLowerCase()
    );
    if (!staffCategory) {
      const overwrites = [{ id: interaction.guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] }];
      for (const roleId of [PERMISSION_ROLE_IDS.manager, PERMISSION_ROLE_IDS.moderator, PERMISSION_ROLE_IDS.owner]) {
        if (roleId) overwrites.push({ id: roleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] });
      }
      staffCategory = await interaction.guild.channels.create({
        name: STAFF_CATEGORY_NAME,
        type: ChannelType.GuildCategory,
        permissionOverwrites: overwrites,
      });
    }
    let reviewChannel = interaction.guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildText && c.name === TESTER_APP_REVIEW_CHANNEL_NAME
    );
    if (!reviewChannel) {
      reviewChannel = await interaction.guild.channels.create({
        name: TESTER_APP_REVIEW_CHANNEL_NAME,
        type: ChannelType.GuildText,
        parent: staffCategory.id,
      });
      requestsCreated.push(TESTER_APP_REVIEW_CHANNEL_NAME);
    } else if (reviewChannel.parentId !== staffCategory.id) {
      await reviewChannel.setParent(staffCategory.id, { lockPermissions: false }).catch(() => {});
    }

    // Delete Discord's default starter channels — replaced by the above.
    const deleted = [];
    for (const target of DEFAULT_CHANNELS_TO_REMOVE) {
      const wantType = target.type === "voice" ? ChannelType.GuildVoice : ChannelType.GuildText;
      const defaultChannel = interaction.guild.channels.cache.find(
        (c) => c.type === wantType && c.name.toLowerCase() === target.name.toLowerCase()
      );
      if (defaultChannel && defaultChannel.id === interaction.channelId) {
        deleted.push(`#${target.name} (${target.type}) — skipped, that's this channel; delete it manually`);
      } else if (defaultChannel) {
        await defaultChannel.delete().catch(() => {});
        deleted.push(`#${target.name} (${target.type})`);
      }
    }

    const created = [];
    const categoriesCreated = [];
    const posted = [];
    const skipped = [];

    const migratedAway = [];
    for (const gamemode of GAMEMODES) {
      const categoryName = queueCategoryName(gamemode);
      let category = interaction.guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === categoryName.toLowerCase()
      );
      if (!category) {
        category = await interaction.guild.channels.create({
          name: categoryName,
          type: ChannelType.GuildCategory,
        });
        categoriesCreated.push(categoryName);
      }

      // Clean up a leftover pre-region channel for this gamemode (e.g. the
      // old single "💎-crystal-tiertest") — it's being replaced by one
      // channel per region below, so there's nothing useful left in it.
      const base = baseChannelName(gamemode);
      const legacyChannel = interaction.guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildText && base && c.name.endsWith(base) && !parseChannelName(c.name)
      );
      if (legacyChannel) {
        migratedAway.push(legacyChannel.name);
        await legacyChannel.delete().catch((err) =>
          console.error(`[setupqueues] couldn't delete legacy #${legacyChannel.name}:`, err.message)
        );
      }

      for (const region of REGIONS) {
        const targetName = regionChannelName(gamemode, region);
        let channel = interaction.guild.channels.cache.find(
          (c) => c.type === ChannelType.GuildText && gamemodeForChannelName(c.name) === gamemode && regionForChannelName(c.name) === region
        );
        if (!channel) {
          channel = await interaction.guild.channels.create({
            name: targetName,
            type: ChannelType.GuildText,
            parent: category.id,
          });
          created.push(targetName);
        } else if (channel.parentId !== category.id) {
          await channel.setParent(category.id, { lockPermissions: false }).catch(() => {});
        }

        // Tiertest channels are read-only for everyone except testers and
        // up — re-applied every run so it also catches channels set up
        // before this existed.
        await lockChannelToTesters(interaction.guild, channel);

        const queueKey = `${gamemode}:${region}`;
        const highKey = `${queueKey}:high`;
        const existingMsgInfo = getQueueMessage(queueKey);
        const existingHighMsgInfo = getQueueMessage(highKey);
        if (existingMsgInfo && existingHighMsgInfo) {
          skipped.push(targetName);
          continue;
        }

        // Pinned-style explainer, pinging @everyone — posted once per
        // channel alongside the queue message below.
        if (!existingMsgInfo) {
          const display = `${GAMEMODE_PING_ROLE_NAMES[gamemode] || gamemode} (${region})`;
          await channel.send({ content: buildWaitingListMessage(display, commandsChannel) }).catch(() => {});

          // New queues start CLOSED — staff open them explicitly (the Open
          // Queue button) when they're actually ready to test. No ping here
          // since there's nothing to join yet.
          suppressRealtimeFor(queueKey);
          await setQueueClosed(queueKey, true);
          await setQueueLocked(queueKey, false);
          await postFreshQueueMessage(channel, queueKey, gamemode);
        }

        // Same for the high queue (LT3+) — its own tracked message in the
        // same channel, also starting closed. Posted independently so
        // re-running /setupqueues backfills it even if the regular queue
        // message already existed from before this was added.
        if (!existingHighMsgInfo) {
          suppressRealtimeFor(highKey);
          await setQueueClosed(highKey, true);
          await setQueueLocked(highKey, false);
          await postFreshQueueMessage(channel, highKey, gamemode, { isHigh: true });
        }

        posted.push(targetName);
      }
    }

    const lines = [];
    if (rolesCreated.length) lines.push(`**Ping roles created:** ${rolesCreated.join(", ")}`);
    if (tierRolesCreatedCount) lines.push(`**Tier roles created:** ${tierRolesCreatedCount}`);
    if (basicCreated.length) lines.push(`**Basic channels created:** ${basicCreated.map((n) => `#${n}`).join(", ")}`);
    if (tierlistCreated.length) lines.push(`**Tierlist channels created:** ${tierlistCreated.map((n) => `#${n}`).join(", ")}`);
    if (requestsCreated.length) lines.push(`**Requests/Staff channels created:** ${requestsCreated.map((n) => `#${n}`).join(", ")}`);
    if (deleted.length) lines.push(`**Deleted:** ${deleted.join(", ")}`);
    if (categoriesCreated.length) lines.push(`**Categories created:** ${categoriesCreated.join(", ")}`);
    if (migratedAway.length) lines.push(`**Migrated away from (deleted, no region):** ${migratedAway.join(", ")}`);
    if (created.length) lines.push(`**Channels created:** ${created.join(", ")}`);
    if (posted.length) lines.push(`**Posted a queue (closed) in:** ${posted.join(", ")}`);
    if (skipped.length) lines.push(`**Already set up (skipped):** ${skipped.join(", ")}`);
    return replyChunked(interaction, lines.length ? lines.join("\n") : "Nothing to do — everything's already set up.");
  }

  // /resetqueues — one-time cleanup for servers that ended up with
  // duplicate tiertest channels and/or duplicate queue messages (this used
  // to happen because the bot's queue-message tracking was in-memory only
  // and forgot everything on restart — now persisted, see loadQueueMessages
  // — and because re-running /setupqueues before the emoji-channel-name fix
  // could create a second channel per gamemode instead of finding the
  // first). For each gamemode: keeps exactly one tiertest channel (deleting
  // any extras), renames it to its proper emoji name, purges every message
  // in it, and re-posts exactly one fresh queue card (plus one high-queue
  // card), both closed.
  if (interaction.isChatInputCommand() && interaction.commandName === "resetqueues") {
    if (!canManageCooldowns(interaction.member)) {
      return interaction.reply({ content: "Only testers, managers, or admins can do that.", ephemeral: true });
    }
    const botMember = interaction.guild.members.me;
    if (!botMember.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
      return interaction.reply({ content: "I need the **Manage Channels** permission to do this.", ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const commandsChannel = interaction.guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildText && c.name === "commands"
    );

    try {
      // Delete leftover pre-region channels first (serial, few of these).
      for (const gamemode of GAMEMODES) {
        const base = baseChannelName(gamemode);
        const legacyChannels = interaction.guild.channels.cache.filter(
          (c) => c.type === ChannelType.GuildText && base && c.name.endsWith(base) && !parseChannelName(c.name)
        );
        for (const legacy of legacyChannels.values()) {
          await legacy.delete().catch((err) => console.error(`[resetqueues] couldn't delete legacy #${legacy.name}:`, err.message));
        }
      }

      // Build the list of (gamemode, region) pairs to process.
      const pairs = GAMEMODES.flatMap((gm) => REGIONS.map((r) => ({ gamemode: gm, region: r })));

      // Pre-suppress realtime for every queue key we're about to write to,
      // so the flood of setQueueClosed/setQueueLocked events doesn't trigger
      // onQueueStateChange and double/triple-post cards into every channel.
      for (const { gamemode, region } of pairs) {
        suppressRealtimeFor(`${gamemode}:${region}`, 10000);
        suppressRealtimeFor(`${gamemode}:${region}:high`, 10000);
      }

      // Process all channels in parallel — purge, rename, repost.
      const results = await Promise.all(
        pairs.map(async ({ gamemode, region }) => {
          const targetName = regionChannelName(gamemode, region);
          const matches = [
            ...interaction.guild.channels.cache
              .filter(
                (c) =>
                  c.type === ChannelType.GuildText &&
                  gamemodeForChannelName(c.name) === gamemode &&
                  regionForChannelName(c.name) === region
              )
              .values(),
          ];
          if (matches.length === 0) {
            return `**${gamemode} (${region})**: no channel found, skipped.`;
          }

          matches.sort((a, b) => (a.name === targetName ? -1 : b.name === targetName ? 1 : 0));
          const [keep, ...extras] = matches;

          await Promise.all(
            extras.map((extra) =>
              extra.delete().catch((err) => console.error(`[resetqueues] couldn't delete #${extra.name}:`, err.message))
            )
          );

          const categoryName = queueCategoryName(gamemode);
          let category = interaction.guild.channels.cache.find(
            (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === categoryName.toLowerCase()
          );
          if (!category) {
            category = await interaction.guild.channels.create({ name: categoryName, type: ChannelType.GuildCategory });
          }
          if (keep.parentId !== category.id) {
            await keep.setParent(category.id, { lockPermissions: false }).catch(() => {});
          }
          if (keep.name !== targetName) {
            await keep.setName(targetName).catch((err) => console.error(`[resetqueues] couldn't rename #${keep.name}:`, err.message));
          }
          await lockChannelToTesters(interaction.guild, keep);

          // Purge all messages — bulkDelete handles up to 100 at a time for
          // messages under 14 days; older ones are deleted one by one.
          let purged = 0;
          for (let i = 0; i < 20; i++) {
            const batch = await keep.messages.fetch({ limit: 100 }).catch(() => null);
            if (!batch || batch.size === 0) break;
            const fresh = batch.filter((m) => Date.now() - m.createdTimestamp < 14 * 24 * 60 * 60 * 1000);
            if (fresh.size > 0) {
              const result = await keep.bulkDelete(fresh, true).catch(() => null);
              purged += result ? result.size : 0;
              if (!result || result.size === 0) {
                for (const m of batch.values()) { await m.delete().catch(() => {}); purged++; }
                break;
              }
            } else {
              for (const m of batch.values()) { await m.delete().catch(() => {}); purged++; }
            }
          }

          const queueKey = `${gamemode}:${region}`;
          const highKey = `${queueKey}:high`;
          await deleteQueueMessage(queueKey);
          await deleteQueueMessage(highKey);
          await setQueueClosed(queueKey, true);
          await setQueueLocked(queueKey, false);
          await setQueueClosed(highKey, true);
          await setQueueLocked(highKey, false);

          const display = `${GAMEMODE_PING_ROLE_NAMES[gamemode] || gamemode} (${region})`;
          await keep.send({ content: buildWaitingListMessage(display, commandsChannel) }).catch(() => {});
          await postFreshQueueMessage(keep, queueKey, gamemode);
          await postFreshQueueMessage(keep, highKey, gamemode, { isHigh: true });

          return `**${gamemode} (${region})**: kept #${keep.name}${extras.length ? ` (deleted ${extras.length} extra)` : ""}, purged ${purged} msg${purged === 1 ? "" : "s"}.`;
        })
      );

      return replyChunked(interaction, results.join("\n") || "Nothing to clean up.");
    } catch (err) {
      console.error("[resetqueues] failed:", err.message);
      return replyChunked(interaction, `Error: ${err.message}`);
    }
  }

  // /verify — disabled; players must verify through the website
  if (interaction.isChatInputCommand() && interaction.commandName === "verify") {
    return interaction.reply({
      content: "Verification is done on the website — head to the **Verify** tab at https://ryft-tiers.web.app to link your Minecraft account.",
      ephemeral: true,
    });
  }

  // /postverifyinfo — posts step-by-step "how to link your account" info to
  // the verify channel. Staff-only, meant to be run once (or again after an edit).
  if (interaction.isChatInputCommand() && interaction.commandName === "postverifyinfo") {
    if (!canManageCooldowns(interaction.member)) {
      return interaction.reply({ content: "Only testers, managers, or admins can do that.", ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    try {
      // Try to find the channel by name first; fall back to the known ID.
      const VERIFY_CHANNEL_ID = process.env.VERIFY_CHANNEL_ID || "1555538610776711201";
      let channel = interaction.guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildText && c.name === "✅verify"
      );
      if (!channel) {
        channel = await interaction.guild.channels.fetch(VERIFY_CHANNEL_ID).catch(() => null);
      }
      if (!channel) {
        return interaction.editReply({ content: "Couldn't find the verify channel. Check the channel ID or name." });
      }
      await channel.send({ embeds: [buildVerifyInfoEmbed()] });
      return interaction.editReply({ content: "Posted." });
    } catch (err) {
      console.error("[postverifyinfo]", err);
      return interaction.editReply({ content: `Failed to post: ${err.message}` });
    }
  }

  // /jointesting
  if (interaction.isChatInputCommand() && interaction.commandName === "jointesting") {
    if (!isTester(interaction.member)) {
      return interaction.reply({ content: "Only testers can do that.", ephemeral: true });
    }
    const parsed = parseChannelName(interaction.channel.name);
    if (!parsed) {
      return interaction.reply({
        content: "Run this in a tiertest queue channel, not here.",
        ephemeral: true,
      });
    }
    const { gamemode, region } = parsed;
    const queueKey = `${gamemode}:${region}`;
    const tester = await ensurePlayerForDiscordUser(interaction.user.id, interaction.member.displayName);
    if (tester?.region !== region) {
      return interaction.reply({
        content: tester?.region
          ? `This is the **${region}** queue — you're set to **${tester.region}**. Run this in your own region's channel instead.`
          : "You don't have a region set yet — run `/verify` or set your region on the website, then try again.",
        ephemeral: true,
      });
    }

    const added = await addQueueTester(queueKey, interaction.user.id);
    if (!added) {
      return interaction.reply({
        content: `You're already testing **${gamemode}** (${region}).`,
        ephemeral: true,
      });
    }

    // If a test is already in progress, add this tester to that ticket too
    // so they don't have to wait for the next pull.
    const active = getActiveTesting(queueKey);
    if (active && !active.testerIds.includes(interaction.user.id)) {
      try {
        const ticketChannel = await interaction.guild.channels.fetch(active.ticketChannelId);
        await ticketChannel.permissionOverwrites.edit(interaction.user.id, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
        });
        active.testerIds.push(interaction.user.id);
        await ticketChannel.send({
          content: `<@${interaction.user.id}> joined this test as a second tester.`,
        });
      } catch (err) {
        console.error("Couldn't add jointesting tester to active ticket:", err.message);
      }
    }

    // Refresh the queue message so the Active Testers list shows the new tester.
    try {
      const stored = getQueueMessage(queueKey);
      if (stored) {
        const queueChannel = await interaction.guild.channels.fetch(stored.channelId);
        const queueMessage = await queueChannel.messages.fetch(stored.messageId);
        await queueMessage.edit({
          embeds: [await buildQueueEmbed(queueKey, gamemode)],
          components: await buildQueueButtons(queueKey),
        });
      }
    } catch (err) {
      console.error("Couldn't refresh queue message after jointesting:", err.message);
    }

    return interaction.reply({
      content: `You're now testing **${gamemode}** (${region}) alongside the other tester(s).`,
      ephemeral: true,
    });
  }

  // /leavetesting
  if (interaction.isChatInputCommand() && interaction.commandName === "leavetesting") {
    const parsed = parseChannelName(interaction.channel.name);
    if (!parsed) {
      return interaction.reply({
        content: "Run this in a tiertest queue channel, not here.",
        ephemeral: true,
      });
    }
    const { gamemode, region } = parsed;
    const queueKey = `${gamemode}:${region}`;

    const removed = await removeQueueTester(queueKey, interaction.user.id);
    if (!removed) {
      return interaction.reply({
        content: `You're not currently testing **${gamemode}** (${region}).`,
        ephemeral: true,
      });
    }

    // If a test is in progress and this tester was part of it, drop them
    // from that ticket's tester list and revoke their personal access.
    const active = getActiveTesting(queueKey);
    if (active) {
      const idx = active.testerIds.indexOf(interaction.user.id);
      if (idx !== -1) {
        active.testerIds.splice(idx, 1);
        try {
          const ticketChannel = await interaction.guild.channels.fetch(active.ticketChannelId);
          await ticketChannel.permissionOverwrites.delete(interaction.user.id).catch(() => {});
          await ticketChannel.send({
            content: `<@${interaction.user.id}> stopped testing this one.`,
          });
        } catch (err) {
          console.error("Couldn't remove leavetesting tester from active ticket:", err.message);
        }
      }
    }

    // Refresh the queue message so the Active Testers list drops this tester.
    try {
      const stored = getQueueMessage(queueKey);
      if (stored) {
        const queueChannel = await interaction.guild.channels.fetch(stored.channelId);
        const queueMessage = await queueChannel.messages.fetch(stored.messageId);
        await queueMessage.edit({
          embeds: [await buildQueueEmbed(queueKey, gamemode)],
          components: await buildQueueButtons(queueKey),
        });
      }
    } catch (err) {
      console.error("Couldn't refresh queue message after leavetesting:", err.message);
    }

    return interaction.reply({
      content: `You've stopped testing **${gamemode}** (${region}).`,
      ephemeral: true,
    });
  }

  // /backfilllogs
  if (interaction.isChatInputCommand() && interaction.commandName === "backfilllogs") {
    if (!canManageCooldowns(interaction.member)) {
      return interaction.reply({
        content: "Only testers, managers, or admins can do that.",
        ephemeral: true,
      });
    }
    if (!process.env.RESULTS_CHANNEL_ID) {
      return interaction.reply({
        content: "RESULTS_CHANNEL_ID isn't set, so there's no channel to read history from.",
        ephemeral: true,
      });
    }

    await interaction.reply({ content: "Reading results channel history, this may take a moment...", ephemeral: true });

    try {
      const resultsChannel = await interaction.guild.channels.fetch(process.env.RESULTS_CHANNEL_ID);
      let before = undefined;
      let imported = 0;
      let scanned = 0;
      const testerNameCache = new Map();

      for (let page = 0; page < 20; page++) {
        const batch = await resultsChannel.messages.fetch({ limit: 100, before });
        if (batch.size === 0) break;

        for (const message of batch.values()) {
          scanned++;
          if (message.author.id !== client.user.id) continue;
          const embed = message.embeds[0];
          if (!embed || !embed.description) continue;
          if (embed.title !== "Tier test result" && embed.title !== "Manual tier change") continue;

          const desc = embed.description;
          const nameMatch = desc.match(/^\*\*(.+?)\*\*/);
          const gamemodeMatch = desc.match(/in \*\*(.+?)\*\*:/);
          const firstLine = desc.split("\n")[0];
          const changeText = firstLine.split(": ").slice(1).join(": ");
          const tierMatch = changeText.split("→");
          const tier = tierMatch.length > 1 ? tierMatch[tierMatch.length - 1].trim() : null;
          const regionMatch = desc.match(/Region: (\w+)/);
          const testerIdMatches = [...desc.matchAll(/<@(\d+)>/g)];
          const testerId = testerIdMatches.length ? testerIdMatches[testerIdMatches.length - 1][1] : null;

          if (!nameMatch || !gamemodeMatch || !tier || !testerId) continue;

          const testeeName = nameMatch[1];
          const gamemode = gamemodeMatch[1].toLowerCase();

          const { data: alreadyImported } = await supabase
            .from("test_log")
            .select("id")
            .eq("discord_message_id", message.id)
            .maybeSingle();
          if (alreadyImported) continue;

          if (!testerNameCache.has(testerId)) {
            testerNameCache.set(testerId, await resolveDisplayName(interaction.guild, testerId));
          }
          const testerName = testerNameCache.get(testerId);

          const player = await getPlayerRowByUsername(testeeName);
          await supabase.from("test_log").insert({
            player_id: player ? player.id : null,
            gamemode,
            tier,
            tester_names: [testerName],
            region: regionMatch ? regionMatch[1] : null,
            created_at: new Date(message.createdTimestamp).toISOString(),
            discord_message_id: message.id,
          });
          imported++;
        }

        before = batch.last().id;
        if (batch.size < 100) break;
      }

      return interaction.followUp({
        content: `Done. Scanned ${scanned} messages, imported ${imported} results into the log.`,
        ephemeral: true,
      });
    } catch (err) {
      console.error(err);
      return interaction.followUp({
        content: "Something went wrong reading the channel history. Check the bot console for details.",
        ephemeral: true,
      });
    }
  }

  // /clearcooldown
  if (interaction.isChatInputCommand() && interaction.commandName === "clearcooldown") {
    if (!canManageCooldowns(interaction.member)) {
      return interaction.reply({
        content: "Only testers, managers, or admins can do that.",
        ephemeral: true,
      });
    }
    const targetUser = interaction.options.getUser("player", true);
    const gamemode = interaction.options.getString("gamemode", true);
    await clearCooldown(gamemode, targetUser.id);
    return interaction.reply({
      content: `Cleared <@${targetUser.id}>'s **${gamemode}** cooldown. They can queue again now.`,
    });
  }

  // /settier
  if (interaction.isChatInputCommand() && interaction.commandName === "settier") {
    if (!canManageCooldowns(interaction.member)) {
      return interaction.reply({
        content: "Only testers, managers, or admins can do that.",
        ephemeral: true,
      });
    }

    const typedUsername = interaction.options.getString("username");
    const pingedPlayer = interaction.options.getUser("player");
    const gamemode = interaction.options.getString("gamemode", true);
    const tier = interaction.options.getString("tier", true);
    const region = interaction.options.getString("region");

    if (!typedUsername && !pingedPlayer) {
      return interaction.reply({
        content: "Give either a \"username\" or a \"player\" ping.",
        ephemeral: true,
      });
    }

    let username;
    if (typedUsername) {
      username = typedUsername.trim();
    } else {
      username = await getVerifiedUsername(pingedPlayer.id);
      if (!username) {
        return interaction.reply({
          content: `<@${pingedPlayer.id}> hasn't linked a Minecraft username yet — have them verify on the website first, or type the "username" option manually instead.`,
          ephemeral: true,
        });
      }
    }

    if (/[.#$\[\]]/.test(username)) {
      return interaction.reply({
        content: `"${username}" isn't a valid Minecraft username — it can't contain ".", "#", "$", "[", or "]".`,
        ephemeral: true,
      });
    }

    const existing = await getPlayer(username);
    if (!existing && !region) {
      return interaction.reply({
        content: `**${username}** isn't on the site yet, so you need to also set the "region" option to add them.`,
        ephemeral: true,
      });
    }

    try {
      const previousTier = existing?.tiers?.[gamemode];
      await setPlayerTier(username, region, gamemode, tier);
      await interaction.reply({
        content: `Set **${username}** to **${tier}** in **${gamemode}**. The website will update automatically.`,
      });

      if (process.env.RESULTS_CHANNEL_ID) {
        const resultsChannel = await interaction.guild.channels
          .fetch(process.env.RESULTS_CHANNEL_ID)
          .catch(() => null);
        if (resultsChannel) {
          const changeText = previousTier ? `${previousTier} → ${tier}` : `Untested → ${tier}`;
          await resultsChannel.send({
            embeds: [
              new EmbedBuilder()
                .setTitle("Manual tier change")
                .setDescription(
                  `**${username}** in **${gamemode.toUpperCase()}**: ${changeText}\nChanged by: <@${interaction.user.id}>`
                )
                .setColor(0xffd54a),
            ],
          });
        }
      }

      // Also post to high-results if the tier is HT3 or above
      if (isHighTier(tier)) {
        const discordId = pingedPlayer?.id || null;
        await postHighResult(interaction.guild, {
          username,
          discordId,
          gamemode,
          previousTier,
          tier,
          region: region || existing?.region || "?",
          fightResultsRaw: "",
          testerTag: `<@${interaction.user.id}>`,
          isManual: true,
        });
      }
    } catch (err) {
      console.error(err);
      return interaction.reply({
        content: "Something went wrong saving that to the database.",
        ephemeral: true,
      });
    }
    return;
  }

  // ---------- buttons ----------
  if (interaction.isButton()) {
    // ---------- #request-support: open a ticket ----------
    if (interaction.customId === "request_open_ticket") {
      return interaction.reply({
        content: "What's this about?",
        components: [buildTicketCategoryButtons()],
        ephemeral: true,
      });
    }

    if (interaction.customId.startsWith("ticket_cat_")) {
      const category = interaction.customId.replace("ticket_cat_", "");
      if (isRestricted(interaction.member) && category !== "appeal" && category !== "help") {
        return interaction.reply({ content: "You are restricted. You may only open a Help or Appeal ticket.", ephemeral: true });
      }
      return interaction.showModal(buildTicketModal(category));
    }

    // ---------- support ticket channel: "Close Ticket" button ----------
    // Just flips the row in Supabase — the support_tickets realtime UPDATE
    // listener in realtime-sync.js (the same one the website's close goes
    // through) notices the status change and tears the channel down itself.
    if (interaction.customId.startsWith("support_ticket_close_")) {
      if (!canManageCooldowns(interaction.member)) {
        return interaction.reply({ content: "Only testers, managers, or admins can do that.", ephemeral: true });
      }
      const ticketId = Number(interaction.customId.replace("support_ticket_close_", ""));
      await interaction.deferReply({ ephemeral: true });
      try {
        const closed = await closeSupportTicketFromDiscord(ticketId);
        return interaction.editReply({
          content: closed
            ? "Closing this ticket — the channel will be deleted shortly."
            : "This ticket was already closed.",
        });
      } catch (err) {
        console.error("[support_ticket_close] failed:", err.message);
        return interaction.editReply({ content: "Something went wrong closing that ticket. Try again or close it from the website." });
      }
    }

    // ---------- #tester-application ----------
    if (interaction.customId === "tester_apply") {
      return interaction.showModal(buildTesterApplicationModal());
    }

    if (interaction.customId === "staff_apply") {
      const modal = new ModalBuilder()
        .setCustomId("staff_apply_modal")
        .setTitle("Staff Application")
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("ign").setLabel("Minecraft IGN").setStyle(TextInputStyle.Short).setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("region").setLabel("Region (NA/EU/AS/ME/AU)").setStyle(TextInputStyle.Short).setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("why")
              .setLabel("Why do you want to be staff?")
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("experience")
              .setLabel("Previous moderation/staff experience")
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(false)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("availability")
              .setLabel("How often are you available?")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          )
        );
      return interaction.showModal(modal);
    }

    // Accept button: app_accept_<type>_<id>
    if (interaction.customId.startsWith("app_accept_")) {
      if (!canReviewApplications(interaction.member)) {
        return interaction.reply({ content: "Only managers/admins can review applications.", ephemeral: true });
      }
      const parts = interaction.customId.split("_"); // ["app","accept","tester"|"staff", ...id]
      const appType = parts[2];
      const appId = parts.slice(3).join("_");
      await interaction.deferUpdate();

      if (appType === "tester") {
        const applicationId = Number(appId);
        const decided = await decideTesterApplication(applicationId, "accepted", interaction.user.id);
        if (!decided) {
          return interaction.followUp({ content: "That application was already decided.", ephemeral: true });
        }
        const app = await getTesterApplication(applicationId);
        const statusLine = `\n\n✅ **Accepted** by <@${interaction.user.id}>`;
        await interaction.message.edit({ embeds: [buildApplicationReviewEmbed(app, statusLine)], components: [] }).catch(() => {});
        try {
          const member = await interaction.guild.members.fetch(app.discord_id);
          const testerRole = interaction.guild.roles.cache.get(PERMISSION_ROLE_IDS.tester);
          if (testerRole) await member.roles.add(testerRole).catch(() => {});
        } catch (err) {
          console.error("Couldn't add Tester role:", err.message);
        }
        try {
          const applicant = await client.users.fetch(app.discord_id);
          await applicant.send("🎉 Your tester application for RyftTiers was **accepted**! You've been given the Tester role.").catch(() => {});
        } catch {}
      } else {
        // Staff application accept — give Moderator role, update embed, DM applicant
        const discordId = appId.split("_")[1]; // s_<discordId>_<timestamp>
        const MODERATOR_ROLE_ID = "1555516390822252654";
        try {
          const member = await interaction.guild.members.fetch(discordId);
          const modRole = interaction.guild.roles.cache.get(MODERATOR_ROLE_ID);
          if (modRole) await member.roles.add(modRole).catch(() => {});
        } catch (err) {
          console.error("Couldn't add Moderator role after accepting staff application:", err.message);
        }
        const originalEmbed = interaction.message.embeds[0];
        const updatedEmbed = EmbedBuilder.from(originalEmbed)
          .setColor(0x4ade80)
          .addFields({ name: "Decision", value: `✅ **Accepted** by <@${interaction.user.id}>` });
        await interaction.message.edit({ embeds: [updatedEmbed], components: [] }).catch(() => {});
        try {
          const applicant = await client.users.fetch(discordId);
          await applicant.send("🎉 Your staff application for RyftTiers was **accepted**! You've been given the Moderator role.").catch(() => {});
        } catch {}
      }
      return;
    }

    // Deny button: app_deny_<type>_<id> — show a modal for denial notes
    if (interaction.customId.startsWith("app_deny_")) {
      if (!canReviewApplications(interaction.member)) {
        return interaction.reply({ content: "Only managers/admins can review applications.", ephemeral: true });
      }
      const parts = interaction.customId.split("_"); // ["app","deny","tester"|"staff", ...id]
      const appType = parts[2];
      const appId = parts.slice(3).join("_");
      const modal = new ModalBuilder()
        .setCustomId(`app_deny_modal_${appType}_${appId}`)
        .setTitle("Deny Application")
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("notes")
              .setLabel("Reason / notes (sent to applicant)")
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(false)
              .setPlaceholder("Leave blank to send a generic denial message.")
              .setMaxLength(1000)
          )
        );
      return interaction.showModal(modal);
    }

    // Ticket-only buttons (submit / close) work in ticket channels, which
    // aren't in GAMEMODE_CHANNELS, so handle those before the gamemode check.
    if (interaction.customId.startsWith("ticket_submit_")) {
      if (!isTester(interaction.member)) {
        return interaction.reply({ content: "Only testers can do that.", ephemeral: true });
      }
      const [, , gamemode, testeeId] = interaction.customId.split("_");

      // Show the modal immediately — no async work (DB calls, etc.) before
      // showModal, or Discord's 3-second acknowledgement window expires and
      // the tester sees "didn't respond in time". The verified-username
      // check happens on the modal submit instead (submit_result_ handler).
      const activeInfo = getActiveTestingByTicket(interaction.channelId);
      const isHighTicket = !!(activeInfo?.isHigh);

      const modal = new ModalBuilder()
        .setCustomId(`submit_result_${gamemode}_${testeeId}${isHighTicket ? "_high" : ""}`)
        .setTitle(`Submit ${gamemode.toUpperCase()} Result`);

      const regionInput = new TextInputBuilder()
        .setCustomId("player_region")
        .setLabel("Region (NA, EU, AS, ME, or AU)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const tierInput = new TextInputBuilder()
        .setCustomId("player_tier")
        .setLabel("Tier")
        .setPlaceholder(TIER_OPTIONS.join(", "))
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      modal.addComponents(
        new ActionRowBuilder().addComponents(regionInput),
        new ActionRowBuilder().addComponents(tierInput)
      );

      if (isHighTicket) {
        const fightsInput = new TextInputBuilder()
          .setCustomId("fight_results")
          .setLabel("Fight results (one per line, e.g. Won 4-3 vs. Steve)")
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder("Won 4-3 vs. PlayerA\nLost 1-4 vs. PlayerB")
          .setRequired(false);
        modal.addComponents(new ActionRowBuilder().addComponents(fightsInput));
      }

      return interaction.showModal(modal);
    }

    if (interaction.customId === "ticket_close") {
      if (!isTester(interaction.member)) {
        return interaction.reply({ content: "Only testers can do that.", ephemeral: true });
      }
      await interaction.reply({ content: "Closing ticket without saving a result..." });
      await clearActiveTestingAndRefresh(interaction.guild, interaction.channelId);
      setTimeout(() => interaction.channel.delete().catch((err) => console.error("Failed to delete ticket channel (close):", err.message)), 3000);
      return;
    }

    // Everything below only applies inside actual gamemode queue channels —
    // each one now pins exactly one (gamemode, region) pair, parsed
    // straight from the channel's own name.
    const parsed = parseChannelName(interaction.channel.name);
    if (!parsed) return;
    const { gamemode, region } = parsed;
    const queueKey = `${gamemode}:${region}`;
    const highKey = `${queueKey}:high`;

    // A tester may only manage (open/close/lock/claim) the queue matching
    // their own verified region — an EU tester can't run the NA queue, etc.
    // Returns the tester's own region string on success, or replies with an
    // error and returns null.
    async function requireOwnRegion(member, userId) {
      const tester = await ensurePlayerForDiscordUser(userId, member.displayName);
      if (!tester?.region) {
        return {
          ok: false,
          message: "You don't have a region set yet — set your region on the website's Verify tab, then try again.",
        };
      }
      if (tester.region !== region) {
        return {
          ok: false,
          message: `This is the **${region}** queue — you're set to **${tester.region}**. Head to your own region's channel instead.`,
        };
      }
      return { ok: true };
    }

    if (interaction.customId === "queue_join") {
      if (isRestricted(interaction.member)) {
        return interaction.reply({ content: "You are restricted from joining queues.", ephemeral: true });
      }
      const verifiedUsername = await getVerifiedUsername(interaction.user.id);
      if (!verifiedUsername) {
        return interaction.reply({
          content:
            "You need to verify before joining a queue — head to the **Verify** tab on the website to link your Minecraft account first.",
          ephemeral: true,
        });
      }
      const joiner = await ensurePlayerForDiscordUser(interaction.user.id, interaction.member.displayName);
      if (!joiner?.region) {
        return interaction.reply({
          content: "Set your region first — head to the **Verify** tab on the website before joining a queue.",
          ephemeral: true,
        });
      }
      if (joiner.region !== region) {
        const correctChannel = interaction.guild.channels.cache.find(
          (c) => gamemodeForChannelName(c.name) === gamemode && regionForChannelName(c.name) === joiner.region
        );
        return interaction.reply({
          content: `This is the **${region}** queue — you're set to **${joiner.region}**. ${
            correctChannel ? `Head to ${correctChannel} instead.` : "Ask staff to run /setupqueues if your region's channel is missing."
          }`,
          ephemeral: true,
        });
      }
      const testerJoining = isTester(interaction.member);
      if (!testerJoining && await isQueueClosed(queueKey)) {
        return interaction.reply({ content: "This queue is closed right now.", ephemeral: true });
      }
      if (!testerJoining && await getQueueLocked(queueKey)) {
        return interaction.reply({ content: "This queue is locked to new joins right now.", ephemeral: true });
      }
      const cooldownUntil = await getCooldownUntil(gamemode, interaction.user.id);
      if (cooldownUntil && cooldownUntil > Date.now()) {
        return interaction.reply({
          content: `You were tested in **${gamemode}** recently. You can queue again in ${formatRemaining(cooldownUntil - Date.now())}.`,
          ephemeral: true,
        });
      }
      const joined = await joinQueue(queueKey, interaction.user.id, region);
      await refreshQueueMessage(interaction, queueKey, gamemode);
      return interaction.reply({
        content: joined ? "You joined the queue." : "You're already in the queue.",
        ephemeral: true,
      });
    }

    if (interaction.customId === "queue_leave") {
      const left = await leaveQueue(queueKey, interaction.user.id);
      await refreshQueueMessage(interaction, queueKey, gamemode);
      return interaction.reply({
        content: left ? "You left the queue." : "You weren't in the queue.",
        ephemeral: true,
      });
    }

    // Closed -> open. The region is fixed by the channel itself — just
    // confirms the tester is actually from that region.
    if (interaction.customId === "queue_open") {
      if (!isTester(interaction.member)) {
        return interaction.reply({ content: "Only testers can do that.", ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });
      try {
        const check = await requireOwnRegion(interaction.member, interaction.user.id);
        if (!check.ok) return interaction.editReply({ content: check.message });
        suppressRealtimeFor(queueKey);
        await setQueueClosed(queueKey, false);
        await setQueueLocked(queueKey, false);
        await postFreshQueueMessage(interaction.channel, queueKey, gamemode, {
          content: `${getRolePing(interaction.guild, gamemode)}Queue is open! (${region})`,
        });
        return interaction.editReply({ content: `Queue opened on **${region}** servers.` });
      } catch (err) {
        console.error("[queue_open] failed:", err.message);
        return interaction.editReply({ content: "Something went wrong opening the queue. Check bot logs." });
      }
    }

    // Open queue, stays open/visible, just stops new joins — distinct from
    // fully closing it.
    if (interaction.customId === "queue_toggle_lock") {
      if (!isTester(interaction.member)) {
        return interaction.reply({ content: "Only testers can do that.", ephemeral: true });
      }
      const check = await requireOwnRegion(interaction.member, interaction.user.id);
      if (!check.ok) return interaction.reply({ content: check.message, ephemeral: true });
      const nowLocked = !(await getQueueLocked(queueKey));
      await setQueueLocked(queueKey, nowLocked);
      await refreshQueueMessage(interaction, queueKey, gamemode);
      return interaction.reply({
        content: nowLocked ? "Queue locked to new joins." : "Queue unlocked.",
        ephemeral: true,
      });
    }

    // Open -> closed. Deletes the open card and posts a fresh closed
    // "No Testers Online" one in its place.
    if (interaction.customId === "queue_close") {
      if (!isTester(interaction.member)) {
        return interaction.reply({ content: "Only testers can do that.", ephemeral: true });
      }
      const check = await requireOwnRegion(interaction.member, interaction.user.id);
      if (!check.ok) return interaction.reply({ content: check.message, ephemeral: true });
      await interaction.reply({ content: "Closing the queue.", ephemeral: true });
      suppressRealtimeFor(queueKey);
      await setQueueClosed(queueKey, true);
      await setQueueLocked(queueKey, false);
      await postFreshQueueMessage(interaction.channel, queueKey, gamemode);
      return;
    }

    if (interaction.customId === "queue_next") {
      if (!isTester(interaction.member)) {
        return interaction.reply({ content: "Only testers can do that.", ephemeral: true });
      }
      // Ack immediately — the Supabase/Discord lookups below can take
      // longer than Discord's 3-second reply window.
      await interaction.deferReply({ ephemeral: true });

      const check = await requireOwnRegion(interaction.member, interaction.user.id);
      if (!check.ok) return interaction.editReply({ content: check.message });

      await addQueueTester(queueKey, interaction.member.id);
      const nextUserId = await popNext(queueKey);

      if (!nextUserId) {
        await refreshQueueMessage(interaction, queueKey, gamemode);
        return interaction.editReply({ content: "Queue is empty." });
      }

      try {
        const ticketChannel = await createTicketChannel(
          interaction.guild,
          interaction.channel,
          gamemode,
          interaction.member,
          nextUserId
        );
        const testerIds = await getQueueTesterIds(queueKey);
        setActiveTesting(queueKey, {
          ticketChannelId: ticketChannel.id,
          testerIds,
          testeeId: nextUserId,
          queueChannelId: interaction.channelId,
          queueMessageId: interaction.message.id,
          gamemode,
          isHigh: false,
        });

        const testeeName = await resolveDisplayName(interaction.guild, nextUserId);
        const testerNames = await Promise.all(
          testerIds.map((id) => resolveDisplayName(interaction.guild, id))
        );
        await setLiveTest(ticketChannel.id, {
          testeeName,
          testerNames,
          testerIds,
          gamemode,
          startedAt: Date.now(),
        });

        await refreshQueueMessage(interaction, queueKey, gamemode);
        return interaction.editReply({
          content: `Created a private ticket for <@${nextUserId}>: ${ticketChannel}`,
        });
      } catch (err) {
        console.error(err);
        await refreshQueueMessage(interaction, queueKey, gamemode);
        return interaction.editReply({
          content:
            "Couldn't create the ticket channel. Make sure the bot has the \"Manage Channels\" permission.",
        });
      }
    }

    // ---------- high queue ----------
    if (interaction.customId === "highqueue_join") {
      const testerJoiningHigh = isTester(interaction.member);

      if (!testerJoiningHigh && isRestricted(interaction.member)) {
        return interaction.reply({ content: "You are restricted from joining queues.", ephemeral: true });
      }
      if (!testerJoiningHigh && await isQueueClosed(highKey)) {
        return interaction.reply({ content: "This queue is closed right now.", ephemeral: true });
      }
      if (!testerJoiningHigh && await getQueueLocked(highKey)) {
        return interaction.reply({ content: "This queue is locked to new joins right now.", ephemeral: true });
      }

      const username = await getVerifiedUsername(interaction.user.id);
      if (!username) {
        return interaction.reply({
          content: `You need to link your Minecraft account first — head to the **Verify** tab on the website, then try joining again.`,
          ephemeral: true,
        });
      }

      const player = await getPlayer(username);
      if (!player?.region) {
        return interaction.reply({
          content: "Set your region first — head to the **Verify** tab on the website before joining a queue.",
          ephemeral: true,
        });
      }
      if (player.region !== region) {
        const correctChannel = interaction.guild.channels.cache.find(
          (c) => gamemodeForChannelName(c.name) === gamemode && regionForChannelName(c.name) === player.region
        );
        return interaction.reply({
          content: `This is the **${region}** high queue — you're set to **${player.region}**. ${
            correctChannel ? `Head to ${correctChannel} instead.` : "Ask staff to run /setupqueues if your region's channel is missing."
          }`,
          ephemeral: true,
        });
      }

      const currentTier = player?.tiers?.[gamemode];
      const tierIndex = currentTier ? TIER_OPTIONS.indexOf(currentTier) : -1;

      if (tierIndex === -1 || tierIndex > HIGH_QUEUE_MAX_INDEX) {
        return interaction.reply({
          content: `The high queue for **${gamemode}** is only open to players already tiered **LT3 or better**. Your current tier: **${currentTier || "Untested"}**.`,
          ephemeral: true,
        });
      }

      const joined = await joinQueue(highKey, interaction.user.id, region);
      await refreshHighQueueMessage(interaction, highKey, gamemode);
      return interaction.reply({
        content: joined ? "You joined the high queue." : "You're already in the high queue.",
        ephemeral: true,
      });
    }

    if (interaction.customId === "highqueue_leave") {
      const left = await leaveQueue(highKey, interaction.user.id);
      await refreshHighQueueMessage(interaction, highKey, gamemode);
      return interaction.reply({
        content: left ? "You left the high queue." : "You weren't in the high queue.",
        ephemeral: true,
      });
    }

    if (interaction.customId === "highqueue_open") {
      if (!isTester(interaction.member)) {
        return interaction.reply({ content: "Only testers can do that.", ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });
      try {
        const check = await requireOwnRegion(interaction.member, interaction.user.id);
        if (!check.ok) return interaction.editReply({ content: check.message });
        suppressRealtimeFor(highKey);
        await setQueueClosed(highKey, false);
        await setQueueLocked(highKey, false);
        await postFreshQueueMessage(interaction.channel, highKey, gamemode, {
          isHigh: true,
          content: `${getRolePing(interaction.guild, gamemode)}High queue is open! (${region})`,
        });
        return interaction.editReply({ content: `High queue opened on **${region}** servers.` });
      } catch (err) {
        console.error("[highqueue_open] failed:", err.message);
        return interaction.editReply({ content: "Something went wrong opening the high queue. Check bot logs." });
      }
    }

    if (interaction.customId === "highqueue_toggle_lock") {
      if (!isTester(interaction.member)) {
        return interaction.reply({ content: "Only testers can do that.", ephemeral: true });
      }
      const check = await requireOwnRegion(interaction.member, interaction.user.id);
      if (!check.ok) return interaction.reply({ content: check.message, ephemeral: true });
      const nowLocked = !(await getQueueLocked(highKey));
      await setQueueLocked(highKey, nowLocked);
      await refreshHighQueueMessage(interaction, highKey, gamemode);
      return interaction.reply({
        content: nowLocked ? "High queue locked to new joins." : "High queue unlocked.",
        ephemeral: true,
      });
    }

    if (interaction.customId === "highqueue_close") {
      if (!isTester(interaction.member)) {
        return interaction.reply({ content: "Only testers can do that.", ephemeral: true });
      }
      const check = await requireOwnRegion(interaction.member, interaction.user.id);
      if (!check.ok) return interaction.reply({ content: check.message, ephemeral: true });
      await interaction.reply({ content: "Closing this high queue.", ephemeral: true });
      suppressRealtimeFor(highKey);
      await setQueueClosed(highKey, true);
      await setQueueLocked(highKey, false);
      await postFreshQueueMessage(interaction.channel, highKey, gamemode, { isHigh: true });
      return;
    }

    if (interaction.customId === "highqueue_next") {
      if (!isTester(interaction.member)) {
        return interaction.reply({ content: "Only testers can do that.", ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });

      const check = await requireOwnRegion(interaction.member, interaction.user.id);
      if (!check.ok) return interaction.editReply({ content: check.message });

      await addQueueTester(highKey, interaction.member.id);
      const nextUserId = await popNext(highKey);

      if (!nextUserId) {
        await refreshHighQueueMessage(interaction, highKey, gamemode);
        return interaction.editReply({ content: "High queue is empty." });
      }

      try {
        const ticketChannel = await createTicketChannel(
          interaction.guild,
          interaction.channel,
          gamemode,
          interaction.member,
          nextUserId,
          { isHigh: true }
        );
        const testerIds = await getQueueTesterIds(highKey);
        setActiveTesting(highKey, {
          ticketChannelId: ticketChannel.id,
          testerIds,
          testeeId: nextUserId,
          queueChannelId: interaction.channelId,
          queueMessageId: interaction.message.id,
          gamemode,
          isHigh: true,
        });

        const highTesteeName = await resolveDisplayName(interaction.guild, nextUserId);
        const highTesterNames = await Promise.all(
          testerIds.map((id) => resolveDisplayName(interaction.guild, id))
        );
        await setLiveTest(ticketChannel.id, {
          testeeName: highTesteeName,
          testerNames: highTesterNames,
          testerIds,
          gamemode: `${gamemode} (high)`,
          startedAt: Date.now(),
        });

        await refreshHighQueueMessage(interaction, highKey, gamemode);
        return interaction.editReply({
          content: `Created a private ticket for <@${nextUserId}>: ${ticketChannel}`,
        });
      } catch (err) {
        console.error(err);
        await refreshHighQueueMessage(interaction, highKey, gamemode);
        return interaction.editReply({
          content:
            "Couldn't create the ticket channel. Make sure the bot has the \"Manage Channels\" permission.",
        });
      }
    }
  }

  // ---------- #request-test: gamemode picker ----------
  if (interaction.isStringSelectMenu() && interaction.customId === "request_test_gamemode") {
    if (isRestricted(interaction.member)) {
      return interaction.reply({ content: "You are restricted from joining queues.", ephemeral: true });
    }
    const channelName = interaction.values[0];
    const gamemode = GAMEMODE_CHANNELS[channelName];
    if (!gamemode) {
      return interaction.reply({ content: "Couldn't find that queue channel — ask staff to run /setupqueues.", ephemeral: true });
    }

    // Route them straight to the channel for THEIR region, derived from
    // their verified profile — no picking a region by hand.
    const requester = await ensurePlayerForDiscordUser(interaction.user.id, interaction.member.displayName);
    if (!requester?.region) {
      return interaction.reply({
        content: "You need to set your region first — head to the **Verify** tab on the website, then come back here.",
        ephemeral: true,
      });
    }
    const channel = interaction.guild.channels.cache.find(
      (c) => gamemodeForChannelName(c.name) === gamemode && regionForChannelName(c.name) === requester.region
    );
    if (!channel) {
      return interaction.reply({
        content: `Couldn't find the **${requester.region}** queue channel for that gamemode — ask staff to run /setupqueues.`,
        ephemeral: true,
      });
    }

    // Give them the gamemode ping role so they're notified when the queue opens.
    const pingRoleName = GAMEMODE_PING_ROLE_NAMES[gamemode];
    let roleNote = "";
    if (pingRoleName) {
      const pingRole = interaction.guild.roles.cache.find(
        (r) => r.name.toLowerCase() === pingRoleName.toLowerCase()
      );
      if (pingRole) {
        const alreadyHas = interaction.member.roles.cache.has(pingRole.id);
        if (!alreadyHas) {
          await interaction.member.roles.add(pingRole).catch(() => {});
          roleNote = `\nYou've been given the **${pingRoleName}** role — you'll be pinged here when the queue opens.`;
        } else {
          roleNote = `\nYou already have the **${pingRoleName}** role and will be pinged when the queue opens.`;
        }
      }
    }

    return interaction.reply({
      content: `Head to ${channel} and use the **Join Queue** button there once it's open.${roleNote}`,
      ephemeral: true,
    });
  }

  // ---------- modal submit ----------

  if (interaction.isModalSubmit() && interaction.customId.startsWith("ticket_modal_")) {
    const category = interaction.customId.replace("ticket_modal_", "");
    const subject = interaction.fields.getTextInputValue("subject").trim();
    const details = interaction.fields.getTextInputValue("details").trim();
    await interaction.deferReply({ ephemeral: true });
    try {
      await createSupportTicketFromDiscord(
        interaction.user.id,
        interaction.member?.displayName || interaction.user.username,
        category,
        subject,
        details
      );
      return interaction.editReply({
        content: "Ticket created — a private channel for it will appear here shortly, and it's on the website under Support too.",
      });
    } catch (err) {
      console.error("Couldn't create ticket from Discord:", err.message);
      return interaction.editReply({ content: "Something went wrong creating that ticket. Try again or ping staff." });
    }
  }

  if (interaction.isModalSubmit() && interaction.customId === "staff_apply_modal") {
    const ign = interaction.fields.getTextInputValue("ign").trim();
    const region = interaction.fields.getTextInputValue("region").trim().toUpperCase();
    const why = interaction.fields.getTextInputValue("why").trim();
    const experience = interaction.fields.getTextInputValue("experience").trim();
    const availability = interaction.fields.getTextInputValue("availability").trim();
    await interaction.deferReply({ ephemeral: true });
    try {
      const reviewChannel = await interaction.guild.channels.fetch(APP_REVIEW_CHANNEL_ID).catch(() => null);
      if (reviewChannel) {
        // Use a stable pseudo-ID for staff apps: Discord snowflake (unique per user per submission)
        const staffAppId = `s_${interaction.user.id}_${Date.now()}`;
        const embed = new EmbedBuilder()
          .setTitle("Staff Application")
          .setColor(0x2f7fd6)
          .addFields(
            { name: "Discord", value: `<@${interaction.user.id}>`, inline: true },
            { name: "IGN", value: ign, inline: true },
            { name: "Region", value: region, inline: true },
            { name: "Why staff?", value: why },
            { name: "Previous experience", value: experience || "None provided" },
            { name: "Availability", value: availability }
          )
          .setTimestamp();
        await reviewChannel.send({
          embeds: [embed],
          components: [buildApplicationReviewButtons("staff", staffAppId)],
        });
      }
      return interaction.editReply({ content: "Application submitted! Staff will review it and reach out to you." });
    } catch (err) {
      console.error("Couldn't submit staff application:", err.message);
      return interaction.editReply({ content: "Something went wrong submitting that. Try again or ping staff." });
    }
  }

  if (interaction.isModalSubmit() && interaction.customId === "tester_apply_modal") {
    const ign = interaction.fields.getTextInputValue("ign").trim();
    const region = interaction.fields.getTextInputValue("region").trim().toUpperCase();
    const experience = interaction.fields.getTextInputValue("experience").trim();
    const availability = interaction.fields.getTextInputValue("availability").trim();
    await interaction.deferReply({ ephemeral: true });
    try {
      const applicationId = await createTesterApplication(interaction.user.id, { ign, region, experience, availability });
      const reviewChannel = await interaction.guild.channels.fetch(APP_REVIEW_CHANNEL_ID).catch(() => null);
      if (reviewChannel) {
        const app = await getTesterApplication(applicationId);
        const reviewMsg = await reviewChannel.send({
          embeds: [buildApplicationReviewEmbed(app)],
          components: [buildApplicationReviewButtons("tester", applicationId)],
        });
        await setTesterApplicationReviewMessage(applicationId, reviewChannel.id, reviewMsg.id);
      }
      return interaction.editReply({ content: "Application submitted! Staff will review it and DM you either way." });
    } catch (err) {
      console.error("Couldn't submit tester application:", err.message);
      return interaction.editReply({ content: "Something went wrong submitting that. Try again or ping staff." });
    }
  }

  // Deny-with-notes modal submit: app_deny_modal_<type>_<id>
  if (interaction.isModalSubmit() && interaction.customId.startsWith("app_deny_modal_")) {
    const suffix = interaction.customId.replace("app_deny_modal_", ""); // "<type>_<id>"
    const firstUnderscore = suffix.indexOf("_");
    const appType = suffix.slice(0, firstUnderscore);
    const appId = suffix.slice(firstUnderscore + 1);
    const notes = (interaction.fields.getTextInputValue("notes") || "").trim();
    await interaction.deferUpdate();

    if (appType === "tester") {
      const applicationId = Number(appId);
      const decided = await decideTesterApplication(applicationId, "denied", interaction.user.id);
      if (!decided) {
        return interaction.followUp({ content: "That application was already decided.", ephemeral: true });
      }
      const app = await getTesterApplication(applicationId);
      const statusLine = `\n\n❌ **Denied** by <@${interaction.user.id}>${notes ? `\n**Notes:** ${notes}` : ""}`;
      await interaction.message.edit({ embeds: [buildApplicationReviewEmbed(app, statusLine)], components: [] }).catch(() => {});
      try {
        const applicant = await client.users.fetch(app.discord_id);
        const dmText = notes
          ? `Your tester application for RyftTiers was **denied**.\n\n**Reason:** ${notes}`
          : "Your tester application for RyftTiers was **denied**. You're welcome to apply again in the future.";
        await applicant.send(dmText).catch(() => {});
      } catch {}
    } else {
      // Staff application deny
      const discordId = appId.split("_")[1]; // s_<discordId>_<timestamp>
      const originalEmbed = interaction.message.embeds[0];
      const updatedEmbed = EmbedBuilder.from(originalEmbed)
        .setColor(0xe05a5a)
        .addFields({
          name: "Decision",
          value: `❌ **Denied** by <@${interaction.user.id}>${notes ? `\n**Notes:** ${notes}` : ""}`,
        });
      await interaction.message.edit({ embeds: [updatedEmbed], components: [] }).catch(() => {});
      try {
        const applicant = await client.users.fetch(discordId);
        const dmText = notes
          ? `Your staff application for RyftTiers was **denied**.\n\n**Reason:** ${notes}`
          : "Your staff application for RyftTiers was **denied**. You're welcome to apply again in the future.";
        await applicant.send(dmText).catch(() => {});
      } catch {}
    }
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("submit_result_")) {
    const parts = interaction.customId.split("_");
    // customId format: submit_result_<gamemode>_<testeeId> or submit_result_<gamemode>_<testeeId>_high
    const isHighTicket = parts[parts.length - 1] === "high";
    const [, , gamemode, testeeId] = parts;
    const region = interaction.fields.getTextInputValue("player_region").trim().toUpperCase();
    const tier = interaction.fields.getTextInputValue("player_tier").trim().toUpperCase();
    const fightResultsRaw = isHighTicket
      ? (interaction.fields.getTextInputValue("fight_results") || "").trim()
      : "";

    const name = await getVerifiedUsername(testeeId);
    if (!name) {
      return interaction.reply({
        content: `<@${testeeId}> isn't verified — they need to link their account on the website before this can be saved.`,
        ephemeral: true,
      });
    }

    if (!TIER_OPTIONS.includes(tier)) {
      return interaction.reply({
        content: `"${tier}" isn't a valid tier. Use one of: ${TIER_OPTIONS.join(", ")}`,
        ephemeral: true,
      });
    }
    if (!["NA", "EU", "AS", "ME", "AU"].includes(region)) {
      return interaction.reply({
        content: `"${region}" isn't a valid region. Use NA, EU, AS, ME, or AU.`,
        ephemeral: true,
      });
    }

    try {
      const existingPlayer = await getPlayer(name);
      const previousTier = existingPlayer?.tiers?.[gamemode];

      await setPlayerTier(name, region, gamemode, tier);
      if (testeeId) {
        await setCooldown(gamemode, testeeId, Date.now() + COOLDOWN_MS);
      }
      await interaction.reply({
        content: `Saved: **${name}** is now **${tier}** in **${gamemode}**. The website will update automatically. They're on a ${COOLDOWN_DAYS}-day cooldown for this gamemode. Closing this ticket in 5 seconds...`,
      });

      if (process.env.RESULTS_CHANNEL_ID) {
        const resultsChannel = await interaction.guild.channels
          .fetch(process.env.RESULTS_CHANNEL_ID)
          .catch(() => null);
        if (resultsChannel) {
          const changeText = previousTier ? `${previousTier} → ${tier}` : `Untested → ${tier}`;
          await resultsChannel.send({
            embeds: [
              new EmbedBuilder()
                .setTitle("Tier test result")
                .setDescription(
                  `**${name}**${testeeId ? ` (<@${testeeId}>)` : ""} in **${gamemode.toUpperCase()}**: ${changeText}\nRegion: ${region}\nTested by: <@${interaction.user.id}>`
                )
                .setColor(0xffd54a),
            ],
          });
        }
      }

      // Post to high-results if this was a high ticket OR tier is HT3+
      if (isHighTicket || isHighTier(tier)) {
        await postHighResult(interaction.guild, {
          username: name,
          discordId: testeeId,
          gamemode,
          previousTier,
          tier,
          region,
          fightResultsRaw,
          testerTag: `<@${interaction.user.id}>`,
          isManual: false,
        });
      }

      const closedInfo = await clearActiveTestingAndRefresh(interaction.guild, interaction.channelId);
      const testerIds = closedInfo?.testerIds || [interaction.user.id];
      const testerNames = await Promise.all(
        testerIds.map((id) => resolveDisplayName(interaction.guild, id))
      );
      await logTestResult({
        testeeName: name,
        testerNames,
        testerIds,
        gamemode,
        tier,
        region,
        timestamp: Date.now(),
      });
      setTimeout(() => interaction.channel.delete().catch((err) => console.error("Failed to delete ticket channel (submit):", err.message)), 5000);
    } catch (err) {
      console.error(err);
      return interaction.reply({
        content: "Something went wrong saving that to the database.",
        ephemeral: true,
      });
    }
  }
 } catch (err) {
   console.error("Interaction handler error:", err);
   try {
     if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
       await interaction.reply({ content: "Something went wrong handling that. Check the bot console for details.", ephemeral: true });
     } else if (interaction.isRepliable() && interaction.deferred && !interaction.replied) {
       await interaction.editReply({ content: "Something went wrong handling that. Check the bot console for details." });
     }
   } catch (_) {}
 }
});

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Load the persisted queue-message tracking before anything can post or
  // refresh a queue card — otherwise the first post after every restart
  // wouldn't know about the previous message and would leave it behind.
  await loadQueueMessages();

  const guildId = process.env.DISCORD_GUILD_ID;

  // Registers slash commands automatically on every boot — no shell access
  // needed (Render's free tier doesn't have one). Re-registering the same
  // command list is a harmless no-op; this only matters when a command is
  // added/changed, like /setupqueues just was.
  if (guildId && process.env.DISCORD_CLIENT_ID) {
    try {
      const rest = new REST().setToken(process.env.DISCORD_TOKEN);
      await rest.put(Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, guildId), {
        body: commands.map((c) => c.toJSON()),
      });
      console.log("[startup] slash commands registered");
    } catch (err) {
      console.error("[startup] slash command registration failed:", err.message);
    }
  } else {
    console.warn("[startup] DISCORD_CLIENT_ID or DISCORD_GUILD_ID not set, skipping command registration.");
  }

  if (!guildId) {
    console.warn("[roles] DISCORD_GUILD_ID not set, skipping role sync.");
    return;
  }

  const runSync = async () => {
    try {
      const guild = await client.guilds.fetch(guildId);
      await syncAllGuildMemberRoles(guild);
      console.log("[roles] guild role sync complete");
    } catch (err) {
      console.error("[roles] guild role sync failed:", err.message);
    }
  };

  await runSync();
  setInterval(runSync, 10 * 60 * 1000); // safety-net resync every 10 min

  try {
    const guild = await client.guilds.fetch(guildId);
    await initRealtimeSync(guild, {
      onActiveTestSet: (queueKey, info) => {
        setActiveTesting(queueKey, info);
      },
      onQueueStateChange: async (g, row) => {
        // row.gamemode is the queue key: "<gamemode>:<region>" for a
        // normal queue, or "<gamemode>:<region>:high" for that region's
        // high queue.
        const queueKey = row.gamemode;
        // Skip if the bot itself just wrote this change — postFreshQueueMessage
        // already posted the card; the realtime echo would double-post it.
        if (isRealtimeSuppressed(queueKey)) return;
        const [gamemode, region, maybeHigh] = queueKey.split(":");
        const isHigh = maybeHigh === "high";
        if (!gamemode || !region) return;

        // Find the tiertest channel matching both the gamemode AND region.
        const channel = g.channels.cache.find(
          (c) =>
            c.type === ChannelType.GuildText &&
            gamemodeForChannelName(c.name) === gamemode &&
            regionForChannelName(c.name) === region
        );
        if (!channel) return;

        const isNowOpen = !row.closed;
        try {
          if (isNowOpen) {
            // Queue was opened from the website — post fresh open card with ping.
            const pingContent = `${getRolePing(g, gamemode)}Queue is open! (${region})`;
            await postFreshQueueMessage(channel, queueKey, gamemode, {
              isHigh,
              content: pingContent,
            });
          } else {
            // Queue was closed from the website — post fresh closed card.
            await postFreshQueueMessage(channel, queueKey, gamemode, { isHigh });
          }
        } catch (err) {
          console.error("[realtime-sync] onQueueStateChange failed:", err.message);
        }
      },
    });
  } catch (err) {
    console.error("[realtime-sync] failed to start:", err.message);
  }

  // Lock down every known tiertest channel to testers-and-up on boot, so
  // this takes effect right away without needing a /setupqueues re-run.
  try {
    const guild = await client.guilds.fetch(guildId);
    const tiertestChannels = guild.channels.cache.filter(
      (c) => c.type === ChannelType.GuildText && gamemodeForChannelName(c.name)
    );
    for (const channel of tiertestChannels.values()) {
      await lockChannelToTesters(guild, channel);
    }
    console.log("[startup] tiertest channels locked to testers-and-up");
  } catch (err) {
    console.error("[startup] failed to lock tiertest channels:", err.message);
  }
});

// Fires whenever a member's roles (or anything else) change — keeps the
// website's permission flags current the moment staff are promoted/demoted.
client.on("guildMemberUpdate", (_oldMember, newMember) => {
  syncMemberRoles(newMember);
});

// Relays staff replies typed directly in a ticket channel back to the
// website (handleTicketChannelMessage no-ops instantly for any other
// channel, so this is cheap to call for every message).
client.on("messageCreate", async (message) => {
  handleTicketChannelMessage(message);

  // Sticky "Testing Punishments" message in #punishments channel.
  // Whenever anyone (including the bot's own sticky repost) sends a message,
  // delete the previous sticky and repost it at the bottom.
  const STICKY_CHANNEL_ID = "1555554731265630349";
  if (message.channelId === STICKY_CHANNEL_ID && !message.author.bot) {
    try {
      // Delete the previous sticky if we stored its ID
      if (client._stickyPunishmentsMessageId) {
        const ch = message.channel;
        const prev = await ch.messages.fetch(client._stickyPunishmentsMessageId).catch(() => null);
        if (prev) await prev.delete().catch(() => {});
      }
      const sticky = await message.channel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle("Testing Punishments")
            .setColor(0x2f7fd6)
            .setDescription(
              "Violations of #ranked-ruleset are handled case by case by staff, but as a general guide:\n\n" +
              "**Minor** *(being disrespectful to a tester, wasting a tester's time, minor sandbagging)*\n→ Warning, and the test may be voided.\n\n" +
              "**Major** *(cheating, using an alt to dodge a result, stream-sniping)*\n→ Test voided, temporary testing ban (duration at staff discretion).\n\n" +
              "**Severe** *(repeat offenses, abusive behavior toward staff/testers)*\n→ Permanent testing ban, possible server ban.\n\n" +
              "Disagree with a punishment? Open an **Appeal a tier** or **Help** ticket and explain your case."
            ),
        ],
      });
      client._stickyPunishmentsMessageId = sticky.id;
    } catch {}
  }
});

// Edits/deletes of a mirrored ticket message on the Discord side should show
// up the same way on the website — edit updates the row, delete removes it.
client.on("messageUpdate", async (oldMessage, newMessage) => {
  try {
    const full = newMessage.partial ? await newMessage.fetch().catch(() => null) : newMessage;
    if (!full) return;
    handleTicketChannelMessageEdit(full);
  } catch (err) {
    console.error("messageUpdate handler error:", err.message);
  }
});

client.on("messageDelete", (message) => {
  handleTicketChannelMessageDelete(message);
});

// Catch anything that slips through interaction handling so a single bad
// click can't take the whole bot process down.
process.on("unhandledRejection", (err) => {
  console.error("Unhandled promise rejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

// Render's free tier is built for web apps, not background workers. This
// tiny server does nothing except answer "OK" so Render (and an uptime
// pinger, if you set one up) sees the app as alive. It has no effect on
// the actual Discord bot logic above.
const http = require("http");
http
  .createServer((req, res) => res.end("RyftTiers bot is running."))
  .listen(process.env.PORT || 3000);

if (!process.env.DISCORD_TOKEN) {
  console.error("[startup] DISCORD_TOKEN environment variable is missing.");
  process.exit(1);
}

console.log("[startup] health server listening, attempting Discord login...");

client
  .login(process.env.DISCORD_TOKEN)
  .then(() => console.log("[startup] client.login() promise resolved"))
  .catch((err) => {
    console.error("[startup] client.login() rejected:", err.message);
  });
