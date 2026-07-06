#!/usr/bin/env node
/**
 * Merge multiple visual compare batch outputs into a single HTML report.
 *
 * Usage:
 *   node merge-reports.mjs <merged-output-dir> <batch-dir-1> <batch-dir-2> ...
 *
 * Each batch dir must contain:
 *   results.json   — written by check-visual.mjs
 *   screenshots/   — page-XXXX subdirs with PNG files
 *
 * The merged output dir will contain:
 *   index.html     — unified HTML report
 *   results.json   — merged machine-readable results
 *   screenshots/   — all page dirs copied from batch dirs
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, cpSync } from 'fs';
import path from 'path';

const [,, mergedOutputDir, ...batchDirs] = process.argv;

if (!mergedOutputDir || batchDirs.length === 0) {
  console.error('Usage: node merge-reports.mjs <merged-output-dir> <batch-dir-1> <batch-dir-2> ...');
  process.exit(1);
}

mkdirSync(path.join(mergedOutputDir, 'screenshots'), { recursive: true });

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

  // Copy screenshot dirs from this batch into the merged output
  const batchSsDir = path.join(batchDir, 'screenshots');
  let pageDirs;
  try {
    pageDirs = readdirSync(batchSsDir);
  } catch {
    continue; // no screenshots dir — batch may have had 0 pages
  }
  for (const pageDir of pageDirs) {
    cpSync(
      path.join(batchSsDir, pageDir),
      path.join(mergedOutputDir, 'screenshots', pageDir),
      { recursive: true },
    );
  }
}

if (!mergedMeta || allPages.length === 0) {
  console.error('No valid batch results found — nothing to merge.');
  process.exit(1);
}

// Sort pages by slug (page-0001, page-0002, …) to preserve original order
allPages.sort((a, b) => a.slug.localeCompare(b.slug));

// ─── HTML report (mirrors check-visual.mjs generateReport) ───────────────────
const { threshold: THRESHOLD, viewports: SELECTED_VIEWPORTS, prodBase, edsBase } = mergedMeta;

const allVp   = allPages.flatMap(r => Object.values(r.viewports));
const passed  = allVp.filter(v => v.status === 'PASS').length;
const failed  = allVp.filter(v => v.status === 'FAIL').length;
const blocked = allVp.filter(v => v.status === 'PROD_BLOCKED').length;
const errors  = allVp.filter(v => ['ERROR', 'DIFF_ERROR', 'EDS_NOT_FOUND'].includes(v.status)).length;

const BADGE = {
  PASS:          ['#4caf50', 'PASS'],
  FAIL:          ['#f44336', 'FAIL'],
  PROD_BLOCKED:  ['#ff9800', 'PROD BLOCKED'],
  EDS_NOT_FOUND: ['#9c27b0', 'EDS 404'],
  ERROR:         ['#9e9e9e', 'ERROR'],
  DIFF_ERROR:    ['#9e9e9e', 'DIFF ERROR'],
};

const badge = (status, pct) => {
  const [color, label] = BADGE[status] || ['#9e9e9e', status];
  const text = status === 'FAIL' && pct != null
    ? `FAIL &nbsp;${pct.toFixed(1)}%`
    : label;
  return `<span class="badge" style="background:${color}">${text}</span>`;
};

const imgPanel = (label, src, isHighlight) => {
  if (!src) return '';
  const border = isHighlight ? 'border:2px solid #f44336' : 'border:1px solid #ddd';
  return `
      <div class="img-panel">
        <div class="img-label">${label}</div>
        <a href="${src}" target="_blank">
          <img src="${src}" loading="lazy" style="${border};border-radius:4px;width:100%;display:block">
        </a>
      </div>`;
};

const vpBlock = (vpName, vr) => {
  if (!vr) return '';
  const hasDiff    = vr.status === 'FAIL';
  const hasScreens = vr.prodImg || vr.edsImg || vr.diffImg;
  const heightNote = vr.prodHeight && vr.edsHeight && vr.prodHeight !== vr.edsHeight
    ? `<span class="height-note">Prod: ${vr.prodHeight}px · EDS: ${vr.edsHeight}px</span>`
    : '';
  return `
    <tr class="vp-row${hasDiff ? ' vp-fail' : ''}">
      <td class="vp-name">${vpName}</td>
      <td>${badge(vr.status, vr.diffPct)}</td>
      <td class="diff-pct">${vr.diffPct != null ? vr.diffPct.toFixed(2) + '%' : vr.prodError || vr.edsError || '—'}</td>
      <td>
        ${heightNote}
        ${hasScreens ? `
        <details>
          <summary class="ss-toggle">View screenshots</summary>
          <div class="ss-grid">
            ${imgPanel('Prod', vr.prodImg, false)}
            ${imgPanel('EDS', vr.edsImg, false)}
            ${imgPanel('Diff', vr.diffImg, hasDiff)}
          </div>
        </details>` : (vr.prodError || vr.edsError || '—')}
      </td>
    </tr>`;
};

const pageRows = allPages.map(r => {
  const maxDiff  = Math.max(...Object.values(r.viewports).map(v => v.diffPct ?? 0));
  const hasIssue = Object.values(r.viewports).some(v => ['FAIL', 'ERROR', 'EDS_NOT_FOUND'].includes(v.status));
  return `
    <tbody>
      <tr class="page-header ${hasIssue ? 'page-fail' : 'page-pass'}">
        <td colspan="4">
          <span class="page-path">${r.urlPath}</span>
          ${maxDiff > 0 ? `<span class="max-diff">max diff: ${maxDiff.toFixed(1)}%</span>` : ''}
        </td>
      </tr>
      ${SELECTED_VIEWPORTS.map(vp => vpBlock(vp, r.viewports[vp])).join('')}
    </tbody>`;
}).join('');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Visual Regression — EDS vs Prod (merged)</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:#f4f4f4;color:#222}
.header{background:#1a1a2e;color:#fff;padding:24px 32px}
.header h1{font-size:20px;font-weight:600}
.header p{font-size:12px;color:#aaa;margin-top:5px}
.stats{display:flex;gap:12px;padding:20px 32px;flex-wrap:wrap}
.stat{background:#fff;border-radius:8px;padding:14px 20px;box-shadow:0 1px 3px rgba(0,0,0,.1);min-width:110px;text-align:center}
.stat .val{font-size:26px;font-weight:700}
.stat .lbl{font-size:11px;color:#888;margin-top:3px;text-transform:uppercase;letter-spacing:.5px}
.stat.s-fail .val{color:#f44336}.stat.s-pass .val{color:#4caf50}.stat.s-warn .val{color:#ff9800}
.content{padding:0 32px 40px}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.1);overflow:hidden;margin-bottom:2px}
th{background:#f0f0f0;padding:9px 12px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;color:#555;border-bottom:2px solid #e0e0e0}
td{padding:8px 12px;border-bottom:1px solid #f0f0f0;vertical-align:top;font-size:13px}
.page-header td{padding:10px 12px;font-weight:600;font-size:13px;border-top:3px solid #e0e0e0}
.page-pass{background:#f8fff8}.page-fail{background:#fff6f6}
.page-path{font-family:monospace;font-size:13px}
.max-diff{font-size:11px;color:#888;font-weight:400;margin-left:10px;font-family:monospace}
.vp-row{background:#fff}.vp-fail{background:#fff9f9}
.vp-name{font-size:12px;color:#666;white-space:nowrap;width:80px}
.diff-pct{font-family:monospace;font-size:12px;width:90px}
.badge{display:inline-block;color:#fff;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700;white-space:nowrap}
.height-note{display:block;font-size:11px;color:#aaa;font-family:monospace;margin-bottom:4px}
.ss-toggle{cursor:pointer;font-size:12px;color:#1a73e8;list-style:none;user-select:none}
.ss-toggle::-webkit-details-marker{display:none}
.ss-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:8px}
.img-panel .img-label{font-size:10px;font-weight:700;text-transform:uppercase;color:#888;margin-bottom:3px}
@media(max-width:900px){.ss-grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="header">
  <h1>Visual Regression — EDS vs Prod</h1>
  <p>Merged ${batchDirs.length} batch(es) &nbsp;·&nbsp; Generated ${new Date().toLocaleString()} &nbsp;·&nbsp; Threshold: ${THRESHOLD}% &nbsp;·&nbsp; Viewports: ${SELECTED_VIEWPORTS.join(', ')}</p>
  <p style="margin-top:3px">Prod: ${prodBase} &rarr; EDS: ${edsBase}</p>
</div>
<div class="stats">
  <div class="stat"><div class="val">${allPages.length}</div><div class="lbl">Pages</div></div>
  <div class="stat s-fail"><div class="val">${failed}</div><div class="lbl">Failed &gt;${THRESHOLD}%</div></div>
  <div class="stat s-pass"><div class="val">${passed}</div><div class="lbl">Passed</div></div>
  <div class="stat s-warn"><div class="val">${blocked}</div><div class="lbl">Prod Blocked</div></div>
  <div class="stat"><div class="val">${errors}</div><div class="lbl">Errors</div></div>
</div>
<div class="content">
  <table>
    <thead>
      <tr>
        <th style="width:85px">Viewport</th>
        <th style="width:130px">Status</th>
        <th style="width:80px">Diff %</th>
        <th>Screenshots</th>
      </tr>
    </thead>
    ${pageRows}
  </table>
</div>
</body>
</html>`;

const reportPath = path.join(mergedOutputDir, 'index.html');
writeFileSync(reportPath, html);

writeFileSync(path.join(mergedOutputDir, 'results.json'), JSON.stringify({
  meta: { ...mergedMeta, mergedAt: new Date().toISOString(), batchCount: batchDirs.length },
  pages: allPages,
}, null, 2));

// Print summary
const failedPages = allPages
  .filter(r => Object.values(r.viewports).some(v => v.status === 'FAIL'))
  .sort((a, b) => {
    const wA = Math.max(...Object.values(a.viewports).map(v => v.diffPct ?? 0));
    const wB = Math.max(...Object.values(b.viewports).map(v => v.diffPct ?? 0));
    return wB - wA;
  })
  .slice(0, 10);

console.log('\n=== Merged Visual Regression Summary ===');
console.log(`Batches merged:     ${batchDirs.length}`);
console.log(`Pages total:        ${allPages.length}`);
console.log(`Viewport checks:    ${allVp.length} (${SELECTED_VIEWPORTS.length}×${allPages.length})`);
console.log(`Passed:             ${passed}`);
console.log(`Failed (>${THRESHOLD}%):  ${failed}`);
console.log(`Prod blocked (WAF): ${blocked}`);
console.log(`Errors:             ${errors}`);

if (failedPages.length) {
  console.log('\n--- Pages with largest visual differences ---');
  failedPages.forEach(r => {
    const diffs = SELECTED_VIEWPORTS
      .filter(vp => r.viewports[vp]?.status === 'FAIL')
      .map(vp => `${vp}: ${r.viewports[vp].diffPct.toFixed(1)}%`)
      .join(', ');
    console.log(`  ${r.urlPath} — ${diffs}`);
  });
}

console.log(`\nReport: ${reportPath}`);
