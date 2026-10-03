# RyftTiers Bot

Discord bot for running tier tests, paired with a Supabase-backed website.
Anyone can join/leave a gamemode's queue; testers (people with the "Tester"
role) pull the next player and submit a result, which is written straight to
Supabase — the same database the website reads from. The bot and website stay
in sync both ways over Supabase Realtime (see `src/realtime-sync.js`).

## Setup

1. Install [Node.js](https://nodejs.org) if you don't have it.
2. In this folder, run:
   ```
   npm install
   ```
3. Copy `.env.example` to a new file named `.env`, and fill in:
   - `DISCORD_TOKEN` — from the Discord Developer Portal, Bot tab
   - `DISCORD_CLIENT_ID` — from General Information, "Application ID"
   - `DISCORD_GUILD_ID` — your server's ID (enable Developer Mode in Discord
     settings, then right-click your server icon → Copy Server ID)
   - `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` — from the Supabase
     project's API settings (the service-role key bypasses RLS, so the bot
     can act on behalf of any player)
4. Apply `supabase/schema.sql` to your Supabase project (SQL editor, or the
   CLI) — safe to re-run any time, it's all `create if not exists` / idempotent
   alters.
5. Register the slash commands:
   ```
   npm run deploy-commands
   ```
6. Start the bot:
   ```
   npm start
   ```
7. Run `/setupqueues` once in any channel. This creates every missing
   gamemode/tier role and tiertest channel (see `src/config.js` for the full
   list) and posts the queue message — both the normal and high (LT3+) queue —
   for each one, starting closed. Testers open them from there with the
   **Open Queue** button (which asks for a region via a popup).

## How it works

- **Join Queue / Leave Queue** — anyone (verified) can click these once a
  queue is open.
- **Open Queue (Tester)** — only testers; picks a region via a popup, then
  opens the queue and pings the gamemode's role.
- **Next (Tester)** — pulls the next person off the queue and announces them.
- **Submit Result (Tester)** — opens a form asking for the player's region
  and tier. Saves it to Supabase and assigns the right Discord role.
- **#request-test** — a gamemode picker that points players at the right
  queue channel and gives them that gamemode's ping role.
- **#request-high-test** — opens a support ticket for players who are already
  LT3+ and want a high tier test set up by staff.
- **#request-support** — opens a help/report/appeal ticket, mirrored to the
  website's Support tab.
- The queue state itself lives in Supabase (not memory), so it survives bot
  restarts.

## Adding or renaming gamemode channels

Edit `src/config.js` — the `GAMEMODE_CHANNELS` object maps a Discord channel
name to a gamemode id. Add a new line for any new channel, then re-run
`/setupqueues` — it only touches what's missing.

## Never commit

`.env` and `serviceAccountKey.json` contain secrets. Both are already listed
in `.gitignore` so `git add .` won't pick them up — but always run `git
status` before committing to double check.
