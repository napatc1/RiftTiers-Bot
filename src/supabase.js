const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

console.log("[startup] supabase.js loaded, checking credentials...");

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "[startup] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variable is missing."
  );
  process.exit(1);
}

// The service-role key bypasses Row Level Security entirely — correct here
// because this is a trusted server process (the bot), not a browser. Never
// put this key in the website's code; that one uses the public anon key.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

console.log("[startup] Supabase client initialized OK");

// ---------- players ----------

// Finds (or lazily creates) the players row for a Discord user interacting
// via the bot, who may never have logged into the website. Keyed by
// discord_id, same column the website's OAuth login trigger uses, so both
// sides always converge on the same row.
async function ensurePlayerForDiscordUser(discordUserId, fallbackUsername) {
  const { data: existing, error: lookupErr } = await supabase
    .from("players")
    .select("id, username, region, platform")
    .eq("discord_id", discordUserId)
    .maybeSingle();
  if (lookupErr) throw lookupErr;
  if (existing) return existing;

  const { data: created, error } = await supabase
    .from("players")
    .insert({
      username: fallbackUsername || `discord-${discordUserId}`,
      discord_id: discordUserId,
    })
    .select("id, username, region, platform")
    .single();
  if (error) throw error;
  return created;
}

async function getPlayerRowByUsername(username) {
  if (!username) return null;
  const { data, error } = await supabase
    .from("players")
    .select("id, username, region, platform")
    .ilike("username", username)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Writes/updates one gamemode's tier for a player, keyed by their name.
// Creates the player (and sets their region) if they don't exist yet.
async function setPlayerTier(playerName, region, gamemode, tier) {
  let player = await getPlayerRowByUsername(playerName);
  if (!player) {
    const { data, error } = await supabase
      .from("players")
      .insert({ username: playerName, region: region || null })
      .select("id, username, region")
      .single();
    if (error) throw error;
    player = data;
  } else if (region && region !== player.region) {
    await supabase.from("players").update({ region }).eq("id", player.id);
  }

  const { error } = await supabase.from("player_tiers").upsert(
    { player_id: player.id, gamemode, tier, updated_at: new Date().toISOString() },
    { onConflict: "player_id,gamemode" }
  );
  if (error) throw error;
}

async function getPlayer(playerName) {
  const player = await getPlayerRowByUsername(playerName);
  if (!player) return null;
  const { data: tiers } = await supabase
    .from("player_tiers")
    .select("gamemode, tier")
    .eq("player_id", player.id);
  const tiersObj = {};
  (tiers || []).forEach((t) => (tiersObj[t.gamemode] = t.tier));
  return { name: player.username, region: player.region, tiers: tiersObj };
}

// ---------- cooldowns ----------
// Cooldowns are keyed by Discord user id (not Minecraft name), since the
// queue itself is joined/left by Discord account.

async function getCooldownUntil(gamemode, discordUserId) {
  const player = await ensurePlayerForDiscordUser(discordUserId);
  const { data } = await supabase
    .from("cooldowns")
    .select("until")
    .eq("gamemode", gamemode)
    .eq("player_id", player.id)
    .maybeSingle();
  return data ? new Date(data.until).getTime() : null;
}

async function setCooldown(gamemode, discordUserId, timestampMs) {
  const player = await ensurePlayerForDiscordUser(discordUserId);
  await supabase.from("cooldowns").upsert(
    { player_id: player.id, gamemode, until: new Date(timestampMs).toISOString() },
    { onConflict: "player_id,gamemode" }
  );
}

async function clearCooldown(gamemode, discordUserId) {
  const player = await ensurePlayerForDiscordUser(discordUserId);
  await supabase.from("cooldowns").delete().eq("gamemode", gamemode).eq("player_id", player.id);
}

// ---------- verification (linking Discord <-> Minecraft username) ----------

async function setVerifiedUsername(discordUserId, mcUsername, platform) {
  const { data: existing } = await supabase
    .from("players")
    .select("id")
    .eq("discord_id", discordUserId)
    .maybeSingle();

  if (existing) {
    await supabase
      .from("players")
      .update({ username: mcUsername, platform: platform || "premium" })
      .eq("id", existing.id);
    return;
  }

  // A players row might already exist under this username (tiered manually
  // before they ever verified, or claimed by the website's login trigger
  // under a different discord_username) — claim it instead of duplicating.
  const byName = await getPlayerRowByUsername(mcUsername);
  if (byName) {
    await supabase
      .from("players")
      .update({ discord_id: discordUserId, platform: platform || "premium" })
      .eq("id", byName.id);
    return;
  }

  await supabase
    .from("players")
    .insert({ username: mcUsername, discord_id: discordUserId, platform: platform || "premium" });
}

async function getVerifiedUsername(discordUserId) {
  const { data } = await supabase
    .from("players")
    .select("username")
    .eq("discord_id", discordUserId)
    .maybeSingle();
  return data ? data.username : null;
}

async function getVerifiedPlatform(discordUserId) {
  const { data } = await supabase
    .from("players")
    .select("platform")
    .eq("discord_id", discordUserId)
    .maybeSingle();
  return data ? data.platform : null;
}

// ---------- live tests & results log ----------
// "Live tests" lets the website show what's happening right now. Keyed by
// ticket channel ID so it's easy to clear when that ticket closes.

async function setLiveTest(ticketChannelId, info) {
  const player = await getPlayerRowByUsername(info.testeeName);
  if (!player) return;

  let testerId = null;
  if (info.testerIds && info.testerIds.length > 0) {
    const testerPlayer = await ensurePlayerForDiscordUser(info.testerIds[0]);
    testerId = testerPlayer.id;
  }

  await supabase.from("live_tests").insert({
    player_id: player.id,
    gamemode: info.gamemode,
    region: player.region,
    tester_id: testerId,
    tester_names: info.testerNames || [],
    discord_ticket_channel_id: ticketChannelId,
  });
}

async function clearLiveTest(ticketChannelId) {
  await supabase.from("live_tests").delete().eq("discord_ticket_channel_id", ticketChannelId);
}

// Permanent-ish log of completed results, so the website can show a
// "recent tests" feed.
async function logTestResult(entry) {
  const player = await getPlayerRowByUsername(entry.testeeName);

  let testerId = null;
  if (entry.testerIds && entry.testerIds.length > 0) {
    const testerPlayer = await ensurePlayerForDiscordUser(entry.testerIds[0]);
    testerId = testerPlayer.id;
  }

  await supabase.from("test_log").insert({
    player_id: player ? player.id : null,
    gamemode: entry.gamemode,
    tier: entry.tier,
    tester_id: testerId,
    tester_names: entry.testerNames || [],
    region: entry.region || null,
    created_at: new Date(entry.timestamp || Date.now()).toISOString(),
  });
}

// ---------- shared queues (gamemode-keyed, same tables the website reads) ----------
// queueKey is a gamemode id ("vanilla") for the normal queue, or
// "<gamemode>:high" for that gamemode's high queue — mirroring how this
// used to be keyed by Discord channel id, just swapped for something the
// website can address too. The website's Testing tab currently only shows
// the normal queue; high-queue entries stay invisible there for now.

async function joinQueue(queueKey, discordUserId, region) {
  const player = await ensurePlayerForDiscordUser(discordUserId);
  const { data: existing } = await supabase
    .from("queue_entries")
    .select("id")
    .eq("gamemode", queueKey)
    .eq("player_id", player.id)
    .maybeSingle();
  if (existing) return false;

  const { error } = await supabase
    .from("queue_entries")
    .insert({ gamemode: queueKey, region: region || player.region || "NA", player_id: player.id });
  if (error) throw error;
  return true;
}

async function leaveQueue(queueKey, discordUserId) {
  const player = await ensurePlayerForDiscordUser(discordUserId);
  const { data, error } = await supabase
    .from("queue_entries")
    .delete()
    .eq("gamemode", queueKey)
    .eq("player_id", player.id)
    .select("id");
  if (error) throw error;
  return (data || []).length > 0;
}

async function popNext(queueKey) {
  const { data: entries, error } = await supabase
    .from("queue_entries")
    .select("id, players!queue_entries_player_id_fkey(discord_id)")
    .eq("gamemode", queueKey)
    .order("joined_at", { ascending: true })
    .limit(1);
  if (error) throw error;
  if (!entries || entries.length === 0) return null;

  const entry = entries[0];
  await supabase.from("queue_entries").delete().eq("id", entry.id);
  return entry.players.discord_id;
}

async function getQueueCount(queueKey) {
  const { count } = await supabase
    .from("queue_entries")
    .select("id", { count: "exact", head: true })
    .eq("gamemode", queueKey);
  return count || 0;
}

async function formatQueue(queueKey) {
  const { data } = await supabase
    .from("queue_entries")
    .select("players!queue_entries_player_id_fkey(discord_id)")
    .eq("gamemode", queueKey)
    .order("joined_at", { ascending: true });
  if (!data || data.length === 0) return "_Queue is empty._";
  return data.map((e, i) => `${i + 1}. <@${e.players.discord_id}>`).join("\n");
}

async function isQueueClosed(queueKey) {
  const { data } = await supabase
    .from("queue_closed")
    .select("closed")
    .eq("gamemode", queueKey)
    .maybeSingle();
  return data ? data.closed : false;
}

async function setQueueClosed(queueKey, closed) {
  const { data: existing } = await supabase
    .from("queue_closed")
    .select("region, last_opened_at")
    .eq("gamemode", queueKey)
    .maybeSingle();
  await supabase.from("queue_closed").upsert(
    {
      gamemode: queueKey,
      closed,
      region: existing ? existing.region : null,
      // Opening bumps the timestamp; closing leaves whatever it was.
      last_opened_at: closed ? existing?.last_opened_at || null : new Date().toISOString(),
    },
    { onConflict: "gamemode" }
  );
}

async function getQueueLastOpenedAt(queueKey) {
  const { data } = await supabase
    .from("queue_closed")
    .select("last_opened_at")
    .eq("gamemode", queueKey)
    .maybeSingle();
  return data ? data.last_opened_at : null;
}

// "Locked" is separate from "closed" — a locked queue is still open and
// visible (testers can still pull Next), it just stops accepting new joins.
async function getQueueLocked(queueKey) {
  const { data } = await supabase
    .from("queue_closed")
    .select("locked")
    .eq("gamemode", queueKey)
    .maybeSingle();
  return data ? !!data.locked : false;
}

async function setQueueLocked(queueKey, locked) {
  const { data: existing } = await supabase
    .from("queue_closed")
    .select("closed, region, last_opened_at")
    .eq("gamemode", queueKey)
    .maybeSingle();
  await supabase.from("queue_closed").upsert(
    {
      gamemode: queueKey,
      locked,
      closed: existing ? existing.closed : false,
      region: existing ? existing.region : null,
      last_opened_at: existing ? existing.last_opened_at : null,
    },
    { onConflict: "gamemode" }
  );
}

async function setQueueRegion(queueKey, region) {
  const { data: existing } = await supabase
    .from("queue_closed")
    .select("closed")
    .eq("gamemode", queueKey)
    .maybeSingle();
  await supabase
    .from("queue_closed")
    .upsert(
      { gamemode: queueKey, region, closed: existing ? existing.closed : false },
      { onConflict: "gamemode" }
    );
}

async function getQueueRegion(queueKey) {
  const { data } = await supabase
    .from("queue_closed")
    .select("region")
    .eq("gamemode", queueKey)
    .maybeSingle();
  return data ? data.region : null;
}

async function addQueueTester(queueKey, discordUserId) {
  const player = await ensurePlayerForDiscordUser(discordUserId);
  const { data: existing } = await supabase
    .from("queue_testers")
    .select("player_id")
    .eq("gamemode", queueKey)
    .eq("player_id", player.id)
    .maybeSingle();
  if (existing) return false;
  await supabase.from("queue_testers").insert({ gamemode: queueKey, player_id: player.id });
  return true;
}

async function removeQueueTester(queueKey, discordUserId) {
  const player = await ensurePlayerForDiscordUser(discordUserId);
  const { data, error } = await supabase
    .from("queue_testers")
    .delete()
    .eq("gamemode", queueKey)
    .eq("player_id", player.id)
    .select("player_id");
  if (error) throw error;
  return (data || []).length > 0;
}

async function getQueueTesterIds(queueKey) {
  const { data } = await supabase
    .from("queue_testers")
    .select("players!queue_testers_player_id_fkey(discord_id)")
    .eq("gamemode", queueKey);
  return (data || []).map((t) => t.players.discord_id);
}

// ---------- in-memory, Discord-only bookkeeping ----------
// Which ticket channel is currently handling a queue's "next" pull, so the
// bot can route submit/close actions and refresh the right queue message.
// This doesn't need to live in Supabase — the website doesn't care which
// Discord channel a test is happening in, only that it IS happening (the
// live_tests table above is what it reads for that). Resets on bot
// restart, same as before.
const activeTestingByQueueKey = new Map(); // queueKey -> info
const ticketToQueueKey = new Map(); // ticketChannelId -> queueKey
const queueMessages = new Map(); // queueKey -> { channelId, messageId }

function setActiveTesting(queueKey, info) {
  activeTestingByQueueKey.set(queueKey, info);
  ticketToQueueKey.set(info.ticketChannelId, queueKey);
}
function getActiveTesting(queueKey) {
  return activeTestingByQueueKey.get(queueKey) || null;
}
function getActiveTestingByTicket(ticketChannelId) {
  const key = ticketToQueueKey.get(ticketChannelId);
  return key ? activeTestingByQueueKey.get(key) : null;
}
function clearActiveTestingByTicket(ticketChannelId) {
  const key = ticketToQueueKey.get(ticketChannelId);
  if (!key) return null;
  const info = activeTestingByQueueKey.get(key);
  activeTestingByQueueKey.delete(key);
  ticketToQueueKey.delete(ticketChannelId);
  return info || null;
}
function setQueueMessage(queueKey, channelId, messageId) {
  queueMessages.set(queueKey, { channelId, messageId });
}
function getQueueMessage(queueKey) {
  return queueMessages.get(queueKey) || null;
}

// ---------- role sync ----------

// Writes website permission flags onto an existing `profiles` row, keyed by
// discord_id. Does nothing if the player hasn't logged into the website yet
// (no profiles row exists) — handle_new_user() creates that row the moment
// they first sign in with Discord, and the next sync pass picks them up.
async function syncProfileRoles(discordId, flags) {
  const { error } = await supabase
    .from("profiles")
    .update({
      is_tester: flags.isTester,
      is_senior_tester: flags.isSeniorTester,
      is_manager: flags.isManager,
      is_moderator: flags.isModerator,
      is_owner: flags.isOwner,
      roles_synced_at: new Date().toISOString(),
    })
    .eq("discord_id", discordId);
  if (error) console.error("[roles] syncProfileRoles error:", error.message);
}

// ---------- support tickets opened from Discord (#request-support) ----------

// Mirrors create_support_ticket's website RPC, but called with the
// service-role key from the bot side. The realtime-sync "new support
// ticket" listener (same one the website's create_support_ticket uses)
// picks this up and creates the private ticket channel automatically —
// same flow regardless of which side opened it.
async function createSupportTicketFromDiscord(discordUserId, displayName, category, subject, message) {
  const player = await ensurePlayerForDiscordUser(discordUserId, displayName);
  const { data: ticket, error } = await supabase
    .from("support_tickets")
    .insert({ player_id: player.id, category, subject })
    .select("id")
    .single();
  if (error) throw error;

  await supabase.from("support_messages").insert({
    ticket_id: ticket.id,
    author_player_id: player.id,
    author_label: displayName,
    source: "discord",
    content: message,
  });

  return ticket.id;
}

// ---------- tester applications (#tester-application) ----------

async function createTesterApplication(discordUserId, { ign, region, experience, availability }) {
  const { data, error } = await supabase
    .from("tester_applications")
    .insert({ discord_id: discordUserId, ign, region, experience, availability })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

async function getTesterApplication(applicationId) {
  const { data } = await supabase
    .from("tester_applications")
    .select("*")
    .eq("id", applicationId)
    .maybeSingle();
  return data;
}

async function setTesterApplicationReviewMessage(applicationId, channelId, messageId) {
  await supabase
    .from("tester_applications")
    .update({ review_channel_id: channelId, review_message_id: messageId })
    .eq("id", applicationId);
}

// Returns false (instead of throwing) if the application was already
// decided, so the button handler can tell the reviewer it's stale.
async function decideTesterApplication(applicationId, status, reviewerDiscordId) {
  const { data, error } = await supabase
    .from("tester_applications")
    .update({ status, reviewed_by_discord_id: reviewerDiscordId, reviewed_at: new Date().toISOString() })
    .eq("id", applicationId)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

module.exports = {
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
  createSupportTicketFromDiscord,
  createTesterApplication,
  getTesterApplication,
  setTesterApplicationReviewMessage,
  decideTesterApplication,
};
