export const TRACKED_SITES_STORAGE_KEY = "shiori.trackedSites";

export const TRACKER_SCRIPT_FILE = "src/content/videoTracker.js";
export const TRACKER_SCRIPT_ID_PREFIX = "shiori-video-tracker";

export const DEFAULT_TRACKED_SITE_INPUTS = Object.freeze([
  {
    origin: "https://animepahe.com",
    label: "Animepahe",
  },
  {
    origin: "https://animepahe.ch",
    label: "Animepahe",
  },
  {
    origin: "https://animepahe.org",
    label: "Animepahe",
  },
  {
    origin: "https://animepahe.pw",
    label: "Animepahe",
  },
]);

export function normalizeTrackableOrigin(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  try {
    const url = new URL(value.trim());

    if (!["http:", "https:"].includes(url.protocol)) {
      return null;
    }

    return url.origin;
  } catch {
    return null;
  }
}

export function createOriginPattern(origin) {
  const normalizedOrigin = normalizeTrackableOrigin(origin);

  if (!normalizedOrigin) {
    return null;
  }

  const url = new URL(normalizedOrigin);

  return `${url.protocol}//${url.host}/*`;
}

export function createTrackedSiteScriptId(origin) {
  const normalizedOrigin = normalizeTrackableOrigin(origin);

  if (!normalizedOrigin) {
    return null;
  }

  const url = new URL(normalizedOrigin);
  const safeProtocol = url.protocol.replace(":", "");
  const safeHost = url.host.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  return `${TRACKER_SCRIPT_ID_PREFIX}-${safeProtocol}-${safeHost}`;
}

export function createTrackedSiteRecord(input, now = Date.now()) {
  const origin = normalizeTrackableOrigin(input?.origin);
  const pattern = createOriginPattern(origin);

  if (!origin || !pattern) {
    return null;
  }

  return {
    origin,
    pattern,
    label: normalizeSiteLabel(input?.label, origin),
    enabled: input?.enabled !== false,
    createdAt: toTimestamp(input?.createdAt, now),
    updatedAt: toTimestamp(input?.updatedAt, now),
  };
}

export function normalizeTrackedSites(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalizedSites = [];
  const seenOrigins = new Set();

  for (const item of value) {
    const site = createTrackedSiteRecord(item);

    if (!site || seenOrigins.has(site.origin)) {
      continue;
    }

    seenOrigins.add(site.origin);
    normalizedSites.push(site);
  }

  return normalizedSites.sort((a, b) => a.label.localeCompare(b.label));
}

export function getDisplayHost(origin) {
  const normalizedOrigin = normalizeTrackableOrigin(origin);

  if (!normalizedOrigin) {
    return "Unsupported site";
  }

  return new URL(normalizedOrigin).host.replace(/^www\./i, "");
}

function normalizeSiteLabel(value, origin) {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim().slice(0, 80);
  }

  return getDisplayHost(origin);
}

function toTimestamp(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  return fallback;
}
