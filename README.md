# ff

(Formerly SkinMatch. The data folder is still called `skinmatch`, so nothing is lost after the rename.)

Shows which League skins you and your friends share, and helps your party match in champ select (including ARAM).

## Setup (do this on both PCs)

1. Install [Node.js](https://nodejs.org) (LTS).
2. In this folder, run:
   ```
   npm install
   npm start
   ```
3. The first time it runs, Windows Firewall will ask about network access. Allow it on **Private networks**. This is how the two PCs find each other.
4. Open the League client. ff connects on its own.

Once ff is running on each PC, just invite each other to a lobby in League. Friends are picked up automatically.

To make a standalone .exe you can double-click: `npm run build` (output lands in `dist/`).

## How it works

- Reads your owned skins from the League client's local API.
- Each app shares its own skin list on your home network and finds the other one automatically.
- Each app keeps a copy of your partner's skins, so it still works if their PC was off during the last sync.
- In champ select, it matches by skinline (Star Guardian, PROJECT, etc.) for the champs you each have. In ARAM it also shows bench swaps that would give you a match.

## Design

The UI follows the Claude Design handoff ("Duo night"): League-adjacent navy, gold only for brand and focus, and one color per person that follows you everywhere (Party banner, champ select card, Stats tab, overlay). Each friend keeps the same color for as long as they're in your party. Matching is the only loud moment: cards slide together under a skinline ribbon with a glow, and when your whole team matches you get sparkles.

## Party

Each person shows up on the same lobby banner they use in the League client: their equipped banner skin (Customize Identity > Banners) with their prestige crest framing the summoner icon. ff reads these from your League client's presence and shares them with your party like skins, so everyone's banner looks right on every screen.


The Party tab mirrors your League lobby: you in the middle, everyone else in your lobby around you. Friends with ff get their color and skin count; lobby members without ff show in a gray card. When you're not in a lobby (or League is closed), it's just you.

Anyone with ff open who joins your lobby is added to your friends list automatically (up to 4), which is what Stats, Explore, Shared skinlines and Collection use. Manage friends, or connect by address if someone doesn't show up, in **Settings > Friends**.

When your lobby hits champ select, the Party tab turns into the champ select view. Each card shows the skin that person has equipped right now; people whose current skins share a skinline group together under a ribbon. Lobby members without ff are included based on what they have equipped. When you could match a skinline with your team, a **pop-up** appears in the bottom-right corner (on any tab) with the skin, who you'd match, an **Equip** button (plus your other skins in that line), Dismiss, and "Always auto-equip." With auto-equip on, ff swaps the skin for you and the pop-up offers **Undo**. If ff is minimized or behind League, you also get a Windows notification.

## Party Snapshot

Under your lobby, the Party tab shows stats for everyone in it, calculated the same way on every screen. A switch at the top picks the mode (ARAM, ARAM: Mayhem, Arena, Summoner's Rift); it starts on whatever your party played most recently. Modes are detected from Riot's queue list, so new variants sort themselves out.

- **Last game** (for 6 hours after a game with your party): each person's champ, grade, KDA, damage, a mode-specific stat (heal/shield in ARAM, placement in Arena, CS on the Rift), where they placed in the lobby, and the party MVP.
- **Performance:** one row per person with a grade and stats that fit the mode.
  - ARAM / Mayhem: best champion class, win rate, KDA, KP, damage/min, damage taken/min, heal + shield/min, pentas and quadras.
  - Arena: best class, average placement, 1st place rate, top 4 rate, KDA, damage dealt and taken per minute.
  - Summoner's Rift: Solo/Duo rank and weekly LP change, main role, win rate, KDA, KP, CS/min, damage/min, vision/min.
- **Grades** are ff's own score: each game you're rated 0-10 against everyone else in it, weighted for the mode (ARAM leans on damage, KP, tanking and healing; Arena is mostly placement; the Rift includes CS and vision), with a small bonus for winning (S+ 8.5+, S 7.5+, A 6.5+, B 5.5+, C 4+, D below).
- **Champion pools** for the mode ("Top champions" in ARAM, "Arena picks" with top-4 rate). In Arena and ARAM: Mayhem each person also gets their **go-to augments**: most picked, with pick count and win rate (top-4 rate in Arena) on hover.
- **Augments** also show on the last-game recap, on Arena/Mayhem rows in Profiles, and as a column in the full scoreboard. Icons are ringed by rarity (silver, gold, prismatic).

## Live game

While you're in a match, the Party tab turns into a live scoreboard using Riot's Live Client Data API (the game serves it locally on your PC). Both teams with champion, level, keystone and summoner spells, KDA, CS, vision and items; dead players are grayed out with their respawn countdown; team kills, towers, inhibitors, drakes, heralds and barons; a running game clock; and a feed of kills, multikills, first blood, objectives and aces. Party members are highlighted in their color. It only shows what the in-game Tab scoreboard already shows, per Riot's game-integrity policy.

## gg ez

After a win, the "ff" next to Swain in the top-left turns into a gold **gg ez**. ff reads the result from League's end-of-game screen the moment the game ends (with your match history as a backup), keeps it through the post-game lobby, and switches back to "ff" when your next game starts or after a loss. In Arena, only 1st place counts as a win.

## Friends and search

- **Friends tab:** everyone you've added, with rank, level, whether they're in your lobby or online on ff, and when they last played. Click a card to open their profile. Add anyone by Riot ID at the top; hover a card to remove someone.
- **Search bar** (top of the app): type any Riot ID and press Enter to open that player's profile, with an **Add friend** button if they're not on your list.
- **Party banners** are clickable too, and open that person's profile.

Friends with ff are still added automatically when they join your League lobby. Search and Riot ID friends need a Riot API key.

## Profiles

op.gg-style pages. The Profile tab opens on you; friends and search results open here too, with a link back to your own:

- **Rank:** Solo/Duo and Flex with tier, LP, and win/loss.
- **Last 20 games:** record, KDA, kill participation, and a win/loss streak strip.
- **Top champions** by mastery.
- **Match history** filterable by queue: champion, level, summoner spells, runes, KDA, CS/min, KP, items, and both teams. Expand any game for the full 10-player scoreboard with damage bars, gold, CS, vision and items. Friends are highlighted in their color.

Profiles need a **Riot API key** (Settings). With a key, profiles refresh on their own when they're more than 10 minutes old, or when you hit Update. Without one you still see your own games from the League client. You can also add friends who don't run ff in **Settings > Friends > Add by Riot ID**; they get a profile but no skin features.

## Collection

Like League's Collection page, but with your whole party in it.

- **Champions:** every champion with your mastery level and how many of their skins you own. Unowned champs are dimmed. Filter by role or ownership, and sort by name, mastery, or skins owned. Click a champ for their title, roles, abilities, short bio, everyone's mastery, and all their skins.
- **Skins:** every skin with its loading screen art, rarity (Epic, Legendary, Ultimate, Mythic, Transcendent, Exalted), legacy tag, skinline, and chromas (the colored dots are yours when lit).
- **Party ownership:** small avatars on each champ and skin show who in your party owns it. The ownership filter has options like "Alex owns, I don't," which is handy for gift ideas.

Friends need this version of ff for their champions and chromas to show up. Their skins show either way.

## Stats

The Stats tab has three views: **You**, **your partner**, and **Together**, each filterable by mode (All, Summoner's Rift, ARAM, Arena).

- **You / Partner:** hours played, games, win rate, KDA, most played champs, and all-time highest mastery.
- **Together:** games and hours as a duo, win rate together vs apart, favorite champ pairs, and how often you matched skins.

Where the data comes from:
- **League client:** mastery plus your recent games load automatically, and new games are added after each match.
- **Riot API (optional):** Settings > Import full match history pulls up to 2 years of games. Get a key at developer.riotgames.com. Dev keys expire after 24 hours, but imported games are saved, so you only need a fresh key if you want to import again. If a key expires mid-import, paste a new one and hit Import again; it picks up where it left off. A full import can take 20+ minutes because of Riot's rate limits.
- **Skin matching stats** only exist for games played since you installed ff (Riot doesn't record skins in match history).

Playtime is added up from game lengths, so it's only as complete as your stored history. Remakes are skipped.

Your API key is saved in plain text in the app's settings file on your PC. It never leaves your machine.

## Settings

- **Auto-equip matching skin:** equips your skin from the best shared skinline. It follows whatever skinline your partner is wearing if you own one. It only fires once per pairing, so manual changes stick.
- **Overlay:** small always-on-top window during champ select. Close it with × for the rest of that champ select.
- **Connect by address** (in the Party tab's add dialog): fallback if a friend doesn't show up automatically. Their PC's address is shown in the same dialog on their end.

## Troubleshooting

- **Partner never shows up:** check the firewall prompt was allowed, then use the manual address.
- **"League client not found":** the client has to be fully open (past the login screen).
- **Skin images missing:** images load from CommunityDragon, so you need internet for those. Everything else works offline.

Uses the League client's local API, which Riot allows for personal tools but doesn't officially support. A client patch could break something; if so, the fix is usually small.

## Riot legal notice

ff is not endorsed by Riot Games and does not reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games and all associated properties are trademarks or registered trademarks of Riot Games, Inc.

## Updates

ff updates itself from this repo's GitHub releases. On startup and every few hours it checks for a newer version, downloads it in the background, and shows **Restart to update** (in the account menu and a small pop-up). If you ignore it, the update installs the next time ff fully quits.

### Publishing a new version (Kam)

1. Bump `"version"` in `package.json` (for example 1.1.0 to 1.1.1). Everyone only gets updates with a higher version number.
2. Commit and push your changes.
3. In PowerShell, from the project folder:
   ```
   $env:GH_TOKEN = gh auth token --user lapis-xo
   npm run release
   ```
   This builds the installer and publishes it as a GitHub release (with the `latest.yml` file ff uses to find updates). Everyone's copy picks it up within a few hours, or on their next launch.

Friends need to install 1.1.0 or newer by hand once (the first version that can update itself). After that, updates are automatic.
