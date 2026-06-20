import { getSettings, updateSettings, resetSettings } from "./settings.js";
import {
  connectMyAnimeList,
  disconnectMyAnimeList,
  getMyAnimeListConnection,
  searchMyAnimeListAnime,
  syncResumeStateToMyAnimeList,
} from "./mal-api.js";
import {
  createDefaultAnimeLibraryState,
  createSyncPlan,
  normalizeAnimeLibraryState,
} from "./sync-policy.js";
import { isInvalidAnimeTitle, parseAnimeIdentity } from "./anime-identity.js";
import {
  DEFAULT_TRACKED_SITE_INPUTS,
  TRACKED_SITES_STORAGE_KEY,
  TRACKER_SCRIPT_FILE,
  TRACKER_SCRIPT_ID_PREFIX,
  createOriginPattern,
  createTrackedSiteRecord,
  createTrackedSiteScriptId,
  normalizeTrackableOrigin,
  normalizeTrackedSites,
} from "./tracked-sites.js";

const MESSAGE_TYPES = Object.freeze({
  HEALTH_CHECK: "HEALTH_CHECK",

  GET_SETTINGS: "GET_SETTINGS",
  UPDATE_SETTINGS: "UPDATE_SETTINGS",
  RESET_SETTINGS: "RESET_SETTINGS",

  SAVE_RESUME_STATE: "SAVE_RESUME_STATE",
  REGISTER_PAGE_CONTEXT: "REGISTER_PAGE_CONTEXT",
  GET_PAGE_CONTEXT: "GET_PAGE_CONTEXT",
  GET_RESUME_STATES: "GET_RESUME_STATES",
  CLEAR_RESUME_STATE: "CLEAR_RESUME_STATE",
  UPDATE_ANIME_LIBRARY_STATE: "UPDATE_ANIME_LIBRARY_STATE",

  GET_MY_ANIME_LIST_STATUS: "GET_MY_ANIME_LIST_STATUS",
  CONNECT_MY_ANIME_LIST: "CONNECT_MY_ANIME_LIST",
  DISCONNECT_MY_ANIME_LIST: "DISCONNECT_MY_ANIME_LIST",
  SYNC_RESUME_STATE_TO_MY_ANIME_LIST: "SYNC_RESUME_STATE_TO_MY_ANIME_LIST",

  GET_TRACKED_SITES: "GET_TRACKED_SITES",
  ENABLE_TRACKED_SITE: "ENABLE_TRACKED_SITE",
  DISABLE_TRACKED_SITE: "DISABLE_TRACKED_SITE",

  SEARCH_MY_ANIME_LIST: "SEARCH_MY_ANIME_LIST",
});

const STORAGE_KEYS = Object.freeze({
  RESUME_STATES: "shiori.resumeStates",
  ANIME_LIBRARY_STATES: "shiori.animeLibraryStates",
  PAGE_CONTEXTS: "shiori.pageContexts",
  TRACKED_SITES: TRACKED_SITES_STORAGE_KEY,
});

const PAGE_CONTEXT_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_PAGE_CONTEXTS = 200;

class ShioriError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "ShioriError";
    this.code = code;
    this.details = details;
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await initialiseStorage();
  await syncTrackedSiteContentScripts();
});

chrome.runtime.onStartup.addListener(() => {
  syncTrackedSiteContentScripts().catch((error) => {
    console.error("Shiori failed to sync tracked content scripts.", error);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((data) => {
      sendResponse({
        ok: true,
        data,
      });
    })
    .catch((error) => {
      sendResponse({
        ok: false,
        error: serializeError(error),
      });
    });

  return true;
});

async function handleMessage(message, sender) {
  assertValidMessage(message);

  switch (message.type) {
    case MESSAGE_TYPES.HEALTH_CHECK:
      return handleHealthCheck();

    case MESSAGE_TYPES.GET_SETTINGS:
      return getSettings();

    case MESSAGE_TYPES.UPDATE_SETTINGS:
      return updateSettings(message.payload);

    case MESSAGE_TYPES.RESET_SETTINGS:
      return resetSettings();

    case MESSAGE_TYPES.SAVE_RESUME_STATE:
      return handleSaveResumeState(message.payload, sender);

    case MESSAGE_TYPES.REGISTER_PAGE_CONTEXT:
      return handleRegisterPageContext(message.payload, sender);

    case MESSAGE_TYPES.GET_PAGE_CONTEXT:
      return handleGetPageContext(message.payload, sender);

    case MESSAGE_TYPES.GET_RESUME_STATES:
      return handleGetResumeStates(message.payload);

    case MESSAGE_TYPES.CLEAR_RESUME_STATE:
      return handleClearResumeState(message.payload);

    case MESSAGE_TYPES.UPDATE_ANIME_LIBRARY_STATE:
      return handleUpdateAnimeLibraryState(message.payload);

    case MESSAGE_TYPES.GET_MY_ANIME_LIST_STATUS:
      return getMyAnimeListConnection();

    case MESSAGE_TYPES.CONNECT_MY_ANIME_LIST:
      return handleConnectMyAnimeList(message.payload);

    case MESSAGE_TYPES.DISCONNECT_MY_ANIME_LIST:
      return disconnectMyAnimeList();

    case MESSAGE_TYPES.SYNC_RESUME_STATE_TO_MY_ANIME_LIST:
      return handleSyncResumeStateToMyAnimeList(message.payload);

    case MESSAGE_TYPES.GET_TRACKED_SITES:
      return handleGetTrackedSites();

    case MESSAGE_TYPES.ENABLE_TRACKED_SITE:
      return handleEnableTrackedSite(message.payload);

    case MESSAGE_TYPES.DISABLE_TRACKED_SITE:
      return handleDisableTrackedSite(message.payload);

    case MESSAGE_TYPES.SEARCH_MY_ANIME_LIST:
      return handleSearchMyAnimeList(message.payload);

    default:
      throw new ShioriError(
        "UNKNOWN_MESSAGE_TYPE",
        `Unknown message type: ${message.type}`,
      );
  }
}

async function initialiseStorage() {
  await ensureResumeStateStore();
  await ensureAnimeLibraryStateStore();
  await ensurePageContextStore();
  await ensureTrackedSiteStore();
  await getSettings();
}

async function ensureResumeStateStore() {
  const existing = await chrome.storage.local.get(STORAGE_KEYS.RESUME_STATES);

  if (!existing[STORAGE_KEYS.RESUME_STATES]) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.RESUME_STATES]: {},
    });
  }
}

async function ensureAnimeLibraryStateStore() {
  const existing = await chrome.storage.local.get(
    STORAGE_KEYS.ANIME_LIBRARY_STATES,
  );

  if (!existing[STORAGE_KEYS.ANIME_LIBRARY_STATES]) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.ANIME_LIBRARY_STATES]: {},
    });
  }
}

async function ensurePageContextStore() {
  const existing = await chrome.storage.local.get(STORAGE_KEYS.PAGE_CONTEXTS);

  if (!existing[STORAGE_KEYS.PAGE_CONTEXTS]) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.PAGE_CONTEXTS]: {},
    });
  }
}

async function ensureTrackedSiteStore() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.TRACKED_SITES);
  const storedSites = stored[STORAGE_KEYS.TRACKED_SITES];

  if (!Array.isArray(storedSites)) {
    await setTrackedSites(
      DEFAULT_TRACKED_SITE_INPUTS.map((site) =>
        createTrackedSiteRecord(site),
      ).filter(Boolean),
    );

    return;
  }

  const normalizedSites = normalizeTrackedSites(storedSites);
  const defaultSites = DEFAULT_TRACKED_SITE_INPUTS.map((site) =>
    createTrackedSiteRecord(site),
  ).filter(Boolean);
  const normalizedOrigins = new Set(normalizedSites.map((site) => site.origin));
  const missingDefaultSites = defaultSites.filter(
    (site) => !normalizedOrigins.has(site.origin),
  );

  if (
    normalizedSites.length !== storedSites.length ||
    missingDefaultSites.length > 0
  ) {
    await setTrackedSites([...normalizedSites, ...missingDefaultSites]);
  }
}

function handleHealthCheck() {
  return {
    extension: "Shiori",
    status: "ready",
    timestamp: Date.now(),
  };
}

async function handleSaveResumeState(payload, sender) {
  const settings = await getSettings();

  if (!settings.resume.enabled) {
    return {
      skipped: true,
      reason: "RESUME_TRACKING_DISABLED",
    };
  }

  const pageContext = await findPageContextForPayload(payload, sender);
  const resumeState = normalizeResumeState(
    applyPageContextToResumePayload(payload, pageContext),
    sender,
  );

  if (isInvalidResumeState(resumeState)) {
    return {
      skipped: true,
      reason: "INVALID_ANIME_IDENTITY",
    };
  }

  if (resumeState.durationSeconds < settings.minimumVideoDurationSeconds) {
    return {
      skipped: true,
      reason: "VIDEO_DURATION_BELOW_MINIMUM",
    };
  }

  const resumeKey = createResumeKey(resumeState);

  const stored = await chrome.storage.local.get(STORAGE_KEYS.RESUME_STATES);
  const resumeStates = stored[STORAGE_KEYS.RESUME_STATES] ?? {};

  for (const [storedKey, storedState] of Object.entries(resumeStates)) {
    if (
      storedKey !== resumeKey &&
      storedState?.episodeUrl === resumeState.episodeUrl
    ) {
      delete resumeStates[storedKey];
    }
  }

  resumeStates[resumeKey] = resumeState;

  await chrome.storage.local.set({
    [STORAGE_KEYS.RESUME_STATES]: resumeStates,
  });

  const libraryState = await ensureAnimeLibraryState(resumeKey);
  const autoSync = await maybeAutoSyncResumeState({
    resumeKey,
    resumeState,
    libraryState,
    settings,
  });

  return {
    resumeKey,
    resumeState,
    autoSync,
  };
}

async function handleRegisterPageContext(payload, sender) {
  const context = normalizePageContext(payload, sender);

  if (!context) {
    return null;
  }

  const contexts = await getPageContexts();
  contexts[context.pageUrl] = context;

  await setPageContexts(contexts);

  return context;
}

async function handleGetPageContext(payload, sender) {
  const pageUrl =
    normalizeOptionalUrl(payload?.pageUrl) ??
    normalizeOptionalUrl(sender?.url) ??
    normalizeOptionalUrl(sender?.tab?.url);

  if (!pageUrl) {
    return null;
  }

  const contexts = await getPageContexts();

  return contexts[pageUrl] ?? null;
}

async function handleGetResumeStates(payload = null) {
  const refreshMyAnimeList = payload?.refreshMyAnimeList === true;
  const forceMyAnimeListRefresh = payload?.forceMyAnimeListRefresh === true;
  const matchRefreshLimit = normalizePositiveInteger(payload?.matchRefreshLimit) ?? 5;
  const [stored, libraryStates, settings] = await Promise.all([
    chrome.storage.local.get(STORAGE_KEYS.RESUME_STATES),
    getAnimeLibraryStates(),
    getSettings(),
  ]);
  const repairResult = await repairResumeStatesWithPageContexts(
    stored[STORAGE_KEYS.RESUME_STATES] ?? {},
    libraryStates,
  );
  const resumeStates = repairResult.resumeStates;
  const nextLibraryStates = repairResult.libraryStates;

  if (repairResult.changed) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.RESUME_STATES]: resumeStates,
      [STORAGE_KEYS.ANIME_LIBRARY_STATES]: nextLibraryStates,
    });
  }

  const enrichedStates = Object.entries(resumeStates)
    .map(([resumeKey, resumeState]) =>
      enrichResumeState(resumeKey, resumeState, nextLibraryStates, settings),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return enrichResumeStatesWithMyAnimeList(enrichedStates, nextLibraryStates, {
    cacheOnly: !refreshMyAnimeList,
    forceRefresh: forceMyAnimeListRefresh,
    limit: refreshMyAnimeList ? matchRefreshLimit : enrichedStates.length,
  });
}

async function handleClearResumeState(payload) {
  if (!payload || typeof payload.resumeKey !== "string") {
    throw new ShioriError(
      "INVALID_CLEAR_PAYLOAD",
      "CLEAR_RESUME_STATE requires a string resumeKey.",
    );
  }

  const stored = await chrome.storage.local.get(STORAGE_KEYS.RESUME_STATES);
  const resumeStates = stored[STORAGE_KEYS.RESUME_STATES] ?? {};

  delete resumeStates[payload.resumeKey];

  const libraryStates = await getAnimeLibraryStates();
  delete libraryStates[payload.resumeKey];

  await chrome.storage.local.set({
    [STORAGE_KEYS.RESUME_STATES]: resumeStates,
    [STORAGE_KEYS.ANIME_LIBRARY_STATES]: libraryStates,
  });

  return {
    removed: payload.resumeKey,
  };
}

async function handleUpdateAnimeLibraryState(payload) {
  if (!payload || typeof payload.resumeKey !== "string") {
    throw new ShioriError(
      "INVALID_LIBRARY_STATE_PAYLOAD",
      "UPDATE_ANIME_LIBRARY_STATE requires a resumeKey.",
    );
  }

  const stored = await chrome.storage.local.get(STORAGE_KEYS.RESUME_STATES);
  const resumeStates = stored[STORAGE_KEYS.RESUME_STATES] ?? {};

  if (!resumeStates[payload.resumeKey]) {
    throw new ShioriError(
      "UNKNOWN_RESUME_KEY",
      "Cannot update sync state for an unknown anime.",
    );
  }

  const libraryStates = await getAnimeLibraryStates();
  const currentState = normalizeAnimeLibraryState(
    libraryStates[payload.resumeKey],
  );
  const nextState = normalizeAnimeLibraryState({
    ...currentState,
    ...payload.libraryState,
    updatedAt: Date.now(),
  });

  libraryStates[payload.resumeKey] = nextState;

  await chrome.storage.local.set({
    [STORAGE_KEYS.ANIME_LIBRARY_STATES]: libraryStates,
  });

  const settings = await getSettings();

  return enrichResumeState(
    payload.resumeKey,
    resumeStates[payload.resumeKey],
    libraryStates,
    settings,
  );
}

async function handleConnectMyAnimeList(payload) {
  const connection = await connectMyAnimeList({
    clientId: payload?.clientId,
    clientSecret: payload?.clientSecret,
  });

  await updateSettings({
    sync: {
      myAnimeListClientId: connection.clientId,
      myAnimeListClientSecret: payload?.clientSecret ?? "",
      myAnimeList: true,
      autoSyncMyAnimeList: true,
    },
  });

  return connection;
}

async function handleSyncResumeStateToMyAnimeList(payload) {
  if (!payload || typeof payload.resumeKey !== "string") {
    throw new ShioriError(
      "INVALID_MAL_SYNC_PAYLOAD",
      "MAL sync requires a resumeKey.",
    );
  }

  const [stored, libraryStates, settings] = await Promise.all([
    chrome.storage.local.get(STORAGE_KEYS.RESUME_STATES),
    getAnimeLibraryStates(),
    getSettings(),
  ]);
  const resumeStates = stored[STORAGE_KEYS.RESUME_STATES] ?? {};
  const resumeState = resumeStates[payload.resumeKey];

  if (!resumeState) {
    throw new ShioriError(
      "UNKNOWN_RESUME_KEY",
      "Cannot sync an unknown anime.",
    );
  }

  const result = await syncResumeStateToMyAnimeList({
    resumeState,
    libraryState: libraryStates[payload.resumeKey],
    animeId: payload.animeId,
    settings,
  });

  if (result.anime) {
    libraryStates[payload.resumeKey] = normalizeAnimeLibraryState({
      ...libraryStates[payload.resumeKey],
      ...createLibraryStateFromMyAnimeListAnime(result.anime),
      updatedAt: Date.now(),
    });

    await chrome.storage.local.set({
      [STORAGE_KEYS.ANIME_LIBRARY_STATES]: libraryStates,
    });
  }

  return {
    result,
    resumeState: enrichResumeState(
      payload.resumeKey,
      resumeState,
      libraryStates,
      settings,
    ),
  };
}

async function handleGetTrackedSites() {
  return getTrackedSites();
}

async function handleEnableTrackedSite(payload) {
  const origin = normalizeTrackableOrigin(payload?.origin);

  if (!origin) {
    throw new ShioriError(
      "INVALID_TRACKED_SITE_ORIGIN",
      "Tracked site origin must be an http or https origin.",
    );
  }

  const pattern = createOriginPattern(origin);
  await assertOriginPermission(pattern);

  const trackedSites = await getTrackedSites();
  const existingSite = trackedSites.find((site) => site.origin === origin);
  const now = Date.now();
  const site = createTrackedSiteRecord(
    {
      origin,
      label: payload?.label ?? existingSite?.label,
      enabled: true,
      createdAt: existingSite?.createdAt ?? now,
      updatedAt: now,
    },
    now,
  );

  const nextSites = [
    ...trackedSites.filter((trackedSite) => trackedSite.origin !== origin),
    site,
  ];

  await setTrackedSites(nextSites);
  await registerTrackedSiteContentScript(site);

  return site;
}

async function handleDisableTrackedSite(payload) {
  const origin = normalizeTrackableOrigin(payload?.origin);

  if (!origin) {
    throw new ShioriError(
      "INVALID_TRACKED_SITE_ORIGIN",
      "Tracked site origin must be an http or https origin.",
    );
  }

  const trackedSites = await getTrackedSites();
  const existingSite = trackedSites.find((site) => site.origin === origin);

  if (!existingSite) {
    await unregisterTrackedSiteContentScript(origin);

    return {
      origin,
      enabled: false,
    };
  }

  const disabledSite = {
    ...existingSite,
    enabled: false,
    updatedAt: Date.now(),
  };

  const nextSites = [
    ...trackedSites.filter((site) => site.origin !== origin),
    disabledSite,
  ];

  await setTrackedSites(nextSites);
  await unregisterTrackedSiteContentScript(origin);

  return disabledSite;
}

async function handleSearchMyAnimeList(payload) {
  const query = normalizeOptionalString(payload?.query);

  if (!query) {
    return [];
  }

  return searchMyAnimeListAnime(query, {
    cacheOnly: payload?.cacheOnly === true,
    forceRefresh: payload?.forceRefresh === true,
  });
}

async function getTrackedSites() {
  await ensureTrackedSiteStore();

  const stored = await chrome.storage.local.get(STORAGE_KEYS.TRACKED_SITES);

  return normalizeTrackedSites(stored[STORAGE_KEYS.TRACKED_SITES]);
}

async function setTrackedSites(trackedSites) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.TRACKED_SITES]: normalizeTrackedSites(trackedSites),
  });
}

async function getPageContexts() {
  await ensurePageContextStore();

  const stored = await chrome.storage.local.get(STORAGE_KEYS.PAGE_CONTEXTS);
  const rawContexts = stored[STORAGE_KEYS.PAGE_CONTEXTS] ?? {};
  const contexts = {};
  const now = Date.now();

  if (!rawContexts || typeof rawContexts !== "object") {
    return contexts;
  }

  for (const [pageUrl, value] of Object.entries(rawContexts)) {
    if (typeof pageUrl !== "string" || !value || typeof value !== "object") {
      continue;
    }

    const updatedAt =
      typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
        ? value.updatedAt
        : 0;

    if (now - updatedAt > PAGE_CONTEXT_TTL_MS) {
      continue;
    }

    contexts[pageUrl] = value;
  }

  return contexts;
}

async function setPageContexts(contexts) {
  const entries = Object.entries(contexts)
    .filter(([, value]) => value && typeof value === "object")
    .sort(([, left], [, right]) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
    .slice(0, MAX_PAGE_CONTEXTS);

  await chrome.storage.local.set({
    [STORAGE_KEYS.PAGE_CONTEXTS]: Object.fromEntries(entries),
  });
}

async function getAnimeLibraryStates() {
  await ensureAnimeLibraryStateStore();

  const stored = await chrome.storage.local.get(
    STORAGE_KEYS.ANIME_LIBRARY_STATES,
  );
  const rawLibraryStates = stored[STORAGE_KEYS.ANIME_LIBRARY_STATES] ?? {};

  if (!rawLibraryStates || typeof rawLibraryStates !== "object") {
    return {};
  }

  const libraryStates = {};

  for (const [resumeKey, value] of Object.entries(rawLibraryStates)) {
    if (typeof resumeKey !== "string" || resumeKey.length === 0) {
      continue;
    }

    libraryStates[resumeKey] = normalizeAnimeLibraryState(value);
  }

  return libraryStates;
}

async function repairResumeStatesWithPageContexts(resumeStates, libraryStates) {
  const contexts = await getPageContexts();
  const nextResumeStates = { ...resumeStates };
  const nextLibraryStates = { ...libraryStates };
  let changed = false;

  for (const [resumeKey, resumeState] of Object.entries(resumeStates)) {
    if (isInvalidResumeState(resumeState)) {
      delete nextResumeStates[resumeKey];
      delete nextLibraryStates[resumeKey];
      changed = true;
      continue;
    }

    const context = contexts[resumeState?.episodeUrl];

    if (!context) {
      continue;
    }

    const identity = parseAnimeIdentity([
      context.titleCandidates,
      context.sourceTitle,
      context.pageTitle,
      resumeState.sourceTitle,
    ]);

    if (!identity.reliable || !identity.title) {
      continue;
    }

    const nextResumeState = {
      ...resumeState,
      site: context.site ?? resumeState.site,
      siteOrigin: context.siteOrigin ?? resumeState.siteOrigin,
      sourceTitle: identity.title,
      normalizedTitle: normalizeTitle(identity.title),
      episodeNumber:
        resumeState.episodeNumber ?? identity.episodeNumber ?? context.episodeNumber,
      pageTitle: context.pageTitle ?? resumeState.pageTitle,
      siteIconUrl: context.siteIconUrl ?? resumeState.siteIconUrl,
    };
    const nextResumeKey = createResumeKey(nextResumeState);

    if (nextResumeKey === resumeKey) {
      if (JSON.stringify(nextResumeStates[resumeKey]) !== JSON.stringify(nextResumeState)) {
        changed = true;
      }

      nextResumeStates[resumeKey] = nextResumeState;
      continue;
    }

    delete nextResumeStates[resumeKey];
    nextResumeStates[nextResumeKey] = nextResumeState;

    if (nextLibraryStates[resumeKey] && !nextLibraryStates[nextResumeKey]) {
      nextLibraryStates[nextResumeKey] = nextLibraryStates[resumeKey];
    }

    delete nextLibraryStates[resumeKey];
    changed = true;
  }

  return {
    resumeStates: nextResumeStates,
    libraryStates: nextLibraryStates,
    changed,
  };
}

async function ensureAnimeLibraryState(resumeKey) {
  if (typeof resumeKey !== "string" || resumeKey.length === 0) {
    return null;
  }

  const libraryStates = await getAnimeLibraryStates();

  if (libraryStates[resumeKey]) {
    return libraryStates[resumeKey];
  }

  const defaultState = createDefaultAnimeLibraryState();
  libraryStates[resumeKey] = defaultState;

  await chrome.storage.local.set({
    [STORAGE_KEYS.ANIME_LIBRARY_STATES]: libraryStates,
  });

  return defaultState;
}

async function maybeAutoSyncResumeState({
  resumeKey,
  resumeState,
  libraryState,
  settings,
}) {
  if (
    settings?.sync?.myAnimeList !== true ||
    settings?.sync?.autoSyncMyAnimeList !== true
  ) {
    return {
      skipped: true,
      reason: "AUTO_SYNC_DISABLED",
    };
  }

  if (!hasReachedCompletionThreshold(resumeState, settings)) {
    return {
      skipped: true,
      reason: "COMPLETION_THRESHOLD_NOT_REACHED",
    };
  }

  try {
    const connection = await getMyAnimeListConnection();

    if (!connection.connected) {
      return {
        skipped: true,
        reason: "MAL_NOT_CONNECTED",
      };
    }

    const libraryStates = await getAnimeLibraryStates();
    let effectiveLibraryState = normalizeAnimeLibraryState(
      libraryStates[resumeKey] ?? libraryState,
    );

    if (!effectiveLibraryState.userConfirmedMatch || !effectiveLibraryState.mediaId) {
      const candidates = await searchMyAnimeListAnime(resumeState.sourceTitle);
      const autoMatchedLibraryState = createAutoMatchedLibraryState(
        { resumeKey, ...resumeState, libraryState: effectiveLibraryState },
        candidates,
        libraryStates,
      );

      if (!autoMatchedLibraryState) {
        return {
          skipped: true,
          reason: "AMBIGUOUS_MAL_MATCH",
        };
      }

      libraryStates[resumeKey] = autoMatchedLibraryState;
      effectiveLibraryState = autoMatchedLibraryState;

      await chrome.storage.local.set({
        [STORAGE_KEYS.ANIME_LIBRARY_STATES]: libraryStates,
      });
    }

    if (isAutoSyncAlreadySatisfied(effectiveLibraryState, resumeState)) {
      return {
        skipped: true,
        reason: "MAL_ALREADY_CURRENT",
      };
    }

    const result = await syncResumeStateToMyAnimeList({
      resumeState,
      libraryState: effectiveLibraryState,
      settings,
    });

    if (result.anime) {
      libraryStates[resumeKey] = normalizeAnimeLibraryState({
        ...effectiveLibraryState,
        ...createLibraryStateFromMyAnimeListAnime(result.anime),
        updatedAt: Date.now(),
      });

      await chrome.storage.local.set({
        [STORAGE_KEYS.ANIME_LIBRARY_STATES]: libraryStates,
      });
    }

    return result.skipped
      ? {
          skipped: true,
          reason: result.reason ?? "NO_SAFE_MAL_UPDATE",
        }
      : {
          skipped: false,
          animeId: result.anime?.id ?? effectiveLibraryState.mediaId,
          update: result.update,
        };
  } catch (error) {
    return {
      skipped: true,
      reason: "AUTO_SYNC_FAILED",
      message: error?.message ?? "MAL auto-sync failed.",
    };
  }
}

function hasReachedCompletionThreshold(resumeState, settings) {
  const progressRatio =
    typeof resumeState?.progressRatio === "number" &&
    Number.isFinite(resumeState.progressRatio)
      ? resumeState.progressRatio
      : 0;
  const threshold =
    typeof settings?.watchCompletionThresholdRatio === "number" &&
    Number.isFinite(settings.watchCompletionThresholdRatio)
      ? Math.min(Math.max(settings.watchCompletionThresholdRatio, 0.5), 0.99)
      : 0.9;

  return progressRatio >= threshold;
}

function isAutoSyncAlreadySatisfied(libraryState, resumeState) {
  const status = libraryState.malStatus ?? libraryState.listStatus;

  if (status === "completed" || status === "dropped") {
    return true;
  }

  const episodeNumber = resumeState?.episodeNumber;

  if (!Number.isInteger(episodeNumber) || episodeNumber <= 0) {
    return status === "watching";
  }

  if (
    Number.isInteger(libraryState.numEpisodes) &&
    libraryState.numEpisodes > 0 &&
    episodeNumber > libraryState.numEpisodes
  ) {
    return status === "watching";
  }

  return (
    Number.isInteger(libraryState.numWatchedEpisodes) &&
    libraryState.numWatchedEpisodes >= episodeNumber
  );
}

function enrichResumeState(resumeKey, resumeState, libraryStates, settings) {
  const libraryState = normalizeAnimeLibraryState(libraryStates[resumeKey]);

  return {
    resumeKey,
    ...resumeState,
    libraryState,
    syncPlan: createSyncPlan(resumeState, libraryState, settings),
  };
}

async function enrichResumeStatesWithMyAnimeList(
  resumeStates,
  libraryStates,
  options = {},
) {
  const connection = await getMyAnimeListConnection();
  const nextLibraryStates = { ...libraryStates };
  let libraryChanged = false;
  const limit = normalizePositiveInteger(options.limit) ?? resumeStates.length;

  if (!connection.connected) {
    return resumeStates.map((state) => ({
      ...state,
      myAnimeList: {
        connected: false,
        candidates: [],
      },
    }));
  }

  if (options.cacheOnly === true) {
    return resumeStates.map((state) => {
      const libraryState = normalizeAnimeLibraryState(
        nextLibraryStates[state.resumeKey] ?? state.libraryState,
      );

      return {
        ...state,
        libraryState,
        posterUrl: libraryState.coverUrl ?? state.posterUrl,
        syncPlan: createSyncPlan(state, libraryState, null),
        myAnimeList: {
          connected: true,
          candidates: [],
        },
      };
    });
  }

  const enrichedStates = [];

  for (const state of resumeStates.slice(0, limit)) {
    try {
      const candidates = await searchMyAnimeListAnime(state.sourceTitle, {
        cacheOnly: options.cacheOnly === true,
        forceRefresh: options.forceRefresh === true,
      });
      const autoMatchedLibraryState = createAutoMatchedLibraryState(
        state,
        candidates,
        nextLibraryStates,
      );

      if (autoMatchedLibraryState) {
        nextLibraryStates[state.resumeKey] = autoMatchedLibraryState;
        libraryChanged = true;
      }

      enrichedStates.push({
        ...state,
        libraryState: autoMatchedLibraryState ?? state.libraryState,
        myAnimeList: {
          connected: true,
          candidates,
        },
      });
    } catch (error) {
      enrichedStates.push({
        ...state,
        myAnimeList: {
          connected: true,
          candidates: [],
          error: error?.message ?? "MAL lookup failed.",
        },
      });
    }
  }

  if (enrichedStates.length < resumeStates.length) {
    enrichedStates.push(...resumeStates.slice(enrichedStates.length));
  }

  if (libraryChanged) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.ANIME_LIBRARY_STATES]: nextLibraryStates,
    });
  }

  return enrichedStates.map((state) => {
    const libraryState = normalizeAnimeLibraryState(
      nextLibraryStates[state.resumeKey] ?? state.libraryState,
    );
    const firstCandidate = state.myAnimeList?.candidates?.[0] ?? null;
    const candidateCover =
      firstCandidate?.mainPicture?.large ??
      firstCandidate?.mainPicture?.medium ??
      null;

    return {
      ...state,
      libraryState,
      posterUrl: libraryState.coverUrl ?? candidateCover ?? state.posterUrl,
      syncPlan: createSyncPlan(state, libraryState, null),
    };
  });
}

function createLibraryStateFromMyAnimeListAnime(anime) {
  const listStatus = convertMyAnimeListStatusToLibraryStatus(
    anime.myListStatus?.status,
  );

  return {
    mediaId: anime.id,
    matchedTitle: anime.title,
    coverUrl: anime.mainPicture?.large ?? anime.mainPicture?.medium ?? null,
    numEpisodes: anime.numEpisodes,
    numWatchedEpisodes: anime.myListStatus?.numEpisodesWatched ?? null,
    malStatus: anime.myListStatus?.status ?? null,
    listStatus,
    score: anime.myListStatus?.score ?? null,
    userConfirmedMatch: true,
  };
}

function createAutoMatchedLibraryState(state, candidates, libraryStates) {
  const currentState = normalizeAnimeLibraryState(
    libraryStates[state.resumeKey] ?? state.libraryState,
  );

  if (currentState.userConfirmedMatch && currentState.mediaId) {
    return null;
  }

  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }

  const [firstCandidate, secondCandidate] = candidates;
  const firstConfidence = normalizeMatchConfidence(
    firstCandidate?.matchConfidence,
  );
  const secondConfidence = normalizeMatchConfidence(
    secondCandidate?.matchConfidence,
  );

  if (firstConfidence < 92 || firstConfidence - secondConfidence < 12) {
    return null;
  }

  return normalizeAnimeLibraryState({
    ...currentState,
    ...createLibraryStateFromMyAnimeListAnime(firstCandidate),
    updatedAt: Date.now(),
  });
}

function normalizeMatchConfidence(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function convertMyAnimeListStatusToLibraryStatus(status) {
  switch (status) {
    case "watching":
      return "watching";

    case "completed":
      return "completed";

    case "on_hold":
      return "on_hold";

    case "plan_to_watch":
      return "plan_to_watch";

    case "dropped":
      return "dropped";

    default:
      return "not_in_list";
  }
}

async function syncTrackedSiteContentScripts() {
  const trackedSites = await getTrackedSites();
  const enabledSites = trackedSites.filter((site) => site.enabled);
  const desiredScriptIds = new Set(
    enabledSites
      .map((site) => createTrackedSiteScriptId(site.origin))
      .filter(Boolean),
  );

  const registeredScripts = await chrome.scripting.getRegisteredContentScripts();
  const managedScriptIds = registeredScripts
    .map((script) => script.id)
    .filter((id) => id.startsWith(TRACKER_SCRIPT_ID_PREFIX));

  const staleScriptIds = managedScriptIds.filter(
    (scriptId) => !desiredScriptIds.has(scriptId),
  );

  await safeUnregisterContentScripts(staleScriptIds);

  for (const site of enabledSites) {
    await registerTrackedSiteContentScript(site);
  }
}

async function registerTrackedSiteContentScript(site) {
  if (!site?.enabled || !site.pattern) {
    return;
  }

  const scriptId = createTrackedSiteScriptId(site.origin);

  if (!scriptId) {
    return;
  }

  const hasPermission = await chrome.permissions.contains({
    origins: [site.pattern],
  });

  if (!hasPermission) {
    return;
  }

  await safeUnregisterContentScripts([scriptId]);

  await chrome.scripting.registerContentScripts([
    {
      id: scriptId,
      js: [TRACKER_SCRIPT_FILE],
      matches: [site.pattern],
      allFrames: true,
      matchOriginAsFallback: true,
      runAt: "document_idle",
      persistAcrossSessions: true,
    },
  ]);
}

async function unregisterTrackedSiteContentScript(origin) {
  const scriptId = createTrackedSiteScriptId(origin);

  if (!scriptId) {
    return;
  }

  await safeUnregisterContentScripts([scriptId]);
}

async function safeUnregisterContentScripts(scriptIds) {
  const safeScriptIds = Array.isArray(scriptIds)
    ? scriptIds.filter((scriptId) => typeof scriptId === "string")
    : [];

  if (safeScriptIds.length === 0) {
    return;
  }

  const registeredScripts = await chrome.scripting.getRegisteredContentScripts({
    ids: safeScriptIds,
  });
  const registeredScriptIds = registeredScripts.map((script) => script.id);

  if (registeredScriptIds.length > 0) {
    await chrome.scripting.unregisterContentScripts({
      ids: registeredScriptIds,
    });
  }
}

async function assertOriginPermission(pattern) {
  const hasPermission = await chrome.permissions.contains({
    origins: [pattern],
  });

  if (!hasPermission) {
    throw new ShioriError(
      "MISSING_HOST_PERMISSION",
      "Shiori needs site access before tracking can be enabled.",
      { pattern },
    );
  }
}

function normalizeResumeState(payload, sender) {
  if (!payload || typeof payload !== "object") {
    throw new ShioriError(
      "INVALID_RESUME_PAYLOAD",
      "Resume payload must be an object.",
    );
  }

  const site = requireNonEmptyString(payload.site, "site");
  const sourceTitle = requireNonEmptyString(payload.sourceTitle, "sourceTitle");
  const episodeUrl = requireNonEmptyString(payload.episodeUrl, "episodeUrl");
  const siteOrigin =
    normalizeTrackableOrigin(payload.siteOrigin) ??
    normalizeTrackableOrigin(sender?.url) ??
    normalizeTrackableOrigin(sender?.tab?.url);

  const episodeNumber = requireOptionalPositiveInteger(
    payload.episodeNumber,
    "episodeNumber",
  );

  const positionSeconds = requireNonNegativeNumber(
    payload.positionSeconds,
    "positionSeconds",
  );

  const durationSeconds = requirePositiveNumber(
    payload.durationSeconds,
    "durationSeconds",
  );

  if (positionSeconds > durationSeconds + 5) {
    throw new ShioriError(
      "INVALID_WATCH_POSITION",
      "positionSeconds cannot be greater than durationSeconds.",
      { positionSeconds, durationSeconds },
    );
  }

  return {
    site,
    siteOrigin,
    sourceTitle,
    normalizedTitle: normalizeTitle(sourceTitle),
    episodeNumber,
    positionSeconds,
    durationSeconds,
    progressRatio: Number((positionSeconds / durationSeconds).toFixed(4)),
    episodeUrl,
    frameUrl: normalizeOptionalUrl(payload.frameUrl),
    pageTitle: normalizeOptionalString(payload.pageTitle),
    posterUrl: normalizeOptionalUrl(payload.posterUrl),
    siteIconUrl:
      normalizeOptionalUrl(payload.siteIconUrl) ??
      normalizeOptionalUrl(sender?.tab?.favIconUrl),
    tabUrl: sender?.tab?.url ?? null,
    updatedAt: Date.now(),
  };
}

function isInvalidResumeState(resumeState) {
  if (!resumeState || typeof resumeState !== "object") {
    return true;
  }

  return [
    resumeState.sourceTitle,
    resumeState.pageTitle,
    resumeState.normalizedTitle,
  ].some((value) => typeof value === "string" && isInvalidAnimeTitle(value));
}

async function findPageContextForPayload(payload, sender) {
  const candidates = [
    payload?.episodeUrl,
    payload?.pageUrl,
    payload?.referrerUrl,
    sender?.tab?.url,
    sender?.url,
  ]
    .map(normalizeOptionalUrl)
    .filter(Boolean);

  if (candidates.length === 0) {
    return null;
  }

  const contexts = await getPageContexts();

  for (const candidate of candidates) {
    if (contexts[candidate]) {
      return contexts[candidate];
    }
  }

  return null;
}

function applyPageContextToResumePayload(payload, pageContext) {
  if (!pageContext) {
    return payload;
  }

  const identity = parseAnimeIdentity([
    pageContext.titleCandidates,
    pageContext.sourceTitle,
    pageContext.pageTitle,
    payload?.sourceTitle,
  ]);

  if (!identity.reliable || !identity.title) {
    return payload;
  }

  return {
    ...payload,
    site: pageContext.site ?? payload?.site,
    siteOrigin: pageContext.siteOrigin ?? payload?.siteOrigin,
    sourceTitle: identity.title,
    episodeNumber:
      payload?.episodeNumber ?? identity.episodeNumber ?? pageContext.episodeNumber,
    episodeUrl: pageContext.pageUrl ?? payload?.episodeUrl,
    pageTitle: pageContext.pageTitle ?? payload?.pageTitle,
    siteIconUrl: pageContext.siteIconUrl ?? payload?.siteIconUrl,
  };
}

function normalizePageContext(payload, sender) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const pageUrl =
    normalizeOptionalUrl(payload.pageUrl) ??
    normalizeOptionalUrl(sender?.url) ??
    normalizeOptionalUrl(sender?.tab?.url);

  if (!pageUrl) {
    return null;
  }

  const titleCandidates = normalizeStringArray(payload.titleCandidates);
  const identity = parseAnimeIdentity([
    titleCandidates,
    payload.sourceTitle,
    payload.pageTitle,
  ]);

  if (!identity.reliable || !identity.title) {
    return null;
  }

  const siteOrigin =
    normalizeTrackableOrigin(payload.siteOrigin) ?? normalizeTrackableOrigin(pageUrl);

  return {
    pageUrl,
    site: normalizeOptionalString(payload.site) ?? getSiteName(siteOrigin),
    siteOrigin,
    sourceTitle: identity.title,
    episodeNumber: identity.episodeNumber,
    pageTitle: normalizeOptionalString(payload.pageTitle),
    siteIconUrl: normalizeOptionalUrl(payload.siteIconUrl),
    titleCandidates,
    updatedAt: Date.now(),
  };
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim().slice(0, 240))
    .slice(0, 20);
}

function createResumeKey(resumeState) {
  const siteKey = resumeState.siteOrigin ?? resumeState.site;

  return `${siteKey}:${resumeState.normalizedTitle}`;
}

function getSiteName(origin) {
  try {
    const host = new URL(origin).hostname.replace(/^www\./i, "");

    if (
      host.endsWith("animepahe.com") ||
      host.endsWith("animepahe.ch") ||
      host.endsWith("animepahe.org") ||
      host.endsWith("animepahe.pw")
    ) {
      return "Animepahe";
    }

    return host;
  } catch {
    return "Unknown site";
  }
}

function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, "-");
}

function normalizePositiveInteger(value) {
  if (Number.isInteger(value) && value > 0) {
    return value;
  }

  const parsed = Number.parseInt(String(value), 10);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeOptionalUrl(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  try {
    return new URL(value.trim()).href;
  } catch {
    return null;
  }
}

function normalizeOptionalString(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  return value.trim().slice(0, 240);
}

function assertValidMessage(message) {
  if (!message || typeof message !== "object") {
    throw new ShioriError("INVALID_MESSAGE", "Message must be an object.");
  }

  if (typeof message.type !== "string" || message.type.length === 0) {
    throw new ShioriError(
      "INVALID_MESSAGE_TYPE",
      "Message type must be a non-empty string.",
    );
  }
}

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ShioriError(
      "INVALID_FIELD",
      `${fieldName} must be a non-empty string.`,
    );
  }

  return value.trim();
}

function requireOptionalPositiveInteger(value, fieldName) {
  if (value === null || value === undefined) {
    return null;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new ShioriError(
      "INVALID_FIELD",
      `${fieldName} must be a positive integer when provided.`,
    );
  }

  return value;
}

function requireNonNegativeNumber(value, fieldName) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ShioriError(
      "INVALID_FIELD",
      `${fieldName} must be a non-negative number.`,
    );
  }

  return value;
}

function requirePositiveNumber(value, fieldName) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ShioriError(
      "INVALID_FIELD",
      `${fieldName} must be a positive number.`,
    );
  }

  return value;
}

function serializeError(error) {
  if (error instanceof ShioriError) {
    return {
      name: error.name,
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  return {
    name: "UnexpectedError",
    code: "UNEXPECTED_ERROR",
    message: error?.message ?? "An unexpected error occurred.",
    details: null,
  };
}
