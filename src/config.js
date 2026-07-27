'use strict';

/**
 * Per-install settings.
 *
 * Nuvio (like Stremio) stores one manifest URL per install, so anything the
 * user chooses on the configure page has to travel inside that URL. The
 * configure page base64url-encodes a small JSON object and drops it into the
 * path: https://host/<config>/manifest.json
 */

const DEFAULTS = {
  // AniList username. Public lists need no password or token — this alone
  // powers Continue Watching, New Episode Available and Recommended For You.
  anilistUser: '',
  // Optional AniList access token, only needed if the list is set to private.
  anilistToken: '',
  // Optional TMDB v3 key. Used to fill gaps the offline mapping misses.
  tmdbApiKey: '',
  // romaji | english | native
  titleLanguage: 'romaji',
  // Show adult titles in catalogues.
  includeAdult: false,
  // Hide entries that have no TMDB or IMDb match, because Nuvio's local
  // scrapers key off those IDs and unmapped entries would play nothing.
  hideUnmapped: true,
  // Catalogue rows to expose, in display order. Empty means "all".
  enabledCatalogs: [],
  // Hours counted as "recently aired".
  recentWindowHours: 168,
  // Rows per catalogue page.
  pageSize: 40,
};

function b64urlEncode(str) {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function fromEnv() {
  return {
    anilistUser: process.env.ANILIST_USER || DEFAULTS.anilistUser,
    anilistToken: process.env.ANILIST_TOKEN || DEFAULTS.anilistToken,
    tmdbApiKey: process.env.TMDB_API_KEY || DEFAULTS.tmdbApiKey,
    titleLanguage: process.env.TITLE_LANGUAGE || DEFAULTS.titleLanguage,
    includeAdult: process.env.INCLUDE_ADULT === 'true',
    hideUnmapped: process.env.HIDE_UNMAPPED !== 'false',
  };
}

/** Turn the path segment into a settings object. Bad input falls back to defaults. */
function parse(segment) {
  const base = { ...DEFAULTS, ...fromEnv() };
  if (!segment) return normalise(base);
  try {
    const raw = JSON.parse(b64urlDecode(decodeURIComponent(segment)));
    return normalise({ ...base, ...raw });
  } catch (err) {
    return normalise(base);
  }
}

function normalise(cfg) {
  const out = { ...cfg };
  out.anilistUser = String(out.anilistUser || '').trim();
  out.anilistToken = String(out.anilistToken || '').trim();
  out.tmdbApiKey = String(out.tmdbApiKey || '').trim();
  if (!['romaji', 'english', 'native'].includes(out.titleLanguage)) out.titleLanguage = 'romaji';
  out.includeAdult = out.includeAdult === true;
  out.hideUnmapped = out.hideUnmapped !== false;
  out.enabledCatalogs = Array.isArray(out.enabledCatalogs) ? out.enabledCatalogs : [];
  out.recentWindowHours = clamp(Number(out.recentWindowHours) || DEFAULTS.recentWindowHours, 1, 720);
  out.pageSize = clamp(Number(out.pageSize) || DEFAULTS.pageSize, 10, 50);
  out.hasUser = Boolean(out.anilistUser || out.anilistToken);
  return out;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/** Encode a settings object back into a path segment. */
function encode(cfg) {
  const slim = {};
  for (const [key, value] of Object.entries(cfg)) {
    if (key === 'hasUser') continue;
    if (JSON.stringify(value) === JSON.stringify(DEFAULTS[key])) continue;
    slim[key] = value;
  }
  return b64urlEncode(JSON.stringify(slim));
}

/** Config segments never contain a dot; that is how routes tell them apart from filenames. */
function looksLikeConfig(segment) {
  return typeof segment === 'string' && segment.length > 0 && !segment.includes('.');
}

module.exports = { DEFAULTS, parse, encode, looksLikeConfig, b64urlEncode, b64urlDecode };
