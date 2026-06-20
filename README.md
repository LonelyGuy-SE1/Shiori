# Shiori

Shiori is a Chrome MV3 extension for tracking anime watch progress on streaming sites and syncing watched progress to MyAnimeList.

It is built to stay minimal: local resume data is stored in Chrome extension storage, site access is opt-in, and MAL lookup data is cached so the popup opens quickly.

## Features

- Saves resume progress for tracked streaming pages.
- Works on AnimePahe by default and can be enabled for other streaming origins from the popup.
- Supports player iframes when the user grants access to the player frame origin.
- Detects anime title, episode number, runtime, progress, source site, page URL, and site icon.
- Shows saved shows with cover art, current episode, watched time, runtime, progress, last update, MAL status, and score.
- Searches saved shows from the Library tab.
- Connects to MyAnimeList with OAuth through Chrome identity.
- Uses MAL as the sync target and local storage as cache/resume state.
- Uses Jikan as a MAL-backed search fallback when MAL search is noisy.
- Caches MAL search results to keep popup load fast.
- Handles sequel, season, part, and cour numbers when matching MAL entries.
- Protects completed MAL entries from being reopened as watching.
- Avoids writing global site episode numbers to a smaller MAL season entry.
- Auto-selects high-confidence MAL matches.
- Auto-syncs only after the configured completion threshold is reached.
- Keeps ambiguous matches manual.
- Keeps track of episode URLs so you dont have to visit the streaming site everytime and will be taken to the episode just by clicking a single button.

## Screenshots

Add screenshots here after capture.

### Library

<img width="439" height="605" alt="image" src="https://github.com/user-attachments/assets/706b499d-1d41-4980-be8e-372f7f9d8975" />

### Current Site

Untracked Page:

<img width="427" height="565" alt="image" src="https://github.com/user-attachments/assets/0b69eee6-5d2a-4ab7-b9c7-254afab2f528" />

Tracked Page: 

<img width="434" height="604" alt="image" src="https://github.com/user-attachments/assets/3005a06d-c600-4a65-be9a-fba0ea33ea87" />

### MyAnimeList Setup

<img width="428" height="511" alt="image" src="https://github.com/user-attachments/assets/a031f4a1-2508-4b63-96a9-3f580a1dd514" />


## Requirements

- Chrome or a Chromium browser with Manifest V3 extension support.
- A MyAnimeList account for MAL sync.
- A MyAnimeList API application for OAuth.
- Streaming pages must expose an HTML video element to the browser, either on the page or inside a player iframe that Shiori can access.

## Install As An Unpacked Extension

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Select `Load unpacked`.
4. 
<img width="1366" height="684" alt="image" src="https://github.com/user-attachments/assets/31becae5-d460-410d-b510-d3b368bd678d" />

5. Choose the Shiori project folder, the folder containing `manifest.json`.
6. Pin Shiori from the Chrome extensions menu if you want quick access.

Chrome's official unpacked extension flow uses `chrome://extensions`, Developer mode, and `Load unpacked`. See the Chrome getting started guide for the base browser flow:
https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world

## MyAnimeList Setup

1. Load Shiori as an unpacked extension first.
2. Open the Shiori popup.
3. Go to the `MyAnimeList` tab.
4. Copy the `Redirect URL`.
5. Create or edit a MyAnimeList API application:
   https://myanimelist.net/apiconfig
6. Paste the Shiori redirect URL into the app's redirect URL field.

<img width="430" height="504" alt="image" src="https://github.com/user-attachments/assets/e35f4620-b8b0-4c8c-bc07-6f2e3d422f2d" />

7. Save the MAL application.
8. Copy the MAL `Client ID`.
9. Paste the `Client ID` into Shiori.
10. Paste the `Client Secret` only if your MAL app provides one and you want to use it.
11. Select `Connect MAL`.
12. Approve the MAL authorization prompt.

Chrome identity redirect URLs are generated with `chrome.identity.getRedirectURL()` and use the `https://<extension-id>.chromiumapp.org/*` shape. Shiori shows the exact redirect URL in the popup so you do not have to guess it.

Chrome identity API reference:
https://developer.chrome.com/docs/extensions/reference/api/identity

MAL API reference:
https://myanimelist.net/apiconfig/references/api/v2

Important: if the unpacked extension ID changes, the redirect URL changes too. Update the MAL application redirect URL if you move/reinstall the unpacked extension and MAL login stops working.

## Track A Site

1. Open an anime episode page.
2. Open Shiori.
3. Go to the `Site` tab.
4. Select `Track this site`.
5. Approve the Chrome site access prompt.
6. Reload the episode tab once after enabling access.
7. Start playback.

Shiori saves progress after the video has a real duration and playback has moved past the early-start guard.

## Track Player Frames

Some sites place the actual video inside a third-party iframe. In that case Shiori may show:

`No top-page video was found. The player is probably inside an iframe.`

Use `Track player frames` from the `Site` tab. Shiori will request access only for the detected player frame origins. Reload the episode page after granting access.

## Daily Use

1. Watch on a tracked site.
2. Open Shiori to see saved progress.
3. Use the Library search field when the list grows.
4. Use `Open episode` to resume from the saved source page.
5. Use `Remove` to delete a local saved entry.
6. Use `Refresh` to force fresh MAL match data.

Normal popup open uses cached/local data first so the UI should appear quickly. Fresh MAL lookups run only when needed or when you press `Refresh`.

## MAL Matching Rules

Shiori uses multiple safeguards before syncing:

- Exact and high-confidence title matches can be selected automatically.
- Season, sequel, part, and cour numbers are significant.
- Low-confidence or ambiguous matches remain manual.
- Jikan is used as a search fallback to find the right MAL ID when MAL search misses or returns noisy results.
- MAL detail data is still hydrated from MAL before sync when possible.

## MAL Sync Rules

Shiori does not write to MAL just because an episode started.

- Local resume progress can save at low progress.
- MAL episode progress syncs only after the configured completion threshold.
- Default completion threshold is `90%`.
- `plan_to_watch` can move to `watching` once safe to sync.
- `on_hold` can move to `watching` only through the safe sync path.
- `completed` entries are protected and will not be reopened as watching.
- Rewatch state is not actively managed.
- Dropped entries are not exposed as a normal user-facing workflow.
- If a site uses global episode numbers across seasons, Shiori avoids writing impossible episode counts to the MAL season.

Example: if a site shows episode `67` for a season that MAL lists as `19` episodes, Shiori can match the correct season but will not write `num_watched_episodes=67` to that MAL entry.

## Settings

- `Completion threshold`: percent watched before MAL episode progress is eligible to sync.
- `Save interval`: how often Shiori saves resume progress while playback continues.

## Supported Sites

Default tracked AnimePahe origins:

- `https://animepahe.com/*`
- `https://animepahe.ch/*`
- `https://animepahe.org/*`
- `https://animepahe.pw/*`

Other sites can be enabled from the popup. A site is trackable when Chrome exposes a usable video element to the extension and the user grants the needed host permissions.

## Performance Notes

- Popup opens from local storage first.
- MAL search results are cached.
- Remote MAL/Jikan searches are limited and refreshed on demand.
- Saved-show search is local and instant.
- Player iframe access is opt-in and scoped to detected frame origins.

## Troubleshooting

### MAL login fails

- Confirm the Redirect URL in Shiori exactly matches the MAL app redirect URL.
- If the extension was moved or reloaded with a different ID, copy the new Redirect URL into MAL.
- Confirm the Client ID is copied correctly.
- Reconnect MAL from the popup.

### The popup is not detecting the episode

- Confirm the current site is tracked.
- Reload the episode page after enabling site access.
- Check the `Site` tab diagnostics.
- If the video is inside an iframe, use `Track player frames`.

### The wrong MAL result appears

- Press `Refresh` to force a fresh lookup.
- If multiple entries are still plausible, use the manual `Use and sync` button for the correct entry.
- Season, part, and cour numbers should be included in the page title when the site provides them.

### MAL did not update after watching a few seconds

That is expected. Shiori saves local progress early, but MAL sync waits until the completion threshold is reached.

### Completed anime was not moved back to watching

That is expected. Completed MAL entries are protected.

## Development

This extension is plain MV3 JavaScript, HTML, and CSS. There is no build step.

Useful checks:

```powershell
node --check src/anime-identity.js
node --check src/mal-api.js
node --check src/background.js
node --check src/popup/popup.js
node --check src/content/videoTracker.js
node --check src/sync-policy.js
node --check src/settings.js
```

After editing `manifest.json`, reload the unpacked extension from `chrome://extensions`.

Note: This extension has only been tested on the Animepahe site.
Btw crunchyroll is gay. Doesnt have Made in Abyss. And also, too many restrictions. :(

