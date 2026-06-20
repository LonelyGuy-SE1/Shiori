import {
  createAnimeSearchQueries,
  normalizeTitleKey,
  scoreAnimeTitleMatch,
} from "./anime-identity.js";

const MAL_AUTH_STORAGE_KEY = "shiori.myAnimeList.auth";
const MAL_SEARCH_CACHE_STORAGE_KEY = "shiori.myAnimeList.searchCache";
const MAL_AUTH_BASE_URL = "https://myanimelist.net/v1/oauth2";
const MAL_API_BASE_URL = "https://api.myanimelist.net/v2";
const JIKAN_API_BASE_URL = "https://api.jikan.moe/v4";
const TOKEN_EXPIRY_BUFFER_MS = 60_000;
const SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SEARCH_CACHE_ENTRIES = 160;
const MIN_CONFIDENT_MATCH_SCORE = 58;
const STRONG_MATCH_SCORE = 88;
const SEARCH_RESULT_LIMIT = 8;
const DISPLAY_RESULT_LIMIT = 5;

export async function getMyAnimeListConnection() {
  const auth = await getStoredAuth();

  return {
    connected: Boolean(auth?.accessToken),
    clientId: auth?.clientId ?? "",
    hasClientSecret: Boolean(auth?.clientSecret),
    redirectUri: chrome.identity.getRedirectURL("mal"),
    user: auth?.user ?? null,
  };
}

export async function connectMyAnimeList({ clientId, clientSecret = "" }) {
  const normalizedClientId = requireClientId(clientId);
  const normalizedClientSecret = normalizeOptionalSecret(clientSecret);
  const redirectUri = chrome.identity.getRedirectURL("mal");
  const state = createRandomToken();
  const codeVerifier = createCodeVerifier();
  const authUrl = createAuthorizationUrl({
    clientId: normalizedClientId,
    redirectUri,
    state,
    codeVerifier,
  });
  const redirectUrl = await launchAuthFlow(authUrl);
  const redirectedUrl = new URL(redirectUrl);

  if (redirectedUrl.searchParams.get("state") !== state) {
    throw new Error("MAL authentication state did not match.");
  }

  const code = redirectedUrl.searchParams.get("code");

  if (!code) {
    throw new Error("MAL did not return an authorization code.");
  }

  const token = await requestToken({
    grant_type: "authorization_code",
    client_id: normalizedClientId,
    client_secret: normalizedClientSecret,
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
  });
  const auth = normalizeTokenResponse(
    token,
    normalizedClientId,
    normalizedClientSecret,
  );
  const user = await fetchMyAnimeListUser(auth.accessToken).catch(() => null);
  const nextAuth = {
    ...auth,
    user,
  };

  await setStoredAuth(nextAuth);

  return getMyAnimeListConnection();
}

export async function disconnectMyAnimeList() {
  await chrome.storage.local.remove(MAL_AUTH_STORAGE_KEY);

  return getMyAnimeListConnection();
}

export async function searchMyAnimeListAnime(query, options = {}) {
  const queries = createAnimeSearchQueries(query);

  if (queries.length === 0) {
    return [];
  }

  const cacheKey = createSearchCacheKey(queries[0]);
  const cachedResults = await getCachedSearchResults(cacheKey);
  const cacheOnly = options?.cacheOnly === true;
  const forceRefresh = options?.forceRefresh === true;

  if (cachedResults && (!forceRefresh || cacheOnly)) {
    return cachedResults;
  }

  if (cacheOnly) {
    return [];
  }

  const accessToken = await getValidAccessToken();
  let lastError = null;
  const animeById = new Map();

  for (const safeQuery of queries) {
    try {
      const results = await fetchMyAnimeListSearch(safeQuery, accessToken);

      for (const anime of results) {
        animeById.set(anime.id, anime);
      }
    } catch (error) {
      lastError = error;
    }

    if (hasStrongSearchResult(animeById, queries[0])) {
      break;
    }
  }

  if (!hasStrongSearchResult(animeById, queries[0])) {
    for (const safeQuery of queries.slice(0, 2)) {
      try {
        const results = await fetchJikanSearch(safeQuery);

        for (const anime of results) {
          if (!animeById.has(anime.id)) {
            animeById.set(anime.id, anime);
          }
        }
      } catch (error) {
        lastError = error;
      }

      if (hasStrongSearchResult(animeById, queries[0])) {
        break;
      }
    }
  }

  let results = [...animeById.values()];

  if (results.length === 0 && lastError) {
    throw lastError;
  }

  results = await hydrateSearchResults(results, queries[0], accessToken);

  const rankedResults = rankAnimeSearchResults(results, queries[0])
    .filter((anime) => anime.matchConfidence >= MIN_CONFIDENT_MATCH_SCORE)
    .slice(0, DISPLAY_RESULT_LIMIT);

  await setCachedSearchResults(cacheKey, rankedResults);

  return rankedResults;
}

async function fetchMyAnimeListSearch(query, accessToken) {
  const safeQuery = requireSearchQuery(query);
  const url = new URL(`${MAL_API_BASE_URL}/anime`);

  url.searchParams.set("q", safeQuery);
  url.searchParams.set("limit", String(SEARCH_RESULT_LIMIT));
  url.searchParams.set(
    "fields",
    "id,title,main_picture,alternative_titles,num_episodes,my_list_status",
  );

  const response = await fetch(url.href, {
    headers: createAuthHeaders(accessToken),
  });

  if (!response.ok) {
    throw new Error(await createHttpErrorMessage(response, "MAL search"));
  }

  const payload = await response.json();

  return normalizeAnimeSearchResults(payload);
}

async function fetchJikanSearch(query) {
  const safeQuery = requireSearchQuery(query);
  const url = new URL(`${JIKAN_API_BASE_URL}/anime`);

  url.searchParams.set("q", safeQuery);
  url.searchParams.set("sfw", "true");
  url.searchParams.set("limit", String(SEARCH_RESULT_LIMIT));

  const response = await fetch(url.href);

  if (!response.ok) {
    throw new Error(await createHttpErrorMessage(response, "Jikan search"));
  }

  const payload = await response.json();

  return normalizeJikanAnimeSearchResults(payload);
}

export async function syncResumeStateToMyAnimeList({
  resumeState,
  libraryState,
  animeId,
  settings,
}) {
  const mediaId = normalizePositiveInteger(animeId ?? libraryState?.mediaId);

  if (!mediaId) {
    throw new Error("Choose a MAL anime before syncing.");
  }

  const accessToken = await getValidAccessToken();
  const anime = await fetchMyAnimeListAnime(mediaId, accessToken);
  const currentStatus = anime.myListStatus?.status ?? null;
  const score = normalizeScore(libraryState?.score);
  const update = createMyAnimeListUpdate({
    currentStatus,
    score,
    episodeNumber: resumeState?.episodeNumber,
    maxEpisodeNumber: anime.numEpisodes,
    progressRatio: resumeState?.progressRatio,
    threshold: settings?.watchCompletionThresholdRatio,
  });

  if (Object.keys(update).length === 0) {
    return {
      skipped: true,
      reason: "NO_SAFE_MAL_UPDATE",
      anime,
    };
  }

  const response = await fetch(
    `${MAL_API_BASE_URL}/anime/${mediaId}/my_list_status`,
    {
      method: "PUT",
      headers: {
        ...createAuthHeaders(accessToken),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(update),
    },
  );

  if (!response.ok) {
    throw new Error(`MAL sync failed with status ${response.status}.`);
  }

  const listStatus = await response.json();

  return {
    skipped: false,
    anime: {
      ...anime,
      myListStatus: normalizeMyListStatus(listStatus),
    },
    update,
  };
}

export function createMyAnimeListUpdate({
  currentStatus,
  score,
  episodeNumber,
  maxEpisodeNumber,
  progressRatio,
  threshold,
}) {
  const update = {};
  const safeCurrentStatus = normalizeListStatus(currentStatus);
  const safeScore = normalizeScore(score);

  if (safeScore !== null) {
    update.score = String(safeScore);
  }

  if (safeCurrentStatus === "completed") {
    return update;
  }

  if (safeCurrentStatus === "dropped") {
    return update;
  }

  if (!safeCurrentStatus || safeCurrentStatus === "plan_to_watch") {
    update.status = "watching";
  }

  if (safeCurrentStatus === "on_hold") {
    update.status = "watching";
  }

  if (
    shouldUpdateEpisode(
      progressRatio,
      threshold,
      episodeNumber,
      maxEpisodeNumber,
    )
  ) {
    update.num_watched_episodes = String(episodeNumber);
  }

  return update;
}

async function fetchMyAnimeListAnime(animeId, accessToken) {
  const url = new URL(`${MAL_API_BASE_URL}/anime/${animeId}`);

  url.searchParams.set(
    "fields",
    "id,title,main_picture,alternative_titles,num_episodes,my_list_status",
  );

  const response = await fetch(url.href, {
    headers: createAuthHeaders(accessToken),
  });

  if (!response.ok) {
    throw new Error(`MAL anime lookup failed with status ${response.status}.`);
  }

  return normalizeAnime(await response.json());
}

async function fetchMyAnimeListUser(accessToken) {
  const response = await fetch(`${MAL_API_BASE_URL}/users/@me`, {
    headers: createAuthHeaders(accessToken),
  });

  if (!response.ok) {
    throw new Error(`MAL profile lookup failed with status ${response.status}.`);
  }

  const user = await response.json();

  return {
    id: user.id ?? null,
    name: user.name ?? null,
    picture: user.picture ?? null,
  };
}

async function getValidAccessToken() {
  const auth = await getStoredAuth();

  if (!auth?.accessToken || !auth?.clientId) {
    throw new Error("Connect MyAnimeList before syncing.");
  }

  if (auth.expiresAt && Date.now() < auth.expiresAt - TOKEN_EXPIRY_BUFFER_MS) {
    return auth.accessToken;
  }

  if (!auth.refreshToken) {
    throw new Error("MAL session expired. Connect again.");
  }

  const token = await requestToken({
    grant_type: "refresh_token",
    client_id: auth.clientId,
    client_secret: auth.clientSecret,
    refresh_token: auth.refreshToken,
  });
  const nextAuth = {
    ...auth,
    ...normalizeTokenResponse(token, auth.clientId, auth.clientSecret),
  };

  await setStoredAuth(nextAuth);

  return nextAuth.accessToken;
}

async function getStoredAuth() {
  const stored = await chrome.storage.local.get(MAL_AUTH_STORAGE_KEY);
  const value = stored[MAL_AUTH_STORAGE_KEY];

  if (!value || typeof value !== "object") {
    return null;
  }

  return {
    clientId: typeof value.clientId === "string" ? value.clientId : "",
    clientSecret:
      typeof value.clientSecret === "string" ? value.clientSecret : "",
    accessToken:
      typeof value.accessToken === "string" ? value.accessToken : "",
    refreshToken:
      typeof value.refreshToken === "string" ? value.refreshToken : "",
    tokenType: typeof value.tokenType === "string" ? value.tokenType : "Bearer",
    expiresAt:
      typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt)
        ? value.expiresAt
        : 0,
    user: value.user && typeof value.user === "object" ? value.user : null,
  };
}

async function setStoredAuth(auth) {
  await chrome.storage.local.set({
    [MAL_AUTH_STORAGE_KEY]: auth,
  });
}

function launchAuthFlow(url) {
  return chrome.identity.launchWebAuthFlow({
    url,
    interactive: true,
  });
}

async function requestToken(body) {
  const tokenBody = new URLSearchParams();

  for (const [key, value] of Object.entries(body)) {
    if (typeof value === "string" && value.length > 0) {
      tokenBody.set(key, value);
    }
  }

  const response = await fetch(`${MAL_AUTH_BASE_URL}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: tokenBody,
  });

  if (!response.ok) {
    throw new Error(await createHttpErrorMessage(response, "MAL token request"));
  }

  return response.json();
}

function createAuthorizationUrl({ clientId, redirectUri, state, codeVerifier }) {
  const url = new URL(`${MAL_AUTH_BASE_URL}/authorize`);

  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeVerifier);

  return url.href;
}

async function createHttpErrorMessage(response, label) {
  const text = await response.text().catch(() => "");
  const details = text.trim().slice(0, 240);

  if (details.length > 0) {
    return `${label} failed with status ${response.status}: ${details}`;
  }

  return `${label} failed with status ${response.status}.`;
}

function normalizeTokenResponse(token, clientId, clientSecret) {
  const accessToken = requireString(token?.access_token, "access_token");
  const refreshToken = requireString(token?.refresh_token, "refresh_token");
  const expiresIn = Number(token?.expires_in);

  return {
    clientId,
    clientSecret,
    accessToken,
    refreshToken,
    tokenType:
      typeof token?.token_type === "string" ? token.token_type : "Bearer",
    expiresAt:
      Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000,
  };
}

function normalizeAnimeSearchResults(payload) {
  if (!Array.isArray(payload?.data)) {
    return [];
  }

  return payload.data.map((entry) => normalizeAnime(entry.node)).filter(Boolean);
}

function normalizeJikanAnimeSearchResults(payload) {
  if (!Array.isArray(payload?.data)) {
    return [];
  }

  return payload.data.map(normalizeJikanAnime).filter(Boolean);
}

async function getCachedSearchResults(cacheKey) {
  const cache = await getSearchCache();
  const cachedEntry = cache[cacheKey];

  if (!cachedEntry || typeof cachedEntry !== "object") {
    return null;
  }

  const updatedAt =
    typeof cachedEntry.updatedAt === "number" && Number.isFinite(cachedEntry.updatedAt)
      ? cachedEntry.updatedAt
      : 0;

  if (Date.now() - updatedAt > SEARCH_CACHE_TTL_MS) {
    return null;
  }

  if (!Array.isArray(cachedEntry.results)) {
    return null;
  }

  return cachedEntry.results.map(normalizeCachedAnime).filter(Boolean);
}

async function setCachedSearchResults(cacheKey, results) {
  const cache = await getSearchCache();

  cache[cacheKey] = {
    updatedAt: Date.now(),
    results: results.map(normalizeCachedAnime).filter(Boolean),
  };

  const entries = Object.entries(cache)
    .filter(([, entry]) => Array.isArray(entry?.results))
    .sort(([, left], [, right]) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
    .slice(0, MAX_SEARCH_CACHE_ENTRIES);

  await chrome.storage.local.set({
    [MAL_SEARCH_CACHE_STORAGE_KEY]: Object.fromEntries(entries),
  });
}

async function getSearchCache() {
  const stored = await chrome.storage.local.get(MAL_SEARCH_CACHE_STORAGE_KEY);
  const cache = stored[MAL_SEARCH_CACHE_STORAGE_KEY];

  return cache && typeof cache === "object" && !Array.isArray(cache)
    ? cache
    : {};
}

async function hydrateSearchResults(results, query, accessToken) {
  const ranked = rankAnimeSearchResults(results, query);
  const hydratedById = new Map();

  await Promise.all(
    ranked.slice(0, DISPLAY_RESULT_LIMIT).map(async (anime) => {
      if (anime.myListStatus) {
        hydratedById.set(anime.id, anime);
        return;
      }

      try {
        hydratedById.set(
          anime.id,
          await fetchMyAnimeListAnime(anime.id, accessToken),
        );
      } catch {
        hydratedById.set(anime.id, anime);
      }
    }),
  );

  return results.map((anime) => hydratedById.get(anime.id) ?? anime);
}

function hasStrongSearchResult(animeById, query) {
  return [...animeById.values()].some(
    (anime) =>
      scoreAnimeSearchResult(anime, normalizeTitleKey(query)) >= STRONG_MATCH_SCORE,
  );
}

function rankAnimeSearchResults(results, query) {
  const queryKey = normalizeTitleKey(query);

  return [...results]
    .map((anime) => ({
      ...anime,
      matchConfidence: scoreAnimeSearchResult(anime, queryKey),
    }))
    .sort((left, right) => {
      const confidenceDelta = right.matchConfidence - left.matchConfidence;

      if (confidenceDelta !== 0) {
        return confidenceDelta;
      }

      return getListStatusRank(right) - getListStatusRank(left);
    });
}

function scoreAnimeSearchResult(anime, queryKey) {
  const titleScore = scoreAnimeTitleMatch(queryKey, getAnimeCandidateTitles(anime));
  let score = titleScore;

  if (titleScore >= MIN_CONFIDENT_MATCH_SCORE && anime.myListStatus?.status) {
    score += 5;
  }

  if (
    titleScore >= MIN_CONFIDENT_MATCH_SCORE &&
    Number.isInteger(anime.numEpisodes) &&
    anime.numEpisodes > 0
  ) {
    score += 2;
  }

  return Math.min(score, 100);
}

function getAnimeCandidateTitles(anime) {
  return [
    anime.title,
    anime.alternativeTitles?.en,
    anime.alternativeTitles?.ja,
    ...(anime.alternativeTitles?.synonyms ?? []),
  ].filter((title) => typeof title === "string" && title.trim().length > 0);
}

function getListStatusRank(anime) {
  const status = anime.myListStatus?.status;

  switch (status) {
    case "watching":
      return 5;

    case "plan_to_watch":
      return 4;

    case "on_hold":
      return 3;

    case "completed":
      return 2;

    default:
      return 1;
  }
}

function normalizeCachedAnime(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const id = normalizePositiveInteger(value.id);
  const title = typeof value.title === "string" ? value.title : null;

  if (!id || !title) {
    return null;
  }

  return {
    id,
    title,
    mainPicture: {
      medium: normalizeUrl(value.mainPicture?.medium),
      large: normalizeUrl(value.mainPicture?.large),
    },
    alternativeTitles: {
      synonyms: Array.isArray(value.alternativeTitles?.synonyms)
        ? value.alternativeTitles.synonyms.filter(
            (titleValue) => typeof titleValue === "string",
          )
        : [],
      en:
        typeof value.alternativeTitles?.en === "string"
          ? value.alternativeTitles.en
          : null,
      ja:
        typeof value.alternativeTitles?.ja === "string"
          ? value.alternativeTitles.ja
          : null,
    },
    numEpisodes: normalizePositiveInteger(value.numEpisodes),
    myListStatus: normalizeCachedMyListStatus(value.myListStatus),
    matchConfidence: normalizeNonNegativeInteger(value.matchConfidence),
  };
}

function normalizeCachedMyListStatus(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  return {
    status: normalizeListStatus(value.status),
    score: normalizeScore(value.score),
    numEpisodesWatched: normalizeNonNegativeInteger(value.numEpisodesWatched),
    isRewatching: value.isRewatching === true,
  };
}

function normalizeAnime(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const id = normalizePositiveInteger(value.id);
  const title = typeof value.title === "string" ? value.title : null;

  if (!id || !title) {
    return null;
  }

  return {
    id,
    title,
    mainPicture: {
      medium: normalizeUrl(value.main_picture?.medium),
      large: normalizeUrl(value.main_picture?.large),
    },
    alternativeTitles: {
      synonyms: Array.isArray(value.alternative_titles?.synonyms)
        ? value.alternative_titles.synonyms.filter(
            (titleValue) => typeof titleValue === "string",
          )
        : [],
      en:
        typeof value.alternative_titles?.en === "string"
          ? value.alternative_titles.en
          : null,
      ja:
        typeof value.alternative_titles?.ja === "string"
          ? value.alternative_titles.ja
          : null,
    },
    numEpisodes: normalizePositiveInteger(value.num_episodes),
    myListStatus: normalizeMyListStatus(value.my_list_status),
  };
}

function normalizeJikanAnime(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const id = normalizePositiveInteger(value.mal_id);
  const title = typeof value.title === "string" ? value.title : null;

  if (!id || !title) {
    return null;
  }

  return {
    id,
    title,
    mainPicture: {
      medium: normalizeUrl(
        value.images?.webp?.image_url ?? value.images?.jpg?.image_url,
      ),
      large: normalizeUrl(
        value.images?.webp?.large_image_url ??
          value.images?.jpg?.large_image_url,
      ),
    },
    alternativeTitles: {
      synonyms: Array.isArray(value.title_synonyms)
        ? value.title_synonyms.filter(
            (titleValue) => typeof titleValue === "string",
          )
        : [],
      en:
        typeof value.title_english === "string" ? value.title_english : null,
      ja:
        typeof value.title_japanese === "string" ? value.title_japanese : null,
    },
    numEpisodes: normalizePositiveInteger(value.episodes),
    myListStatus: null,
  };
}

function normalizeMyListStatus(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  return {
    status: normalizeListStatus(value.status),
    score: normalizeScore(value.score),
    numEpisodesWatched: normalizeNonNegativeInteger(
      value.num_episodes_watched,
    ),
    isRewatching: value.is_rewatching === true,
  };
}

function normalizeListStatus(value) {
  const allowed = new Set([
    "watching",
    "completed",
    "on_hold",
    "dropped",
    "plan_to_watch",
  ]);

  return allowed.has(value) ? value : null;
}

function shouldUpdateEpisode(
  progressRatio,
  threshold,
  episodeNumber,
  maxEpisodeNumber,
) {
  if (!Number.isInteger(episodeNumber) || episodeNumber <= 0) {
    return false;
  }

  if (
    Number.isInteger(maxEpisodeNumber) &&
    maxEpisodeNumber > 0 &&
    episodeNumber > maxEpisodeNumber
  ) {
    return false;
  }

  const safeRatio =
    typeof progressRatio === "number" && Number.isFinite(progressRatio)
      ? progressRatio
      : 0;
  const safeThreshold =
    typeof threshold === "number" && Number.isFinite(threshold)
      ? Math.min(Math.max(threshold, 0.5), 0.99)
      : 0.9;

  return safeRatio >= safeThreshold;
}

function createAuthHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
  };
}

function requireClientId(value) {
  const clientId = requireString(value, "MAL client ID");

  if (clientId.length < 8) {
    throw new Error("Enter a valid MAL client ID.");
  }

  return clientId;
}

function normalizeOptionalSecret(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function requireSearchQuery(value) {
  const query = requireString(value, "MAL search query");

  if (query.length < 2) {
    throw new Error("MAL search query is too short.");
  }

  return query.slice(0, 120);
}

function createSearchCacheKey(query) {
  return normalizeTitleKey(query).slice(0, 160);
}

function requireString(value, fieldName) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} is required.`);
  }

  return value.trim();
}

function normalizeScore(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const score = Number(value);

  if (!Number.isFinite(score)) {
    return null;
  }

  const roundedScore = Math.round(score);

  if (roundedScore <= 0) {
    return null;
  }

  return Math.min(roundedScore, 10);
}

function normalizePositiveInteger(value) {
  if (Number.isInteger(value) && value > 0) {
    return value;
  }

  return null;
}

function normalizeNonNegativeInteger(value) {
  if (Number.isInteger(value) && value >= 0) {
    return value;
  }

  return null;
}

function normalizeUrl(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  try {
    return new URL(value).href;
  } catch {
    return null;
  }
}

function createRandomToken() {
  const values = new Uint8Array(24);
  crypto.getRandomValues(values);

  return base64UrlEncode(values);
}

function createCodeVerifier() {
  const values = new Uint8Array(96);
  crypto.getRandomValues(values);

  return base64UrlEncode(values).slice(0, 128);
}

function base64UrlEncode(values) {
  return btoa(String.fromCharCode(...values))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
