// Keeps Discord in sync with things that happen purely in Supabase (i.e.
// via the website, which never talks to Discord directly): a player's tier
// changing, and support tickets/messages. Subscribes to Postgres changes
// over Supabase Realtime and reacts to each one. Also exposes
// handleTicketChannelMessage(), which index.js's messageCreate listener
// calls so staff replies typed in a ticket channel make it back to the
// website.
const { EmbedBuilder, ChannelType, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { supabase, ensurePlayerForDiscordUser } = require("./supabase");
const { GAMEMODE_PING_ROLE_NAMES, PERMISSION_ROLE_IDS, SUPPORT_CATEGORY_NAME, tierRoleName, queueCategoryName } = require("./config");

const VERIFIED_ROLE_ID = "1556203882529558539";

// channelId -> ticketId, kept in memory so messageCreate can cheaply tell
// whether a message was typed in a ticket channel at all. Rebuilt on every
// boot from open tickets, and kept current by the support_tickets
// subscription below.
const ticketChannelMap = new Map();

// channelId -> liveTestId, same idea for test ticket channels.
// Populated from live_tests on boot and kept current as channels are created.
const testChannelMap = new Map();

function sanitizeChannelName(name) {
  return (
    (name || "player")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "player"
  );
}

// ---------- verified role ----------

// Called when a players row is inserted or updated with a discord_id set.
// Grants the Verified role so gated channels become visible.
async function grantVerifiedRole(guild, discordId) {
  if (!discordId) return;
  try {
    const member = await guild.members.fetch(discordId).catch(() => null);
    if (!member) return;
    const role = guild.roles.cache.get(VERIFIED_ROLE_ID);
    if (!role) {
      console.warn("[realtime-sync] Verified role not found:", VERIFIED_ROLE_ID);
      return;
    }
    if (!member.roles.cache.has(VERIFIED_ROLE_ID)) {
      await member.roles.add(role).catch(() => {});
      console.log(`[realtime-sync] granted Verified role to ${discordId}`);
    }
  } catch (err) {
    console.error("[realtime-sync] grantVerifiedRole failed:", err.message);
  }
}

// ---------- tier roles ----------

// Removes any other tier role for this gamemode and adds the right one,
// creating it first if it somehow doesn't exist yet. No-ops quietly if the
// player has no linked Discord account or isn't in the server.
async function assignTierRole(guild, playerId, gamemode, tier) {
  try {
    const { data: player } = await supabase
      .from("players")
      .select("discord_id")
      .eq("id", playerId)
      .maybeSingle();
    if (!player || !player.discord_id) return;

    const member = await guild.members.fetch(player.discord_id).catch(() => null);
    if (!member) return;

    const gamemodePrefix = `${(GAMEMODE_PING_ROLE_NAMES[gamemode] || gamemode).toLowerCase()} `;
    const targetName = tierRoleName(gamemode, tier);

    const toRemove = member.roles.cache.filter(
      (r) => r.name.toLowerCase().startsWith(gamemodePrefix) && r.name !== targetName
    );
    for (const role of toRemove.values()) {
      await member.roles.remove(role).catch(() => {});
    }

    let targetRole = guild.roles.cache.find((r) => r.name === targetName);
    if (!targetRole) {
      targetRole = await guild.roles.create({ name: targetName, mentionable: false }).catch(() => null);
    }
    if (targetRole && !member.roles.cache.has(targetRole.id)) {
      await member.roles.add(targetRole).catch(() => {});
    }
  } catch (err) {
    console.error("[realtime-sync] assignTierRole failed:", err.message);
  }
}

// ---------- support tickets ----------

async function getOrCreateSupportCategory(guild) {
  let category = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === SUPPORT_CATEGORY_NAME.toLowerCase()
  );
  if (!category) {
    const overwrites = [{ id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] }];
    for (const roleId of [PERMISSION_ROLE_IDS.moderator, PERMISSION_ROLE_IDS.owner]) {
      if (roleId) {
        overwrites.push({
          id: roleId,
          allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages],
        });
      }
    }
    category = await guild.channels.create({
      name: SUPPORT_CATEGORY_NAME,
      type: ChannelType.GuildCategory,
      permissionOverwrites: overwrites,
    });
  }
  return category;
}

function ticketCategoryLabel(id) {
  return (
    { help: "Help", report: "Report a player", appeal: "Appeal a tier", hightest: "High Tier Test Request" }[id] || id
  );
}

function buildTicketCloseButton(ticketId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`support_ticket_close_${ticketId}`)
      .setLabel("Close Ticket")
      .setStyle(ButtonStyle.Danger)
  );
}

// New support_tickets row -> create its Discord channel, post the opening
// message, and remember the mapping.
async function createTicketChannel(guild, ticket) {
  try {
    if (ticket.discord_channel_id) {
      ticketChannelMap.set(ticket.discord_channel_id, ticket.id);
      return;
    }

    const { data: player } = await supabase
      .from("players")
      .select("username")
      .eq("id", ticket.player_id)
      .maybeSingle();

    const category = await getOrCreateSupportCategory(guild);
    const channelName = `${sanitizeChannelName(player?.username)}-ticket`;
    const channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: category.id,
    });

    const { data: firstMessage } = await supabase
      .from("support_messages")
      .select("content")
      .eq("ticket_id", ticket.id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle(`${ticketCategoryLabel(ticket.category)}: ${ticket.subject}`)
          .setDescription(
            `Opened by **${player?.username || "a player"}**.\n\n` +
              (firstMessage?.content || "*(no message)*") +
              "\n\nReplies here are sent to the player on the website, and their replies show up here too. Edits and deletes sync too. Use **Close Ticket** below (or close it on the website) to close it — either way deletes this channel and moves it to ticket history on the site."
          )
          .setColor(0x3fa0f5),
      ],
      components: [buildTicketCloseButton(ticket.id)],
    });

    await supabase
      .from("support_tickets")
      .update({ discord_channel_id: channel.id })
      .eq("id", ticket.id);

    ticketChannelMap.set(channel.id, ticket.id);
  } catch (err) {
    console.error("[realtime-sync] createTicketChannel failed:", err.message);
  }
}

// A closed ticket keeps living as "History" on the website only — the
// Discord side of it is torn down entirely (no leftover/archive channel in
// Discord). Posts a quick heads-up, then deletes the channel a few seconds
// later so anyone currently looking at it sees why it's going away.
async function closeTicketChannel(guild, ticket) {
  try {
    if (!ticket.discord_channel_id) return;
    const channel = await guild.channels.fetch(ticket.discord_channel_id).catch(() => null);
    if (!channel) return;
    ticketChannelMap.delete(channel.id);
    await channel.send({ content: "🔒 This ticket was closed — this channel will be deleted shortly. It's kept in ticket history on the site." }).catch(() => {});
    setTimeout(() => {
      channel.delete().catch((err) => console.error("[realtime-sync] failed to delete closed ticket channel:", err.message));
    }, 5000);
  } catch (err) {
    console.error("[realtime-sync] closeTicketChannel failed:", err.message);
  }
}

// New support_messages row from the website -> mirror it into the ticket's
// Discord channel. Rows that originated in Discord (source: "discord") are
// skipped here since they're already in the channel they came from.
async function mirrorMessageToDiscord(guild, message) {
  try {
    if (message.source !== "website") return;
    const { data: ticket } = await supabase
      .from("support_tickets")
      .select("discord_channel_id")
      .eq("id", message.ticket_id)
      .maybeSingle();
    if (!ticket || !ticket.discord_channel_id) return;

    const channel = await guild.channels.fetch(ticket.discord_channel_id).catch(() => null);
    if (!channel) return;

    await channel.send({
      content: `**${message.author_label || "Staff"} (website):** ${message.content}`,
    });
  } catch (err) {
    console.error("[realtime-sync] mirrorMessageToDiscord failed:", err.message);
  }
}

// Called from index.js's messageCreate listener for every message. No-ops
// immediately unless the channel is a known open ticket channel.
async function handleTicketChannelMessage(message) {
  if (message.author.bot) return;
  const ticketId = ticketChannelMap.get(message.channelId);
  if (!ticketId) return;

  try {
    const player = await ensurePlayerForDiscordUser(
      message.author.id,
      message.member?.displayName || message.author.username
    );
    await supabase.from("support_messages").insert({
      ticket_id: ticketId,
      author_player_id: player?.id || null,
      author_label: message.member?.displayName || message.author.username,
      source: "discord",
      content: message.content || "*(no text content)*",
      discord_message_id: message.id,
    });
  } catch (err) {
    console.error("[realtime-sync] handleTicketChannelMessage failed:", err.message);
  }
}

// Called from index.js's messageUpdate listener. Only known ticket-channel
// messages that we actually mirrored (i.e. have a discord_message_id row)
// are updated — edits to anything else, or to the bot's own messages, are
// silently ignored.
async function handleTicketChannelMessageEdit(message) {
  if (message.author?.bot) return;
  const ticketId = ticketChannelMap.get(message.channelId);
  if (!ticketId) return;

  try {
    await supabase
      .from("support_messages")
      .update({
        content: message.content || "*(no text content)*",
        edited_at: new Date().toISOString(),
      })
      .eq("discord_message_id", message.id);
  } catch (err) {
    console.error("[realtime-sync] handleTicketChannelMessageEdit failed:", err.message);
  }
}

// Called from index.js's messageDelete listener. Removes the mirrored row
// entirely so it disappears from the website thread too.
async function handleTicketChannelMessageDelete(message) {
  const ticketId = ticketChannelMap.get(message.channelId);
  if (!ticketId) return;

  try {
    await supabase.from("support_messages").delete().eq("discord_message_id", message.id);
  } catch (err) {
    console.error("[realtime-sync] handleTicketChannelMessageDelete failed:", err.message);
  }
}

// Called from index.js messageCreate. If the message is in a test ticket
// channel, mirror it to test_messages so the website chat panel sees it.
async function handleTestChannelMessage(message) {
  if (message.author.bot) return;
  const liveTestId = testChannelMap.get(message.channelId);
  if (!liveTestId) return;

  try {
    const player = await ensurePlayerForDiscordUser(
      message.author.id,
      message.member?.displayName || message.author.username
    );
    await supabase.from("test_messages").insert({
      live_test_id: liveTestId,
      author_player_id: player?.id || null,
      author_label: message.member?.displayName || message.author.username,
      source: "discord",
      content: message.content || "*(no text content)*",
      discord_message_id: message.id,
    });
  } catch (err) {
    console.error("[realtime-sync] handleTestChannelMessage failed:", err.message);
  }
}

// ---------- test tickets from website ----------

// When a tester clicks "Next / Pull" on the website, claim_next() inserts a
// live_tests row with discord_ticket_channel_id = null. We catch that INSERT
// here, create the Discord ticket channel (same style as the bot's own
// ticket), write the channel id back so the website/bot know where it lives,
// and also register the test in the in-memory activeTestingMap so the usual
// Submit / Cancel buttons work from inside that channel.
async function createTestTicketFromWebsite(guild, liveTest, { onActiveTestSet } = {}) {
  try {
    // Skip rows that already have a channel (e.g. created from Discord).
    if (liveTest.discord_ticket_channel_id) return;

    // Look up tester's discord_id from their player row.
    const { data: testerPlayer } = await supabase
      .from("players")
      .select("discord_id, username")
      .eq("id", liveTest.tester_id)
      .maybeSingle();
    if (!testerPlayer?.discord_id) {
      console.warn("[realtime-sync] createTestTicketFromWebsite: tester has no discord_id, skipping");
      return;
    }

    // Look up testee's player row.
    const { data: testeePlayer } = await supabase
      .from("players")
      .select("discord_id, username, region")
      .eq("id", liveTest.player_id)
      .maybeSingle();

    const testerMember = await guild.members.fetch(testerPlayer.discord_id).catch(() => null);
    const testeeMember = testeePlayer?.discord_id
      ? await guild.members.fetch(testeePlayer.discord_id).catch(() => null)
      : null;

    // Place the ticket under the gamemode's test category if it exists,
    // otherwise fall back to no parent (placed at top level).
    const categoryName = queueCategoryName(liveTest.gamemode);
    const category = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === categoryName.toLowerCase()
    );

    // Build permission overwrites — tester + testee can see it, everyone else cannot.
    const testerRoleIds = Object.values(PERMISSION_ROLE_IDS).filter(Boolean);
    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
      ...testerRoleIds.map((id) => ({
        id,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory],
      })),
    ];
    if (testerMember) {
      overwrites.push({
        id: testerMember.id,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory],
      });
    }
    if (testeeMember) {
      overwrites.push({
        id: testeeMember.id,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory],
      });
    }

    const testeeName = testeePlayer?.username || "player";
    const testerName = testerPlayer?.username || "tester";
    const slug = testeeName.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24);
    const channel = await guild.channels.create({
      name: `ticket-${liveTest.gamemode}-${slug}`,
      type: ChannelType.GuildText,
      parent: category?.id || null,
      permissionOverwrites: overwrites,
    });

    const testeeInfoLine = testeePlayer
      ? `**IGN:** ${testeeName}\n**Region:** ${testeePlayer.region || "Unknown"}\n`
      : `**IGN:** Not linked to Discord\n`;

    const testerMention = testerMember ? `<@${testerMember.id}>` : testerName;
    const testeeMention = testeeMember ? `<@${testeeMember.id}>` : testeeName;

    await channel.send({
      content: `${testeeMention} ${testerMention}`,
      embeds: [
        new EmbedBuilder()
          .setTitle(`${liveTest.gamemode.toUpperCase()} test in progress`)
          .setDescription(
            `Tester: ${testerMention}\nTestee: ${testeeMention}\n${testeeInfoLine}\n` +
              `When the test is done, click **Submit Result** to save the tier and close this ticket. ` +
              `Only testers and the testee can see this channel.\n\n` +
              `_This ticket closes automatically after 2 hours if left open._`
          )
          .setColor(0xffd54a),
      ],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`ticket_submit_${liveTest.gamemode}_${testeeMember?.id || "unknown"}`)
            .setLabel("Submit Result")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId("ticket_close")
            .setLabel("Cancel Test")
            .setStyle(ButtonStyle.Danger)
        ),
      ],
    });

    // Write the channel id back so the website can show it and the bot
    // knows which channel to delete when the test ends.
    await supabase
      .from("live_tests")
      .update({
        discord_ticket_channel_id: channel.id,
        tester_names: [testerName],
      })
      .eq("id", liveTest.id);

    // Register so Discord messages in this channel get mirrored to test_messages.
    testChannelMap.set(channel.id, liveTest.id);

    // Register in the in-memory map so Submit/Cancel buttons work.
    if (onActiveTestSet) {
      const queueKey = `${liveTest.gamemode}:${liveTest.region || "NA"}`;
      onActiveTestSet(queueKey, {
        ticketChannelId: channel.id,
        testerIds: testerMember ? [testerMember.id] : [],
        testerNames: [testerName],
        testeeId: testeeMember?.id || null,
        testeeName,
        queueChannelId: null,
        queueMessageId: null,
        gamemode: liveTest.gamemode,
        isHigh: false,
      });
    }

    // Auto-close after 2 hours.
    setTimeout(async () => {
      try {
        const stillExists = await guild.channels.fetch(channel.id).catch(() => null);
        if (!stillExists) return;
        await channel.send({ content: "This ticket has been open for 2 hours with no result submitted — closing it automatically." }).catch(() => {});
        await supabase.from("live_tests").delete().eq("id", liveTest.id);
        await channel.delete().catch((err) => console.error("[realtime-sync] failed to auto-delete stale ticket:", err.message));
      } catch (err) {
        console.error("[realtime-sync] auto-close error:", err.message);
      }
    }, 2 * 60 * 60 * 1000);

    console.log(`[realtime-sync] created website-claimed ticket channel ${channel.name} for live_test ${liveTest.id}`);
  } catch (err) {
    console.error("[realtime-sync] createTestTicketFromWebsite failed:", err.message);
  }
}

// ---------- wiring ----------

async function initRealtimeSync(guild, { onQueueStateChange, onActiveTestSet } = {}) {
  // Prime the in-memory channel map from whatever's already open, so a bot
  // restart doesn't lose track of existing ticket channels.
  const { data: openTickets } = await supabase
    .from("support_tickets")
    .select("id, discord_channel_id")
    .eq("status", "open")
    .not("discord_channel_id", "is", null);
  (openTickets || []).forEach((t) => ticketChannelMap.set(t.discord_channel_id, t.id));

  // Prime the test channel map from live_tests that already have a channel.
  const { data: liveTests } = await supabase
    .from("live_tests")
    .select("id, discord_ticket_channel_id")
    .not("discord_ticket_channel_id", "is", null);
  (liveTests || []).forEach((t) => testChannelMap.set(t.discord_ticket_channel_id, t.id));

  supabase
    .channel("bot-player-tiers")
    .on("postgres_changes", { event: "*", schema: "public", table: "player_tiers" }, (payload) => {
      const row = payload.new;
      if (row) assignTierRole(guild, row.player_id, row.gamemode, row.tier);
    })
    .subscribe();

  // Grant the Verified role whenever a player row is created or updated with
  // a discord_id (i.e. when they link their account on the website).
  supabase
    .channel("bot-players-verified")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "players" }, (payload) => {
      if (payload.new?.discord_id) grantVerifiedRole(guild, payload.new.discord_id);
    })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "players" }, (payload) => {
      // Only fire when discord_id was just set (wasn't set before, now is).
      if (payload.new?.discord_id && !payload.old?.discord_id) {
        grantVerifiedRole(guild, payload.new.discord_id);
      }
    })
    .subscribe();

  supabase
    .channel("bot-support-tickets")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "support_tickets" }, (payload) => {
      createTicketChannel(guild, payload.new);
    })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "support_tickets" }, (payload) => {
      if (payload.new?.status === "closed" && payload.old?.status !== "closed") {
        closeTicketChannel(guild, payload.new);
      }
    })
    .subscribe();

  supabase
    .channel("bot-support-messages")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "support_messages" }, (payload) => {
      mirrorMessageToDiscord(guild, payload.new);
    })
    .subscribe();

  // Website → Discord: when a test_message with source='website' is inserted,
  // post it into the Discord test ticket channel.
  supabase
    .channel("bot-test-messages")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "test_messages" }, async (payload) => {
      const row = payload.new;
      if (!row || row.source !== "website") return;
      try {
        const { data: lt } = await supabase
          .from("live_tests")
          .select("discord_ticket_channel_id")
          .eq("id", row.live_test_id)
          .maybeSingle();
        if (!lt?.discord_ticket_channel_id) return;
        const ch = guild.channels.cache.get(lt.discord_ticket_channel_id)
          || await guild.channels.fetch(lt.discord_ticket_channel_id).catch(() => null);
        if (!ch) return;
        await ch.send(`**${row.author_label || "Player"}:** ${row.content}`);
      } catch (err) {
        console.error("[realtime-sync] test_messages → Discord failed:", err.message);
      }
    })
    .subscribe();

  // Watch queue_closed so that opening/closing from the website (which calls
  // the set_queue_closed RPC directly) is reflected in Discord immediately.
  //
  // Debounced per queue key: opening/closing from Discord triggers both a
  // setQueueClosed and a setQueueLocked write in quick succession, each
  // producing its own realtime event. Without debouncing, onQueueStateChange
  // fires twice and posts two identical cards to the channel. 400 ms is
  // enough to collapse the pair into one call while still feeling instant.
  if (onQueueStateChange) {
    const queueDebounceTimers = new Map();
    supabase
      .channel("bot-queue-closed")
      .on("postgres_changes", { event: "*", schema: "public", table: "queue_closed" }, (payload) => {
        const row = payload.new;
        if (!row) return;
        const key = row.gamemode;
        if (queueDebounceTimers.has(key)) clearTimeout(queueDebounceTimers.get(key));
        queueDebounceTimers.set(
          key,
          setTimeout(() => {
            queueDebounceTimers.delete(key);
            onQueueStateChange(guild, row);
          }, 400)
        );
      })
      .subscribe();
  }

  // Watch live_tests inserts.
  // - No discord_ticket_channel_id → claimed from website, create the channel.
  // - Already has a channel id → claimed from Discord, just register it in the map.
  supabase
    .channel("bot-live-tests")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "live_tests" }, (payload) => {
      const row = payload.new;
      if (!row) return;
      if (row.discord_ticket_channel_id) {
        // Discord-side claim: register so messages get mirrored.
        testChannelMap.set(row.discord_ticket_channel_id, row.id);
      } else {
        createTestTicketFromWebsite(guild, row, { onActiveTestSet });
      }
    })
    .subscribe();

  // Backfill: process any live_tests rows that were claimed from the website
  // before this bot instance started (discord_ticket_channel_id still null).
  const { data: pendingTests } = await supabase
    .from("live_tests")
    .select("*")
    .is("discord_ticket_channel_id", null);
  if (pendingTests && pendingTests.length > 0) {
    console.log(`[realtime-sync] backfilling ${pendingTests.length} pending live_test(s) without Discord channels`);
    for (const row of pendingTests) {
      await createTestTicketFromWebsite(guild, row, { onActiveTestSet });
    }
  }

  console.log("[realtime-sync] subscribed to player_tiers, support_tickets, support_messages, queue_closed, live_tests");
}

module.exports = {
  initRealtimeSync,
  handleTicketChannelMessage,
  handleTicketChannelMessageEdit,
  handleTicketChannelMessageDelete,
  handleTestChannelMessage,
  assignTierRole,
};
