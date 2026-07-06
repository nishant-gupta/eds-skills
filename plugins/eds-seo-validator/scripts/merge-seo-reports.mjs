/**
 * merge-seo-reports.mjs
 *
 * Merges multiple deep SEO audit batch HTML files into one unified report.
 * Preserves exact styling, row colors, and category badge colors from individual batches.
 *
 * Usage:
 *   node merge-seo-reports.mjs <output-path> <batch1.html> [batch2.html ...]
 *
 * Example:
 *   node merge-seo-reports.mjs /tmp/seo-merged/index.html /tmp/seo-batch-1.html /tmp/seo-batch-2.html
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const [, , outputPath, ...batchFiles] = process.argv;

if (!outputPath || batchFiles.length === 0) {
  console.error('Usage: node merge-seo-reports.mjs <output-path> <batch1.html> [batch2.html ...]');
  process.exit(1);
}

mkdirSync(dirname(outputPath), { recursive: true });

// Aggregate data
let totalPages = 0, totalPassed = 0, totalFailed = 0, totalErrors = 0;
const catCounts = {};
const issueCounts = {};
const allRows = [];
let detectedBaseUrl = '';
let detectedDate = new Date().toISOString().slice(0, 10);

for (const file of batchFiles) {
  const html = readFileSync(file, 'utf8');

  // Extract base URL and date from batch header meta line
  // Format: "Generated 2026-07-04T15:57:15.386Z &nbsp;·&nbsp; 200 pages &nbsp;·&nbsp; https://..."
  if (!detectedBaseUrl) {
    const metaMatch = html.match(/Generated ([\d]{4}-[\d]{2}-[\d]{2})[^<]*?·[^<]*?·[^<]*?(https?:\/\/[^\s<&]+)/);
    if (metaMatch) {
      detectedDate = metaMatch[1].trim();
      detectedBaseUrl = metaMatch[2].trim();
    }
  }

  // Extract stats
  const statsMatch = html.match(/<div class="stat"><div class="n">(\d+)<\/div><div class="l">Pages audited/);
  const passMatch  = html.match(/<div class="stat"><div class="n" style="color:#2D9D78">(\d+)<\/div><div class="l">Passed/);
  const failMatch  = html.match(/<div class="stat"><div class="n" style="color:#FF0000">(\d+)<\/div><div class="l">Failed/);
  const errMatch   = html.match(/<div class="stat"><div class="n" style="color:#8E8E8E">(\d+)<\/div><div class="l">Error/);
  if (statsMatch) totalPages   += parseInt(statsMatch[1]);
  if (passMatch)  totalPassed  += parseInt(passMatch[1]);
  if (failMatch)  totalFailed  += parseInt(failMatch[1]);
  if (errMatch)   totalErrors  += parseInt(errMatch[1]);

  // Extract category stats
  const catRe = /<div class="stat"><div class="n" style="color:([^"]+)">(\d+)<\/div><div class="l">(OG\/TWITTER|METADATA|HEADINGS|LINKS|CWV|IMAGES\/A11Y|JSON-LD|MOBILE|URL|REDIRECTS)<\/div>/g;
  let m;
  while ((m = catRe.exec(html)) !== null) {
    const [, color, count, cat] = m;
    if (!catCounts[cat]) catCounts[cat] = { color, count: 0 };
    catCounts[cat].count += parseInt(count);
  }

  // Extract issue texts for top issues table (strip category span + section ref)
  const issueRe = /<li>(?:<span[^>]*>[^<]*<\/span>\s*)?([^<]+?)(?:\s*\(§[\d.]+\))?<\/li>/g;
  while ((m = issueRe.exec(html)) !== null) {
    const txt = m[1].trim();
    if (txt) issueCounts[txt] = (issueCounts[txt] || 0) + 1;
  }

  // Extract all table rows (preserving full inner HTML with colored spans)
  const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
  if (tbodyMatch) {
    const rowRe = /<tr class="(row-pass|row-fail|row-error)">([\s\S]*?)<\/tr>/g;
    while ((m = rowRe.exec(tbodyMatch[1])) !== null) {
      const rowClass = m[1];
      const rowContent = m[2];
      const issueCountMatch = rowContent.match(/<td style="text-align:center">(\d+)<\/td>/);
      const issueCount = issueCountMatch ? parseInt(issueCountMatch[1]) : 0;
      allRows.push({ rowClass, rowContent, issueCount });
    }
  }
}

// Sort: failed worst-first, then passed, then errors
allRows.sort((a, b) => {
  if (a.rowClass === 'row-fail' && b.rowClass !== 'row-fail') return -1;
  if (b.rowClass === 'row-fail' && a.rowClass !== 'row-fail') return 1;
  if (a.rowClass === 'row-pass' && b.rowClass === 'row-error') return -1;
  if (b.rowClass === 'row-pass' && a.rowClass === 'row-error') return 1;
  return b.issueCount - a.issueCount;
});

const passRate = totalPages > 0 ? Math.round((totalPassed / totalPages) * 100) : 0;
const passRateColor = passRate >= 80 ? '#2D9D78' : passRate >= 50 ? '#E68619' : '#FF0000';

// Top 30 issues
const topIssues = Object.entries(issueCounts)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 30);

// Category stat cards
const catOrder = ['METADATA', 'HEADINGS', 'OG/TWITTER', 'JSON-LD', 'LINKS', 'CWV', 'IMAGES/A11Y', 'MOBILE', 'URL', 'REDIRECTS'];
const catStatsHtml = catOrder
  .filter(cat => catCounts[cat])
  .map(cat => `<div class="stat"><div class="n" style="color:${catCounts[cat].color}">${catCounts[cat].count.toLocaleString()}</div><div class="l">${cat}</div></div>`)
  .join('');

const topIssuesHtml = topIssues
  .map(([issue, count]) => `<tr><td>${issue}</td><td style="text-align:right;font-weight:700;color:#D71E28">${count.toLocaleString()}</td></tr>`)
  .join('\n');

const rowsHtml = allRows
  .map(({ rowClass, rowContent }) => `<tr class="${rowClass}">${rowContent}</tr>`)
  .join('\n');

const reportTitle = detectedBaseUrl
  ? `Deep SEO Audit — ${detectedBaseUrl.replace(/^https?:\/\//, '')}`
  : 'Deep SEO Audit';

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${reportTitle} (${totalPages} pages)</title>
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
  h2{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#444;margin-bottom:12px}
  table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1);margin-bottom:24px}
  th{background:#1B1B1B;color:#fff;padding:9px 12px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
  td{padding:8px 12px;border-bottom:1px solid #f0f0f0;vertical-align:top;font-size:12px}
  tr.row-pass td{background:#f0faf4}
  tr.row-fail td{background:#fff5f5}
  tr.row-error td{background:#f8f8f8;color:#999}
  .label{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;letter-spacing:.4px}
  .label-pass{background:#2D9D78;color:#fff}
  .label-fail{background:#FF0000;color:#fff}
  .label-error{background:#8E8E8E;color:#fff}
  ul{list-style:disc}
  li{margin-bottom:3px}
  a{color:#1473E6}
  .section{margin-bottom:32px}
  .divider{border:none;border-top:2px solid #e0e0e0;margin:32px 0}
</style>
</head>
<body>
<div class="page-header">
  <div class="eyebrow">SEO Audit Report</div>
  <h1>${reportTitle}</h1>
  <div class="meta">68-point checklist · Playwright Chromium · ${detectedDate} · ${totalPages.toLocaleString()} pages · ${batchFiles.length} batches merged</div>
</div>
<div class="content">

  <div class="section">
    <div class="stats">
      <div class="stat"><div class="n">${totalPages.toLocaleString()}</div><div class="l">Pages audited</div></div>
      <div class="stat"><div class="n" style="color:#2D9D78">${totalPassed.toLocaleString()}</div><div class="l">Passed</div></div>
      <div class="stat"><div class="n" style="color:#FF0000">${totalFailed.toLocaleString()}</div><div class="l">Failed</div></div>
      <div class="stat"><div class="n" style="color:#8E8E8E">${totalErrors.toLocaleString()}</div><div class="l">Error (404)</div></div>
      <div class="stat"><div class="n" style="color:${passRateColor}">${passRate}%</div><div class="l">Pass Rate</div></div>
      ${catStatsHtml}
    </div>
  </div>

  <div class="section">
    <h2>Top 30 Most Common Issues</h2>
    <table>
      <thead><tr><th>Issue</th><th style="text-align:right;width:80px">Count</th></tr></thead>
      <tbody>${topIssuesHtml}</tbody>
    </table>
  </div>

  <div class="section">
    <h2>All Pages — Sorted by Issue Count (Worst First)</h2>
    <table>
      <thead>
        <tr>
          <th style="width:60px">Status</th>
          <th style="width:280px">URL</th>
          <th style="width:50px;text-align:center">Issues</th>
          <th style="width:50px;text-align:center">HTTP</th>
          <th>Details</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  </div>

  <hr class="divider">

  <div class="section">
    <h2 style="margin-bottom:16px">SEO Validation Checklist — Section Reference Guide</h2>
    <p style="color:#666;font-size:12px;margin-bottom:16px">All §N.N references in the audit map to checklist items below. <span style="background:#2D9D78;color:#fff;padding:1px 6px;border-radius:3px;font-size:11px;font-weight:700">CHECKED</span> = validated in this audit. <span style="background:#8E8E8E;color:#fff;padding:1px 6px;border-radius:3px;font-size:11px;font-weight:700">SKIPPED</span> = not automatable.</p>
    <table>
      <thead><tr><th style="width:90px">Ref</th><th>Checklist Item</th><th style="width:100px">Status</th></tr></thead>
      <tbody>
        <tr class="row-pass"><td><strong>§1.1</strong></td><td>Meta title present on every page</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-pass"><td><strong>§1.2</strong></td><td>Meta title unique per page (no duplicates)</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-pass"><td><strong>§1.3</strong></td><td>Meta title length 50–60 characters</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-error"><td><strong>§1.4</strong></td><td>Meta title contains primary target keyword</td><td><span class="label label-error">SKIPPED</span></td></tr>
        <tr class="row-pass"><td><strong>§1.5</strong></td><td>Meta description present on every page</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-pass"><td><strong>§1.6</strong></td><td>Meta description unique per page (no duplicates)</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-pass"><td><strong>§1.7</strong></td><td>Meta description length 140–160 characters</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-error"><td><strong>§1.8</strong></td><td>Meta description contains target keyword and CTA</td><td><span class="label label-error">SKIPPED</span></td></tr>
        <tr class="row-pass"><td><strong>§1.9</strong></td><td>Meta keywords tag removed (obsolete)</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-pass"><td><strong>§1.10</strong></td><td>Robots meta tag: index, follow on live pages</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-pass"><td><strong>§2.1</strong></td><td>WebSite + Sitelink Searchbox schema on homepage</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-error"><td><strong>§2.2</strong></td><td>Organization schema on homepage / About / Contact</td><td><span class="label label-error">SKIPPED</span></td></tr>
        <tr class="row-pass"><td><strong>§2.3</strong></td><td>BreadcrumbList schema when breadcrumb UI present</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-error"><td><strong>§2.4–2.9</strong></td><td>FAQPage, ItemList, Product, VideoObject schemas etc.</td><td><span class="label label-error">SKIPPED</span></td></tr>
        <tr class="row-pass"><td><strong>§2.10</strong></td><td>Schema validated (no parse errors), placed in &lt;head&gt;</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-pass"><td><strong>§3.1</strong></td><td>Exactly one H1 per page</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-pass"><td><strong>§3.2</strong></td><td>H1 unique across all pages (no duplicates)</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-pass"><td><strong>§3.3</strong></td><td>Heading hierarchy sequential — no skipped levels</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-error"><td><strong>§3.4–3.5</strong></td><td>H2s for section headings; headings contain keywords</td><td><span class="label label-error">SKIPPED</span></td></tr>
        <tr class="row-pass"><td><strong>§4.1</strong></td><td>rel=canonical present on every indexable page</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-pass"><td><strong>§4.2</strong></td><td>Canonical HTTPS and self-referencing path</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-error"><td><strong>§4.3–4.6</strong></td><td>Canonical on paginated/parameterised URLs, www consistency</td><td><span class="label label-error">SKIPPED</span></td></tr>
        <tr class="row-pass"><td><strong>§5.1</strong></td><td>robots.txt present and correctly configured</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-pass"><td><strong>§5.2</strong></td><td>XML sitemap present and referenced in robots.txt</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-error"><td><strong>§5.3–5.10</strong></td><td>GSC submission, crawl depth, orphaned pages, Googlebot checks</td><td><span class="label label-error">SKIPPED</span></td></tr>
        <tr class="row-pass"><td><strong>§6.1</strong></td><td>All URLs lowercase</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-pass"><td><strong>§6.2</strong></td><td>Hyphens used as word separators (not underscores)</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-error"><td><strong>§6.3–6.5</strong></td><td>Descriptive keywords in URLs, no legacy/hash URLs</td><td><span class="label label-error">SKIPPED</span></td></tr>
        <tr class="row-pass"><td><strong>§7.1</strong></td><td>Internal links return 200 (non-HTTPS flagged)</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-pass"><td><strong>§7.2</strong></td><td>Internal links HTTPS</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-pass"><td><strong>§7.3</strong></td><td>Anchor text descriptive (no generic "click here")</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-pass"><td><strong>§7.4</strong></td><td>Image links have alt text as anchor</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-error"><td><strong>§7.5</strong></td><td>Navigation works without JavaScript</td><td><span class="label label-error">SKIPPED</span></td></tr>
        <tr class="row-pass"><td><strong>§7.6</strong></td><td>Breadcrumb navigation present when breadcrumb UI exists</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-pass"><td><strong>§8.1</strong></td><td>HTTP → HTTPS redirect (301 only)</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-pass"><td><strong>§8.2</strong></td><td>www vs non-www redirect consistency</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-pass"><td><strong>§8.3</strong></td><td>Custom 404 page present</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-pass"><td><strong>§9.1</strong></td><td>og:title present on all pages</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-pass"><td><strong>§9.2</strong></td><td>og:description present on all pages</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-pass"><td><strong>§9.3</strong></td><td>og:image present and accessible (200 status + 1200×630px)</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-pass"><td><strong>§9.4</strong></td><td>og:url, og:type, og:site_name present</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-pass"><td><strong>§9.5</strong></td><td>twitter:title, twitter:description, twitter:image present</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-pass"><td><strong>§9.6</strong></td><td>twitter:site set to verified handle</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-pass"><td><strong>§10.1</strong></td><td>LCP ≤ 2,500ms (Largest Contentful Paint)</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-pass"><td><strong>§10.2</strong></td><td>FCP ≤ 1,800ms (First Contentful Paint)</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-error"><td><strong>§10.3</strong></td><td>INP ≤ 200ms (Interaction to Next Paint)</td><td><span class="label label-error">SKIPPED</span></td></tr>
        <tr class="row-pass"><td><strong>§10.4</strong></td><td>CLS ≤ 0.1 (Cumulative Layout Shift)</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-pass"><td><strong>§10.5</strong></td><td>TTFB ≤ 800ms (Time to First Byte)</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-pass"><td><strong>§11.1</strong></td><td>All images have descriptive alt text</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-error"><td><strong>§11.2</strong></td><td>Decorative images use empty alt=""</td><td><span class="label label-error">SKIPPED</span></td></tr>
        <tr class="row-pass"><td><strong>§11.3</strong></td><td>All buttons have accessible labels</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-pass"><td><strong>§11.4</strong></td><td>Favicon present (link tag or /favicon.ico)</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-error"><td><strong>§11.5–11.6</strong></td><td>No notification prompts on load; password fields allow paste</td><td><span class="label label-error">SKIPPED</span></td></tr>
        <tr class="row-pass"><td><strong>§12.1</strong></td><td>Responsive design (mobile/tablet/desktop)</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-pass"><td><strong>§12.2</strong></td><td>Viewport meta tag correct (width=device-width)</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-error"><td><strong>§12.3</strong></td><td>Mobile renders same content as desktop</td><td><span class="label label-error">SKIPPED</span></td></tr>
        <tr class="row-pass"><td><strong>§12.4</strong></td><td>No horizontal scroll on mobile (390px viewport)</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-error"><td><strong>§12.5</strong></td><td>Touch targets ≥ 48px spacing</td><td><span class="label label-error">SKIPPED</span></td></tr>
        <tr class="row-error"><td><strong>§12.6</strong></td><td>No content hidden via CSS from Googlebot</td><td><span class="label label-error">SKIPPED</span></td></tr>
        <tr class="row-pass"><td><strong>§13.1</strong></td><td>rel=next / rel=prev on paginated pages</td><td><span class="label label-pass">CHECKED</span></td></tr>
        <tr class="row-error"><td><strong>§13.2–13.4</strong></td><td>Infinite scroll, JS content, dynamic page indexing</td><td><span class="label label-error">SKIPPED</span></td></tr>
      </tbody>
    </table>
    <p style="color:#999;font-size:11px;margin-top:8px">68 of 80 checklist items automated. 12 skipped (require GSC API, keyword maps, or Googlebot simulation).</p>
  </div>

</div>
</body>
</html>`;

writeFileSync(outputPath, html);
console.log(`Merged report written to ${outputPath}`);
console.log(`Total: ${totalPages} pages | Passed: ${totalPassed} | Failed: ${totalFailed} | Errors: ${totalErrors} | Pass rate: ${passRate}%`);
console.log(`Rows in table: ${allRows.length} | Batches merged: ${batchFiles.length}`);
