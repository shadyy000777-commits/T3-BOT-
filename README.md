# T3 Registration Bot

A standalone Discord bot with a **T3 Scrims registration panel** — same
3-step modal flow as the verification panel it's based on (team info,
5 players' IGN/UID, then pick the 4 who are actually playing).

## What it does

- `/admin-panel` — posts a single consolidated panel covering everything
  below (log channel, required role, groups/day, registration panel, live
  panel, schedule editing) so you don't need to remember each separate
  command.
- `/t3-panel` — posts an embed with **Register** and **Edit** buttons.
- Clicking **Register** walks the player through 3 short forms, then a
  member picker to confirm the 4-person playing lineup.
- On completion: the player gets an ephemeral confirmation, and (if
  configured) the full team card is posted to a log channel.
- `/set-log-channel` — pick which channel gets the team cards.
- `/set-t3-role @role` — only members with this role can click **Register**
  (Edit still works for anyone who already has a saved registration).
  Registration is **closed** until this is set — there's no "open to
  everyone" mode.
- `/clear-t3-role` — clear the required role, closing registration again
  until a new one is set.
- `/remove-registration @user` — clear someone's registration so they can
  redo it.
- `!team @user` — quickly look up someone's registered team in chat.
- **Round promotion system** — each group's lobby channel gets a **Result**
  button (admin only). Clicking it opens a picker of that group's teams;
  confirming promotes the picked teams into **T3 ROUND 2** (its own role +
  single shared channel, auto-created the first time it's needed). T3 ROUND
  2 gets its own Result button too, chaining into T3 ROUND 3, T3 ROUND 4,
  etc. — up to however many rounds `/set-max-rounds` (or the admin panel's
  **Set Max Rounds** button) is set to. On whichever round is currently the
  last one, Result instead picks a single winner and hands them the **T3
  Scrims Winner** role. Re-running Result on a group cleanly replaces its
  previous picks — anyone dropped gets un-promoted (and un-promoted from
  any further round they'd already reached).
- Every group's/round's admin panel also has:
  - **Match Reminder** — posts a public ping to that group's/round's role
    with the match schedule (Round 1) or a plain heads-up (Round 2+).
  - **Publish Slot List** — posts a standing embed listing every slot in
    the group (or every team currently in the round's pool) — click again
    later to refresh it in place. It also auto-refreshes on its own
    whenever a team registers, edits, gets punished, or gets promoted.
  - **Manage Slot** (Round 1 only) — open to any already-registered
    player, not just admins. Lets them move their own team into a
    different currently-open group/match-time, freeing their old slot.
  - **Punish Team** — pick one or more teams to punish: every member on
    their roster gets a **Scrims Ban** role that blocks the Register
    button for 2 days (lifted automatically), the team is removed from
    its group/round and its slot/role is cleared, and a summary is
    posted to the log channel.
- `/live-panel` — posts a standing, self-updating panel showing the next
  open groups, their fill count, and match times. Same slot/group math as
  the original bot (20 teams per group, slots wrap 6-25 per group) —
  defaults to 2 groups/day, adjustable via `/set-groups-per-day`.
- `/set-groups-per-day <count>` — change how many groups play per real day
  (defaults to 2, max 25). Applies going forward — already-registered slots
  keep their group, but which day each group falls into and which schedule
  "position" it reuses can shift. After increasing it, set match times for
  the new position(s) via `/group-schedule`.
- `/group-schedule` — admin panel to set each daily match-time slot
  (IDP/start time + maps) one at a time via a select menu. Scales to
  however many groups/day are configured.
- `/set-daily-schedule` — set **both** daily groups' match times at once in
  a single modal (only works when exactly 2 groups/day are configured —
  Discord's modal field limit can't fit more; use `/group-schedule` for 3+).
  Either way, whatever's set becomes the standing daily schedule — every
  future day's groups reuse it automatically, and the live panel updates
  immediately.

Each completed registration is automatically assigned the next open slot
(and shown its group + match schedule in the confirmation), which is what
the live panel displays fill counts from. The first team registered into a
group also triggers that group's **lobby channel** to be created — a
private text channel named `T3 Lobby 1`, `T3 Lobby 2`, etc. under a "🏆 T3
Lobbies" category, visible only to players registered in that group. It
starts locked (view-only) — run **`!open <group number>`** (or just
`!open` inside the lobby channel itself) to let that group send messages
and attach files.

Deleting a group's or round's lobby channel yourself (in Discord, not via
a bot command) automatically deletes that group's/round's role too and
clears every stored reference to both — nothing is left orphaned. It does
**not** touch anyone's registration or slot — those stay on record even
once the channel/role are gone.

This version deliberately leaves out the public/private channel split and
the heavier result/closing system from the original bot — just the panel,
the form, one log channel, the live groups panel, and per-group lobby
channels.

## Setup

1. **Create the Discord application/bot** (if you haven't already, for
   *this* bot specifically — it needs its own token, separate from your
   other bot):
   - Go to https://discord.com/developers/applications → New Application
   - Bot tab → Reset Token → copy it
   - OAuth2 → URL Generator → scopes: `bot`, `applications.commands`;
     permissions: `Send Messages`, `Embed Links`, `Read Message History`,
     `Manage Roles`, `Manage Channels` (the last two are needed to
     auto-create each group's role + lobby channel). Use the generated URL
     to invite it to your server.
   - Enable **Server Members Intent** and **Message Content Intent**
     under Bot → Privileged Gateway Intents (needed for `!team`/`!open`).
   - After inviting, drag the bot's role near the top of your server's
     role list (above where group roles like "Group 1" will get created) —
     otherwise it can create the role but can't assign it.

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure environment** — copy `.env.example` to `.env` and fill in:
   ```
   DISCORD_TOKEN=your-bot-token
   CLIENT_ID=your-application-id
   GUILD_ID=your-server-id
   ```

4. **Register slash commands** (also happens automatically on every
   startup, but you can run it manually):
   ```bash
   npm run deploy
   ```

5. **Run the bot**:
   ```bash
   npm start
   ```

6. In your server, run `/t3-panel` in the channel where you want the
   registration panel posted, then `/set-log-channel` to pick where
   completed registrations get logged.

## Data storage

Registrations are saved to `data.json` in this folder (or wherever
`DATA_DIR` points, e.g. a Railway volume) — same simple JSON-file
approach as the original bot, per-guild.

## Files

- `index.js` — bot entry point, wires up all buttons/modals/select menus.
- `cmd-t3-panel.js` — `/t3-panel` slash command.
- `cmd-set-log-channel.js`, `cmd-remove-registration.js` — admin commands.
- `pcmd-team.js` — `!team @user` prefix command.
- `registration-handlers.js` — all the step-by-step logic.
- `registration-modals.js` — the 3 modal forms.
- `pending-registrations.js` — in-memory state between modal steps.
- `storage.js` — reads/writes `data.json`.
- `deploy-commands.js` — one-off script to register slash commands.
