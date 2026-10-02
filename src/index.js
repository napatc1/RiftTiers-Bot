console.log("[startup] index.js starting...");
require("dotenv").config();
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
} = require("discord.js");
const commands = require("./commands");
const {
  GAMEMODE_CHANNELS,
  GAMEMODES,
  TIER_OPTIONS,
  COOLDOWN_DAYS,
  GAMEMODE_PING_ROLE_NAMES,
  PERMISSION_ROLE_IDS,
  SUPPORT_CATEGORY_NAME,
  GENERAL_CATEGORY_NAME,
  TESTING_CATEGORY_NAME,
  TESTING_CHANNELS,
  BASIC_CHANNELS,
  DEFAULT_CHANNELS_TO_REMOVE,
  tierRoleName,
  queueCategoryName,
} = require("./config");
const {
  supabase,
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
  getQueueLastOpenedAt,
  setQueueRegion,
  getQueueRegion,
  addQueueTester,
  removeQueueTester,
  getQueueTesterIds,
  setActiveTesting,
  getActiveTesting,
  getActiveTestingByTicket,
  clearActiveTestingByTicket,
  setQueueMessage,
  getQueueMessage,
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

// @everyone only actually pings when it's in a message's plain content, not
// inside an embed, so this is sent as a normal message rather than an
// embed. commandsChannel is a Channel object (or null, if #commands
// somehow isn't around) — mentioned so players know where to run /leave.
function buildWaitingListMessage(gamemodeDisplay, commandsChannel) {
  const commandsMention = commandsChannel ? `<#${commandsChannel.id}>` : "#commands";
  return `@everyone
**__${gamemodeDisplay} Tier Test__**

Being in the waitlist simply means that you are waiting to be tested at some point, it does not mean you are immediately going to be tested right away. Please be patient!

The queue is what you join once you are ready to actually test. When a tester for this region becomes available, @here will be pinged with a button to join the queue. This button is meant for players readily available to log on for their evaluation test.

If no testers are available, the queue card here will show **No Testers Online** and the Join button will be disabled. You'll be pinged the moment a tester opens it back up.

After a tester has marked themselves as unavailable with no other testers active, the queue will be closed. If you were in the queue, your queue position will not be saved. You can still enter the queue again like normal whenever a tester becomes available.


If you decide you no longer want to be tested, use \`/leave\` in the ${commandsMention} channel.`;
}

function buildVerifyInfoEmbed() {
  return new EmbedBuilder()
    .setTitle("Link your account to RiftTiers")
    .setDescription(
      "Linking takes two quick steps — one on the website, one with the bot.\n\n" +
        "**1. Log into the website**\nOpen the RiftTiers website and click **Login with Discord** in the top-right corner. Once you're logged in you can join queues, open a Support ticket, and (if you're a tester) claim tests and submit results, right from the site.\n\n" +
        "**2. Link your Minecraft username**\nIn any channel here, run:\n```/verify username:<your IGN> platform:<Bedrock/Premium/Cracked>```\nThis tells the bot which Minecraft account is yours so testers can see it and your tier shows up correctly on the leaderboard.\n\n" +
        "Once both are done, you can join a tiertest queue from Discord **or** the website — they're the same queue."
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

// Warns a player if their stored region doesn't match the region a tester
// picked for this queue session. Non-blocking — they can still join.
async function regionMismatchWarning(discordUserId, queueRegion) {
  if (!queueRegion) return "";
  const username = await getVerifiedUsername(discordUserId);
  if (!username) return "";
  const player = await getPlayer(username);
  if (!player || !player.region || player.region === queueRegion) return "";
  return `\n\n⚠️ If you join this queue, the tester will only allow you to test on **${queueRegion}** servers.`;
}

// queueKey is the gamemode id ("vanilla") for a normal queue, or
// "<gamemode>:high" for that gamemode's high queue. These are the same
// Supabase tables the website's Testing tab reads/writes, so a queue
// joined here shows up there too (and vice versa).

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
function queueAuthor(gamemode) {
  const display = GAMEMODE_PING_ROLE_NAMES[gamemode] || gamemode.toUpperCase();
  return {
    name: `RiftTiers — ${display} Tier Test`,
    iconURL: client.user ? client.user.displayAvatarURL() : undefined,
  };
}

// "No Testers Online" card shown in place of the queue list while closed —
// styled after MCTiers' closed-queue embed: a branded header, a bold
// heading, a short friendly explanation, and a clean last-session date.
async function closedCardDescription(queueKey, region) {
  const lastOpenedAt = await getQueueLastOpenedAt(queueKey);
  const ts = absoluteTimestamp(lastOpenedAt);
  return (
    (region ? `**Region:** ${region}\n\n` : "") +
    "**No Testers Online**\n" +
    "No testers are available for this gamemode right now. You'll be pinged here the moment a tester opens the queue — check back later!\n\n" +
    `**Last testing session:** ${ts || "Hasn't been opened yet."}`
  );
}

async function buildQueueEmbed(queueKey, gamemode) {
  const [closed, count, region, testersBlock, queueText] = await Promise.all([
    isQueueClosed(queueKey),
    getQueueCount(queueKey),
    getQueueRegion(queueKey),
    activeTestersBlock(queueKey),
    formatQueue(queueKey),
  ]);
  const embed = new EmbedBuilder()
    .setAuthor(queueAuthor(gamemode))
    .setColor(closed ? 0x555555 : 0xffd54a);
  if (closed) {
    return embed.setDescription(await closedCardDescription(queueKey, region));
  }
  return embed
    .setTitle(`${gamemode.toUpperCase()} Queue (${count})`)
    .setDescription(
      (region ? `**Server Region:** ${region}\n\n` : "") + testersBlock + queueText
    );
}

async function buildHighQueueEmbed(highKey, gamemode) {
  const [closed, count, region, testersBlock, queueText] = await Promise.all([
    isQueueClosed(highKey),
    getQueueCount(highKey),
    getQueueRegion(highKey),
    activeTestersBlock(highKey),
    formatQueue(highKey),
  ]);
  const embed = new EmbedBuilder()
    .setAuthor(queueAuthor(gamemode))
    .setColor(closed ? 0x555555 : 0xff8a3d);
  if (closed) {
    return embed.setDescription(await closedCardDescription(highKey, region));
  }
  return embed
    .setTitle(`${gamemode.toUpperCase()} HIGH Queue (${count})`)
    .setDescription(
      (region ? `**Server Region:** ${region}\n\n` : "") +
        testersBlock +
        `Only players already tiered **LT3 or better** in ${gamemode.toUpperCase()} can join.\n\n${queueText}`
    );
}

// Main queue message: anyone can Join/Leave, testers can pull Next or
// close/reopen the queue to new joins.
async function buildQueueButtons(queueKey) {
  const closed = await isQueueClosed(queueKey);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("queue_join")
      .setLabel("Join Queue")
      .setStyle(ButtonStyle.Success)
      .setDisabled(closed),
    new ButtonBuilder()
      .setCustomId("queue_leave")
      .setLabel("Leave Queue")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("queue_next")
      .setLabel("Next (Tester)")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("queue_toggle_close")
      .setLabel(closed ? "Unlock Queue" : "Lock Queue")
      .setStyle(closed ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("queue_delete")
      .setLabel("Close Queue")
      .setStyle(ButtonStyle.Danger)
  );
}

async function buildHighQueueButtons(highKey) {
  const closed = await isQueueClosed(highKey);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("highqueue_join")
      .setLabel("Join High Queue")
      .setStyle(ButtonStyle.Success)
      .setDisabled(closed),
    new ButtonBuilder()
      .setCustomId("highqueue_leave")
      .setLabel("Leave Queue")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("highqueue_next")
      .setLabel("Next (Tester)")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("highqueue_toggle_close")
      .setLabel(closed ? "Unlock Queue" : "Lock Queue")
      .setStyle(closed ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("highqueue_delete")
      .setLabel("Close Queue")
      .setStyle(ButtonStyle.Danger)
  );
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

async function refreshQueueMessage(interaction, gamemode) {
  await interaction.message.edit({
    embeds: [await buildQueueEmbed(gamemode, gamemode)],
    components: [await buildQueueButtons(gamemode)],
  });
}

async function refreshHighQueueMessage(interaction, gamemode) {
  const highKey = `${gamemode}:high`;
  await interaction.message.edit({
    embeds: [await buildHighQueueEmbed(highKey, gamemode)],
    components: [await buildHighQueueButtons(highKey)],
  });
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
        components: [await buildHighQueueButtons(highKey)],
      });
    } else {
      await queueMessage.edit({
        embeds: [await buildQueueEmbed(info.gamemode, info.gamemode)],
        components: [await buildQueueButtons(info.gamemode)],
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
async function createTicketChannel(guild, sourceChannel, gamemode, testerMember, testeeId) {
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

  const channel = await guild.channels.create({
    name: `ticket-${gamemode}-${slugify(testeeMember ? testeeMember.user.username : testeeId)}`,
    type: ChannelType.GuildText,
    parent: sourceChannel.parentId || null,
    permissionOverwrites: overwrites,
  });

  const testeeUsername = await getVerifiedUsername(testeeId);
  const testeePlatform = await getVerifiedPlatform(testeeId);
  const testeeRecord = testeeUsername ? await getPlayer(testeeUsername) : null;
  const platformLabel = { bedrock: "Bedrock", premium: "Premium", cracked: "Cracked" }[testeePlatform] || "Unknown";
  const testeeInfoLine = testeeUsername
    ? `**IGN:** ${testeeUsername} (${platformLabel})\n**Region:** ${testeeRecord?.region || "Unverified/new"}\n`
    : `**IGN:** Not verified — ask them to run \`/verify\`\n`;

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

// ---------- interactions ----------

client.on("interactionCreate", async (interaction) => {
 try {
  // /postqueue
  if (interaction.isChatInputCommand() && interaction.commandName === "postqueue") {
    const gamemode = GAMEMODE_CHANNELS[interaction.channel.name];
    if (!gamemode) {
      return interaction.reply({
        content: "This channel isn't set up as a tiertest channel in config.js.",
        ephemeral: true,
      });
    }
    await addQueueTester(gamemode, interaction.user.id);
    const queueRegion = interaction.options.getString("region", true);
    await setQueueRegion(gamemode, queueRegion);
    await interaction.reply({ content: "Queue posted below.", ephemeral: true });
    const queueMsg = await interaction.channel.send({
      content: `${getRolePing(interaction.guild, gamemode)}Queue is open!`,
      embeds: [await buildQueueEmbed(gamemode, gamemode)],
      components: [await buildQueueButtons(gamemode)],
    });
    setQueueMessage(gamemode, interaction.channelId, queueMsg.id);
    return;
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
    const region = interaction.options.getString("region", true);

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

    // "Testing" category: reference channels (rubric, results) separate from
    // the per-gamemode queue categories. #testing-rubric gets the rubric
    // posted automatically the first time it's created.
    let testingCategory = interaction.guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === TESTING_CATEGORY_NAME.toLowerCase()
    );
    if (!testingCategory) {
      testingCategory = await interaction.guild.channels.create({
        name: TESTING_CATEGORY_NAME,
        type: ChannelType.GuildCategory,
      });
    }
    const testingCreated = [];
    for (const spec of TESTING_CHANNELS) {
      let channel = interaction.guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildText && c.name === spec.name
      );
      let justCreated = false;
      if (!channel) {
        channel = await interaction.guild.channels.create({
          name: spec.name,
          type: ChannelType.GuildText,
          parent: testingCategory.id,
        });
        testingCreated.push(spec.name);
        justCreated = true;
      } else if (channel.parentId !== testingCategory.id) {
        await channel.setParent(testingCategory.id, { lockPermissions: false }).catch(() => {});
      }
      if (spec.name === "testing-rubric" && justCreated) {
        await channel.send({ embeds: [buildTestingRubricEmbed()] }).catch(() => {});
      }
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

    for (const [channelName, gamemode] of Object.entries(GAMEMODE_CHANNELS)) {
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

      let channel = interaction.guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildText && c.name === channelName
      );
      if (!channel) {
        channel = await interaction.guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          parent: category.id,
        });
        created.push(channelName);
      } else if (channel.parentId !== category.id) {
        await channel.setParent(category.id, { lockPermissions: false }).catch(() => {});
      }

      const existingMsgInfo = getQueueMessage(gamemode);
      if (existingMsgInfo) {
        skipped.push(channelName);
        continue;
      }

      // Pinned-style explainer, pinging @everyone — posted once per channel
      // alongside the queue message below (so a bot restart that loses
      // track of the queue message, per channel.send() below, doesn't
      // re-spam this too... except it will, same as the queue message
      // itself, since neither is tracked in Supabase. Acceptable for now.
      const display = GAMEMODE_PING_ROLE_NAMES[gamemode] || gamemode;
      await channel.send({ content: buildWaitingListMessage(display, commandsChannel) }).catch(() => {});

      // New queues start CLOSED — staff open them explicitly (button or
      // /postqueue) when they're actually ready to test. No ping here since
      // there's nothing to join yet.
      await setQueueRegion(gamemode, region);
      await setQueueClosed(gamemode, true);
      const queueMsg = await channel.send({
        embeds: [await buildQueueEmbed(gamemode, gamemode)],
        components: [await buildQueueButtons(gamemode)],
      });
      setQueueMessage(gamemode, channel.id, queueMsg.id);
      posted.push(channelName);
    }

    const lines = [];
    if (rolesCreated.length) lines.push(`**Ping roles created:** ${rolesCreated.join(", ")}`);
    if (tierRolesCreatedCount) lines.push(`**Tier roles created:** ${tierRolesCreatedCount}`);
    if (basicCreated.length) lines.push(`**Basic channels created:** ${basicCreated.map((n) => `#${n}`).join(", ")}`);
    if (testingCreated.length) lines.push(`**Testing channels created:** ${testingCreated.map((n) => `#${n}`).join(", ")}`);
    if (deleted.length) lines.push(`**Deleted:** ${deleted.join(", ")}`);
    if (categoriesCreated.length) lines.push(`**Categories created:** ${categoriesCreated.join(", ")}`);
    if (created.length) lines.push(`**Channels created:** ${created.join(", ")}`);
    if (posted.length) lines.push(`**Posted a queue (closed) in:** ${posted.join(", ")}`);
    if (skipped.length) lines.push(`**Already set up (skipped):** ${skipped.join(", ")}`);
    return interaction.editReply({
      content: lines.length ? lines.join("\n") : "Nothing to do — everything's already set up.",
    });
  }

  // /verify
  if (interaction.isChatInputCommand() && interaction.commandName === "verify") {
    const username = interaction.options.getString("username", true).trim();
    const platform = interaction.options.getString("platform", true);
    if (/[.#$\[\]]/.test(username)) {
      return interaction.reply({
        content: `"${username}" isn't a valid Minecraft username — it can't contain ".", "#", "$", "[", or "]".`,
        ephemeral: true,
      });
    }
    await setVerifiedUsername(interaction.user.id, username, platform);
    const platformLabel = { bedrock: "Bedrock", premium: "Premium", cracked: "Cracked" }[platform];
    return interaction.reply({
      content: `Linked your Discord account to Minecraft username **${username}** (${platformLabel}).`,
      ephemeral: true,
    });
  }

  // /postverifyinfo — posts step-by-step "how to link your account" info to
  // a fixed channel. Staff-only, meant to be run once (or again after an
  // edit), not on every bot restart.
  if (interaction.isChatInputCommand() && interaction.commandName === "postverifyinfo") {
    if (!canManageCooldowns(interaction.member)) {
      return interaction.reply({ content: "Only testers, managers, or admins can do that.", ephemeral: true });
    }
    try {
      const byName = interaction.guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildText && c.name.toLowerCase() === "verify"
      );
      const channel =
        byName || (await interaction.guild.channels.fetch(process.env.VERIFY_CHANNEL_ID || "1555518328028536832"));
      await channel.send({ embeds: [buildVerifyInfoEmbed()] });
      return interaction.reply({ content: "Posted.", ephemeral: true });
    } catch (err) {
      console.error(err);
      return interaction.reply({
        content: "Couldn't post to that channel — make sure the bot can see it and has Send Messages permission there.",
        ephemeral: true,
      });
    }
  }

  // /jointesting
  if (interaction.isChatInputCommand() && interaction.commandName === "jointesting") {
    if (!isTester(interaction.member)) {
      return interaction.reply({ content: "Only testers can do that.", ephemeral: true });
    }
    const gamemode = GAMEMODE_CHANNELS[interaction.channel.name];
    if (!gamemode) {
      return interaction.reply({
        content: "Run this in a tiertest queue channel, not here.",
        ephemeral: true,
      });
    }

    const added = await addQueueTester(gamemode, interaction.user.id);
    if (!added) {
      return interaction.reply({
        content: `You're already testing **${gamemode}**.`,
        ephemeral: true,
      });
    }

    // If a test is already in progress, add this tester to that ticket too
    // so they don't have to wait for the next pull.
    const active = getActiveTesting(gamemode);
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
      const stored = getQueueMessage(gamemode);
      if (stored) {
        const queueChannel = await interaction.guild.channels.fetch(stored.channelId);
        const queueMessage = await queueChannel.messages.fetch(stored.messageId);
        await queueMessage.edit({
          embeds: [await buildQueueEmbed(gamemode, gamemode)],
          components: [await buildQueueButtons(gamemode)],
        });
      }
    } catch (err) {
      console.error("Couldn't refresh queue message after jointesting:", err.message);
    }

    return interaction.reply({
      content: `You're now testing **${gamemode}** alongside the other tester(s).`,
      ephemeral: true,
    });
  }

  // /leavetesting
  if (interaction.isChatInputCommand() && interaction.commandName === "leavetesting") {
    const gamemode = GAMEMODE_CHANNELS[interaction.channel.name];
    if (!gamemode) {
      return interaction.reply({
        content: "Run this in a tiertest queue channel, not here.",
        ephemeral: true,
      });
    }

    const removed = await removeQueueTester(gamemode, interaction.user.id);
    if (!removed) {
      return interaction.reply({
        content: `You're not currently testing **${gamemode}**.`,
        ephemeral: true,
      });
    }

    // If a test is in progress and this tester was part of it, drop them
    // from that ticket's tester list and revoke their personal access.
    const active = getActiveTesting(gamemode);
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
      const stored = getQueueMessage(gamemode);
      if (stored) {
        const queueChannel = await interaction.guild.channels.fetch(stored.channelId);
        const queueMessage = await queueChannel.messages.fetch(stored.messageId);
        await queueMessage.edit({
          embeds: [await buildQueueEmbed(gamemode, gamemode)],
          components: [await buildQueueButtons(gamemode)],
        });
      }
    } catch (err) {
      console.error("Couldn't refresh queue message after leavetesting:", err.message);
    }

    return interaction.reply({
      content: `You've stopped testing **${gamemode}**.`,
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

  // /posthighqueue
  if (interaction.isChatInputCommand() && interaction.commandName === "posthighqueue") {
    const gamemode = GAMEMODE_CHANNELS[interaction.channel.name];
    if (!gamemode) {
      return interaction.reply({
        content: "This channel isn't set up as a tiertest channel in config.js.",
        ephemeral: true,
      });
    }
    const highKey = `${gamemode}:high`;
    await addQueueTester(highKey, interaction.user.id);
    const highQueueRegion = interaction.options.getString("region", true);
    await setQueueRegion(highKey, highQueueRegion);
    await interaction.reply({ content: "High queue posted below.", ephemeral: true });
    const highQueueMsg = await interaction.channel.send({
      content: `${getRolePing(interaction.guild, gamemode)}High queue is open!`,
      embeds: [await buildHighQueueEmbed(highKey, gamemode)],
      components: [await buildHighQueueButtons(highKey)],
    });
    setQueueMessage(highKey, interaction.channelId, highQueueMsg.id);
    return;
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
          content: `<@${pingedPlayer.id}> hasn't linked a Minecraft username yet — have them run \`/verify\` first, or type the "username" option manually instead.`,
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
    // Ticket-only buttons (submit / close) work in ticket channels, which
    // aren't in GAMEMODE_CHANNELS, so handle those before the gamemode check.
    if (interaction.customId.startsWith("ticket_submit_")) {
      if (!isTester(interaction.member)) {
        return interaction.reply({ content: "Only testers can do that.", ephemeral: true });
      }
      const [, , gamemode, testeeId] = interaction.customId.split("_");

      const verifiedUsername = await getVerifiedUsername(testeeId);
      if (!verifiedUsername) {
        return interaction.reply({
          content: `<@${testeeId}> hasn't linked a Minecraft username yet. They need to run \`/verify username:<their IGN>\` before a result can be submitted.`,
          ephemeral: true,
        });
      }

      const modal = new ModalBuilder()
        .setCustomId(`submit_result_${gamemode}_${testeeId}`)
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

    // Everything below only applies inside actual gamemode queue channels.
    const gamemode = GAMEMODE_CHANNELS[interaction.channel.name];
    if (!gamemode) return;

    if (interaction.customId === "queue_join") {
      const verifiedUsername = await getVerifiedUsername(interaction.user.id);
      if (!verifiedUsername) {
        return interaction.reply({
          content:
            "You need to verify before joining a queue — head to the **Verify** tab on the website (or run `/verify`) to link your Minecraft account first.",
          ephemeral: true,
        });
      }
      if (await isQueueClosed(gamemode)) {
        return interaction.reply({ content: "This queue is closed right now.", ephemeral: true });
      }
      const cooldownUntil = await getCooldownUntil(gamemode, interaction.user.id);
      if (cooldownUntil && cooldownUntil > Date.now()) {
        return interaction.reply({
          content: `You were tested in **${gamemode}** recently. You can queue again in ${formatRemaining(cooldownUntil - Date.now())}.`,
          ephemeral: true,
        });
      }
      const queueRegion = await getQueueRegion(gamemode);
      const joined = await joinQueue(gamemode, interaction.user.id, queueRegion);
      await refreshQueueMessage(interaction, gamemode);
      const warning = joined ? await regionMismatchWarning(interaction.user.id, queueRegion) : "";
      return interaction.reply({
        content: (joined ? "You joined the queue." : "You're already in the queue.") + warning,
        ephemeral: true,
      });
    }

    if (interaction.customId === "queue_leave") {
      const left = await leaveQueue(gamemode, interaction.user.id);
      await refreshQueueMessage(interaction, gamemode);
      return interaction.reply({
        content: left ? "You left the queue." : "You weren't in the queue.",
        ephemeral: true,
      });
    }

    if (interaction.customId === "queue_toggle_close") {
      if (!isTester(interaction.member)) {
        return interaction.reply({ content: "Only testers can do that.", ephemeral: true });
      }
      const nowClosed = !(await isQueueClosed(gamemode));
      await setQueueClosed(gamemode, nowClosed);
      await refreshQueueMessage(interaction, gamemode);
      if (!nowClosed) {
        // Unlocking: ping publicly since the confirmation below is ephemeral.
        await interaction.channel.send({
          content: `${getRolePing(interaction.guild, gamemode)}Queue is open again!`,
        });
      }
      return interaction.reply({
        content: nowClosed ? "Queue locked to new joins." : "Queue unlocked.",
        ephemeral: true,
      });
    }

    if (interaction.customId === "queue_delete") {
      if (!isTester(interaction.member)) {
        return interaction.reply({ content: "Only testers can do that.", ephemeral: true });
      }
      await interaction.reply({ content: "Closing this queue.", ephemeral: true });
      await interaction.message.delete().catch(() => {});
      return;
    }

    if (interaction.customId === "queue_next") {
      if (!isTester(interaction.member)) {
        return interaction.reply({ content: "Only testers can do that.", ephemeral: true });
      }
      // Ack immediately — the Supabase/Discord lookups below can take
      // longer than Discord's 3-second reply window.
      await interaction.deferReply({ ephemeral: true });

      await addQueueTester(gamemode, interaction.member.id);
      const nextUserId = await popNext(gamemode);

      if (!nextUserId) {
        await refreshQueueMessage(interaction, gamemode);
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
        const testerIds = await getQueueTesterIds(gamemode);
        setActiveTesting(gamemode, {
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

        await refreshQueueMessage(interaction, gamemode);
        return interaction.editReply({
          content: `Created a private ticket for <@${nextUserId}>: ${ticketChannel}`,
        });
      } catch (err) {
        console.error(err);
        await refreshQueueMessage(interaction, gamemode);
        return interaction.editReply({
          content:
            "Couldn't create the ticket channel. Make sure the bot has the \"Manage Channels\" permission.",
        });
      }
    }

    // ---------- high queue ----------
    if (interaction.customId === "highqueue_join") {
      const highKey = `${gamemode}:high`;

      if (await isQueueClosed(highKey)) {
        return interaction.reply({ content: "This queue is closed right now.", ephemeral: true });
      }

      const username = await getVerifiedUsername(interaction.user.id);
      if (!username) {
        return interaction.reply({
          content: `You need to link your Minecraft account first — run \`/verify username:<your IGN>\`, then try joining again.`,
          ephemeral: true,
        });
      }

      const player = await getPlayer(username);
      const currentTier = player?.tiers?.[gamemode];
      const tierIndex = currentTier ? TIER_OPTIONS.indexOf(currentTier) : -1;

      if (tierIndex === -1 || tierIndex > HIGH_QUEUE_MAX_INDEX) {
        return interaction.reply({
          content: `The high queue for **${gamemode}** is only open to players already tiered **LT3 or better**. Your current tier: **${currentTier || "Untested"}**.`,
          ephemeral: true,
        });
      }

      const highQueueRegionSet = await getQueueRegion(highKey);
      const joined = await joinQueue(highKey, interaction.user.id, highQueueRegionSet);
      await refreshHighQueueMessage(interaction, gamemode);
      const warning =
        joined && highQueueRegionSet && player?.region && player.region !== highQueueRegionSet
          ? `\n\n⚠️ If you join this queue, the tester will only allow you to test on **${highQueueRegionSet}** servers.`
          : "";
      return interaction.reply({
        content: (joined ? "You joined the high queue." : "You're already in the high queue.") + warning,
        ephemeral: true,
      });
    }

    if (interaction.customId === "highqueue_leave") {
      const highKey = `${gamemode}:high`;
      const left = await leaveQueue(highKey, interaction.user.id);
      await refreshHighQueueMessage(interaction, gamemode);
      return interaction.reply({
        content: left ? "You left the high queue." : "You weren't in the high queue.",
        ephemeral: true,
      });
    }

    if (interaction.customId === "highqueue_toggle_close") {
      if (!isTester(interaction.member)) {
        return interaction.reply({ content: "Only testers can do that.", ephemeral: true });
      }
      const highKey = `${gamemode}:high`;
      const nowClosed = !(await isQueueClosed(highKey));
      await setQueueClosed(highKey, nowClosed);
      await refreshHighQueueMessage(interaction, gamemode);
      if (!nowClosed) {
        await interaction.channel.send({
          content: `${getRolePing(interaction.guild, gamemode)}High queue is open again!`,
        });
      }
      return interaction.reply({
        content: nowClosed ? "High queue locked to new joins." : "High queue unlocked.",
        ephemeral: true,
      });
    }

    if (interaction.customId === "highqueue_delete") {
      if (!isTester(interaction.member)) {
        return interaction.reply({ content: "Only testers can do that.", ephemeral: true });
      }
      await interaction.reply({ content: "Closing this high queue.", ephemeral: true });
      await interaction.message.delete().catch(() => {});
      return;
    }

    if (interaction.customId === "highqueue_next") {
      if (!isTester(interaction.member)) {
        return interaction.reply({ content: "Only testers can do that.", ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });

      const highKey = `${gamemode}:high`;
      await addQueueTester(highKey, interaction.member.id);
      const nextUserId = await popNext(highKey);

      if (!nextUserId) {
        await refreshHighQueueMessage(interaction, gamemode);
        return interaction.editReply({ content: "High queue is empty." });
      }

      try {
        const ticketChannel = await createTicketChannel(
          interaction.guild,
          interaction.channel,
          gamemode,
          interaction.member,
          nextUserId
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

        await refreshHighQueueMessage(interaction, gamemode);
        return interaction.editReply({
          content: `Created a private ticket for <@${nextUserId}>: ${ticketChannel}`,
        });
      } catch (err) {
        console.error(err);
        await refreshHighQueueMessage(interaction, gamemode);
        return interaction.editReply({
          content:
            "Couldn't create the ticket channel. Make sure the bot has the \"Manage Channels\" permission.",
        });
      }
    }
  }

  // ---------- modal submit ----------
  if (interaction.isModalSubmit() && interaction.customId.startsWith("submit_result_")) {
    const [, , gamemode, testeeId] = interaction.customId.split("_");
    const region = interaction.fields.getTextInputValue("player_region").trim().toUpperCase();
    const tier = interaction.fields.getTextInputValue("player_tier").trim().toUpperCase();

    const name = await getVerifiedUsername(testeeId);
    if (!name) {
      return interaction.reply({
        content: `<@${testeeId}> isn't verified anymore — they need to run \`/verify\` again before this can be saved.`,
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
    await initRealtimeSync(guild);
  } catch (err) {
    console.error("[realtime-sync] failed to start:", err.message);
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
client.on("messageCreate", (message) => {
  handleTicketChannelMessage(message);
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
  .createServer((req, res) => res.end("RiftTiers bot is running."))
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
