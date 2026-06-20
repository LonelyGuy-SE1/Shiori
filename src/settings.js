const SETTINGS_STORAGE_KEY = "shiori.settings";

const DEFAULT_SETTINGS = Object.freeze({
  watchCompletionThresholdRatio: 0.9,
  resumeSaveIntervalSeconds: 10,
  minimumVideoDurationSeconds: 300,

  sync: {
    myAnimeList: true,
    autoSyncMyAnimeList: true,
    myAnimeListClientId: "",
    myAnimeListClientSecret: "",
  },

  resume: {
    enabled: true,
    saveWhilePaused: true,
    saveWhileWatching: true,
  },
});

const SETTING_LIMITS = Object.freeze({
  watchCompletionThresholdRatio: {
    min: 0.5,
    max: 0.99,
  },

  resumeSaveIntervalSeconds: {
    min: 3,
    max: 120,
  },

  minimumVideoDurationSeconds: {
    min: 30,
    max: 1800,
  },
});

export async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  const settings = stored[SETTINGS_STORAGE_KEY];

  if (!settings) {
    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]: DEFAULT_SETTINGS,
    });

    return structuredClone(DEFAULT_SETTINGS);
  }

  const mergedSettings = mergeSettings(DEFAULT_SETTINGS, settings);
  const validatedSettings = validateSettings(mergedSettings);

  if (JSON.stringify(validatedSettings) !== JSON.stringify(settings)) {
    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]: validatedSettings,
    });
  }

  return validatedSettings;
}

export async function updateSettings(partialSettings) {
  const currentSettings = await getSettings();
  const nextSettings = mergeSettings(currentSettings, partialSettings);
  const validatedSettings = validateSettings(nextSettings);

  await chrome.storage.local.set({
    [SETTINGS_STORAGE_KEY]: validatedSettings,
  });

  return validatedSettings;
}

export async function resetSettings() {
  const settings = structuredClone(DEFAULT_SETTINGS);

  await chrome.storage.local.set({
    [SETTINGS_STORAGE_KEY]: settings,
  });

  return settings;
}

export function validateSettings(settings) {
  const normalized = structuredClone(settings);

  normalized.watchCompletionThresholdRatio = clampNumber(
    normalized.watchCompletionThresholdRatio,
    SETTING_LIMITS.watchCompletionThresholdRatio.min,
    SETTING_LIMITS.watchCompletionThresholdRatio.max,
    DEFAULT_SETTINGS.watchCompletionThresholdRatio,
  );

  normalized.resumeSaveIntervalSeconds = clampInteger(
    normalized.resumeSaveIntervalSeconds,
    SETTING_LIMITS.resumeSaveIntervalSeconds.min,
    SETTING_LIMITS.resumeSaveIntervalSeconds.max,
    DEFAULT_SETTINGS.resumeSaveIntervalSeconds,
  );

  normalized.minimumVideoDurationSeconds = clampInteger(
    normalized.minimumVideoDurationSeconds,
    SETTING_LIMITS.minimumVideoDurationSeconds.min,
    SETTING_LIMITS.minimumVideoDurationSeconds.max,
    DEFAULT_SETTINGS.minimumVideoDurationSeconds,
  );

  normalized.sync = {
    myAnimeList: toBoolean(
      normalized.sync?.myAnimeList,
      DEFAULT_SETTINGS.sync.myAnimeList,
    ),

    autoSyncMyAnimeList: true,

    myAnimeListClientId: toSafeString(
      normalized.sync?.myAnimeListClientId,
      DEFAULT_SETTINGS.sync.myAnimeListClientId,
    ),

    myAnimeListClientSecret: toSafeString(
      normalized.sync?.myAnimeListClientSecret,
      DEFAULT_SETTINGS.sync.myAnimeListClientSecret,
    ),
  };

  normalized.resume = {
    enabled: toBoolean(
      normalized.resume?.enabled,
      DEFAULT_SETTINGS.resume.enabled,
    ),

    saveWhilePaused: toBoolean(
      normalized.resume?.saveWhilePaused,
      DEFAULT_SETTINGS.resume.saveWhilePaused,
    ),

    saveWhileWatching: toBoolean(
      normalized.resume?.saveWhileWatching,
      DEFAULT_SETTINGS.resume.saveWhileWatching,
    ),
  };

  return normalized;
}

function mergeSettings(base, override) {
  if (!isPlainObject(override)) {
    return structuredClone(base);
  }

  const merged = structuredClone(base);

  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(merged[key])) {
      merged[key] = mergeSettings(merged[key], value);
    } else {
      merged[key] = value;
    }
  }

  return merged;
}

function clampNumber(value, min, max, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(Math.max(value, min), max);
}

function clampInteger(value, min, max, fallback) {
  if (!Number.isInteger(value)) {
    return fallback;
  }

  return Math.min(Math.max(value, min), max);
}

function toBoolean(value, fallback) {
  if (typeof value !== "boolean") {
    return fallback;
  }

  return value;
}

function toSafeString(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }

  return value.trim();
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
