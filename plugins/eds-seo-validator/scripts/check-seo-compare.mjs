#!/usr/bin/env node
/**
 * EDS SEO Migration Comparator
 * Usage: node check-seo-compare.js <sitemap-json> <prod-base-url> <eds-base-url> <output-csv>
 *        [--auth-eds=user:pass] [--auth-prod=user:pass]
 *
 * For each URL in the sitemap JSON, fetches both the production page and the
 * equivalent EDS page in parallel, extracts all SEO metadata from both, and
 * produces a side-by-side diff CSV that surfaces migration gaps.
 *
 * Fields compared:
 *   title, description, keywords, canonical,
 *   og:title, og:description, og:image, og:url, og:type, og:site_name,
 *   twitter:card, twitter:title, twitter:description, twitter:image, twitter:site,
 *   robots meta, h1 (extracted via regex)
 *
 * Per-field diff values:
 *   MATCH            — identical (normalised whitespace)
 *   DIFFERENT        — both present but values differ
 *   MISSING_ON_EDS   — prod has value, EDS does not
 *   MISSING_ON_PROD  — EDS has value, prod does not
 *   BOTH_MISSING     — neither side has the value
 *
 * Migration status per page:
 *   NOT_MIGRATED     — EDS returned non-200
 *   PROD_NOT_FOUND   — prod returned non-200 (skip comparison)
 *   FULLY_MATCHED    — all compared fields match
 *   HAS_GAPS         — page is live on EDS but ≥1 field differs or is missing
 *
 * Requires Node.js 18+ (native fetch).
 */

import { readFileSync, writeFileSync } from 'fs';
import { URL } from 'url';

const [,, sitemapJsonFile, prodBaseUrl, edsBaseUrl, outputCsvFile, ...flags] = process.argv;

if (!sitemapJsonFile || !prodBaseUrl || !edsBaseUrl || !outputCsvFile) {
  console.error(
    'Usage: node check-seo-compare.js <sitemap-json> <prod-base-url> <eds-base-url> <output-csv>\n' +
    '       [--auth-eds=user:pass] [--auth-prod=user:pass]\n' +
    '       [--auth-header-eds="token ..."] [--auth-header-prod="token ..."]  (or env EDS_AUTH / PROD_AUTH)'
  );
  process.exit(1);
}

const urls       = JSON.parse(readFileSync(sitemapJsonFile, 'utf8'));
const prodBase   = prodBaseUrl.replace(/\/$/, '');
const edsBase    = edsBaseUrl.replace(/\/$/, '');

const authEdsFlag  = flags.find(f => f.startsWith('--auth-eds='))?.slice(11)  || '';
const authProdFlag = flags.find(f => f.startsWith('--auth-prod='))?.slice(12) || '';
// Raw Authorization header (EDS/AEM sidekick "token ..." / "Bearer ..." tokens);
// flag first, then env var. Takes precedence over Basic user:pass.
const rawAuthEds   = flags.find(f => f.startsWith('--auth-header-eds='))?.slice('--auth-header-eds='.length)
  || process.env.EDS_AUTH || '';
const rawAuthProd  = flags.find(f => f.startsWith('--auth-header-prod='))?.slice('--auth-header-prod='.length)
  || process.env.PROD_AUTH || '';

// Build request headers: raw token header if given, else Basic from user:pass.
const makeAuthHeader = (cred, rawHeader) =>
  rawHeader ? { Authorization: rawHeader }
    : cred ? { Authorization: 'Basic ' + Buffer.from(cred).toString('base64') }
      : {};

const authEdsHeaders  = makeAuthHeader(authEdsFlag,  rawAuthEds);
const authProdHeaders = makeAuthHeader(authProdFlag, rawAuthProd);

const CONCURRENCY = 5;
const TIMEOUT_MS  = 20000;

// ─── Fields that are side-by-side compared ────────────────────────────────────
const COMPARE_FIELDS = [
  'title', 'description', 'keywords', 'canonical',
  'ogTitle', 'ogDescription', 'ogImage', 'ogUrl', 'ogType', 'ogSiteName',
  'twitterCard', 'twitterTitle', 'twitterDescription', 'twitterImage', 'twitterSite',
  'robotsMeta', 'h1',
];

// Human-readable label for each field (used in gap summary)
const FIELD_LABEL = {
  title:              'title',
  description:        'meta description',
  keywords:           'keywords',
  canonical:          'canonical',
  ogTitle:            'og:title',
  ogDescription:      'og:description',
  ogImage:            'og:image',
  ogUrl:              'og:url',
  ogType:             'og:type',
  ogSiteName:         'og:site_name',
  twitterCard:        'twitter:card',
  twitterTitle:       'twitter:title',
  twitterDescription: 'twitter:description',
  twitterImage:       'twitter:image',
  twitterSite:        'twitter:site',
  robotsMeta:         'robots meta',
  h1:                 'h1',
};

// Fields where a difference is a critical SEO gap (vs informational)
const CRITICAL_FIELDS = new Set([
  'title', 'description', 'canonical', 'ogTitle', 'ogDescription', 'ogImage', 'h1',
]);

// ─── HTML extractor (regex — no dependencies) ─────────────────────────────────
function extractMeta(html) {
  const metaContent = (nameOrProp, attr = 'name') => {
    const re  = new RegExp(`<meta[^>]+${attr}=["']${nameOrProp}["'][^>]*content=["']([^"']*?)["']`, 'i');
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*?)["'][^>]*${attr}=["']${nameOrProp}["']`, 'i');
    return (html.match(re) || html.match(re2) || [])[1]?.trim() || '';
  };

  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '')
    .replace(/\s+/g, ' ').trim();

  const canonical = (html.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)
    || html.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["']canonical["']/i)
    || [])[1]?.trim() || '';

  // H1 — first one only
  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '')
    .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

  return {
    title,
    description:        metaContent('description'),
    keywords:           metaContent('keywords'),
    canonical,
    ogTitle:            metaContent('og:title',            'property'),
    ogDescription:      metaContent('og:description',      'property'),
    ogImage:            metaContent('og:image',            'property'),
    ogUrl:              metaContent('og:url',              'property'),
    ogType:             metaContent('og:type',             'property'),
    ogSiteName:         metaContent('og:site_name',        'property'),
    twitterCard:        metaContent('twitter:card',        'name') || metaContent('twitter:card',        'property'),
    twitterTitle:       metaContent('twitter:title',       'name') || metaContent('twitter:title',       'property'),
    twitterDescription: metaContent('twitter:description', 'name') || metaContent('twitter:description', 'property'),
    twitterImage:       metaContent('twitter:image',       'name') || metaContent('twitter:image',       'property'),
    twitterSite:        metaContent('twitter:site',        'name') || metaContent('twitter:site',        'property'),
    robotsMeta:         metaContent('robots'),
    h1,
  };
}

// ─── Normalise before comparison (trim + collapse whitespace + lowercase URLs) ─
function normalise(value, isUrl = false) {
  const v = (value || '').replace(/\s+/g, ' ').trim();
  if (isUrl) {
    try { return new URL(v).pathname + new URL(v).search; } catch { return v.toLowerCase(); }
  }
  return v;
}

const URL_FIELDS = new Set(['canonical', 'ogUrl', 'ogImage', 'twitterImage']);

// ─── Diff one field ───────────────────────────────────────────────────────────
function diffField(field, prodVal, edsVal) {
  const isUrl = URL_FIELDS.has(field);
  const p = normalise(prodVal, isUrl);
  const e = normalise(edsVal, isUrl);

  if (!p && !e) return 'BOTH_MISSING';
  if (p && !e)  return 'MISSING_ON_EDS';
  if (!p && e)  return 'MISSING_ON_PROD';
  return p === e ? 'MATCH' : 'DIFFERENT';
}

// ─── HTTP fetch helper ────────────────────────────────────────────────────────
async function fetchHtml(url, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'EDS-SEO-Comparator/1.0', ...extraHeaders },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { status: res.status, html: '' };
    return { status: res.status, html: await res.text() };
  } catch (err) {
    clearTimeout(timer);
    return { status: err.name === 'AbortError' ? 'TIMEOUT' : 'ERROR', html: '' };
  }
}

// ─── Process one URL ──────────────────────────────────────────────────────────
async function processUrl(originalUrl) {
  let path;
  try {
    const parsed = new URL(originalUrl);
    path = parsed.pathname.replace(/\/$/, '') + (parsed.search || '');
  } catch {
    return makeErrorRow(originalUrl, '', '', 'INVALID_URL', 'INVALID_URL', 'Invalid URL in sitemap');
  }

  const prodUrl = `${prodBase}${path}`;
  const edsUrl  = `${edsBase}${path}`;

  // Fetch both in parallel
  const [prod, eds] = await Promise.all([
    fetchHtml(prodUrl, authProdHeaders),
    fetchHtml(edsUrl,  authEdsHeaders),
  ]);

  const prodMeta = prod.html ? extractMeta(prod.html) : null;
  const edsMeta  = eds.html  ? extractMeta(eds.html)  : null;

  // Determine migration status
  let migrationStatus;
  if (eds.status !== 200 && prod.status !== 200) {
    migrationStatus = 'BOTH_NOT_FOUND';
  } else if (eds.status !== 200) {
    migrationStatus = 'NOT_MIGRATED';
  } else if (prod.status !== 200) {
    migrationStatus = 'PROD_NOT_FOUND';
  } else {
    migrationStatus = 'CHECK_PENDING'; // resolved after diffs
  }

  // Build diff for each field
  const diffs = {};
  const gaps  = [];
  const criticalGaps = [];

  if (migrationStatus === 'CHECK_PENDING') {
    for (const field of COMPARE_FIELDS) {
      const result = diffField(field, prodMeta[field], edsMeta[field]);
      diffs[field] = result;
      if (result !== 'MATCH' && result !== 'BOTH_MISSING' && result !== 'MISSING_ON_PROD') {
        gaps.push(FIELD_LABEL[field]);
        if (CRITICAL_FIELDS.has(field)) criticalGaps.push(FIELD_LABEL[field]);
      }
    }
    migrationStatus = gaps.length === 0 ? 'FULLY_MATCHED' : 'HAS_GAPS';
  } else {
    for (const field of COMPARE_FIELDS) diffs[field] = migrationStatus === 'NOT_MIGRATED' ? 'NOT_MIGRATED' : 'PROD_404';
  }

  return {
    original_url:    originalUrl,
    prod_url:        prodUrl,
    eds_url:         edsUrl,
    prod_status:     prod.status,
    eds_status:      eds.status,
    migration_status: migrationStatus,
    gaps_count:      gaps.length,
    critical_gaps_count: criticalGaps.length,
    gaps:            gaps.join(' | '),
    critical_gaps:   criticalGaps.join(' | '),
    // prod values
    prod_title:              prodMeta?.title              ?? '',
    prod_description:        prodMeta?.description        ?? '',
    prod_keywords:           prodMeta?.keywords           ?? '',
    prod_canonical:          prodMeta?.canonical          ?? '',
    prod_h1:                 prodMeta?.h1                 ?? '',
    prod_og_title:           prodMeta?.ogTitle            ?? '',
    prod_og_description:     prodMeta?.ogDescription      ?? '',
    prod_og_image:           prodMeta?.ogImage            ?? '',
    prod_og_url:             prodMeta?.ogUrl              ?? '',
    prod_og_type:            prodMeta?.ogType             ?? '',
    prod_og_site_name:       prodMeta?.ogSiteName         ?? '',
    prod_twitter_card:       prodMeta?.twitterCard        ?? '',
    prod_twitter_title:      prodMeta?.twitterTitle       ?? '',
    prod_twitter_description:prodMeta?.twitterDescription ?? '',
    prod_twitter_image:      prodMeta?.twitterImage       ?? '',
    prod_twitter_site:       prodMeta?.twitterSite        ?? '',
    prod_robots_meta:        prodMeta?.robotsMeta         ?? '',
    // EDS values
    eds_title:               edsMeta?.title              ?? '',
    eds_description:         edsMeta?.description        ?? '',
    eds_keywords:            edsMeta?.keywords           ?? '',
    eds_canonical:           edsMeta?.canonical          ?? '',
    eds_h1:                  edsMeta?.h1                 ?? '',
    eds_og_title:            edsMeta?.ogTitle            ?? '',
    eds_og_description:      edsMeta?.ogDescription      ?? '',
    eds_og_image:            edsMeta?.ogImage            ?? '',
    eds_og_url:              edsMeta?.ogUrl              ?? '',
    eds_og_type:             edsMeta?.ogType             ?? '',
    eds_og_site_name:        edsMeta?.ogSiteName         ?? '',
    eds_twitter_card:        edsMeta?.twitterCard        ?? '',
    eds_twitter_title:       edsMeta?.twitterTitle       ?? '',
    eds_twitter_description: edsMeta?.twitterDescription ?? '',
    eds_twitter_image:       edsMeta?.twitterImage       ?? '',
    eds_twitter_site:        edsMeta?.twitterSite        ?? '',
    eds_robots_meta:         edsMeta?.robotsMeta         ?? '',
    // diff columns
    diff_title:              diffs.title              ?? '',
    diff_description:        diffs.description        ?? '',
    diff_keywords:           diffs.keywords           ?? '',
    diff_canonical:          diffs.canonical          ?? '',
    diff_h1:                 diffs.h1                 ?? '',
    diff_og_title:           diffs.ogTitle            ?? '',
    diff_og_description:     diffs.ogDescription      ?? '',
    diff_og_image:           diffs.ogImage            ?? '',
    diff_og_url:             diffs.ogUrl              ?? '',
    diff_og_type:            diffs.ogType             ?? '',
    diff_og_site_name:       diffs.ogSiteName         ?? '',
    diff_twitter_card:       diffs.twitterCard        ?? '',
    diff_twitter_title:      diffs.twitterTitle       ?? '',
    diff_twitter_description:diffs.twitterDescription ?? '',
    diff_twitter_image:      diffs.twitterImage       ?? '',
    diff_twitter_site:       diffs.twitterSite        ?? '',
    diff_robots_meta:        diffs.robotsMeta         ?? '',
  };
}

function makeErrorRow(originalUrl, prodUrl, edsUrl, prodStatus, edsStatus, note) {
  const row = {
    original_url: originalUrl, prod_url: prodUrl, eds_url: edsUrl,
    prod_status: prodStatus, eds_status: edsStatus,
    migration_status: 'ERROR', gaps_count: 0, critical_gaps_count: 0,
    gaps: note, critical_gaps: '',
  };
  for (const f of COMPARE_FIELDS) { row[`prod_${f}`] = ''; row[`eds_${f}`] = ''; row[`diff_${f}`] = ''; }
  return row;
}

// ─── Concurrency runner ───────────────────────────────────────────────────────
async function runWithConcurrency(items, fn, concurrency) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
      process.stderr.write(`\r  Comparing: ${idx + 1}/${items.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  process.stderr.write('\n');
  return results;
}

// ─── CSV helpers ──────────────────────────────────────────────────────────────
function csvCell(v) { return `"${String(v ?? '').replace(/"/g, '""')}"`; }

// ─── CSV columns ──────────────────────────────────────────────────────────────
const CSV_COLUMNS = [
  // Status
  'original_url', 'prod_url', 'eds_url',
  'prod_status', 'eds_status', 'migration_status',
  'gaps_count', 'critical_gaps_count', 'gaps', 'critical_gaps',
  // Prod values
  'prod_title', 'prod_description', 'prod_keywords', 'prod_canonical', 'prod_h1',
  'prod_og_title', 'prod_og_description', 'prod_og_image', 'prod_og_url',
  'prod_og_type', 'prod_og_site_name',
  'prod_twitter_card', 'prod_twitter_title', 'prod_twitter_description',
  'prod_twitter_image', 'prod_twitter_site', 'prod_robots_meta',
  // EDS values
  'eds_title', 'eds_description', 'eds_keywords', 'eds_canonical', 'eds_h1',
  'eds_og_title', 'eds_og_description', 'eds_og_image', 'eds_og_url',
  'eds_og_type', 'eds_og_site_name',
  'eds_twitter_card', 'eds_twitter_title', 'eds_twitter_description',
  'eds_twitter_image', 'eds_twitter_site', 'eds_robots_meta',
  // Diff
  'diff_title', 'diff_description', 'diff_keywords', 'diff_canonical', 'diff_h1',
  'diff_og_title', 'diff_og_description', 'diff_og_image', 'diff_og_url',
  'diff_og_type', 'diff_og_site_name',
  'diff_twitter_card', 'diff_twitter_title', 'diff_twitter_description',
  'diff_twitter_image', 'diff_twitter_site', 'diff_robots_meta',
];

// ─── Main ─────────────────────────────────────────────────────────────────────
console.error(`\nSEO Migration Comparison: ${urls.length} URLs`);
console.error(`  Production : ${prodBase}`);
console.error(`  EDS        : ${edsBase}\n`);

const results = await runWithConcurrency(urls, processUrl, CONCURRENCY);

// Write CSV
const rows = results.map(r => CSV_COLUMNS.map(c => csvCell(r[c])).join(','));
writeFileSync(outputCsvFile, [CSV_COLUMNS.map(csvCell).join(','), ...rows].join('\n') + '\n');

// ─── Summary ──────────────────────────────────────────────────────────────────
const total          = results.length;
const notMigrated    = results.filter(r => r.migration_status === 'NOT_MIGRATED').length;
const prodNotFound   = results.filter(r => r.migration_status === 'PROD_NOT_FOUND').length;
const bothNotFound   = results.filter(r => r.migration_status === 'BOTH_NOT_FOUND').length;
const fullyMatched   = results.filter(r => r.migration_status === 'FULLY_MATCHED').length;
const hasGaps        = results.filter(r => r.migration_status === 'HAS_GAPS').length;
const withCritical   = results.filter(r => r.critical_gaps_count > 0).length;

// Gap frequency across all live EDS pages
const gapFreq = {};
results
  .filter(r => r.migration_status === 'HAS_GAPS')
  .forEach(r => (r.gaps || '').split(' | ').filter(Boolean).forEach(g => {
    gapFreq[g] = (gapFreq[g] || 0) + 1;
  }));

// Field-level diff counts
const diffStats = {};
for (const field of COMPARE_FIELDS) {
  const key = `diff_${field}`;
  diffStats[FIELD_LABEL[field]] = {
    MATCH:           results.filter(r => r[key] === 'MATCH').length,
    DIFFERENT:       results.filter(r => r[key] === 'DIFFERENT').length,
    MISSING_ON_EDS:  results.filter(r => r[key] === 'MISSING_ON_EDS').length,
    BOTH_MISSING:    results.filter(r => r[key] === 'BOTH_MISSING').length,
  };
}

console.log('\n╔══════════════════════════════════════════════════════╗');
console.log('║       SEO Migration Comparison Summary               ║');
console.log('╚══════════════════════════════════════════════════════╝');
console.log(`  Total URLs checked     : ${total}`);
console.log(`  Fully matched (EDS ✓)  : ${fullyMatched}`);
console.log(`  Has SEO gaps (EDS live) : ${hasGaps}  (${withCritical} with critical gaps)`);
console.log(`  Not migrated (EDS 404)  : ${notMigrated}`);
console.log(`  Prod not found (404)    : ${prodNotFound}`);
if (bothNotFound) console.log(`  Both 404                : ${bothNotFound}`);

if (Object.keys(gapFreq).length) {
  console.log('\n── Most Common SEO Gaps on EDS (vs Production) ──────');
  Object.entries(gapFreq)
    .sort((a, b) => b[1] - a[1])
    .forEach(([gap, count]) => {
      const critical = CRITICAL_FIELDS.has(Object.keys(FIELD_LABEL).find(k => FIELD_LABEL[k] === gap) || '')
        ? ' ⚑ CRITICAL' : '';
      console.log(`  [${String(count).padStart(3)}x] ${gap}${critical}`);
    });
}

console.log('\n── Field-Level Diff Breakdown (migrated pages only) ──');
console.log(`  ${'Field'.padEnd(22)} ${'MATCH'.padStart(6)} ${'DIFF'.padStart(6)} ${'MISS_EDS'.padStart(9)} ${'BOTH_MISS'.padStart(10)}`);
console.log('  ' + '─'.repeat(55));
for (const [label, stat] of Object.entries(diffStats)) {
  const anyIssue = stat.DIFFERENT + stat.MISSING_ON_EDS;
  const flag = anyIssue > 0 ? ' ←' : '';
  console.log(
    `  ${label.padEnd(22)} ${String(stat.MATCH).padStart(6)} ${String(stat.DIFFERENT).padStart(6)}` +
    ` ${String(stat.MISSING_ON_EDS).padStart(9)} ${String(stat.BOTH_MISSING).padStart(10)}${flag}`
  );
}

// Worst pages
const worst = results
  .filter(r => r.migration_status === 'HAS_GAPS')
  .sort((a, b) => b.critical_gaps_count - a.critical_gaps_count || b.gaps_count - a.gaps_count)
  .slice(0, 10);

if (worst.length) {
  console.log('\n── Pages with Most Gaps ──────────────────────────────');
  worst.forEach(r =>
    console.log(`  (${r.critical_gaps_count} critical, ${r.gaps_count} total) ${r.eds_url}\n    Gaps: ${r.gaps}`)
  );
}

// Pages not migrated (first 20)
if (notMigrated > 0) {
  console.log(`\n── Not Migrated (EDS 404) — showing first 20 of ${notMigrated} ──`);
  results
    .filter(r => r.migration_status === 'NOT_MIGRATED')
    .slice(0, 20)
    .forEach(r => console.log(`  ${r.eds_url}`));
  if (notMigrated > 20) console.log(`  ... and ${notMigrated - 20} more (see CSV)`);
}

console.log(`\n  CSV report: ${outputCsvFile}`);

// ─── HTML report ──────────────────────────────────────────────────────────────
const htmlPath = outputCsvFile.replace(/\.csv$/i, '.html');
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const statusBadge = status => {
  const map = {
    FULLY_MATCHED: ['#2D9D78', 'MATCHED'],
    HAS_GAPS:      ['#E68619', 'HAS GAPS'],
    NOT_MIGRATED:  ['#8E8E8E', 'NOT MIGRATED'],
    PROD_NOT_FOUND:['#8E8E8E', 'PROD 404'],
    BOTH_NOT_FOUND:['#8E8E8E', 'BOTH 404'],
    ERROR:         ['#FF0000', 'ERROR'],
  };
  const [bg, label] = map[status] || ['#8E8E8E', status];
  return `<span class="badge" style="background:${bg}">${label}</span>`;
};

const diffBadge = val => {
  const map = {
    MATCH:           ['#2D9D78', 'MATCH'],
    DIFFERENT:       ['#E68619', 'DIFF'],
    MISSING_ON_EDS:  ['#FF0000', 'MISS EDS'],
    MISSING_ON_PROD: ['#1473E6', 'MISS PROD'],
    BOTH_MISSING:    ['#8E8E8E', 'BOTH MISS'],
    NOT_MIGRATED:    ['#8E8E8E', '—'],
    PROD_404:        ['#8E8E8E', '—'],
  };
  if (!val) return '';
  const [bg, label] = map[val] || ['#8E8E8E', val];
  return `<span class="badge" style="background:${bg};font-size:9px">${label}</span>`;
};

const DIFF_FIELDS_DISPLAY = [
  ['title', 'Title'],
  ['description', 'Description'],
  ['h1', 'H1'],
  ['canonical', 'Canonical'],
  ['og_title', 'OG Title'],
  ['og_description', 'OG Desc'],
  ['og_image', 'OG Image'],
  ['og_type', 'OG Type'],
  ['og_site_name', 'OG Site'],
  ['twitter_card', 'TW Card'],
  ['twitter_title', 'TW Title'],
  ['twitter_description', 'TW Desc'],
  ['twitter_image', 'TW Image'],
  ['twitter_site', 'TW Site'],
  ['keywords', 'Keywords'],
  ['robots_meta', 'Robots'],
];

const sortedResults = [...results].sort((a, b) => {
  const order = { HAS_GAPS: 0, NOT_MIGRATED: 1, FULLY_MATCHED: 2, PROD_NOT_FOUND: 3, BOTH_NOT_FOUND: 4, ERROR: 5 };
  return (order[a.migration_status] ?? 9) - (order[b.migration_status] ?? 9)
    || (b.critical_gaps_count - a.critical_gaps_count)
    || (b.gaps_count - a.gaps_count);
});

const tableRows = sortedResults.map(r => {
  const path = (() => { try { return new URL(r.eds_url || r.original_url).pathname; } catch (_) { return r.eds_url || r.original_url; } })();
  const diffCells = DIFF_FIELDS_DISPLAY.map(([key]) => `<td style="text-align:center">${diffBadge(r[`diff_${key}`])}</td>`).join('');
  const rowClass = r.migration_status === 'FULLY_MATCHED' ? 'row-pass'
    : r.migration_status === 'HAS_GAPS' ? (r.critical_gaps_count > 0 ? 'row-fail' : 'row-warn')
    : 'row-na';
  const gapsHtml = r.gaps ? `<div style="font-size:10px;color:#666;margin-top:2px">${esc(r.gaps)}</div>` : '';
  return `
    <tr class="${rowClass}">
      <td>${statusBadge(r.migration_status)}</td>
      <td><a href="${esc(r.eds_url)}" target="_blank">${esc(path)}</a>${gapsHtml}</td>
      <td style="text-align:center;color:${r.critical_gaps_count > 0 ? '#FF0000' : '#666'}">${r.critical_gaps_count || ''}</td>
      <td style="text-align:center">${r.gaps_count || ''}</td>
      ${diffCells}
    </tr>`;
}).join('');

const diffHeaders = DIFF_FIELDS_DISPLAY.map(([, label]) => `<th>${label}</th>`).join('');

const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>EDS SEO Migration Compare</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:13px;color:#222;background:#f4f4f4}
  .page-header{background:#1B1B1B;color:#fff;padding:24px 32px}
  .page-header .eyebrow{font-size:11px;color:#FF0000;text-transform:uppercase;letter-spacing:1px;font-weight:700;margin-bottom:6px}
  .page-header h1{font-size:22px;margin:0 0 4px;color:#fff;font-weight:600}
  .page-header .meta{color:#aaa;font-size:12px}
  .content{padding:24px 32px 40px;overflow-x:auto}
  .stats{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px}
  .stat{background:#fff;border-radius:8px;padding:14px 20px;box-shadow:0 1px 3px rgba(0,0,0,.1);min-width:120px}
  .stat .n{font-size:28px;font-weight:700}
  .stat .l{font-size:11px;color:#6E6E6E;text-transform:uppercase;letter-spacing:.5px;margin-top:2px}
  h2{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#444;margin-bottom:12px}
  table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)}
  th{background:#1B1B1B;color:#fff;padding:8px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;white-space:nowrap}
  td{padding:7px 10px;border-bottom:1px solid #f0f0f0;vertical-align:top;font-size:11px}
  tr.row-pass td{background:#f0faf4}
  tr.row-fail td{background:#fff5f5}
  tr.row-warn td{background:#fffbf0}
  tr.row-na td{background:#f8f8f8;color:#999}
  .badge{display:inline-block;padding:2px 6px;border-radius:3px;font-size:10px;font-weight:700;color:#fff;white-space:nowrap}
  a{color:#1473E6}
  .legend{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;font-size:11px;align-items:center}
  .legend span{display:inline-flex;align-items:center;gap:4px}
</style>
</head>
<body>
<div class="page-header">
  <div class="eyebrow">AEM Edge Delivery Services</div>
  <h1>EDS SEO Migration Compare</h1>
  <div class="meta">Generated ${new Date().toISOString()} &nbsp;·&nbsp; ${total} URLs &nbsp;·&nbsp; Prod: ${prodBase} &nbsp;→&nbsp; EDS: ${edsBase}</div>
</div>
<div class="content">
<div class="stats">
  <div class="stat"><div class="n">${total}</div><div class="l">Total</div></div>
  <div class="stat"><div class="n" style="color:#2D9D78">${fullyMatched}</div><div class="l">Fully Matched</div></div>
  <div class="stat"><div class="n" style="color:#E68619">${hasGaps}</div><div class="l">Has Gaps</div></div>
  <div class="stat"><div class="n" style="color:#FF0000">${withCritical}</div><div class="l">Critical Gaps</div></div>
  <div class="stat"><div class="n" style="color:#8E8E8E">${notMigrated}</div><div class="l">Not Migrated</div></div>
</div>
<div class="legend">
  <strong>Diff legend:</strong>
  <span><span class="badge" style="background:#2D9D78">MATCH</span> Identical</span>
  <span><span class="badge" style="background:#E68619;font-size:9px">DIFF</span> Different</span>
  <span><span class="badge" style="background:#FF0000;font-size:9px">MISS EDS</span> Missing on EDS</span>
  <span><span class="badge" style="background:#1473E6;font-size:9px">MISS PROD</span> Missing on Prod</span>
  <span><span class="badge" style="background:#8E8E8E;font-size:9px">BOTH MISS</span> Both missing</span>
</div>
<h2>All Pages (${total})</h2>
<table>
  <thead><tr>
    <th>Status</th><th>Page</th><th>Critical</th><th>Gaps</th>
    ${diffHeaders}
  </tr></thead>
  <tbody>${tableRows}</tbody>
</table>
</div>
</body>
</html>`;

writeFileSync(htmlPath, htmlContent);
console.log(`  HTML report: ${htmlPath}`);
