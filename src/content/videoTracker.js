(() => {
  const SHIORI_NAMESPACE = "__shioriVideoTracker";

  if (globalThis[SHIORI_NAMESPACE]?.started) {
    return;
  }

  const MESSAGE_TYPES = Object.freeze({
    GET_SETTINGS: "GET_SETTINGS",
    SAVE_RESUME_STATE: "SAVE_RESUME_STATE",
    REGISTER_PAGE_CONTEXT: "REGISTER_PAGE_CONTEXT",
    GET_PAGE_CONTEXT: "GET_PAGE_CONTEXT",
  });

  const DEFAULT_SETTINGS = Object.freeze({
    resumeSaveIntervalSeconds: 10,
    minimumVideoDurationSeconds: 300,
    resume: {
      saveWhilePaused: true,
      saveWhileWatching: true,
    },
  });

  const VIDEO_SELECTOR = "video";
  const IFRAME_SELECTOR = "iframe";
  const MINIMUM_POSITION_SECONDS = 2;
  const IMMEDIATE_SAVE_REASONS = new Set(["pause", "ended", "pagehide"]);

  const state = {
    started: true,
    settings: DEFAULT_SETTINGS,
    settingsLoadedAt: 0,
    attachedVideos: new WeakSet(),
    attachedVideoCount: 0,
    activeVideo: null,
    lastSaveByVideo: new WeakMap(),
    inFlightByVideo: new WeakMap(),
    observer: null,
    diagnostics: createInitialDiagnostics(),
    getDiagnostics: createDiagnosticsSnapshot,
  };

  globalThis[SHIORI_NAMESPACE] = state;

  initialise();

  async function initialise() {
    state.diagnostics.status = "starting";
    updatePageDiagnostics();
    await refreshSettings();
    await registerPageContext();
    attachExistingVideos();
    watchForVideos();
    updatePageDiagnostics();

    state.diagnostics.status = "ready";
    document.addEventListener("visibilitychange", handleVisibilityChange);
    globalThis.addEventListener("pagehide", handlePageHide);
  }

  async function refreshSettings() {
    try {
      const settings = await sendMessage(MESSAGE_TYPES.GET_SETTINGS);
      state.settings = normalizeSettings(settings);
      state.settingsLoadedAt = Date.now();
      state.diagnostics.settingsLoaded = true;
    } catch (error) {
      state.settings = DEFAULT_SETTINGS;
      state.diagnostics.settingsLoaded = false;
      setLastError(error);
    }
  }

  async function registerPageContext() {
    if (!isTopFrame()) {
      return;
    }

    const payload = createPageContextPayload();

    if (!payload) {
      return;
    }

    try {
      await sendMessage(MESSAGE_TYPES.REGISTER_PAGE_CONTEXT, payload);
    } catch (error) {
      setLastError(error);
    }
  }

  async function getStoredPageContext(pageUrl) {
    if (!isUsefulText(pageUrl)) {
      return null;
    }

    try {
      return await sendMessage(MESSAGE_TYPES.GET_PAGE_CONTEXT, { pageUrl });
    } catch {
      return null;
    }
  }

  function attachExistingVideos() {
    document.querySelectorAll(VIDEO_SELECTOR).forEach(attachVideo);
  }

  function watchForVideos() {
    if (!document.documentElement) {
      state.diagnostics.status = "waiting_for_document";
      return;
    }

    state.observer = new MutationObserver((mutations) => {
      let shouldUpdateDiagnostics = false;

      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof Element)) {
            continue;
          }

          shouldUpdateDiagnostics = true;

          if (node.matches(VIDEO_SELECTOR)) {
            attachVideo(node);
          }

          node.querySelectorAll?.(VIDEO_SELECTOR).forEach(attachVideo);
        }
      }

      if (shouldUpdateDiagnostics) {
        updatePageDiagnostics();
      }
    });

    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function attachVideo(video) {
    if (!(video instanceof HTMLVideoElement) || state.attachedVideos.has(video)) {
      return;
    }

    state.attachedVideos.add(video);
    state.attachedVideoCount += 1;
    state.diagnostics.lastAttachedAt = Date.now();
    updatePageDiagnostics();

    video.addEventListener("loadedmetadata", () =>
      saveVideoProgress(video, "metadata"),
    );
    video.addEventListener("play", () => {
      state.activeVideo = video;
      saveVideoProgress(video, "play");
    });
    video.addEventListener("timeupdate", () => saveVideoProgress(video));
    video.addEventListener("pause", () => saveVideoProgress(video, "pause"));
    video.addEventListener("ended", () => saveVideoProgress(video, "ended"));
  }

  function handleVisibilityChange() {
    if (document.visibilityState === "hidden" && state.activeVideo) {
      saveVideoProgress(state.activeVideo, "pagehide");
    }
  }

  function handlePageHide() {
    if (state.activeVideo) {
      saveVideoProgress(state.activeVideo, "pagehide");
    }
  }

  async function saveVideoProgress(video, reason = "interval") {
    updatePageDiagnostics(video);
    state.diagnostics.lastSaveAttemptAt = Date.now();
    state.diagnostics.lastSaveReason = reason;

    if (!shouldAttemptSave(video, reason)) {
      return;
    }

    state.lastSaveByVideo.set(video, Date.now());

    const inFlight = state.inFlightByVideo.get(video);

    if (inFlight) {
      setSkipReason("SAVE_ALREADY_IN_FLIGHT");
      return;
    }

    const payload = await createResumePayload(video, reason);
    state.diagnostics.lastPayload = createDiagnosticPayload(payload);

    const savePromise = sendMessage(MESSAGE_TYPES.SAVE_RESUME_STATE, payload)
      .then((result) => {
        state.diagnostics.lastSavedAt = Date.now();
        state.diagnostics.lastSaveResult = {
          resumeKey: result?.resumeKey ?? null,
          skipped: result?.skipped === true,
          reason: result?.reason ?? null,
        };
        state.diagnostics.lastSkipReason = result?.skipped
          ? result.reason ?? "BACKGROUND_SKIPPED_SAVE"
          : null;
        state.diagnostics.lastError = null;

        return result;
      })
      .catch((error) => {
        setLastError(error);
        return null;
      });

    state.inFlightByVideo.set(video, savePromise);

    await savePromise;
    state.inFlightByVideo.delete(video);
  }

  function shouldAttemptSave(video, reason) {
    if (!(video instanceof HTMLVideoElement)) {
      setSkipReason("NOT_A_VIDEO_ELEMENT");
      return false;
    }

    const duration = video.duration;
    const position = getVideoPosition(video, reason);

    if (!Number.isFinite(duration) || duration <= 0) {
      setSkipReason("VIDEO_DURATION_NOT_READY", { duration });
      return false;
    }

    if (duration < state.settings.minimumVideoDurationSeconds) {
      setSkipReason("VIDEO_DURATION_BELOW_MINIMUM", {
        duration,
        minimum: state.settings.minimumVideoDurationSeconds,
      });
      return false;
    }

    if (!Number.isFinite(position) || position < MINIMUM_POSITION_SECONDS) {
      setSkipReason("WATCH_POSITION_TOO_EARLY", { position });
      return false;
    }

    const settings = normalizeSettings(state.settings);

    if (video.paused && !settings.resume.saveWhilePaused) {
      setSkipReason("PAUSED_SAVE_DISABLED");
      return false;
    }

    if (!video.paused && !settings.resume.saveWhileWatching) {
      setSkipReason("WATCHING_SAVE_DISABLED");
      return false;
    }

    if (IMMEDIATE_SAVE_REASONS.has(reason)) {
      state.diagnostics.lastSkipReason = null;
      state.diagnostics.lastSkipDetails = null;
      return true;
    }

    const intervalMs = Math.max(
      3,
      settings.resumeSaveIntervalSeconds,
    ) * 1000;
    const lastSavedAt = state.lastSaveByVideo.get(video) ?? 0;
    const elapsedMs = Date.now() - lastSavedAt;

    if (elapsedMs < intervalMs) {
      setSkipReason("SAVE_INTERVAL_WAIT", {
        remainingSeconds: Math.ceil((intervalMs - elapsedMs) / 1000),
      });
      return false;
    }

    state.diagnostics.lastSkipReason = null;
    state.diagnostics.lastSkipDetails = null;

    return true;
  }

  async function createResumePayload(video, reason) {
    const pageUrl = getPageUrl();
    const pageContext = await getStoredPageContext(pageUrl);
    const rawTitle = getBestTitle(video, pageContext);
    const sourceTitle = normalizeSourceTitle(rawTitle);
    const pageOrigin = getOrigin(pageUrl) ?? location.origin;
    const episodeNumber =
      pageContext?.episodeNumber ??
      extractEpisodeNumber(rawTitle, pageContext?.pageTitle, pageUrl, location.href);
    const siteOrigin = pageOrigin;
    const site = getSiteName(siteOrigin);

    return {
      site,
      siteOrigin,
      sourceTitle: pageContext?.sourceTitle ?? sourceTitle,
      episodeNumber,
      positionSeconds: roundSeconds(getVideoPosition(video, reason)),
      durationSeconds: roundSeconds(video.duration),
      episodeUrl: pageUrl,
      frameUrl: location.href,
      pageTitle: pageContext?.pageTitle ?? getPageTitle(),
      posterUrl: normalizeUrl(video.poster),
      siteIconUrl: pageContext?.siteIconUrl ?? getSiteIconUrl(pageOrigin),
      titleCandidates: getTitleCandidates(video),
      referrerUrl: document.referrer || null,
    };
  }

  function getVideoPosition(video, reason) {
    if (
      reason === "ended" &&
      Number.isFinite(video.duration) &&
      video.duration > 0
    ) {
      return video.duration;
    }

    return video.currentTime;
  }

  function createInitialDiagnostics() {
    return {
      status: "created",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      settingsLoaded: false,
      pageUrl: getPageUrl(),
      frameUrl: location.href,
      pageTitle: getPageTitle(),
      sourceTitle: null,
      episodeNumber: null,
      isTopFrame: isTopFrame(),
      videoCount: 0,
      playableVideoCount: 0,
      iframeCount: 0,
      attachedVideoCount: 0,
      activeVideo: null,
      lastAttachedAt: null,
      lastSaveAttemptAt: null,
      lastSavedAt: null,
      lastSaveReason: null,
      lastSaveResult: null,
      lastSkipReason: null,
      lastSkipDetails: null,
      lastError: null,
      lastPayload: null,
    };
  }

  function createPageContextPayload() {
    const titleCandidates = getTitleCandidates();
    const sourceTitle = normalizeSourceTitle(titleCandidates[0]);

    if (!isUsefulText(sourceTitle)) {
      return null;
    }

    return {
      pageUrl: location.href,
      site: getSiteName(location.origin),
      siteOrigin: location.origin,
      sourceTitle,
      episodeNumber: extractEpisodeNumber(...titleCandidates, location.href),
      pageTitle: document.title,
      siteIconUrl: getSiteIconUrl(location.origin),
      titleCandidates,
    };
  }

  function createDiagnosticsSnapshot() {
    updatePageDiagnostics(state.activeVideo);

    return {
      ...state.diagnostics,
      settings: {
        resumeSaveIntervalSeconds: state.settings.resumeSaveIntervalSeconds,
        minimumVideoDurationSeconds: state.settings.minimumVideoDurationSeconds,
        saveWhilePaused: state.settings.resume.saveWhilePaused,
        saveWhileWatching: state.settings.resume.saveWhileWatching,
      },
    };
  }

  function updatePageDiagnostics(preferredVideo = null) {
    const videos = Array.from(document.querySelectorAll(VIDEO_SELECTOR));
    const video =
      preferredVideo instanceof HTMLVideoElement ? preferredVideo : videos[0];
    const rawTitle = getBestTitle(video);
    const pageUrl = getPageUrl();

    state.diagnostics.updatedAt = Date.now();
    state.diagnostics.pageUrl = pageUrl;
    state.diagnostics.frameUrl = location.href;
    state.diagnostics.pageTitle = getPageTitle();
    state.diagnostics.sourceTitle = normalizeSourceTitle(rawTitle);
    state.diagnostics.episodeNumber = extractEpisodeNumber(
      rawTitle,
      pageUrl,
      location.href,
    );
    state.diagnostics.isTopFrame = isTopFrame();
    state.diagnostics.videoCount = videos.length;
    state.diagnostics.playableVideoCount = videos.filter(
      (item) => Number.isFinite(item.duration) && item.duration > 0,
    ).length;
    state.diagnostics.iframeCount =
      document.querySelectorAll(IFRAME_SELECTOR).length;
    state.diagnostics.attachedVideoCount = state.attachedVideoCount;
    state.diagnostics.activeVideo =
      video instanceof HTMLVideoElement
        ? {
            duration: normalizeDiagnosticNumber(video.duration),
            currentTime: normalizeDiagnosticNumber(video.currentTime),
            paused: video.paused,
            readyState: video.readyState,
          }
        : null;
  }

  function createDiagnosticPayload(payload) {
    return {
      site: payload.site,
      siteOrigin: payload.siteOrigin,
      sourceTitle: payload.sourceTitle,
      episodeNumber: payload.episodeNumber,
      positionSeconds: payload.positionSeconds,
      durationSeconds: payload.durationSeconds,
      hasPoster: typeof payload.posterUrl === "string",
      hasIcon: typeof payload.siteIconUrl === "string",
    };
  }

  function setSkipReason(reason, details = null) {
    state.diagnostics.lastSkipReason = reason;
    state.diagnostics.lastSkipDetails = normalizeDiagnosticDetails(details);
    state.diagnostics.updatedAt = Date.now();
  }

  function setLastError(error) {
    state.diagnostics.lastError = {
      name: error?.name ?? "Error",
      message: error?.message ?? "Unknown tracker error.",
    };
    state.diagnostics.updatedAt = Date.now();
  }

  function normalizeDiagnosticDetails(details) {
    if (!details || typeof details !== "object") {
      return null;
    }

    return Object.fromEntries(
      Object.entries(details).map(([key, value]) => [
        key,
        normalizeDiagnosticNumber(value),
      ]),
    );
  }

  function normalizeDiagnosticNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function getBestTitle(video, pageContext = null) {
    const candidates = [
      pageContext?.sourceTitle,
      ...(Array.isArray(pageContext?.titleCandidates)
        ? pageContext.titleCandidates
        : []),
      ...getTitleCandidates(video),
    ];

    return candidates.find((candidate) => isUsefulText(candidate)) ?? location.hostname;
  }

  function getTitleCandidates(video = null) {
    return [
      getText("h1"),
      document.title,
      getMetaContent('meta[name="anime_planet"]'),
      getText(".title"),
      getText("[data-title]"),
      video?.getAttribute("title"),
      video?.getAttribute("aria-label"),
      getTopDocumentTitle(),
      getReferrerTitleCandidate(),
      getMetaContent('meta[name="twitter:title"]'),
      getMetaContent('meta[property="og:title"]'),
      location.pathname.split("/").filter(Boolean).at(-1),
      location.hostname,
    ].filter((candidate) => isUsefulText(candidate));
  }

  function normalizeSourceTitle(value) {
    const withoutSiteSuffix = String(value)
      .replace(/\s+\|\s+animepahe.*$/i, "")
      .replace(/\s+-\s+animepahe.*$/i, "")
      .replace(/\s+::\s+animepahe.*$/i, "");

    const withoutWatchPrefix = withoutSiteSuffix.replace(/^watch\s+/i, "");
    const withoutEpisode = withoutWatchPrefix
      .replace(/\bepisode\s+\d+(\.\d+)?\b/gi, "")
      .replace(/\bep\.?\s*\d+(\.\d+)?\b/gi, "")
      .replace(/\s+-\s*\d{1,4}\s*$/i, "")
      .replace(/\s+-\s*\d{1,4}\s+online\b/i, "")
      .replace(/\s+online\b/gi, "");

    return cleanWhitespace(withoutEpisode) || cleanWhitespace(value) || location.hostname;
  }

  function extractEpisodeNumber(...values) {
    for (const value of values) {
      if (typeof value !== "string") {
        continue;
      }

      const decodedValue = safeDecode(value);
      const match = decodedValue.match(
        /(?:episode|ep\.?|[^\p{L}\p{N}]e)\s*0*(\d{1,4})(?:\D|$)|(?:^|[-_\s.])0*(\d{1,4})(?=\s+online\b|[-_\s.]*(?:\d{3,4}p|subsplease|$))/iu,
      );

      if (!match) {
        continue;
      }

      const parsed = Number.parseInt(match[1] ?? match[2], 10);

      if (Number.isInteger(parsed) && parsed > 0) {
        return parsed;
      }
    }

    return null;
  }

  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  function getPageUrl() {
    return getTopLocationHref() ?? document.referrer ?? location.href;
  }

  function getPageTitle() {
    return getTopDocumentTitle() ?? document.title;
  }

  function getTopLocationHref() {
    try {
      return globalThis.top?.location?.href ?? null;
    } catch {
      return null;
    }
  }

  function getTopDocumentTitle() {
    try {
      const title = globalThis.top?.document?.title;

      return isUsefulText(title) ? title : null;
    } catch {
      return null;
    }
  }

  function getReferrerTitleCandidate() {
    if (!isUsefulText(document.referrer)) {
      return null;
    }

    try {
      const url = new URL(document.referrer);

      return url.pathname.split("/").filter(Boolean).at(-1) ?? null;
    } catch {
      return null;
    }
  }

  function isTopFrame() {
    try {
      return globalThis.top === globalThis;
    } catch {
      return false;
    }
  }

  function getOrigin(value) {
    if (typeof value !== "string" || value.length === 0) {
      return null;
    }

    try {
      return new URL(value).origin;
    } catch {
      return null;
    }
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
      return location.hostname;
    }
  }

  function getMetaContent(selector) {
    return document.querySelector(selector)?.getAttribute("content");
  }

  function getText(selector) {
    const element = document.querySelector(selector);

    if (!element) {
      return null;
    }

    return element.getAttribute("data-title") ?? element.textContent;
  }

  function getSiteIconUrl(pageOrigin = location.origin) {
    const iconElement =
      document.querySelector('link[rel~="icon"]') ??
      document.querySelector('link[rel="shortcut icon"]') ??
      document.querySelector('link[rel="apple-touch-icon"]');

    return normalizeUrl(iconElement?.getAttribute("href")) ?? `${pageOrigin}/favicon.ico`;
  }

  function normalizeUrl(value) {
    if (typeof value !== "string" || value.trim().length === 0) {
      return null;
    }

    try {
      return new URL(value.trim(), location.href).href;
    } catch {
      return null;
    }
  }

  function isUsefulText(value) {
    return (
      typeof value === "string" &&
      cleanWhitespace(value).length > 1 &&
      !isRejectedText(value)
    );
  }

  function isRejectedText(value) {
    return /\b(?:okay-ish anime website|anime website|kwik|loading|player|an[\W_]+error[\W_]+occurred|method[\W_]+not[\W_]+allowed|not[\W_]+found|forbidden|access[\W_]+denied|bad[\W_]+gateway|service[\W_]+unavailable|server[\W_]+returned|cloudflare|captcha|just[\W_]+a[\W_]+moment)\b/i.test(value);
  }

  function cleanWhitespace(value) {
    return String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function roundSeconds(value) {
    return Math.max(0, Math.round(value));
  }

  function normalizeSettings(value) {
    const settings = isPlainObject(value) ? value : {};
    const resume = isPlainObject(settings.resume) ? settings.resume : {};

    return {
      resumeSaveIntervalSeconds: clampInteger(
        settings.resumeSaveIntervalSeconds,
        3,
        120,
        DEFAULT_SETTINGS.resumeSaveIntervalSeconds,
      ),
      minimumVideoDurationSeconds: clampInteger(
        settings.minimumVideoDurationSeconds,
        30,
        1800,
        DEFAULT_SETTINGS.minimumVideoDurationSeconds,
      ),
      resume: {
        saveWhilePaused: toBoolean(
          resume.saveWhilePaused,
          DEFAULT_SETTINGS.resume.saveWhilePaused,
        ),
        saveWhileWatching: toBoolean(
          resume.saveWhileWatching,
          DEFAULT_SETTINGS.resume.saveWhileWatching,
        ),
      },
    };
  }

  function clampInteger(value, min, max, fallback) {
    if (!Number.isInteger(value)) {
      return fallback;
    }

    return Math.min(Math.max(value, min), max);
  }

  function toBoolean(value, fallback) {
    return typeof value === "boolean" ? value : fallback;
  }

  function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function sendMessage(type, payload = null) {
    return chrome.runtime
      .sendMessage({
        type,
        payload,
      })
      .then((response) => {
        if (!response?.ok) {
          throw new Error(response?.error?.message ?? "Shiori message failed.");
        }

        return response.data;
      });
  }
})();
