#!/usr/bin/env node
/**
 * CWV Checker — Google PageSpeed Insights API (Lighthouse)
 * Usage: node check-cwv.js <sitemap-json> <output-csv> [options]
 *
 * Options:
 *   --key=API_KEY           Google API key (recommended — without key: 1 req/2s rate limit)
 *   --base-url=URL          Remap sitemap URLs to this base (e.g. EDS preview domain)
 *   --strategy=mobile|desktop  Default: mobile (Google uses mobile for ranking)
 *
 * Without --base-url, uses original sitemap URLs directly (checks the live site).
 *
 * PSI API checks pages from Google's servers — URLs must be publicly accessible.
 *
 * Requires Node.js 18+ (native fetch).
 */

import { readFileSync, writeFileSync } from 'fs';
import { URL } from 'url';

const [,, sitemapJsonFile, outputCsvFile, ...flags] = process.argv;

if (!sitemapJsonFile || !outputCsvFile) {
  console.error('Usage: node check-cwv.js <sitemap-json> <output-csv> [--key=API_KEY] [--base-url=URL] [--strategy=mobile|desktop]');
  process.exit(1);
}

const apiKey   = flags.find(f => f.startsWith('--key='))?.slice(6)      || '';
const baseUrl  = flags.find(f => f.startsWith('--base-url='))?.slice(11) || '';
const strategy = flags.find(f => f.startsWith('--strategy='))?.slice(11) || 'mobile';

const CONCURRENCY = apiKey ? 3 : 1;
const DELAY_MS    = apiKey ? 300 : 2000; // be polite; PSI without key ~1 req/2s

const PSI_BASE = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

// ─── Thresholds (Core Web Vitals 2024) ────────────────────────────────────────
const T = {
  lcp:  { good: 2500,  poor: 4000  },
  fcp:  { good: 1800,  poor: 3000  },
  cls:  { good: 0.1,   poor: 0.25  },
  ttfb: { good: 800,   poor: 1800  },
  tbt:  { good: 200,   poor: 600   },
  inp:  { good: 200,   poor: 500   },
};

function rate(value, thresholds) {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  if (value <= thresholds.good) return 'GOOD';
  if (value <= thresholds.poor) return 'NEEDS_IMPROVEMENT';
  return 'POOR';
}

// ─── URL mapping ───────────────────────────────────────────────────────────────
function toTargetUrl(originalUrl) {
  if (!baseUrl) return originalUrl;
  try {
    const p = new URL(originalUrl);
    return `${baseUrl.replace(/\/$/, '')}${p.pathname}${p.search || ''}`;
  } catch { return originalUrl; }
}

// ─── PSI API call ──────────────────────────────────────────────────────────────
async function checkUrl(url) {
  const params = new URLSearchParams({ url, strategy });
  if (apiKey) params.set('key', apiKey);
  const apiUrl = `${PSI_BASE}?${params}`;

  let data;
  try {
    const res = await fetch(apiUrl, { signal: AbortSignal.timeout(90000) });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const msg  = JSON.parse(body)?.error?.message || body.slice(0, 120);
      return { url, error: `PSI API ${res.status}: ${msg}` };
    }
    data = await res.json();
  } catch (e) {
    return { url, error: e.message.slice(0, 120) };
  }

  // ── Lab data (Lighthouse) ──────────────────────────────────────────────────
  const audits = data.lighthouseResult?.audits || {};
  const perfScore = data.lighthouseResult?.categories?.performance?.score;

  const n = (key) => {
    const v = audits[key]?.numericValue;
    return v != null ? v : null;
  };

  const lab = {
    score:         perfScore != null ? Math.round(perfScore * 100) : null,
    lcp_ms:        n('largest-contentful-paint') != null ? Math.round(n('largest-contentful-paint')) : null,
    fcp_ms:        n('first-contentful-paint')   != null ? Math.round(n('first-contentful-paint'))   : null,
    cls:           n('cumulative-layout-shift'),
    ttfb_ms:       n('server-response-time')     != null ? Math.round(n('server-response-time'))     : null,
    tbt_ms:        n('total-blocking-time')      != null ? Math.round(n('total-blocking-time'))      : null,
    speed_index_ms:n('speed-index')              != null ? Math.round(n('speed-index'))              : null,
    tti_ms:        n('interactive')              != null ? Math.round(n('interactive'))              : null,
    lcp_display:   audits['largest-contentful-paint']?.displayValue || '',
    fcp_display:   audits['first-contentful-paint']?.displayValue   || '',
    cls_display:   audits['cumulative-layout-shift']?.displayValue  || '',
    ttfb_display:  audits['server-response-time']?.displayValue     || '',
  };

  // ── Field data (CrUX 75th percentile) ──────────────────────────────────────
  // loadingExperience = origin-level; originLoadingExperience also available
  const fm = data.loadingExperience?.metrics || {};

  // CLS in CrUX is stored ×100 (e.g. 5 = 0.05); INP/LCP/FCP/TTFB in ms
  const clsRaw = fm.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile;
  const field = {
    overall:      data.loadingExperience?.overall_category || 'NO_DATA',
    lcp_p75_ms:   fm.LARGEST_CONTENTFUL_PAINT_MS?.percentile  ?? null,
    fcp_p75_ms:   fm.FIRST_CONTENTFUL_PAINT_MS?.percentile    ?? null,
    cls_p75:      clsRaw != null ? +(clsRaw / 100).toFixed(3) : null,
    inp_p75_ms:   fm.INTERACTION_TO_NEXT_PAINT?.percentile    ?? null,
    ttfb_p75_ms:  fm.EXPERIMENTAL_TIME_TO_FIRST_BYTE?.percentile ?? null,
    lcp_category: fm.LARGEST_CONTENTFUL_PAINT_MS?.category   || '',
    fcp_category: fm.FIRST_CONTENTFUL_PAINT_MS?.category     || '',
    cls_category: fm.CUMULATIVE_LAYOUT_SHIFT_SCORE?.category  || '',
    inp_category: fm.INTERACTION_TO_NEXT_PAINT?.category     || '',
  };

  // ── Issues from lab data ───────────────────────────────────────────────────
  const issues = [];
  if (lab.score    != null && lab.score < 90)   issues.push(`Perf score ${lab.score}/100`);
  if (lab.lcp_ms   != null && lab.lcp_ms  > T.lcp.good)  issues.push(`LCP ${lab.lcp_ms}ms [${rate(lab.lcp_ms, T.lcp)}]`);
  if (lab.fcp_ms   != null && lab.fcp_ms  > T.fcp.good)  issues.push(`FCP ${lab.fcp_ms}ms [${rate(lab.fcp_ms, T.fcp)}]`);
  if (lab.cls      != null && lab.cls     > T.cls.good)  issues.push(`CLS ${lab.cls?.toFixed(3)} [${rate(lab.cls, T.cls)}]`);
  if (lab.ttfb_ms  != null && lab.ttfb_ms > T.ttfb.good) issues.push(`TTFB ${lab.ttfb_ms}ms [${rate(lab.ttfb_ms, T.ttfb)}]`);
  if (lab.tbt_ms   != null && lab.tbt_ms  > T.tbt.good)  issues.push(`TBT ${lab.tbt_ms}ms [${rate(lab.tbt_ms, T.tbt)}]`);

  // Field issues
  if (field.lcp_category === 'SLOW') issues.push(`Field LCP ${field.lcp_p75_ms}ms POOR (CrUX p75)`);
  if (field.cls_category === 'SLOW') issues.push(`Field CLS ${field.cls_p75} POOR (CrUX p75)`);
  if (field.inp_category === 'SLOW') issues.push(`Field INP ${field.inp_p75_ms}ms POOR (CrUX p75)`);

  return { url, lab, field, issues, error: null };
}

// ─── Concurrency + rate limit ─────────────────────────────────────────────────
async function runWithConcurrency(items, fn, concurrency, delayMs) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      if (idx > 0 && delayMs) await new Promise(r => setTimeout(r, delayMs));
      results[idx] = await fn(items[idx]);
      const r = results[idx];
      const score = r.lab?.score != null ? ` | score ${r.lab.score}` : '';
      const err   = r.error ? ` | ERROR: ${r.error}` : '';
      process.stderr.write(`\r  ${idx + 1}/${items.length}: ${r.url.slice(-60)}${score}${err}\n`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// ─── CSV helpers ───────────────────────────────────────────────────────────────
function csvCell(v) {
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}

// ─── Main ──────────────────────────────────────────────────────────────────────
const urls         = JSON.parse(readFileSync(sitemapJsonFile, 'utf8'));
const targetUrls   = urls.map(toTargetUrl);
const uniqueUrls   = [...new Set(targetUrls)];

console.error(`\nCWV check: ${uniqueUrls.length} URLs | strategy: ${strategy} | key: ${apiKey ? 'YES' : 'NO (rate limited)'}`);
if (!apiKey) console.error('  Tip: add --key=YOUR_API_KEY for faster checks (free at console.cloud.google.com)');
if (baseUrl) console.error(`  Base URL: ${baseUrl}`);

const results = await runWithConcurrency(uniqueUrls, checkUrl, CONCURRENCY, DELAY_MS);

// ─── CSV output ────────────────────────────────────────────────────────────────
const CSV_COLUMNS = [
  'url',
  // Lab (Lighthouse)
  'lab_perf_score',
  'lab_lcp_ms', 'lab_lcp_rating', 'lab_lcp_display',
  'lab_fcp_ms', 'lab_fcp_rating', 'lab_fcp_display',
  'lab_cls',    'lab_cls_rating',  'lab_cls_display',
  'lab_ttfb_ms','lab_ttfb_rating', 'lab_ttfb_display',
  'lab_tbt_ms', 'lab_tbt_rating',
  'lab_speed_index_ms',
  'lab_tti_ms',
  // Field (CrUX p75)
  'field_overall',
  'field_lcp_p75_ms', 'field_lcp_category',
  'field_fcp_p75_ms', 'field_fcp_category',
  'field_cls_p75',    'field_cls_category',
  'field_inp_p75_ms', 'field_inp_category',
  'field_ttfb_p75_ms',
  // Summary
  'issues_count', 'issues',
  'error',
];

const rows = results.map(r => {
  const l = r.lab   || {};
  const f = r.field || {};
  return [
    r.url,
    l.score,
    l.lcp_ms,  rate(l.lcp_ms,  T.lcp),  l.lcp_display,
    l.fcp_ms,  rate(l.fcp_ms,  T.fcp),  l.fcp_display,
    l.cls,     rate(l.cls,     T.cls),  l.cls_display,
    l.ttfb_ms, rate(l.ttfb_ms, T.ttfb), l.ttfb_display,
    l.tbt_ms,  rate(l.tbt_ms,  T.tbt),
    l.speed_index_ms,
    l.tti_ms,
    f.overall,
    f.lcp_p75_ms,  f.lcp_category,
    f.fcp_p75_ms,  f.fcp_category,
    f.cls_p75,     f.cls_category,
    f.inp_p75_ms,  f.inp_category,
    f.ttfb_p75_ms,
    (r.issues || []).length,
    (r.issues || []).join(' | '),
    r.error || '',
  ].map(csvCell).join(',');
});

writeFileSync(outputCsvFile, [CSV_COLUMNS.map(csvCell).join(','), ...rows].join('\n') + '\n');

// ─── Summary ───────────────────────────────────────────────────────────────────
const valid    = results.filter(r => !r.error && r.lab);
const errored  = results.filter(r => r.error);
const noData   = results.filter(r => !r.error && r.field?.overall === 'NO_DATA');

const avg = (arr, fn) => {
  const vals = arr.map(fn).filter(v => v != null && !Number.isNaN(v));
  return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
};

console.log('\n=== CWV Summary ===');
console.log(`Total URLs:          ${results.length}`);
console.log(`Checked:             ${valid.length}`);
console.log(`Errors / skipped:    ${errored.length}`);
console.log(`No CrUX field data:  ${noData.length}`);
console.log(`\n--- Lab Averages (Lighthouse / ${strategy}) ---`);
console.log(`  Perf score avg:  ${avg(valid, r => r.lab?.score) ?? 'n/a'}`);
console.log(`  LCP avg:         ${avg(valid, r => r.lab?.lcp_ms) ?? 'n/a'} ms`);
console.log(`  FCP avg:         ${avg(valid, r => r.lab?.fcp_ms) ?? 'n/a'} ms`);
console.log(`  CLS avg:         ${avg(valid, r => r.lab?.cls)?.toFixed ? (avg(valid, r => r.lab?.cls) / 1000).toFixed(3) : 'n/a'}`);
console.log(`  TTFB avg:        ${avg(valid, r => r.lab?.ttfb_ms) ?? 'n/a'} ms`);
console.log(`  TBT avg:         ${avg(valid, r => r.lab?.tbt_ms) ?? 'n/a'} ms`);

// Score distribution
const scoreBuckets = { excellent: 0, good: 0, needs_improvement: 0, poor: 0 };
valid.forEach(r => {
  const s = r.lab?.score;
  if (s == null) return;
  if (s >= 90) scoreBuckets.excellent++;
  else if (s >= 75) scoreBuckets.good++;
  else if (s >= 50) scoreBuckets.needs_improvement++;
  else scoreBuckets.poor++;
});
console.log('\n--- Performance Score Distribution ---');
console.log(`  90–100 (Excellent):        ${scoreBuckets.excellent}`);
console.log(`  75–89  (Good):             ${scoreBuckets.good}`);
console.log(`  50–74  (Needs improvement):${scoreBuckets.needs_improvement}`);
console.log(`  0–49   (Poor):             ${scoreBuckets.poor}`);

// Worst pages
const worst = valid.filter(r => (r.issues || []).length > 0)
  .sort((a, b) => (b.lab?.score ?? 0) - (a.lab?.score ?? 0))
  .sort((a, b) => (b.issues || []).length - (a.issues || []).length)
  .slice(0, 5);
if (worst.length) {
  console.log('\n--- Pages with Most Issues ---');
  worst.forEach(r => console.log(`  [score ${r.lab?.score ?? '?'}] ${r.url} — ${(r.issues || []).join(', ')}`));
}

if (errored.length) {
  console.log('\n--- Errors ---');
  errored.slice(0, 10).forEach(r => console.log(`  ${r.url}: ${r.error}`));
}

console.log(`\nCSV report: ${outputCsvFile}`);
