#!/usr/bin/env node
/**
 * CWV Checker — Google PageSpeed Insights API (Lighthouse)
 * Usage: node check-cwv.mjs <sitemap-json> <output-csv> [options]
 *
 * Options:
 *   --key=API_KEY                Google API key (recommended — without key: 1 req/2s rate limit)
 *   --base-url=URL               Remap sitemap URLs to this base (e.g. EDS preview domain)
 *   --strategy=mobile|desktop|both  Default: both (runs mobile + desktop in parallel per URL)
 *   --batch-size=N               URLs per batch (default: 50)
 *   --parallel=N                 Batches to run in parallel per wave (default: 3)
 *
 * Without --base-url, uses original sitemap URLs directly (checks the live site).
 *
 * PSI API checks pages from Google's servers — URLs must be publicly accessible.
 *
 * Requires Node.js 18+ (native fetch).
 */

import { readFileSync, writeFileSync, appendFileSync } from 'fs';
import { URL } from 'url';

const [,, sitemapJsonFile, outputCsvFile, ...flags] = process.argv;

if (!sitemapJsonFile || !outputCsvFile) {
  console.error('Usage: node check-cwv.mjs <sitemap-json> <output-csv> [--key=API_KEY] [--base-url=URL] [--strategy=mobile|desktop|both] [--batch-size=N] [--parallel=N]');
  process.exit(1);
}

const apiKey       = flags.find(f => f.startsWith('--key='))?.slice(6)        || '';
const baseUrl      = flags.find(f => f.startsWith('--base-url='))?.slice(11)  || '';
const strategyFlag = flags.find(f => f.startsWith('--strategy='))?.slice(11)  || 'both';
const strategies   = strategyFlag === 'both' ? ['mobile', 'desktop'] : [strategyFlag];
const BATCH_SIZE   = parseInt(flags.find(f => f.startsWith('--batch-size='))?.slice(13) || '50', 10);
const PARALLEL     = parseInt(flags.find(f => f.startsWith('--parallel='))?.slice(11)   || '3',  10);

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
    const raw = p.pathname.replace(/\/$/, '') || '/';
    return `${baseUrl.replace(/\/$/, '')}${raw}${p.search || ''}`;
  } catch { return originalUrl; }
}

// ─── PSI API call ──────────────────────────────────────────────────────────────
async function checkUrl(url, strat) {
  const params = new URLSearchParams({ url, strategy: strat });
  params.append('category', 'performance');
  params.append('category', 'seo');
  params.append('category', 'accessibility');
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
  const cats = data.lighthouseResult?.categories || {};
  const perfScore = cats.performance?.score;
  const seoScore  = cats.seo?.score;
  const a11yScore = cats.accessibility?.score;

  const n = (key) => {
    const v = audits[key]?.numericValue;
    return v != null ? v : null;
  };

  const lab = {
    score:         perfScore != null ? Math.round(perfScore * 100) : null,
    seo_score:     seoScore  != null ? Math.round(seoScore  * 100) : null,
    a11y_score:    a11yScore != null ? Math.round(a11yScore * 100) : null,
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

// ─── CSV helpers ───────────────────────────────────────────────────────────────
function csvCell(v) {
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
const avg = (arr, fn) => {
  const vals = arr.map(fn).filter(v => v != null && !Number.isNaN(v));
  return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
};

function scoreBucketsFor(valid) {
  const b = { excellent: 0, good: 0, needs_improvement: 0, poor: 0 };
  valid.forEach(r => {
    const s = r.lab?.score;
    if (s == null) return;
    if (s >= 90) b.excellent++;
    else if (s >= 75) b.good++;
    else if (s >= 50) b.needs_improvement++;
    else b.poor++;
  });
  return b;
}

// ─── CSV column definitions ────────────────────────────────────────────────────
const isBoth = strategies.length > 1;

const CSV_COLUMNS = [
  ...(isBoth ? ['strategy'] : []),
  'url',
  'lab_perf_score',
  'lab_seo_score',
  'lab_a11y_score',
  'lab_lcp_ms', 'lab_lcp_rating', 'lab_lcp_display',
  'lab_fcp_ms', 'lab_fcp_rating', 'lab_fcp_display',
  'lab_cls',    'lab_cls_rating',  'lab_cls_display',
  'lab_ttfb_ms','lab_ttfb_rating', 'lab_ttfb_display',
  'lab_tbt_ms', 'lab_tbt_rating',
  'lab_speed_index_ms',
  'lab_tti_ms',
  'field_overall',
  'field_lcp_p75_ms', 'field_lcp_category',
  'field_fcp_p75_ms', 'field_fcp_category',
  'field_cls_p75',    'field_cls_category',
  'field_inp_p75_ms', 'field_inp_category',
  'field_ttfb_p75_ms',
  'issues_count', 'issues',
  'error',
];

function buildCsvRow(r) {
  const l = r.lab   || {};
  const f = r.field || {};
  return [
    ...(isBoth ? [r.strat] : []),
    r.url,
    l.score,
    l.seo_score,
    l.a11y_score,
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
}

// ─── Main ──────────────────────────────────────────────────────────────────────
const urls       = JSON.parse(readFileSync(sitemapJsonFile, 'utf8'));
const targetUrls = urls.map(toTargetUrl);
const uniqueUrls = [...new Set(targetUrls)];

// Write CSV header upfront (rows appended incrementally as each URL completes)
writeFileSync(outputCsvFile, CSV_COLUMNS.map(csvCell).join(',') + '\n');

// Split into batches
const batches = [];
for (let i = 0; i < uniqueUrls.length; i += BATCH_SIZE) {
  batches.push(uniqueUrls.slice(i, i + BATCH_SIZE));
}

const totalWaves = Math.ceil(batches.length / PARALLEL);
console.error(`\nCWV check: ${uniqueUrls.length} URLs | strategy: ${strategies.join('+')} | key: ${apiKey ? 'YES' : 'NO (rate limited)'}`);
if (!apiKey) console.error('  Tip: add --key=YOUR_API_KEY for faster checks (free at console.cloud.google.com)');
if (baseUrl) console.error(`  Base URL: ${baseUrl}`);
console.error(`  Batch size: ${BATCH_SIZE} | Parallel batches: ${PARALLEL} | Concurrency/batch: ${CONCURRENCY} | Batches: ${batches.length} | Waves: ${totalWaves}`);

const allResults = [];
let completed = 0;

// Process one URL across all strategies in parallel, then append CSV rows
async function processUrl(url) {
  const stratResults = await Promise.all(
    strategies.map(strat => checkUrl(url, strat).then(r => ({ ...r, strat })))
  );
  for (const r of stratResults) {
    allResults.push(r);
    appendFileSync(outputCsvFile, buildCsvRow(r) + '\n');
  }
  completed++;
  const scores = stratResults
    .filter(r => !r.error && r.lab)
    .map(r => `${r.strat}:${r.lab.score ?? '?'}`)
    .join(' ');
  const err = stratResults.find(r => r.error);
  process.stderr.write(`  [${completed}/${uniqueUrls.length}] ${url.slice(-70)} ${err ? `ERROR: ${err.error.slice(0, 50)}` : scores}\n`);
}

// Run a batch of URLs with CONCURRENCY workers, DELAY_MS between each URL
async function runBatch(batch) {
  let i = 0;
  async function worker() {
    while (i < batch.length) {
      const idx = i++;
      if (idx > 0 && DELAY_MS) await new Promise(r => setTimeout(r, DELAY_MS));
      await processUrl(batch[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batch.length) }, worker));
}

// Run waves: PARALLEL batches at a time
for (let w = 0; w < batches.length; w += PARALLEL) {
  const wave = batches.slice(w, w + PARALLEL);
  const waveNum = Math.floor(w / PARALLEL) + 1;
  const urlsInWave = wave.reduce((s, b) => s + b.length, 0);
  console.error(`\nWave ${waveNum}/${totalWaves}: ${wave.length} batch(es) in parallel | ${urlsInWave} URLs`);
  await Promise.all(wave.map(batch => runBatch(batch)));
}

console.log(`\nCSV report: ${outputCsvFile} (${allResults.length} rows)`);

// ─── Per-strategy summary ──────────────────────────────────────────────────────
for (const strat of strategies) {
  const sr      = allResults.filter(r => r.strat === strat);
  const valid   = sr.filter(r => !r.error && r.lab);
  const errored = sr.filter(r => r.error);
  const noData  = sr.filter(r => !r.error && r.field?.overall === 'NO_DATA');
  const sb      = scoreBucketsFor(valid);

  console.log(`\n=== CWV Summary (${strat}) ===`);
  console.log(`Total URLs:          ${sr.length}`);
  console.log(`Checked:             ${valid.length}`);
  console.log(`Errors / skipped:    ${errored.length}`);
  console.log(`No CrUX field data:  ${noData.length}`);
  console.log(`\n--- Lab Averages (Lighthouse / ${strat}) ---`);
  console.log(`  Perf score avg:  ${avg(valid, r => r.lab?.score) ?? 'n/a'}`);
  console.log(`  SEO score avg:   ${avg(valid, r => r.lab?.seo_score) ?? 'n/a'}`);
  console.log(`  A11y score avg:  ${avg(valid, r => r.lab?.a11y_score) ?? 'n/a'}`);
  console.log(`  LCP avg:         ${avg(valid, r => r.lab?.lcp_ms) ?? 'n/a'} ms`);
  console.log(`  FCP avg:         ${avg(valid, r => r.lab?.fcp_ms) ?? 'n/a'} ms`);
  console.log(`  TTFB avg:        ${avg(valid, r => r.lab?.ttfb_ms) ?? 'n/a'} ms`);
  console.log(`  TBT avg:         ${avg(valid, r => r.lab?.tbt_ms) ?? 'n/a'} ms`);
  console.log('\n--- Performance Score Distribution ---');
  console.log(`  90–100 (Excellent):        ${sb.excellent}`);
  console.log(`  75–89  (Good):             ${sb.good}`);
  console.log(`  50–74  (Needs improvement):${sb.needs_improvement}`);
  console.log(`  0–49   (Poor):             ${sb.poor}`);

  const worst = valid.filter(r => (r.issues || []).length > 0)
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
}

// ─── Combined HTML report ──────────────────────────────────────────────────────
const htmlPath = outputCsvFile.replace(/\.csv$/i, '.html');

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const metricCell = (value, rating, display) => {
  const colours = { GOOD: '#2D9D78', NEEDS_IMPROVEMENT: '#E68619', POOR: '#FF0000' };
  const col = colours[rating] ?? '#666';
  return `<span style="color:${col};font-weight:600">${esc(display ?? (value != null ? String(value) : '—'))}</span>`;
};

// Build per-strategy stats for HTML summary cards
const statsByStrat = {};
for (const strat of strategies) {
  const sr    = allResults.filter(r => r.strat === strat);
  const valid = sr.filter(r => !r.error && r.lab);
  statsByStrat[strat] = {
    total:      sr.length,
    valid:      valid.length,
    errored:    sr.filter(r => r.error).length,
    avgScore:   avg(valid, r => r.lab?.score),
    avgSeo:     avg(valid, r => r.lab?.seo_score),
    avgA11y:    avg(valid, r => r.lab?.a11y_score),
    sb:         scoreBucketsFor(valid),
  };
}

const stratBadge = strat =>
  `<span style="background:${strat==='mobile'?'#1473E6':'#7326D3'};color:#fff;padding:2px 7px;border-radius:4px;font-size:11px;font-weight:700">${strat}</span>`;

const statsHtml = strategies.map(strat => {
  const s = statsByStrat[strat];
  const heading = isBoth ? `<h3 style="margin:0 0 10px;font-size:13px;color:#444">${stratBadge(strat)}</h3>` : '';
  const perfColor  = s.avgScore  >= 90 ? '#2D9D78' : s.avgScore  >= 75 ? '#E68619' : '#FF0000';
  const seoColor   = s.avgSeo    >= 90 ? '#2D9D78' : s.avgSeo    >= 75 ? '#E68619' : '#FF0000';
  const a11yColor  = s.avgA11y   >= 90 ? '#2D9D78' : s.avgA11y   >= 75 ? '#E68619' : '#FF0000';
  return `${heading}<div class="stats">
  <div class="stat"><div class="n">${s.total}</div><div class="l">Total Pages</div></div>
  <div class="stat"><div class="n" style="color:${perfColor}">${s.avgScore ?? '—'}</div><div class="l">Avg Perf Score</div></div>
  <div class="stat"><div class="n" style="color:${seoColor}">${s.avgSeo ?? '—'}</div><div class="l">Avg SEO Score</div></div>
  <div class="stat"><div class="n" style="color:${a11yColor}">${s.avgA11y ?? '—'}</div><div class="l">Avg A11y Score</div></div>
  <div class="stat"><div class="n" style="color:#2D9D78">${s.sb.excellent}</div><div class="l">Excellent (90+)</div></div>
  <div class="stat"><div class="n" style="color:#2D9D78">${s.sb.good}</div><div class="l">Good (75–89)</div></div>
  <div class="stat"><div class="n" style="color:#E68619">${s.sb.needs_improvement}</div><div class="l">Needs Work (50–74)</div></div>
  <div class="stat"><div class="n" style="color:#FF0000">${s.sb.poor}</div><div class="l">Poor (&lt;50)</div></div>
  <div class="stat"><div class="n" style="color:#8E8E8E">${s.errored}</div><div class="l">Errors</div></div>
</div>`;
}).join('<hr style="margin:16px 0;border:none;border-top:1px solid #ddd">');

// ─── Group by URL for side-by-side mobile+desktop layout ─────────────────────
const byUrl = {};
for (const r of allResults) {
  if (!byUrl[r.url]) byUrl[r.url] = {};
  byUrl[r.url][r.strat] = r;
}
const urlList = [...new Set(allResults.map(r => r.url))];

// Sort: worst mobile (or desktop) score first
const sortedUrls = urlList.sort((a, b) => {
  const worstOf = url => {
    const scores = strategies.map(s => byUrl[url][s]?.lab?.score).filter(s => s != null);
    return scores.length ? Math.min(...scores) : (byUrl[url][strategies[0]]?.error ? -1 : 100);
  };
  return worstOf(a) - worstOf(b);
});

const scoreCell = r => {
  if (!r) return `<td style="text-align:center;color:#ccc">—</td>`;
  if (r.error) return `<td style="text-align:center;color:#999;font-size:10px">${esc(r.error.slice(0, 40))}</td>`;
  const s = r.lab?.score;
  if (s == null) return `<td style="text-align:center">—</td>`;
  const col = s >= 90 ? '#2D9D78' : s >= 75 ? '#E68619' : '#FF0000';
  return `<td style="text-align:center;font-weight:700;font-size:15px;color:${col}">${s}</td>`;
};

const mCell = (r, metric, threshold, displayKey) => {
  if (!r || r.error) return '<td style="color:#ccc">—</td>';
  const l = r.lab ?? {};
  return `<td>${metricCell(l[metric], rate(l[metric], threshold), l[displayKey])}</td>`;
};

const allRows = sortedUrls.map(url => {
  const mob  = isBoth ? byUrl[url]['mobile']  : byUrl[url][strategies[0]];
  const desk = isBoth ? byUrl[url]['desktop'] : null;
  const path = (() => { try { return new URL(url).pathname; } catch (_) { return url; } })();

  const worstScore = Math.min(mob?.lab?.score ?? 100, desk?.lab?.score ?? 100);
  const hasError   = mob?.error || desk?.error;
  const rc = hasError ? 'row-error' : worstScore >= 90 ? 'row-good' : worstScore >= 75 ? 'row-fair' : 'row-poor';

  const allIssues = [...new Set([...(mob?.issues || []), ...(desk?.issues || [])])];
  const issueHtml = allIssues.length
    ? `<ul style="margin:0;padding-left:16px">${allIssues.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`
    : '';

  const mobCells = isBoth ? `
      ${scoreCell(mob)}
      ${scoreCell({ ...mob, lab: { ...mob?.lab, score: mob?.lab?.seo_score } })}
      ${scoreCell({ ...mob, lab: { ...mob?.lab, score: mob?.lab?.a11y_score } })}
      ${mCell(mob, 'lcp_ms', T.lcp, 'lcp_display')}
      ${mCell(mob, 'fcp_ms', T.fcp, 'fcp_display')}
      ${mCell(mob, 'cls', T.cls, 'cls_display')}
      ${mCell(mob, 'ttfb_ms', T.ttfb, 'ttfb_display')}
      ${scoreCell(desk)}
      ${scoreCell({ ...desk, lab: { ...desk?.lab, score: desk?.lab?.seo_score } })}
      ${scoreCell({ ...desk, lab: { ...desk?.lab, score: desk?.lab?.a11y_score } })}
      ${mCell(desk, 'lcp_ms', T.lcp, 'lcp_display')}
      ${mCell(desk, 'fcp_ms', T.fcp, 'fcp_display')}
      ${mCell(desk, 'cls', T.cls, 'cls_display')}
      ${mCell(desk, 'ttfb_ms', T.ttfb, 'ttfb_display')}` : `
      ${scoreCell(mob)}
      ${scoreCell({ ...mob, lab: { ...mob?.lab, score: mob?.lab?.seo_score } })}
      ${scoreCell({ ...mob, lab: { ...mob?.lab, score: mob?.lab?.a11y_score } })}
      ${mCell(mob, 'lcp_ms', T.lcp, 'lcp_display')}
      ${mCell(mob, 'fcp_ms', T.fcp, 'fcp_display')}
      ${mCell(mob, 'cls', T.cls, 'cls_display')}
      ${mCell(mob, 'ttfb_ms', T.ttfb, 'ttfb_display')}`;

  return `
    <tr class="${rc}">
      <td><a href="${esc(url)}" target="_blank">${esc(path)}</a></td>
      ${mobCells}
      <td>${issueHtml}</td>
    </tr>`;
}).join('');

const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>EDS CWV Report</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:13px;color:#222;background:#f4f4f4}
  .page-header{background:#1B1B1B;color:#fff;padding:24px 32px}
  .page-header .eyebrow{font-size:11px;color:#FF0000;text-transform:uppercase;letter-spacing:1px;font-weight:700;margin-bottom:6px}
  .page-header h1{font-size:22px;margin:0 0 4px;color:#fff;font-weight:600}
  .page-header .meta{color:#aaa;font-size:12px}
  .content{padding:24px 32px 40px}
  .stats{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px}
  .stat{background:#fff;border-radius:8px;padding:14px 20px;box-shadow:0 1px 3px rgba(0,0,0,.1);min-width:120px}
  .stat .n{font-size:28px;font-weight:700}
  .stat .l{font-size:11px;color:#6E6E6E;text-transform:uppercase;letter-spacing:.5px;margin-top:2px}
  h2{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#444;margin-bottom:12px;margin-top:24px}
  table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)}
  th{background:#1B1B1B;color:#fff;padding:9px 12px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
  td{padding:8px 12px;border-bottom:1px solid #f0f0f0;vertical-align:top;font-size:12px}
  tr.row-good td{background:#f0faf4}
  tr.row-fair td{background:#fffbf0}
  tr.row-poor td{background:#fff5f5}
  tr.row-error td{background:#f8f8f8;color:#999}
  .label{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;letter-spacing:.4px}
  .label-good{background:#2D9D78;color:#fff}
  .label-fair{background:#E68619;color:#fff}
  .label-poor{background:#FF0000;color:#fff}
  .label-error{background:#8E8E8E;color:#fff}
  ul{list-style:disc;margin:0;padding-left:16px}
  li{margin-bottom:3px}
  a{color:#1473E6}
</style>
</head>
<body>
<div class="page-header">
  <div class="eyebrow">AEM Edge Delivery Services</div>
  <h1>EDS Core Web Vitals Report</h1>
  <div class="meta">Generated ${new Date().toISOString()} &nbsp;·&nbsp; ${uniqueUrls.length} pages &nbsp;·&nbsp; ${strategies.join(' + ')}</div>
</div>
<div class="content">
${statsHtml}
<h2>All results (${urlList.length} pages)</h2>
<table>
  <thead>
    ${isBoth ? `
    <tr>
      <th rowspan="2" style="vertical-align:bottom">Page</th>
      <th colspan="7" style="text-align:center;background:#1473E6;border-right:2px solid #0d5dbf">Mobile</th>
      <th colspan="7" style="text-align:center;background:#7326D3;border-right:2px solid #5a1dab">Desktop</th>
      <th rowspan="2" style="vertical-align:bottom">Issues</th>
    </tr>
    <tr>
      <th style="background:#1473E6">Perf</th><th style="background:#1473E6">SEO</th><th style="background:#1473E6">A11y</th><th style="background:#1473E6">LCP</th><th style="background:#1473E6">FCP</th><th style="background:#1473E6">CLS</th><th style="background:#1473E6;border-right:2px solid #0d5dbf">TTFB</th>
      <th style="background:#7326D3">Perf</th><th style="background:#7326D3">SEO</th><th style="background:#7326D3">A11y</th><th style="background:#7326D3">LCP</th><th style="background:#7326D3">FCP</th><th style="background:#7326D3">CLS</th><th style="background:#7326D3;border-right:2px solid #5a1dab">TTFB</th>
    </tr>` : `
    <tr>
      <th>Page</th><th>Perf</th><th>SEO</th><th>A11y</th><th>LCP</th><th>FCP</th><th>CLS</th><th>TTFB</th><th>Issues</th>
    </tr>`}
  </thead>
  <tbody>${allRows}</tbody>
</table>
</div>
</body>
</html>`;

writeFileSync(htmlPath, htmlContent);
console.log(`HTML report: ${htmlPath}`);
