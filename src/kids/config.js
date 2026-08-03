'use strict';

/**
 * The four brands this addon builds catalogues for.
 *
 * `networkId` is TMDB's *TV network* id — used for /discover/tv. TMDB has no
 * search-by-name endpoint for networks, so these were looked up by hand
 * against the canonical network page on themoviedb.org and are considered
 * verified as of the addon's build date. If TMDB ever renumbers a network,
 * override it with the matching TMDB_NETWORK_ID_* env var rather than
 * editing this file.
 *
 * `companyQuery` is used against TMDB's /search/company endpoint (which does
 * exist) to find a production company id for /discover/movie, since movies
 * aren't attached to TV networks on TMDB. Preschool brands don't produce
 * many theatrical films, so movie catalogues will often be thin — that's a
 * property of the data, not a bug here. Override with TMDB_COMPANY_ID_* if
 * the auto-search picks the wrong company.
 */
const BRANDS = [
  {
    id: 'pbskids',
    name: 'PBS Kids',
    networkId: 122,
    companyQuery: 'PBS Kids',
    originCountries: ['US'],
    envNetworkId: 'TMDB_NETWORK_ID_PBSKIDS',
    envCompanyId: 'TMDB_COMPANY_ID_PBSKIDS'
  },
  {
    id: 'disneyjr',
    name: 'Disney Junior',
    networkId: 281,
    companyQuery: 'Disney Junior',
    originCountries: ['US'],
    envNetworkId: 'TMDB_NETWORK_ID_DISNEYJR',
    envCompanyId: 'TMDB_COMPANY_ID_DISNEYJR'
  },
  {
    id: 'nickjr',
    name: 'Nick Jr.',
    networkId: 35,
    companyQuery: 'Nick Jr.',
    originCountries: ['US'],
    envNetworkId: 'TMDB_NETWORK_ID_NICKJR',
    envCompanyId: 'TMDB_COMPANY_ID_NICKJR'
  },
  {
    id: 'cbeebies',
    name: 'CBeebies',
    networkId: 166,
    companyQuery: 'CBeebies',
    originCountries: ['GB'],
    envNetworkId: 'TMDB_NETWORK_ID_CBEEBIES',
    envCompanyId: 'TMDB_COMPANY_ID_CBEEBIES'
  }
];

// Countries whose native TV/film language is English. A show/movie must
// either be tagged original_language=en or originate from one of these to
// pass the English-only filter (see src/tmdb.js:isEnglishOrigin).
const ENGLISH_ORIGIN_COUNTRIES = ['US', 'GB', 'CA', 'AU', 'IE', 'NZ'];

module.exports = { BRANDS, ENGLISH_ORIGIN_COUNTRIES };
