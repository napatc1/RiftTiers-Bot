// Keeps Discord in sync with things that happen purely in Supabase (i.e.
// via the website, which never talks to Discord directly): a player's tier
// changing, and support tickets/messages. Subscribes to Postgres changes
// over Supabase Realtime and reacts to each one. Also exposes
// handleTicketChannelMessage(), which index.js's messageCreate listener
// calls so staff replies typed in a ticket channel make it back to the
// website.
const { EmbedBuilder, ChannelType, PermissionsBitField } = require("discord.js");
const { supabase, ensurePlayerForDiscordUser } = require("./supabase");
const { GAMEMODE_PING_ROLE_NAMES, PERMISSION_ROLE_IDS, SUPPORT_CATEGORY_NAME, tierRoleName } = require("./config");

// channelId -> ticketId, kept in memory so messageCreate can cheaply tell
// whether a message was typed in a ticket channel at all. Rebuilt on every
// boot from open tickets, and kept current by the support_tickets
// subscription below.
const ticketChannelMap = new Map();

function sanitizeChannelName(name) {
  return (
    (name || "player")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "player"
  );
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
            `Opened by **${player?.username || "a player"}** on the website.\n\n` +
              (firstMessage?.content || "*(no message)*") +
              "\n\nReplies here are sent to the player on the website, and their replies show up here too. Edits and deletes sync too. Closing the ticket on the website deletes this channel and moves it to ticket history on the site."
          )
          .setColor(0x3fa0f5),
      ],
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
    await channel.send({ content: "🔒 This ticket was closed on the website — this channel will be deleted shortly. It's kept in ticket history on the site." }).catch(() => {});
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

// ---------- wiring ----------

async function initRealtimeSync(guild, { onQueueStateChange } = {}) {
  // Prime the in-memory channel map from whatever's already open, so a bot
  // restart doesn't lose track of existing ticket channels.
  const { data: openTickets } = await supabase
    .from("support_tickets")
    .select("id, discord_channel_id")
    .eq("status", "open")
    .not("discord_channel_id", "is", null);
  (openTickets || []).forEach((t) => ticketChannelMap.set(t.discord_channel_id, t.id));

  supabase
    .channel("bot-player-tiers")
    .on("postgres_changes", { event: "*", schema: "public", table: "player_tiers" }, (payload) => {
      const row = payload.new;
      if (row) assignTierRole(guild, row.player_id, row.gamemode, row.tier);
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

  // Watch queue_closed so that opening/closing from the website (which calls
  // the set_queue_closed RPC directly) is reflected in Discord immediately.
  if (onQueueStateChange) {
    supabase
      .channel("bot-queue-closed")
      .on("postgres_changes", { event: "*", schema: "public", table: "queue_closed" }, (payload) => {
        const row = payload.new;
        if (row) onQueueStateChange(guild, row);
      })
      .subscribe();
  }

  console.log("[realtime-sync] subscribed to player_tiers, support_tickets, support_messages, queue_closed");
}

module.exports = {
  initRealtimeSync,
  handleTicketChannelMessage,
  handleTicketChannelMessageEdit,
  handleTicketChannelMessageDelete,
  assignTierRole,
};
