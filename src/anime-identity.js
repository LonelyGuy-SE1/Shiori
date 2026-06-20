const MEDIA_EXTENSION_PATTERN = /\.(mkv|mp4|webm|avi|mov|m4v)(?:$|[?#])/i;
const QUALITY_PATTERN =
  /\b(?:2160p|1440p|1080p|720p|540p|480p|360p|10bit|8bit|x264|x265|h264|h265|hevc|av1|aac|flac|web[-\s]?dl|webrip|bluray|blu[-\s]?ray|bd|hdr|sdr)\b/gi;
const RELEASE_TAG_PATTERN =
  /\b(?:animepahe|subsplease|erai[-\s]?raws|horriblesubs|judas|ember|asw|yameii|vostfr|multi[-\s]?sub|dual[-\s]?audio)\b/gi;
const GENERIC_TITLE_PATTERN =
  /\b(?:anime website|watch anime|stream anime|free anime|kwik|player|video player|embed|loading)\b/i;
const ERROR_TITLE_PATTERN =
  /\b(?:an[\W_]+error[\W_]+occurred|method[\W_]+not[\W_]+allowed|not[\W_]+found|forbidden|access[\W_]+denied|bad[\W_]+gateway|service[\W_]+unavailable|server[\W_]+returned|cloudflare|captcha|just[\W_]+a[\W_]+moment)\b/i;
const LOW_VALUE_TITLE_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "by",
  "cour",
  "episode",
  "ep",
  "for",
  "from",
  "in",
  "movie",
  "of",
  "on",
  "online",
  "or",
  "ova",
  "part",
  "season",
  "special",
  "the",
  "to",
  "tv",
  "when",
  "with",
]);

export function parseAnimeIdentity(...values) {
  const candidates = values
    .flatMap((value) => normalizeCandidateInputs(value))
    .map(parseCandidate)
    .filter((candidate) => candidate.title);

  if (candidates.length === 0) {
    return {
      title: null,
      episodeNumber: null,
      confidence: 0,
      rawTitle: null,
      reliable: false,
    };
  }

  const bestCandidate = candidates.sort((left, right) => {
    if (right.confidence !== left.confidence) {
      return right.confidence - left.confidence;
    }

    return right.title.length - left.title.length;
  })[0];

  return {
    title: bestCandidate.title,
    episodeNumber: bestCandidate.episodeNumber,
    confidence: bestCandidate.confidence,
    rawTitle: bestCandidate.rawTitle,
    reliable: bestCandidate.confidence >= 40,
  };
}

export function createAnimeSearchQueries(...values) {
  const identity = parseAnimeIdentity(...values);

  if (!identity.reliable || !identity.title) {
    return [];
  }

  const queries = [
    identity.title,
    stripTrailingSeasonWords(identity.title),
    stripTrailingPartWords(identity.title),
  ];

  return [...new Set(queries.map(normalizeSearchQuery).filter(Boolean))].slice(
    0,
    3,
  );
}

export function isReliableAnimeTitle(value) {
  return parseAnimeIdentity(value).reliable;
}

export function isInvalidAnimeTitle(value) {
  if (typeof value !== "string" || cleanWhitespace(value).length < 2) {
    return true;
  }

  return isRejectedTitle(cleanWhitespace(value));
}

export function normalizeSearchQuery(value) {
  const query = cleanWhitespace(value)
    .replace(QUALITY_PATTERN, " ")
    .replace(RELEASE_TAG_PATTERN, " ");
  const cleaned = cleanWhitespace(query);

  if (cleaned.length < 2 || isRejectedTitle(cleaned)) {
    return null;
  }

  return cleaned.slice(0, 120);
}

export function normalizeTitleKey(title) {
  return cleanWhitespace(title)
    .toLowerCase()
    .replace(/\b(\d+)(?:st|nd|rd|th)\b/g, "$1")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function scoreAnimeTitleMatch(query, candidateTitles) {
  const queryKey = normalizeTitleKey(normalizeSearchQuery(query) ?? query);

  if (!queryKey || isRejectedTitle(queryKey)) {
    return 0;
  }

  return normalizeCandidateInputs(candidateTitles).reduce((bestScore, title) => {
    const titleKey = normalizeTitleKey(title);

    if (!titleKey || isRejectedTitle(titleKey)) {
      return bestScore;
    }

    return Math.max(bestScore, scoreTitleKeyPair(queryKey, titleKey));
  }, 0);
}

function parseCandidate(value) {
  const rawTitle = cleanWhitespace(value);
  const decodedValue = safeDecode(rawTitle);
  const source = getMostUsefulSourceText(decodedValue);
  const episodeNumber = extractEpisodeNumber(source);
  const titleSource = stripEpisodeSuffix(source, episodeNumber);
  const title = normalizeAnimeTitle(titleSource);
  const confidence = scoreCandidate({
    rawTitle,
    source,
    title,
    episodeNumber,
  });

  return {
    title,
    episodeNumber,
    confidence,
    rawTitle,
  };
}

function normalizeCandidateInputs(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeCandidateInputs(item));
  }

  if (typeof value !== "string") {
    return [];
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return [];
  }

  return [trimmed];
}

function getMostUsefulSourceText(value) {
  const withoutQuery = value.split(/[?#]/, 1)[0];

  try {
    const url = new URL(value);

    if (!["http:", "https:"].includes(url.protocol)) {
      return safeDecode(withoutQuery);
    }

    const segment = url.pathname.split("/").filter(Boolean).at(-1);

    if (segment) {
      return safeDecode(segment);
    }
  } catch {
  }

  return safeDecode(withoutQuery);
}

function stripEpisodeSuffix(value, episodeNumber) {
  const withoutExtension = value
    .replace(MEDIA_EXTENSION_PATTERN, "")
    .replace(/\s+::\s+animepahe.*$/i, "")
    .replace(/\s+\|\s+animepahe.*$/i, "");

  if (!episodeNumber) {
    return withoutExtension;
  }

  const escapedEpisode = String(episodeNumber).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  const patterns = [
    new RegExp(
      `(?:^|[-_\\s.])(?:episode|ep)\\.?\\s*0*${escapedEpisode}(?=$|[-_\\s.])`,
      "i",
    ),
    new RegExp(`(?:^|[-_\\s.])s\\d{1,2}e0*${escapedEpisode}(?=$|[-_\\s.])`, "i"),
    new RegExp(
      `(?:[-_\\s.]+-[-_\\s.]+|[-_\\s.]+)0*${escapedEpisode}(?=[-_\\s.]*(?:online|\\d{3,4}p|subsplease|erai|web|bd|$))`,
      "i",
    ),
  ];

  for (const pattern of patterns) {
    const match = withoutExtension.match(pattern);

    if (match?.index !== undefined && match.index > 0) {
      return withoutExtension.slice(0, match.index);
    }
  }

  return withoutExtension;
}

function normalizeAnimeTitle(value) {
  const title = safeDecode(value)
    .replace(MEDIA_EXTENSION_PATTERN, "")
    .replace(/\s+::\s+animepahe.*$/i, "")
    .replace(/\s+\|\s+animepahe.*$/i, "")
    .replace(/^watch\s+/i, "")
    .replace(/\s+online\b/gi, " ")
    .replace(/\[[^\]]*]/g, " ")
    .replace(/\([^)]*(?:\d{3,4}p|x264|x265|hevc|aac|av1)[^)]*\)/gi, " ")
    .replace(/[._]+/g, " ")
    .replace(/\s*-\s*/g, " ")
    .replace(RELEASE_TAG_PATTERN, " ")
    .replace(QUALITY_PATTERN, " ")
    .replace(/\b[a-f0-9]{8,}\b/gi, " ")
    .replace(/\b(?:mp4|mkv|webm)\b/gi, " ");

  return cleanWhitespace(title);
}

function extractEpisodeNumber(value) {
  const normalizedValue = safeDecode(value).replace(MEDIA_EXTENSION_PATTERN, "");
  const patterns = [
    /(?:^|[^\p{L}\p{N}])(?:episode|ep)\.?\s*0*(\d{1,4})(?=$|[^\p{L}\p{N}])/iu,
    /(?:^|[^\p{L}\p{N}])s\d{1,2}e0*(\d{1,4})(?=$|[^\p{L}\p{N}])/iu,
    /(?:[-_\s.]+-[-_\s.]+|[-_\s.]+)0*(\d{1,4})(?=[-_\s.]*(?:online|\d{3,4}p|subsplease|erai|web|bd|$))/i,
  ];

  for (const pattern of patterns) {
    const match = normalizedValue.match(pattern);
    const parsed = Number.parseInt(match?.[1] ?? "", 10);

    if (match && isSequenceNumberMatch(normalizedValue, match)) {
      continue;
    }

    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

function isSequenceNumberMatch(value, match) {
  const matchedNumber = match[1];

  if (!matchedNumber || match.index === undefined) {
    return false;
  }

  const numberOffset = match[0].lastIndexOf(matchedNumber);
  const numberIndex = match.index + Math.max(numberOffset, 0);
  const beforeNumber = value.slice(0, numberIndex);

  return /\b(?:season|part|cour)\s*$/i.test(beforeNumber);
}

function scoreCandidate({ rawTitle, source, title, episodeNumber }) {
  if (!title || title.length < 2 || isRejectedTitle(title)) {
    return 0;
  }

  let score = 10;

  if (MEDIA_EXTENSION_PATTERN.test(rawTitle) || MEDIA_EXTENSION_PATTERN.test(source)) {
    score += 18;
  }

  if (episodeNumber) {
    score += 20;
  }

  if (/^watch\s+/i.test(rawTitle) || /\bep\.?\s*\d{1,4}\b/i.test(rawTitle)) {
    score += 25;
  }

  if (/\s+::\s+animepahe\b/i.test(rawTitle) || /\s+online\b/i.test(rawTitle)) {
    score += 15;
  }

  if (!isRejectedTitle(title)) {
    score += 20;
  }

  if (/[a-z]/i.test(title) && title.split(/\s+/).length >= 2) {
    score += 10;
  }

  if (isRejectedTitle(rawTitle)) {
    score -= 35;
  }

  if (/^https?:\/\//i.test(rawTitle)) {
    score -= 5;
  }

  return Math.max(0, score);
}

function scoreTitleKeyPair(queryKey, titleKey) {
  if (queryKey === titleKey) {
    return 100;
  }

  if (compactTitleKey(queryKey) === compactTitleKey(titleKey)) {
    return applySequenceScoreCap(98, queryKey, titleKey);
  }

  const queryBase = stripTrailingSeasonWords(stripTrailingPartWords(queryKey));
  const titleBase = stripTrailingSeasonWords(stripTrailingPartWords(titleKey));

  if (queryBase && titleBase && queryBase === titleBase) {
    return applySequenceScoreCap(96, queryKey, titleKey);
  }

  if (titleKey.includes(queryKey) || queryKey.includes(titleKey)) {
    const shorter = Math.min(queryKey.length, titleKey.length);
    const longer = Math.max(queryKey.length, titleKey.length);
    return applySequenceScoreCap(
      Math.round(80 + (shorter / longer) * 12),
      queryKey,
      titleKey,
    );
  }

  const queryWords = getMeaningfulTitleWords(queryKey);
  const titleWords = getMeaningfulTitleWords(titleKey);

  if (queryWords.length === 0 || titleWords.length === 0) {
    return 0;
  }

  const titleWordSet = new Set(titleWords);
  const sharedWords = queryWords.filter((word) => titleWordSet.has(word));

  if (sharedWords.length === 0) {
    return 0;
  }

  const recall = sharedWords.length / queryWords.length;
  const precision = sharedWords.length / titleWords.length;
  const harmonic =
    precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const importantWordBonus = hasSharedDistinctiveWord(sharedWords, queryWords)
    ? 8
    : 0;

  return applySequenceScoreCap(
    Math.round(harmonic * 82 + importantWordBonus),
    queryKey,
    titleKey,
  );
}

function applySequenceScoreCap(score, queryKey, titleKey) {
  const querySequence = getTitleSequence(queryKey);
  const titleSequence = getTitleSequence(titleKey);

  if (!querySequence && !titleSequence) {
    return score;
  }

  if (querySequence && titleSequence) {
    if (querySequence.value === titleSequence.value) {
      return Math.min(100, score + 4);
    }

    return Math.min(score, 55);
  }

  if (querySequence && !titleSequence) {
    return Math.min(score, 70);
  }

  return Math.min(score, 76);
}

function getTitleSequence(value) {
  const key = normalizeTitleKey(value);
  const explicitMatch = key.match(
    /\b(?:season|part|cour)\s*([2-9])\b|\b([2-9])(?:nd|rd|th)?\s*(?:season|part|cour)\b/,
  );

  if (explicitMatch) {
    return {
      value: Number.parseInt(explicitMatch[1] ?? explicitMatch[2], 10),
    };
  }

  const trailingMatch = key.match(/\b([2-9]|ii|iii|iv|v)$/i);

  if (!trailingMatch) {
    return null;
  }

  return {
    value: parseSequenceValue(trailingMatch[1]),
  };
}

function parseSequenceValue(value) {
  switch (String(value).toLowerCase()) {
    case "ii":
      return 2;

    case "iii":
      return 3;

    case "iv":
      return 4;

    case "v":
      return 5;

    default:
      return Number.parseInt(value, 10);
  }
}

function getMeaningfulTitleWords(value) {
  return normalizeTitleKey(value)
    .split(/\s+/)
    .filter(
      (word) =>
        word.length > 1 &&
        (!LOW_VALUE_TITLE_WORDS.has(word) || /^\d+$/.test(word)),
    );
}

function hasSharedDistinctiveWord(sharedWords, queryWords) {
  const distinctiveWords = queryWords.filter(
    (word) => word.length >= 5 && !LOW_VALUE_TITLE_WORDS.has(word),
  );

  return sharedWords.some((word) => distinctiveWords.includes(word));
}

function compactTitleKey(value) {
  return value.replace(/\s+/g, "");
}

function isRejectedTitle(value) {
  return GENERIC_TITLE_PATTERN.test(value) || ERROR_TITLE_PATTERN.test(value);
}

function stripTrailingSeasonWords(value) {
  return cleanWhitespace(
    value.replace(/\b(?:season|part|cour)\s+\d{1,2}\b/gi, ""),
  );
}

function stripTrailingPartWords(value) {
  return cleanWhitespace(value.replace(/\b(?:ii|iii|iv|v|2nd|3rd|4th)\b$/i, ""));
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function cleanWhitespace(value) {
  return String(value ?? "")
    .replace(/\+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
