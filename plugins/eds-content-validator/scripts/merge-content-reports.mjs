#!/usr/bin/env node
/**
 * Merge multiple content compare batch outputs into a single HTML report.
 *
 * Usage:
 *   node merge-content-reports.mjs <merged-output-dir> <batch-dir-1> <batch-dir-2> ...
 *
 * Each batch dir must contain results.json written by check-content.mjs or check-content-deep.mjs.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';

const [,, mergedOutputDir, ...batchDirs] = process.argv;

if (!mergedOutputDir || batchDirs.length === 0) {
  console.error('Usage: node merge-content-reports.mjs <merged-output-dir> <batch-dir-1> <batch-dir-2> ...');
  process.exit(1);
}

mkdirSync(mergedOutputDir, { recursive: true });

let mergedMeta = null;
let allPages   = [];

for (const batchDir of batchDirs) {
  const resultsPath = path.join(batchDir, 'results.json');
  let batch;
  try {
    batch = JSON.parse(readFileSync(resultsPath, 'utf8'));
  } catch (err) {
    console.error(`WARN: Could not read ${resultsPath} — skipping (${err.message})`);
    continue;
  }
  if (!mergedMeta) mergedMeta = batch.meta;
  allPages = allPages.concat(batch.pages);
}

if (!mergedMeta || allPages.length === 0) {
  console.error('No valid batch results found — nothing to merge.');
  process.exit(1);
}

// Sort by slug to preserve original URL order
allPages.sort((a, b) => a.slug.localeCompare(b.slug));

// ─── Merged results.json ──────────────────────────────────────────────────────

writeFileSync(path.join(mergedOutputDir, 'results.json'), JSON.stringify({
  meta: { ...mergedMeta, mergedAt: new Date().toISOString(), batchCount: batchDirs.length },
  pages: allPages,
}, null, 2));

// ─── Build merged CSV ─────────────────────────────────────────────────────────

const csvEsc = v => {
  const s = String(v ?? '');
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s;
};

const csvHeaders = [
  'slug', 'url_path', 'status', 'overall_sim_pct',
  'prod_word_count', 'eds_word_count', 'word_count_delta_pct',
  'prod_heading_count', 'eds_heading_count', 'matched_heading_count',
  'missing_headings', 'cta_match_rate_pct', 'prod_cta_count', 'eds_cta_count',
  'prod_h1', 'eds_h1',
];
const csvRows = allPages.map(r => [
  r.slug, r.urlPath, r.status,
  r.overallSim?.toFixed(1) ?? '',
  r.prodWordCount ?? '', r.edsWordCount ?? '',
  r.wordCountDelta?.toFixed(1) ?? '',
  r.prodHeadingCount ?? '', r.edsHeadingCount ?? '',
  r.matchedHeadingCount ?? '',
  (r.missingHeadings ?? []).join(' | '),
  r.ctaMatchRate?.toFixed(1) ?? '',
  r.prodCtaCount ?? '', r.edsCtaCount ?? '',
  r.prodH1 ?? '', r.edsH1 ?? '',
].map(csvEsc).join(','));

writeFileSync(
  path.join(mergedOutputDir, 'content-report.csv'),
  [csvHeaders.join(','), ...csvRows].join('\n'),
);

// ─── Build merged HTML report ─────────────────────────────────────────────────

const { threshold: THRESHOLD, mode: MODE, prodBase, edsBase } = mergedMeta;

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const BADGE = {
  MATCH:         ['#4caf50', 'MATCH'],
  PARTIAL:       ['#ff9800', 'PARTIAL'],
  MISMATCH:      ['#f44336', 'MISMATCH'],
  PROD_BLOCKED:  ['#ff9800', 'PROD BLOCKED'],
  EDS_NOT_FOUND: ['#9c27b0', 'EDS 404'],
  ERROR:         ['#9e9e9e', 'ERROR'],
  COMPARE_ERROR: ['#9e9e9e', 'COMPARE ERROR'],
};

const badge = (status, sim) => {
  const [color, label] = BADGE[status] ?? ['#9e9e9e', status];
  const text = sim != null ? `${label}&nbsp;${sim.toFixed(1)}%` : label;
  return `<span class="badge" style="background:${color}">${text}</span>`;
};

const sectionRows = (sections = []) => sections.map(s => {
  const color = { MATCH: '#4caf50', PARTIAL: '#ff9800', MISMATCH: '#f44336', MISSING: '#f44336' }[s.status] ?? '#9e9e9e';
  return `<tr>
    <td class="sec-heading">${esc(s.heading)}</td>
    <td><span style="background:${color};color:#fff;padding:1px 6px;border-radius:8px;font-size:11px">${s.status}${s.sim != null ? ` ${s.sim.toFixed(0)}%` : ''}</span></td>
  </tr>`;
}).join('');

const pageRows = allPages.map(r => {
  const isIssue = !['MATCH'].includes(r.status);
  return `
  <tbody>
    <tr class="page-header ${isIssue ? 'page-fail' : 'page-pass'}">
      <td colspan="6">
        <span class="page-path">${esc(r.urlPath)}</span>
        ${r.overallSim != null ? `<span class="sim-pct">${r.overallSim.toFixed(1)}% similar</span>` : ''}
        ${r.error ? `<span class="err-note"> — ${esc(r.error)}</span>` : ''}
      </td>
    </tr>
    <tr>
      <td>${badge(r.status, r.overallSim)}</td>
      <td class="num">${r.prodWordCount ?? '—'}&nbsp;/&nbsp;${r.edsWordCount ?? '—'}</td>
      <td class="num">${r.wordCountDelta != null ? (r.wordCountDelta > 0 ? '+' : '') + r.wordCountDelta.toFixed(0) + '%' : '—'}</td>
      <td class="num">${r.matchedHeadingCount != null ? `${r.matchedHeadingCount}/${r.prodHeadingCount}` : '—'}</td>
      <td class="num">${r.ctaMatchRate != null ? r.ctaMatchRate.toFixed(0) + '%' : '—'}</td>
      <td>
        ${(r.missingHeadings ?? []).length ? `<details><summary class="tog">${r.missingHeadings.length} missing heading(s)</summary><ul class="missing-list">${r.missingHeadings.map(h => `<li>${esc(h)}</li>`).join('')}</ul></details>` : ''}
        ${(r.sectionResults ?? []).length ? `<details><summary class="tog">Sections (${r.sectionResults.length})</summary><table class="sec-table">${sectionRows(r.sectionResults)}</table></details>` : ''}
      </td>
    </tr>
  </tbody>`;
}).join('');

const matched    = allPages.filter(r => r.status === 'MATCH').length;
const partial    = allPages.filter(r => r.status === 'PARTIAL').length;
const mismatched = allPages.filter(r => r.status === 'MISMATCH').length;
const blocked    = allPages.filter(r => r.status === 'PROD_BLOCKED').length;
const errors     = allPages.filter(r => ['ERROR', 'COMPARE_ERROR', 'EDS_NOT_FOUND'].includes(r.status)).length;
const simPages   = allPages.filter(r => r.overallSim != null);
const avgSim     = simPages.length ? simPages.reduce((s, r) => s + r.overallSim, 0) / simPages.length : 0;

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Content Comparison (Merged) — EDS vs Prod</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f4f4f4;color:#222}
.header{background:#1a1a2e;color:#fff;padding:24px 32px}
.header h1{font-size:20px;font-weight:600}
.header p{font-size:12px;color:#aaa;margin-top:5px}
.stats{display:flex;gap:12px;padding:20px 32px;flex-wrap:wrap}
.stat{background:#fff;border-radius:8px;padding:14px 20px;box-shadow:0 1px 3px rgba(0,0,0,.1);min-width:110px;text-align:center}
.stat .val{font-size:26px;font-weight:700}
.stat .lbl{font-size:11px;color:#888;margin-top:3px;text-transform:uppercase;letter-spacing:.5px}
.stat.s-match .val{color:#4caf50}.stat.s-partial .val{color:#ff9800}.stat.s-fail .val{color:#f44336}
.content{padding:0 32px 40px}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.1);overflow:hidden;margin-bottom:2px}
th{background:#f0f0f0;padding:9px 12px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;color:#555;border-bottom:2px solid #e0e0e0}
td{padding:8px 12px;border-bottom:1px solid #f0f0f0;vertical-align:top;font-size:13px}
.page-header td{padding:10px 12px;font-weight:600;font-size:13px;border-top:3px solid #e0e0e0}
.page-pass{background:#f8fff8}.page-fail{background:#fff6f6}
.page-path{font-family:monospace;font-size:13px}
.sim-pct{font-size:11px;color:#888;font-weight:400;margin-left:10px;font-family:monospace}
.err-note{font-size:11px;color:#f44336;font-weight:400;margin-left:6px}
.badge{display:inline-block;color:#fff;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700;white-space:nowrap}
.num{font-family:monospace;font-size:12px;white-space:nowrap}
.tog{cursor:pointer;font-size:12px;color:#1a73e8;user-select:none}
.tog::-webkit-details-marker{display:none}
.missing-list{font-size:12px;padding:4px 0 4px 16px;color:#f44336}
.sec-table{margin-top:4px;box-shadow:none}
.sec-heading{font-size:12px;color:#555}
</style>
</head>
<body>
<div class="header">
  <h1>Content Comparison — EDS vs Prod (Merged)</h1>
  <p>Merged ${batchDirs.length} batch(es) &nbsp;&middot;&nbsp; Mode: ${MODE ?? 'fast'} &nbsp;&middot;&nbsp; Generated ${new Date().toLocaleString()} &nbsp;&middot;&nbsp; Threshold: ${THRESHOLD}%</p>
  <p style="margin-top:3px">Prod: ${esc(prodBase)} &rarr; EDS: ${esc(edsBase)}</p>
</div>
<div class="stats">
  <div class="stat"><div class="val">${allPages.length}</div><div class="lbl">Pages</div></div>
  <div class="stat"><div class="val">${avgSim.toFixed(0)}%</div><div class="lbl">Avg Similarity</div></div>
  <div class="stat s-match"><div class="val">${matched}</div><div class="lbl">Match &ge;${THRESHOLD}%</div></div>
  <div class="stat s-partial"><div class="val">${partial}</div><div class="lbl">Partial 50&ndash;${THRESHOLD}%</div></div>
  <div class="stat s-fail"><div class="val">${mismatched}</div><div class="lbl">Mismatch &lt;50%</div></div>
  <div class="stat"><div class="val">${blocked}</div><div class="lbl">Prod Blocked</div></div>
  <div class="stat"><div class="val">${errors}</div><div class="lbl">Errors</div></div>
</div>
<div class="content">
  <table>
    <thead>
      <tr>
        <th style="width:160px">Status</th>
        <th style="width:130px">Words (Prod / EDS)</th>
        <th style="width:80px">&Delta; Words</th>
        <th style="width:120px">Headings matched</th>
        <th style="width:90px">CTA match</th>
        <th>Details</th>
      </tr>
    </thead>
    ${pageRows}
  </table>
</div>
</body>
</html>`;

const reportPath = path.join(mergedOutputDir, 'index.html');
writeFileSync(reportPath, html);

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log('\n=== Merged Content Comparison Summary ===');
console.log(`Batches merged:      ${batchDirs.length}`);
console.log(`Pages total:         ${allPages.length}`);
console.log(`Avg similarity:      ${avgSim.toFixed(1)}%`);
console.log(`Match (≥${THRESHOLD}%):    ${matched}`);
console.log(`Partial (50–${THRESHOLD}%): ${partial}`);
console.log(`Mismatch (<50%):     ${mismatched}`);
console.log(`Prod blocked (WAF):  ${blocked}`);
console.log(`Errors:              ${errors}`);

const worst = [...simPages]
  .sort((a, b) => a.overallSim - b.overallSim)
  .slice(0, 10);

if (worst.length) {
  console.log('\n--- Pages with lowest content similarity ---');
  worst.forEach(r => {
    const note = r.missingHeadings?.length ? ` (${r.missingHeadings.length} missing headings)` : '';
    console.log(`  ${r.urlPath} — ${r.overallSim.toFixed(1)}%${note}`);
  });
}

console.log(`\nReport: ${reportPath}`);
console.log(`CSV:    ${path.join(mergedOutputDir, 'content-report.csv')}`);
