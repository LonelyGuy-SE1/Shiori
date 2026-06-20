# Shiori

A browser extension that bookmarks anime watch progress and syncs watched episodes to MyAnimeList.

## Current scope

- Saves local resume progress from tracked streaming origins that expose HTML video elements.
- Tracks Animepahe by default across `animepahe.com`, `animepahe.org`, and `animepahe.pw`.
- Lets the user enable tracking for the current site from the popup. The choice is persisted in extension storage.
- Keeps broad site access optional, so new streaming sites require an explicit user action.
- Shows each saved anime with episode, watch time, duration, source, last update, MAL images, account status, score, and sync controls.
- Updates MAL watched episode count through `num_watched_episodes` when the configured completion threshold is reached.
- Protects completed MAL entries from being moved back to watching.

## Local install

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Select Load unpacked.
4. Choose this project folder.

Open the popup on any http or https streaming page and select Track site to persist tracking for that origin.

## MyAnimeList setup

1. Create a MAL API app in your MyAnimeList API settings.
2. Copy the popup Redirect URL into that app.
3. Copy the MAL Client ID into Shiori.
4. Select Connect MAL.
