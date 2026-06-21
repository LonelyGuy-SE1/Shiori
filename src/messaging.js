export async function sendMessage(type, payload = null) {
  const response = await chrome.runtime.sendMessage({
    type,
    payload,
  });

  if (!response) {
    throw new Error("No response received from Shiori background service.");
  }

  if (!response.ok) {
    throw createRemoteError(response.error);
  }

  return response.data;
}

function createRemoteError(errorPayload) {
  const error = new Error(
    errorPayload?.message ?? "Unknown Shiori background error.",
  );

  error.name = errorPayload?.name ?? "ShioriRemoteError";
  error.code = errorPayload?.code ?? "UNKNOWN_REMOTE_ERROR";
  error.details = errorPayload?.details ?? null;

  return error;
}

export const MESSAGE_TYPES = Object.freeze({
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
