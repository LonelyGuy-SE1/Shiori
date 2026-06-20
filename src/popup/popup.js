import { sendMessage, MESSAGE_TYPES } from "../messaging.js";
import { LIBRARY_STATUS_OPTIONS } from "../sync-policy.js";
import {
  createOriginPattern,
  getDisplayHost,
  normalizeTrackableOrigin,
} from "../tracked-sites.js";

const TRACKER_SCRIPT_FILE = "src/content/videoTracker.js";
const FALLBACK_COVER_URL = "../../assets/icons/SE148.png";

const elements = {
  refreshButton: document.getElementById("refreshButton"),
  statusBanner: document.getElementById("statusBanner"),
  tabTriggers: Array.from(document.querySelectorAll(".tab-trigger")),
  tabPanels: Array.from(document.querySelectorAll(".tab-panel")),

  malHeaderStatus: document.getElementById("malHeaderStatus"),
  malStatusText: document.getElementById("malStatusText"),
  malClientIdInput: document.getElementById("malClientIdInput"),
  malClientSecretInput: document.getElementById("malClientSecretInput"),
  malRedirectUriInput: document.getElementById("malRedirectUriInput"),
  malConnectButton: document.getElementById("malConnectButton"),
  malDisconnectButton: document.getElementById("malDisconnectButton"),

  currentSiteHost: document.getElementById("currentSiteHost"),
  currentSiteBadge: document.getElementById("currentSiteBadge"),
  trackSiteButton: document.getElementById("trackSiteButton"),
  trackerDiagnostics: document.getElementById("trackerDiagnostics"),
  currentPageMatches: document.getElementById("currentPageMatches"),

  resumeCount: document.getElementById("resumeCount"),
  librarySearchInput: document.getElementById("librarySearchInput"),
  resumeList: document.getElementById("resumeList"),
  emptyState: document.getElementById("emptyState"),

  completionThresholdInput: document.getElementById("completionThresholdInput"),
  saveIntervalInput: document.getElementById("saveIntervalInput"),
  saveSettingsButton: document.getElementById("saveSettingsButton"),
  resetSettingsButton: document.getElementById("resetSettingsButton"),
};

const popupState = {
  activeTab: null,
  activePanelId: null,
  currentOrigin: null,
  trackedSites: [],
  myAnimeList: null,
  currentInspection: null,
  currentPageMatches: null,
  resumeStates: [],
  libraryQuery: "",
  matchRefreshPromise: null,
};

document.addEventListener("DOMContentLoaded", initialisePopup);

async function initialisePopup() {
  bindEvents();
  await refreshPopup();
}

function bindEvents() {
  elements.refreshButton.addEventListener("click", () =>
    refreshPopup({
      refreshMyAnimeList: true,
      forceMyAnimeListRefresh: true,
    }),
  );
  elements.trackSiteButton.addEventListener("click", toggleCurrentSiteTracking);
  elements.malConnectButton.addEventListener("click", connectMyAnimeList);
  elements.malDisconnectButton.addEventListener("click", disconnectMyAnimeList);
  elements.saveSettingsButton.addEventListener("click", saveSettings);
  elements.resetSettingsButton.addEventListener("click", resetSettings);
  elements.librarySearchInput.addEventListener("input", () => {
    popupState.libraryQuery = elements.librarySearchInput.value.trim();
    renderResumeStates();
  });

  for (const trigger of elements.tabTriggers) {
    trigger.addEventListener("click", () => {
      setActiveTab(trigger.dataset.tabTarget);
    });
  }
}

function setActiveTab(panelId) {
  const safePanelId = elements.tabPanels.some((panel) => panel.id === panelId)
    ? panelId
    : "libraryPanel";

  popupState.activePanelId = safePanelId;

  for (const trigger of elements.tabTriggers) {
    const isActive = trigger.dataset.tabTarget === safePanelId;
    trigger.dataset.state = isActive ? "active" : "inactive";
  }

  for (const panel of elements.tabPanels) {
    const isActive = panel.id === safePanelId;
    panel.dataset.state = isActive ? "active" : "inactive";
  }
}

async function refreshPopup(options = {}) {
  setLoading(true);
  clearStatus();

  try {
    const [resumeStates, settings, trackedSites, myAnimeList, activeTab] =
      await Promise.all([
        sendMessage(MESSAGE_TYPES.GET_RESUME_STATES, {
          refreshMyAnimeList: options.refreshMyAnimeList === true,
          forceMyAnimeListRefresh: options.forceMyAnimeListRefresh === true,
          matchRefreshLimit: 5,
        }),
        sendMessage(MESSAGE_TYPES.GET_SETTINGS),
        sendMessage(MESSAGE_TYPES.GET_TRACKED_SITES),
        sendMessage(MESSAGE_TYPES.GET_MY_ANIME_LIST_STATUS),
        getActiveTab(),
      ]);

    popupState.activeTab = activeTab;
    popupState.currentOrigin = normalizeTrackableOrigin(activeTab?.url);
    popupState.trackedSites = Array.isArray(trackedSites) ? trackedSites : [];
    popupState.myAnimeList = myAnimeList;
    popupState.currentInspection = await getCurrentPageInspection(activeTab);
    popupState.currentPageMatches = await getCurrentPageMatches(
      popupState.currentInspection,
      myAnimeList,
      {
        cacheOnly: options.refreshMyAnimeList !== true,
        forceRefresh: options.forceMyAnimeListRefresh === true,
      },
    );
    popupState.resumeStates = Array.isArray(resumeStates) ? resumeStates : [];

    renderMyAnimeList(myAnimeList, settings);
    renderCurrentSite();
    renderResumeStates();
    renderSettings(settings);
    setActiveTab(getPreferredPanelId());

    if (options.refreshMyAnimeList !== true) {
      queueMatchRefresh();
    }
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    setLoading(false);
  }
}

function getPreferredPanelId() {
  if (popupState.activePanelId) {
    return popupState.activePanelId;
  }

  if (
    popupState.currentOrigin &&
    popupState.currentInspection?.ok === true &&
    popupState.currentInspection?.isEpisodePage !== true
  ) {
    return "sitePanel";
  }

  return "libraryPanel";
}

function queueMatchRefresh() {
  if (
    popupState.matchRefreshPromise ||
    popupState.myAnimeList?.connected !== true ||
    !shouldWarmMatchCache()
  ) {
    return;
  }

  popupState.matchRefreshPromise = Promise.all([
    sendMessage(MESSAGE_TYPES.GET_RESUME_STATES, {
      refreshMyAnimeList: true,
      forceMyAnimeListRefresh: false,
      matchRefreshLimit: 5,
    }),
    getCurrentPageMatches(popupState.currentInspection, popupState.myAnimeList, {
      cacheOnly: false,
      forceRefresh: false,
    }),
  ])
    .then(([resumeStates, currentPageMatches]) => {
      popupState.resumeStates = Array.isArray(resumeStates)
        ? resumeStates
        : popupState.resumeStates;
      popupState.currentPageMatches = currentPageMatches;

      renderResumeStates();
      renderCurrentPageMatches();
    })
    .catch(() => null)
    .finally(() => {
      popupState.matchRefreshPromise = null;
    });
}

function shouldWarmMatchCache() {
  const hasUnmatchedResumeState = popupState.resumeStates.some(
    (state) =>
      state.myAnimeList?.connected === true &&
      !state.libraryState?.mediaId &&
      (!Array.isArray(state.myAnimeList?.candidates) ||
        state.myAnimeList.candidates.length === 0),
  );
  const currentPageNeedsMatch =
    popupState.currentInspection?.isEpisodePage === true &&
    popupState.currentInspection?.sourceTitle &&
    (!Array.isArray(popupState.currentPageMatches?.candidates) ||
      popupState.currentPageMatches.candidates.length === 0);

  return hasUnmatchedResumeState || currentPageNeedsMatch;
}

function renderMyAnimeList(myAnimeList, settings) {
  const connected = myAnimeList?.connected === true;
  const userName = myAnimeList?.user?.name;
  const label = connected
    ? userName
      ? `MAL: ${userName}`
      : "MAL connected"
    : "MAL offline";

  elements.malHeaderStatus.textContent = label;
  elements.malHeaderStatus.dataset.state = connected ? "connected" : "idle";
  elements.malStatusText.textContent = connected
    ? userName
      ? `Connected as ${userName}`
      : "Connected"
    : "Disconnected";
  elements.malStatusText.dataset.state = connected ? "enabled" : "idle";
  elements.malClientIdInput.value =
    myAnimeList?.clientId ?? settings?.sync?.myAnimeListClientId ?? "";
  elements.malClientSecretInput.value =
    settings?.sync?.myAnimeListClientSecret ?? "";
  elements.malRedirectUriInput.value = myAnimeList?.redirectUri ?? "";
  elements.malConnectButton.disabled = connected;
  elements.malDisconnectButton.disabled = !connected;
}

function renderCurrentSite() {
  const origin = popupState.currentOrigin;

  if (!origin) {
    elements.currentSiteHost.textContent = "Unsupported browser page";
    elements.currentSiteBadge.textContent = "Off";
    elements.currentSiteBadge.dataset.state = "idle";
    elements.trackSiteButton.textContent = "Unavailable";
    elements.trackSiteButton.disabled = true;
    renderTrackerDiagnostics(false);
    renderCurrentPageMatches();
    return;
  }

  const trackedSite = getTrackedSite(origin);
  const isEnabled = trackedSite?.enabled === true;

  elements.currentSiteHost.textContent = getDisplayHost(origin);
  elements.currentSiteBadge.textContent = isEnabled ? "Tracked" : "Not tracked";
  elements.currentSiteBadge.dataset.state = isEnabled ? "enabled" : "idle";
  elements.trackSiteButton.textContent = isEnabled
    ? "Stop tracking"
    : "Track this site";
  elements.trackSiteButton.disabled = false;
  renderTrackerDiagnostics(isEnabled);
  renderCurrentPageMatches();
}

function renderTrackerDiagnostics(isTrackingEnabled) {
  elements.trackerDiagnostics.replaceChildren();

  const inspection = popupState.currentInspection;
  const tracker = inspection?.tracker ?? null;
  const trackerStatus = tracker
    ? "Running"
    : isTrackingEnabled
      ? "Not loaded"
      : "Idle";

  const rows = [
    createDiagnosticItem("Tracker", trackerStatus),
    createDiagnosticItem("Detected anime", inspection?.sourceTitle ?? "Unknown"),
    createDiagnosticItem("Episode", formatEpisode(inspection?.episodeNumber)),
    createDiagnosticItem("Top-page videos", formatCount(inspection?.videoCount)),
    createDiagnosticItem("Playable videos", formatCount(inspection?.playableVideoCount)),
    createDiagnosticItem("Iframes", formatCount(inspection?.iframeCount)),
    createDiagnosticItem(
      "Player frames",
      formatOriginList(inspection?.playerFrameOrigins),
    ),
    createDiagnosticItem("Last skip", tracker?.lastSkipReason ?? "None"),
  ];

  if (inspection?.error) {
    rows.push(createDiagnosticItem("Page check", inspection.error));
  }

  if (tracker?.lastError?.message) {
    rows.push(createDiagnosticItem("Tracker error", tracker.lastError.message));
  }

  const panelHeader = document.createElement("div");
  panelHeader.className = "diagnostics-header";

  const title = document.createElement("div");
  title.className = "diagnostics-title";
  title.textContent = "Tracker health";

  const badge = document.createElement("span");
  badge.className = "metric-pill";
  badge.dataset.state = tracker ? "enabled" : "idle";
  badge.textContent = trackerStatus;

  panelHeader.append(title, badge);

  const grid = document.createElement("div");
  grid.className = "diagnostic-grid";
  grid.append(...rows);

  const hint = createTrackerHint(inspection, tracker, isTrackingEnabled);
  const frameActions = createPlayerFrameActions(inspection);

  elements.trackerDiagnostics.append(panelHeader, grid);

  if (hint) {
    elements.trackerDiagnostics.appendChild(hint);
  }

  if (frameActions) {
    elements.trackerDiagnostics.appendChild(frameActions);
  }
}

function renderCurrentPageMatches() {
  elements.currentPageMatches.replaceChildren();

  const inspection = popupState.currentInspection;
  const matchState = popupState.currentPageMatches;

  const header = document.createElement("div");
  header.className = "diagnostics-header";

  const title = document.createElement("div");
  title.className = "diagnostics-title";
  title.textContent = "Current page MAL";

  const badge = document.createElement("span");
  badge.className = "metric-pill";
  badge.dataset.state =
    inspection?.isEpisodePage === true && matchState?.candidates?.length > 0
      ? "enabled"
      : "idle";
  badge.textContent = matchState?.candidates?.length
    ? `${matchState.candidates.length} found`
    : inspection?.isEpisodePage === false
      ? "Inactive"
    : "No match";

  header.append(title, badge);
  elements.currentPageMatches.appendChild(header);

  if (inspection?.isEpisodePage !== true) {
    elements.currentPageMatches.appendChild(
      createMutedText("No episode is active on this page."),
    );
    return;
  }

  if (popupState.myAnimeList?.connected !== true) {
    elements.currentPageMatches.appendChild(
      createMutedText("Connect MAL to preview current-page matches."),
    );
    return;
  }

  if (!inspection?.sourceTitle) {
    elements.currentPageMatches.appendChild(
      createMutedText("No usable title detected on this page yet."),
    );
    return;
  }

  if (matchState?.error) {
    elements.currentPageMatches.appendChild(createMutedText(matchState.error));
    return;
  }

  const candidates = Array.isArray(matchState?.candidates)
    ? matchState.candidates
    : [];

  if (candidates.length === 0) {
    elements.currentPageMatches.appendChild(
      createMutedText(`No MAL result found for ${inspection.sourceTitle}.`),
    );
    return;
  }

  const list = document.createElement("div");
  list.className = "mal-match-list";

  for (const candidate of candidates.slice(0, 5)) {
    list.appendChild(createMyAnimeListPreview(candidate));
  }

  elements.currentPageMatches.appendChild(list);
}

function createDiagnosticItem(label, value) {
  const item = document.createElement("div");
  item.className = "diagnostic-item";

  const term = document.createElement("span");
  term.className = "diagnostic-label";
  term.textContent = label;

  const detail = document.createElement("span");
  detail.className = "diagnostic-value";
  detail.textContent = value ?? "Unknown";

  item.append(term, detail);

  return item;
}

function createTrackerHint(inspection, tracker, isTrackingEnabled) {
  const hint = document.createElement("p");
  hint.className = "diagnostics-hint";

  if (inspection?.ok === false && inspection.error) {
    hint.textContent = inspection.error;
    return hint;
  }

  if (isTrackingEnabled && inspection?.isEpisodePage === false) {
    hint.textContent =
      "This page does not look like an episode page. Open an episode to save progress.";
    return hint;
  }

  if (isTrackingEnabled && !tracker) {
    hint.textContent =
      "Tracker is enabled, but this tab has not loaded the tracker. Reload the episode tab once after enabling site access.";
    return hint;
  }

  if ((inspection?.videoCount ?? 0) === 0 && (inspection?.iframeCount ?? 0) > 0) {
    hint.textContent =
      "No top-page video was found. The player is probably inside an iframe, so Shiori needs access to that player frame origin too.";
    return hint;
  }

  if (tracker?.lastSkipReason === "WATCH_POSITION_TOO_EARLY") {
    hint.textContent =
      "Playback was detected, but Shiori waits until at least 2 seconds before saving progress.";
    return hint;
  }

  if (tracker?.lastSkipReason === "VIDEO_DURATION_BELOW_MINIMUM") {
    hint.textContent =
      "The detected video is shorter than the minimum duration in Settings.";
    return hint;
  }

  if (tracker?.lastSkipReason === "VIDEO_DURATION_NOT_READY") {
    hint.textContent =
      "A video element exists, but the browser has not exposed its runtime yet.";
    return hint;
  }

  return null;
}

function createPlayerFrameActions(inspection) {
  const origins = getUntrackedFrameOrigins(inspection?.playerFrameOrigins);

  if (origins.length === 0) {
    return null;
  }

  const wrapper = document.createElement("div");
  wrapper.className = "diagnostics-actions";

  const button = document.createElement("button");
  button.className = "button button-secondary";
  button.type = "button";
  button.textContent = "Track player frames";
  button.addEventListener("click", async () => {
    await enablePlayerFrameOrigins(origins);
  });

  wrapper.appendChild(button);

  return wrapper;
}

async function enablePlayerFrameOrigins(origins) {
  const uniqueOrigins = getUntrackedFrameOrigins(origins);

  if (uniqueOrigins.length === 0) {
    showStatus("Detected player frame origins are already tracked.", "success");
    return;
  }

  clearStatus();

  try {
    for (const origin of uniqueOrigins) {
      const pattern = createOriginPattern(origin);

      if (!pattern) {
        continue;
      }

      const granted = await requestHostPermission(pattern);

      if (!granted) {
        throw new Error(`Site access was not granted for ${getDisplayHost(origin)}.`);
      }

      await sendMessage(MESSAGE_TYPES.ENABLE_TRACKED_SITE, {
        origin,
        label: getDisplayHost(origin),
      });
    }

    await refreshPopup();
    showStatus("Player frame tracking enabled. Reload the episode tab once.", "success");
  } catch (error) {
    showStatus(error.message, "error");
  }
}

function getUntrackedFrameOrigins(origins) {
  if (!Array.isArray(origins)) {
    return [];
  }

  const seenOrigins = new Set();
  const result = [];

  for (const origin of origins) {
    const normalizedOrigin = normalizeTrackableOrigin(origin);

    if (
      !normalizedOrigin ||
      normalizedOrigin === popupState.currentOrigin ||
      seenOrigins.has(normalizedOrigin)
    ) {
      continue;
    }

    const trackedSite = getTrackedSite(normalizedOrigin);

    if (trackedSite?.enabled === true) {
      continue;
    }

    seenOrigins.add(normalizedOrigin);
    result.push(normalizedOrigin);
  }

  return result.slice(0, 4);
}

function createMyAnimeListPreview(candidate) {
  const match = document.createElement("article");
  match.className = "mal-match";

  const image = document.createElement("img");
  image.className = "mal-cover";
  image.alt = "";
  image.loading = "lazy";
  image.src =
    candidate.mainPicture?.medium ??
    candidate.mainPicture?.large ??
    FALLBACK_COVER_URL;
  image.addEventListener("error", () => {
    image.src = FALLBACK_COVER_URL;
  });

  const body = document.createElement("div");
  body.className = "mal-match-body";

  const title = document.createElement("p");
  title.className = "mal-match-title";
  title.textContent = candidate.title;

  const meta = document.createElement("p");
  meta.className = "mal-match-meta";
  meta.textContent = createMyAnimeListMeta(candidate);

  body.append(title, meta);
  match.append(image, body);

  return match;
}

function renderResumeStates(resumeStates = popupState.resumeStates) {
  elements.resumeList.replaceChildren();

  const safeStates = Array.isArray(resumeStates) ? resumeStates : [];
  const filteredStates = filterResumeStates(safeStates, popupState.libraryQuery);

  elements.resumeCount.textContent =
    popupState.libraryQuery && filteredStates.length !== safeStates.length
      ? `${filteredStates.length}/${safeStates.length} shown`
      : `${safeStates.length} saved`;
  elements.emptyState.hidden = filteredStates.length !== 0;

  for (const state of filteredStates) {
    elements.resumeList.appendChild(createAnimeCard(state));
  }
}

function filterResumeStates(resumeStates, query) {
  const normalizedQuery = normalizeSearchText(query);

  if (!normalizedQuery) {
    return resumeStates;
  }

  return resumeStates.filter((state) => {
    return [
      state.sourceTitle,
      state.libraryState?.matchedTitle,
      state.pageTitle,
      state.site,
    ]
      .map(normalizeSearchText)
      .some((value) => value.includes(normalizedQuery));
  });
}

function createAnimeCard(state) {
  const card = document.createElement("article");
  card.className = "anime-card";

  const cover = document.createElement("img");
  cover.className = "anime-cover";
  cover.alt = "";
  cover.loading = "lazy";
  cover.src = state.posterUrl ?? state.siteIconUrl ?? FALLBACK_COVER_URL;
  cover.addEventListener("error", () => {
    cover.src = FALLBACK_COVER_URL;
  });

  const content = document.createElement("div");
  content.className = "anime-content";

  const titleRow = document.createElement("div");
  titleRow.className = "anime-title-row";

  const title = document.createElement("div");
  title.className = "anime-title";
  title.textContent = state.libraryState?.matchedTitle ?? state.sourceTitle ?? "Unknown anime";

  const site = document.createElement("span");
  site.className = "anime-site";
  site.textContent = state.site ?? "site";

  titleRow.append(title, site);

  const meta = document.createElement("p");
  meta.className = "anime-meta";
  meta.textContent = state.pageTitle ?? getUrlHost(state.episodeUrl);

  const progressTrack = document.createElement("div");
  progressTrack.className = "progress-track";

  const progressFill = document.createElement("div");
  progressFill.className = "progress-fill";
  progressFill.style.setProperty(
    "--progress",
    `${toPercent(state.progressRatio)}%`,
  );
  progressTrack.appendChild(progressFill);

  const details = document.createElement("dl");
  details.className = "anime-detail-grid";
  details.append(
    createDetailItem("Episode", formatEpisode(state.episodeNumber)),
    createDetailItem("Progress", `${toPercent(state.progressRatio)}%`),
    createDetailItem("Watched", formatDuration(state.positionSeconds)),
    createDetailItem("Runtime", formatDuration(state.durationSeconds)),
    createDetailItem("Updated", formatUpdatedAt(state.updatedAt)),
    createDetailItem("MAL score", formatRawScore(state.libraryState?.score)),
  );

  content.append(
    titleRow,
    meta,
    progressTrack,
    details,
    createSyncPanel(state),
    createLibraryControls(state),
    createAnimeActions(state),
  );

  card.append(cover, content);

  return card;
}

function createSyncPanel(state) {
  const panel = document.createElement("div");
  panel.className = "sync-panel";

  const header = document.createElement("div");
  header.className = "sync-header";

  const badge = document.createElement("span");
  badge.className = "sync-badge";
  badge.dataset.tone = state.syncPlan?.tone ?? "review";
  badge.textContent = state.syncPlan?.label ?? "Needs MAL match";

  const score = document.createElement("span");
  score.className = "sync-score";
  score.textContent = formatScore(state.libraryState?.score);

  header.append(badge, score);

  const summary = document.createElement("p");
  summary.className = "sync-summary";
  summary.textContent =
    state.syncPlan?.summary ?? "Choose the correct MAL result before syncing.";

  const payload = document.createElement("p");
  payload.className = "sync-payload";
  payload.textContent = createSyncPayloadText(state);

  panel.append(header, summary, payload, createMyAnimeListMatches(state));

  return panel;
}

function createMyAnimeListMatches(state) {
  const wrapper = document.createElement("div");
  wrapper.className = "mal-match-list";

  if (state.myAnimeList?.connected !== true) {
    wrapper.appendChild(createMutedText("Connect MAL to load covers and sync episodes."));
    return wrapper;
  }

  const candidates = Array.isArray(state.myAnimeList?.candidates)
    ? state.myAnimeList.candidates
    : [];
  const visibleCandidates = getVisibleMyAnimeListCandidates(state, candidates);

  if (visibleCandidates.length === 0) {
    wrapper.appendChild(
      createMutedText(state.myAnimeList?.error ?? "No MAL result found yet."),
    );
    return wrapper;
  }

  for (const candidate of visibleCandidates.slice(0, 5)) {
    wrapper.appendChild(createMyAnimeListMatch(state, candidate));
  }

  return wrapper;
}

function getVisibleMyAnimeListCandidates(state, candidates) {
  const selectedMediaId = state.libraryState?.mediaId;

  if (!Number.isInteger(selectedMediaId)) {
    return candidates;
  }

  const selectedCandidates = candidates.filter(
    (candidate) => candidate.id === selectedMediaId,
  );

  if (selectedCandidates.length > 0) {
    return selectedCandidates;
  }

  if (state.libraryState?.matchedTitle) {
    return [
      {
        id: selectedMediaId,
        title: state.libraryState.matchedTitle,
        mainPicture: {
          medium: state.libraryState.coverUrl ?? null,
          large: state.libraryState.coverUrl ?? null,
        },
        numEpisodes: state.libraryState.numEpisodes ?? null,
        myListStatus: {
          status: state.libraryState.malStatus ?? state.libraryState.listStatus,
          score: state.libraryState.score ?? null,
          numEpisodesWatched: state.libraryState.numWatchedEpisodes ?? null,
        },
      },
    ];
  }

  return [];
}

function createMyAnimeListMatch(state, candidate) {
  const match = document.createElement("article");
  match.className = "mal-match";

  const image = document.createElement("img");
  image.className = "mal-cover";
  image.alt = "";
  image.loading = "lazy";
  image.src =
    candidate.mainPicture?.medium ??
    candidate.mainPicture?.large ??
    FALLBACK_COVER_URL;
  image.addEventListener("error", () => {
    image.src = FALLBACK_COVER_URL;
  });

  const body = document.createElement("div");
  body.className = "mal-match-body";

  const title = document.createElement("p");
  title.className = "mal-match-title";
  title.textContent = candidate.title;

  const meta = document.createElement("p");
  meta.className = "mal-match-meta";
  meta.textContent = createMyAnimeListMeta(candidate);

  const button = document.createElement("button");
  button.className = "button button-primary";
  button.type = "button";
  button.textContent =
    candidate.id === state.libraryState?.mediaId ? "Sync progress" : "Use and sync";
  button.addEventListener("click", async () => {
    await syncMyAnimeList(state.resumeKey, candidate.id);
  });

  body.append(title, meta, button);
  match.append(image, body);

  return match;
}

function createLibraryControls(state) {
  const controls = document.createElement("div");
  controls.className = "library-controls";

  const statusSelect = document.createElement("select");
  statusSelect.className = "library-select";
  statusSelect.setAttribute("aria-label", "MAL list status");

  for (const option of LIBRARY_STATUS_OPTIONS) {
    const optionElement = document.createElement("option");
    optionElement.value = option.value;
    optionElement.textContent = option.label;
    optionElement.selected = option.value === state.libraryState?.listStatus;
    statusSelect.appendChild(optionElement);
  }

  const scoreInput = document.createElement("input");
  scoreInput.className = "input score-input";
  scoreInput.type = "number";
  scoreInput.min = "0";
  scoreInput.max = "10";
  scoreInput.step = "1";
  scoreInput.inputMode = "numeric";
  scoreInput.placeholder = "Score";
  scoreInput.setAttribute("aria-label", "MAL score out of 10");
  scoreInput.value =
    typeof state.libraryState?.score === "number"
      ? String(state.libraryState.score)
      : "";

  const saveButton = document.createElement("button");
  saveButton.className = "button button-secondary";
  saveButton.type = "button";
  saveButton.textContent = "Save";
  saveButton.addEventListener("click", async () => {
    await saveAnimeLibraryState(state.resumeKey, {
      listStatus: statusSelect.value,
      score: parseOptionalScore(scoreInput.value),
    });
  });

  controls.append(statusSelect, scoreInput, saveButton);

  return controls;
}

function createAnimeActions(state) {
  const actions = document.createElement("div");
  actions.className = "anime-actions";

  const continueButton = document.createElement("button");
  continueButton.className = "button button-primary";
  continueButton.type = "button";
  continueButton.textContent = "Open episode";
  continueButton.addEventListener("click", () => {
    openEpisode(state.episodeUrl);
  });

  const clearButton = document.createElement("button");
  clearButton.className = "button button-secondary";
  clearButton.type = "button";
  clearButton.textContent = "Remove";
  clearButton.addEventListener("click", async () => {
    await clearResumeState(state.resumeKey);
  });

  actions.append(continueButton, clearButton);

  return actions;
}

function createDetailItem(label, value) {
  const wrapper = document.createElement("div");
  wrapper.className = "anime-detail-item";

  const term = document.createElement("dt");
  term.textContent = label;

  const description = document.createElement("dd");
  description.textContent = value;

  wrapper.append(term, description);

  return wrapper;
}

function createMutedText(text) {
  const paragraph = document.createElement("p");
  paragraph.className = "sync-summary";
  paragraph.textContent = text;

  return paragraph;
}

async function connectMyAnimeList() {
  const clientId = elements.malClientIdInput.value.trim();
  const clientSecret = elements.malClientSecretInput.value.trim();

  if (clientId.length === 0) {
    setActiveTab("malPanel");
    showStatus("Enter your MAL API Client ID first.", "error");
    return;
  }

  setMalButtonsDisabled(true);
  clearStatus();

  try {
    await sendMessage(MESSAGE_TYPES.CONNECT_MY_ANIME_LIST, {
      clientId,
      clientSecret,
    });
    await refreshPopup();
    showStatus("MyAnimeList connected.", "success");
  } catch (error) {
    setMalButtonsDisabled(false);
    showStatus(error.message, "error");
  }
}

async function disconnectMyAnimeList() {
  setMalButtonsDisabled(true);
  clearStatus();

  try {
    await sendMessage(MESSAGE_TYPES.DISCONNECT_MY_ANIME_LIST);
    await refreshPopup();
    showStatus("MyAnimeList disconnected.", "success");
  } catch (error) {
    setMalButtonsDisabled(false);
    showStatus(error.message, "error");
  }
}

async function toggleCurrentSiteTracking() {
  const origin = popupState.currentOrigin;

  if (!origin) {
    showStatus("This browser page cannot be tracked.", "error");
    return;
  }

  const trackedSite = getTrackedSite(origin);
  const isEnabled = trackedSite?.enabled === true;

  setTrackingButtonDisabled(true);
  clearStatus();

  try {
    if (isEnabled) {
      await disableCurrentSite(origin);
      showStatus("Tracking disabled for this site.", "success");
    } else {
      await enableCurrentSite(origin);
      showStatus("Tracking enabled for this site.", "success");
    }

    await refreshPopup();
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    setTrackingButtonDisabled(false);
  }
}

async function enableCurrentSite(origin) {
  const pattern = createOriginPattern(origin);

  if (!pattern) {
    throw new Error("This site cannot be tracked.");
  }

  const granted = await requestHostPermission(pattern);

  if (!granted) {
    throw new Error("Site access was not granted.");
  }

  await sendMessage(MESSAGE_TYPES.ENABLE_TRACKED_SITE, {
    origin,
    label: getDisplayHost(origin),
  });

  await injectTrackerIntoActiveTab();
}

async function disableCurrentSite(origin) {
  const pattern = createOriginPattern(origin);

  await sendMessage(MESSAGE_TYPES.DISABLE_TRACKED_SITE, { origin });

  if (pattern) {
    await removeHostPermission(pattern);
  }
}

function renderSettings(settings) {
  elements.completionThresholdInput.value = String(
    Math.round((settings.watchCompletionThresholdRatio ?? 0.9) * 100),
  );

  elements.saveIntervalInput.value = String(
    settings.resumeSaveIntervalSeconds ?? 10,
  );
}

async function saveSettings() {
  setSettingsButtonsDisabled(true);
  clearStatus();

  try {
    const thresholdPercent = parseIntegerInput(
      elements.completionThresholdInput.value,
      90,
    );
    const saveIntervalSeconds = parseIntegerInput(
      elements.saveIntervalInput.value,
      10,
    );

    await sendMessage(MESSAGE_TYPES.UPDATE_SETTINGS, {
      watchCompletionThresholdRatio: thresholdPercent / 100,
      resumeSaveIntervalSeconds,
      sync: {
        myAnimeListClientId: elements.malClientIdInput.value.trim(),
        myAnimeListClientSecret: elements.malClientSecretInput.value.trim(),
      },
    });
    showStatus("Settings saved.", "success");
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    setSettingsButtonsDisabled(false);
  }
}

async function resetSettings() {
  setSettingsButtonsDisabled(true);
  clearStatus();

  try {
    const settings = await sendMessage(MESSAGE_TYPES.RESET_SETTINGS);
    renderSettings(settings);
    renderMyAnimeList(popupState.myAnimeList, settings);
    showStatus("Settings reset.", "success");
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    setSettingsButtonsDisabled(false);
  }
}

async function saveAnimeLibraryState(resumeKey, libraryState) {
  if (typeof resumeKey !== "string" || resumeKey.length === 0) {
    showStatus("Cannot save this anime because its key is missing.", "error");
    return;
  }

  clearStatus();

  try {
    await sendMessage(MESSAGE_TYPES.UPDATE_ANIME_LIBRARY_STATE, {
      resumeKey,
      libraryState,
    });
    await refreshPopup();
    showStatus("Anime state saved.", "success");
  } catch (error) {
    showStatus(error.message, "error");
  }
}

async function syncMyAnimeList(resumeKey, animeId) {
  if (typeof resumeKey !== "string" || resumeKey.length === 0) {
    showStatus("Cannot sync because the anime key is missing.", "error");
    return;
  }

  clearStatus();

  try {
    const response = await sendMessage(
      MESSAGE_TYPES.SYNC_RESUME_STATE_TO_MY_ANIME_LIST,
      {
        resumeKey,
        animeId,
      },
    );

    await refreshPopup();

    if (response?.result?.skipped) {
      showStatus("No MAL update was needed for this entry.", "success");
    } else {
      showStatus("MyAnimeList updated.", "success");
    }
  } catch (error) {
    showStatus(error.message, "error");
  }
}

async function clearResumeState(resumeKey) {
  if (typeof resumeKey !== "string" || resumeKey.length === 0) {
    showStatus("Cannot remove this anime because its key is missing.", "error");
    return;
  }

  clearStatus();

  try {
    await sendMessage(MESSAGE_TYPES.CLEAR_RESUME_STATE, { resumeKey });
    await refreshPopup();
  } catch (error) {
    showStatus(error.message, "error");
  }
}

function openEpisode(url) {
  if (typeof url !== "string" || url.length === 0) {
    showStatus("Episode URL is missing.", "error");
    return;
  }

  chrome.tabs.create({ url });
}

function getTrackedSite(origin) {
  return popupState.trackedSites.find((site) => site.origin === origin) ?? null;
}

function normalizeSearchText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query(
      {
        active: true,
        currentWindow: true,
      },
      ([tab]) => {
        resolve(tab ?? null);
      },
    );
  });
}

function getCurrentPageInspection(tab) {
  if (!Number.isInteger(tab?.id)) {
    return Promise.resolve({
      ok: false,
      error: "No active tab was found.",
    });
  }

  if (!normalizeTrackableOrigin(tab.url)) {
    return Promise.resolve({
      ok: false,
      error: "This browser page cannot be inspected by Shiori.",
    });
  }

  return new Promise((resolve) => {
    chrome.scripting.executeScript(
      {
        target: { tabId: tab.id },
        func: inspectCurrentPageForShiori,
      },
      (results) => {
        const error = chrome.runtime.lastError;

        if (error) {
          resolve({
            ok: false,
            error: error.message,
          });
          return;
        }

        resolve(
          results?.[0]?.result ?? {
            ok: false,
            error: "No page inspection result was returned.",
          },
        );
      },
    );
  });
}

async function getCurrentPageMatches(inspection, myAnimeList, options = {}) {
  if (
    myAnimeList?.connected !== true ||
    inspection?.isEpisodePage !== true ||
    !inspection?.sourceTitle
  ) {
    return {
      candidates: [],
    };
  }

  try {
    const candidates = await sendMessage(MESSAGE_TYPES.SEARCH_MY_ANIME_LIST, {
      query: inspection.sourceTitle,
      cacheOnly: options.cacheOnly === true,
      forceRefresh: options.forceRefresh === true,
    });

    return {
      candidates: Array.isArray(candidates) ? candidates : [],
    };
  } catch (error) {
    return {
      candidates: [],
      error: error.message,
    };
  }
}

function inspectCurrentPageForShiori() {
  const namespace = "__shioriVideoTracker";
  const trackerState = globalThis[namespace];
  const tracker = trackerState?.getDiagnostics
    ? trackerState.getDiagnostics()
    : null;
  const videos = Array.from(document.querySelectorAll("video"));
  const iframes = Array.from(document.querySelectorAll("iframe"));
  const titleCandidates = getTitleCandidates(videos[0]);
  const rawTitle = titleCandidates[0] ?? getBestTitle(videos[0]);
  const sourceTitle = normalizeSourceTitle(rawTitle);
  const episodeNumber = extractEpisodeNumber(...titleCandidates, location.href);
  const playerFrameOrigins = getLikelyPlayerFrameOrigins(iframes);
  const isEpisodePage = isLikelyEpisodePage({
    titleCandidates,
    sourceTitle,
    episodeNumber,
    videos,
  });

  return {
    ok: true,
    url: location.href,
    origin: location.origin,
    pageTitle: document.title,
    sourceTitle: isEpisodePage ? sourceTitle : null,
    episodeNumber: isEpisodePage ? episodeNumber : null,
    isEpisodePage,
    videoCount: videos.length,
    playableVideoCount: videos.filter(
      (video) => Number.isFinite(video.duration) && video.duration > 0,
    ).length,
    iframeCount: iframes.length,
    playerFrameOrigins,
    tracker,
  };

  function getBestTitle(video) {
    return getTitleCandidates(video)[0] ?? location.hostname;
  }

  function getTitleCandidates(video) {
    return [
      getText("h1"),
      document.title,
      getMetaContent('meta[name="anime_planet"]'),
      getText(".title"),
      getText("[data-title]"),
      video?.getAttribute("title"),
      video?.getAttribute("aria-label"),
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

  function isLikelyEpisodePage({
    titleCandidates,
    sourceTitle,
    episodeNumber,
    videos,
  }) {
    const joinedTitles = titleCandidates.join(" ");
    const episodeLikeTitle =
      /\bwatch\b.+\bonline\b/i.test(joinedTitles) ||
      /\b(?:episode|ep\.?)\s*\d{1,4}\b/i.test(joinedTitles);
    const episodeLikePath = /\/(?:play|watch|episode)\//i.test(location.pathname);
    const hasVideo =
      videos.some((video) => Number.isFinite(video.duration) && video.duration > 0) ||
      videos.length > 0;

    return Boolean(
      sourceTitle &&
        !isRejectedText(sourceTitle) &&
        (episodeNumber || episodeLikeTitle || episodeLikePath || hasVideo),
    );
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

  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  function getLikelyPlayerFrameOrigins(iframes) {
    const origins = [];
    const seenOrigins = new Set();

    for (const iframe of iframes) {
      const origin = getFrameOrigin(iframe);

      if (!origin || origin === location.origin || seenOrigins.has(origin)) {
        continue;
      }

      if (!isLikelyPlayerFrame(iframe)) {
        continue;
      }

      seenOrigins.add(origin);
      origins.push(origin);
    }

    return origins.slice(0, 4);
  }

  function isLikelyPlayerFrame(iframe) {
    const allow = iframe.getAttribute("allow") ?? "";
    const title = iframe.getAttribute("title") ?? "";
    const name = iframe.getAttribute("name") ?? "";
    const src = iframe.getAttribute("src") ?? "";
    const joinedText = `${allow} ${title} ${name} ${src}`;
    const rect = iframe.getBoundingClientRect();
    const largeFrame = rect.width >= 320 && rect.height >= 180;
    const grantsMedia =
      iframe.allowFullscreen ||
      /fullscreen|autoplay|encrypted-media|picture-in-picture/i.test(allow);
    const looksNamed =
      /player|video|stream|embed|watch|episode/i.test(joinedText);

    return (largeFrame && grantsMedia) || (largeFrame && looksNamed);
  }

  function getFrameOrigin(iframe) {
    const src = iframe.getAttribute("src");

    if (typeof src !== "string" || src.trim().length === 0) {
      return null;
    }

    try {
      const url = new URL(src.trim(), location.href);

      if (!["http:", "https:"].includes(url.protocol)) {
        return null;
      }

      return url.origin;
    } catch {
      return null;
    }
  }
}

function requestHostPermission(pattern) {
  return new Promise((resolve, reject) => {
    chrome.permissions.request(
      {
        origins: [pattern],
      },
      (granted) => {
        const error = chrome.runtime.lastError;

        if (error) {
          reject(new Error(error.message));
          return;
        }

        resolve(Boolean(granted));
      },
    );
  });
}

function removeHostPermission(pattern) {
  return new Promise((resolve) => {
    chrome.permissions.remove(
      {
        origins: [pattern],
      },
      () => {
        resolve(!chrome.runtime.lastError);
      },
    );
  });
}

function injectTrackerIntoActiveTab() {
  const tabId = popupState.activeTab?.id;

  if (!Number.isInteger(tabId)) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        files: [TRACKER_SCRIPT_FILE],
      },
      () => {
        const error = chrome.runtime.lastError;

        if (error) {
          reject(new Error(`Tracker injection failed: ${error.message}`));
          return;
        }

        resolve();
      },
    );
  });
}

function setLoading(isLoading) {
  elements.refreshButton.disabled = isLoading;
}

function setTrackingButtonDisabled(isDisabled) {
  elements.trackSiteButton.disabled = isDisabled;
}

function setMalButtonsDisabled(isDisabled) {
  elements.malConnectButton.disabled = isDisabled;
  elements.malDisconnectButton.disabled = isDisabled;
}

function setSettingsButtonsDisabled(isDisabled) {
  elements.saveSettingsButton.disabled = isDisabled;
  elements.resetSettingsButton.disabled = isDisabled;
}

function showStatus(message, tone) {
  elements.statusBanner.textContent = message;
  elements.statusBanner.dataset.tone = tone;
  elements.statusBanner.hidden = false;
}

function clearStatus() {
  elements.statusBanner.textContent = "";
  delete elements.statusBanner.dataset.tone;
  elements.statusBanner.hidden = true;
}

function toPercent(ratio) {
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) {
    return 0;
  }

  return Math.round(Math.min(Math.max(ratio, 0), 1) * 100);
}

function formatEpisode(episodeNumber) {
  return Number.isInteger(episodeNumber) ? String(episodeNumber) : "Unknown";
}

function formatCount(value) {
  return Number.isInteger(value) ? String(value) : "0";
}

function formatOriginList(origins) {
  if (!Array.isArray(origins) || origins.length === 0) {
    return "None";
  }

  return origins.map((origin) => getDisplayHost(origin)).join(", ");
}

function formatScore(score) {
  return typeof score === "number" ? `Score ${score}/10` : "No score";
}

function formatRawScore(score) {
  return typeof score === "number" ? `${score}/10` : "None";
}

function createSyncPayloadText(state) {
  const myAnimeList = state.syncPlan?.payload?.myAnimeList;

  if (!myAnimeList) {
    return "Choose the correct MAL result to sync this entry.";
  }

  return `MAL status: ${formatListStatus(
    myAnimeList.status,
  )}. Watched episodes: ${formatNullableEpisode(
    myAnimeList.num_watched_episodes,
  )}.`;
}

function createMyAnimeListMeta(candidate) {
  const status = formatListStatus(candidate.myListStatus?.status);
  const watched = Number.isInteger(candidate.myListStatus?.numEpisodesWatched)
    ? candidate.myListStatus.numEpisodesWatched
    : 0;
  const total = Number.isInteger(candidate.numEpisodes)
    ? candidate.numEpisodes
    : "?";
  const parts = [`${status}`, `${watched} / ${total} eps`];

  if (
    Number.isInteger(candidate.myListStatus?.score) &&
    candidate.myListStatus.score > 0
  ) {
    parts.push(`Score ${candidate.myListStatus.score}/10`);
  }

  if (Number.isInteger(candidate.matchConfidence)) {
    parts.push(`Match ${candidate.matchConfidence}`);
  }

  return parts.join(" | ");
}

function formatListStatus(status) {
  switch (status) {
    case "watching":
      return "Watching";

    case "completed":
      return "Completed";

    case "on_hold":
      return "On hold";

    case "dropped":
      return "Dropped";

    case "plan_to_watch":
      return "Plan to watch";

    default:
      return "Not in list";
  }
}

function formatNullableEpisode(value) {
  return Number.isInteger(value) && value > 0 ? String(value) : "pending";
}

function getUrlHost(value) {
  if (typeof value !== "string" || value.length === 0) {
    return "Unknown source";
  }

  try {
    return new URL(value).host.replace(/^www\./i, "");
  } catch {
    return "Unknown source";
  }
}

function parseOptionalScore(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed)) {
    return null;
  }

  return Math.min(Math.max(parsed, 0), 10);
}

function formatDuration(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return "--:--";
  }

  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;

  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function formatUpdatedAt(timestamp) {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return "unknown";
  }

  const deltaMs = Date.now() - timestamp;
  const deltaMinutes = Math.max(0, Math.floor(deltaMs / 60000));

  if (deltaMinutes < 1) {
    return "just now";
  }

  if (deltaMinutes < 60) {
    return `${deltaMinutes}m ago`;
  }

  const deltaHours = Math.floor(deltaMinutes / 60);

  if (deltaHours < 24) {
    return `${deltaHours}h ago`;
  }

  return `${Math.floor(deltaHours / 24)}d ago`;
}

function parseIntegerInput(value, fallback) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed)) {
    return fallback;
  }

  return parsed;
}
