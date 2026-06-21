const LIBRARY_STATUSES = Object.freeze({
  UNKNOWN: "unknown",
  NOT_IN_LIST: "not_in_list",
  WATCHING: "watching",
  COMPLETED: "completed",
  ON_HOLD: "on_hold",
  DROPPED: "dropped",
  PLAN_TO_WATCH: "plan_to_watch",
});

export const LIBRARY_STATUS_OPTIONS = Object.freeze([
  {
    value: LIBRARY_STATUSES.UNKNOWN,
    label: "Unknown",
  },
  {
    value: LIBRARY_STATUSES.NOT_IN_LIST,
    label: "Not in list",
  },
  {
    value: LIBRARY_STATUSES.WATCHING,
    label: "Watching",
  },
  {
    value: LIBRARY_STATUSES.PLAN_TO_WATCH,
    label: "Plan to watch",
  },
  {
    value: LIBRARY_STATUSES.ON_HOLD,
    label: "On hold",
  },
  {
    value: LIBRARY_STATUSES.COMPLETED,
    label: "Completed",
  },
]);

const MAL_STATUS_BY_LIBRARY_STATUS = Object.freeze({
  [LIBRARY_STATUSES.NOT_IN_LIST]: "watching",
  [LIBRARY_STATUSES.WATCHING]: "watching",
  [LIBRARY_STATUSES.PLAN_TO_WATCH]: "watching",
  [LIBRARY_STATUSES.ON_HOLD]: "watching",
  [LIBRARY_STATUSES.DROPPED]: "watching",
  [LIBRARY_STATUSES.COMPLETED]: "completed",
});

export function createDefaultAnimeLibraryState(now = Date.now()) {
  return {
    listStatus: LIBRARY_STATUSES.UNKNOWN,
    score: null,
    mediaId: null,
    matchedTitle: null,
    userConfirmedMatch: false,
    updatedAt: now,
  };
}

export function normalizeAnimeLibraryState(value, now = Date.now()) {
  if (!value || typeof value !== "object") {
    return createDefaultAnimeLibraryState(now);
  }

  const listStatus = isKnownLibraryStatus(value.listStatus)
    ? value.listStatus
    : LIBRARY_STATUSES.UNKNOWN;

  return {
    listStatus,
    score: normalizeScore(value.score),
    mediaId: normalizeMediaId(value.mediaId),
    matchedTitle: normalizeOptionalString(value.matchedTitle),
    coverUrl: normalizeOptionalString(value.coverUrl),
    numEpisodes: normalizePositiveInteger(value.numEpisodes),
    numWatchedEpisodes: normalizeNonNegativeInteger(value.numWatchedEpisodes),
    malStatus: normalizeOptionalString(value.malStatus),
    userConfirmedMatch: value.userConfirmedMatch === true,
    updatedAt: normalizeTimestamp(value.updatedAt, now),
  };
}

export function createSyncPlan(resumeState, libraryState, settings) {
  const normalizedLibraryState = normalizeAnimeLibraryState(libraryState);
  const threshold = normalizeCompletionThreshold(settings);
  const episodeNumber = normalizeEpisodeNumber(resumeState?.episodeNumber);
  const progressRatio = normalizeRatio(resumeState?.progressRatio);
  const completedEpisode = progressRatio >= threshold;
  const episodeOutOfRange =
    Number.isInteger(normalizedLibraryState.numEpisodes) &&
    Number.isInteger(episodeNumber) &&
    episodeNumber > normalizedLibraryState.numEpisodes;
  const watchedEpisode =
    completedEpisode && !episodeOutOfRange ? episodeNumber : null;
  const basePayload = createProviderPayload(
    normalizedLibraryState,
    watchedEpisode,
    progressRatio,
    completedEpisode,
  );
  const progressSummary = episodeOutOfRange
    ? "The site episode number is outside this MAL season, so Shiori will only update status and score."
    : "Keep watching status and update progress.";

  switch (normalizedLibraryState.listStatus) {
    case LIBRARY_STATUSES.UNKNOWN:
      return createPlan({
        code: "review_match",
        tone: "review",
        label: "Review match",
        summary: "Confirm the account match before syncing.",
        payload: basePayload,
      });

    case LIBRARY_STATUSES.NOT_IN_LIST:
      return createPlan({
        code: "confirm_add",
        tone: "review",
        label: "Ready to add",
        summary: episodeOutOfRange
          ? progressSummary
          : "Add as watching after confirmation.",
        payload: basePayload,
      });

    case LIBRARY_STATUSES.PLAN_TO_WATCH:
      return createPlan({
        code: "move_to_watching",
        tone: "ready",
        label: "Move to watching",
        summary: episodeOutOfRange
          ? progressSummary
          : "Move from plan to watch and update progress.",
        payload: basePayload,
      });

    case LIBRARY_STATUSES.WATCHING:
      return createPlan({
        code: "update_progress",
        tone: "ready",
        label: "Update progress",
        summary: progressSummary,
        payload: basePayload,
      });

    case LIBRARY_STATUSES.ON_HOLD:
      return createPlan({
        code: "confirm_resume",
        tone: "review",
        label: "Resume review",
        summary: episodeOutOfRange
          ? progressSummary
          : "Ask before moving this from on hold.",
        payload: basePayload,
      });

    case LIBRARY_STATUSES.DROPPED:
      return createPlan({
        code: "blocked_dropped",
        tone: "blocked",
        label: "Manual review",
        summary: "Never auto-change a dropped entry.",
        payload: basePayload,
      });

    case LIBRARY_STATUSES.COMPLETED:
      return createPlan({
        code: "completed_protected",
        tone: "ready",
        label: "Completed",
        summary: "Already completed. Shiori will not reopen this entry.",
        payload: {
          ...basePayload,
          myAnimeList: {
            ...basePayload.myAnimeList,
            status: "completed",
            num_watched_episodes: null,
          },
        },
      });


    default:
      return createPlan({
        code: "review_match",
        tone: "review",
        label: "Review match",
        summary: "Confirm the account match before syncing.",
        payload: basePayload,
      });
  }
}

function isKnownLibraryStatus(value) {
  return Object.values(LIBRARY_STATUSES).includes(value);
}

function createProviderPayload(
  libraryState,
  watchedEpisode,
  progressRatio,
  completedEpisode,
) {
  const malStatus =
    MAL_STATUS_BY_LIBRARY_STATUS[libraryState.listStatus] ?? "watching";

  return {
    myAnimeList: {
      status: malStatus,
      num_watched_episodes: watchedEpisode,
      score: libraryState.score,
    },
    local: {
      progressRatio,
      completedEpisode,
    },
  };
}

function createPlan({ code, tone, label, summary, payload }) {
  return {
    code,
    tone,
    label,
    summary,
    payload,
  };
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

function normalizeMediaId(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (Number.isInteger(value) && value > 0) {
    return value;
  }

  const parsed = Number.parseInt(String(value), 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
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

function normalizeOptionalString(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  return value.trim().slice(0, 160);
}

function normalizeTimestamp(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  return fallback;
}

function normalizeCompletionThreshold(settings) {
  const value = settings?.watchCompletionThresholdRatio;

  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0.9;
  }

  return Math.min(Math.max(value, 0.5), 0.99);
}

function normalizeEpisodeNumber(value) {
  if (Number.isInteger(value) && value > 0) {
    return value;
  }

  return null;
}

function normalizeRatio(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }

  return Math.min(Math.max(value, 0), 1);
}
