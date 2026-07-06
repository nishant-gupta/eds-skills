#!/usr/bin/env node
/**
 * EDS Sitemap URL Checker
 * Usage: node check-urls.js <sitemap-json-file> <eds-base-url> <output-csv-file>
 *
 * Reads URLs from a JSON file, maps them to the EDS domain, checks HTTP status,
 * writes results to CSV, and prints a summary.
 */

import { readFileSync, writeFileSync } from 'fs';
import { URL } from 'url';

const [,, sitemapJsonFile, edsBaseUrl, outputCsvFile, ...flags] = process.argv;

if (!sitemapJsonFile || !edsBaseUrl || !outputCsvFile) {
  console.error('Usage: node check-urls.js <sitemap-json-file> <eds-base-url> <output-csv-file> [--auth=user:pass] [--auth-header="<raw Authorization value>"]');
  console.error('  --auth=user:pass          HTTP Basic auth (htaccess-protected environments)');
  console.error('  --auth-header="token abc" Raw Authorization header value, sent verbatim');
  console.error('                            (supports EDS/AEM sidekick "token ..." and "Bearer ..." tokens)');
  process.exit(1);
}

const urls = JSON.parse(readFileSync(sitemapJsonFile, 'utf8'));
const edsBase = edsBaseUrl.replace(/\/$/, '');

// Auth: either a raw Authorization header value (--auth-header, for EDS/AEM
// sidekick "token ..." / "Bearer ..." tokens) or HTTP Basic (--auth=user:pass).
// --auth-header takes precedence and is also read from the EDS_AUTH env var so
// tokens need not appear in the process argument list.
const rawAuthHeader = flags.find(f => f.startsWith('--auth-header='))?.slice('--auth-header='.length)
  || process.env.EDS_AUTH || '';
const basicFlag = flags.find(f => f.startsWith('--auth='))?.slice(7) || '';
let authHeaders = {};
if (rawAuthHeader) {
  authHeaders = { Authorization: rawAuthHeader };
} else if (basicFlag) {
  authHeaders = { Authorization: 'Basic ' + Buffer.from(basicFlag).toString('base64') };
}

const CONCURRENCY = 10;
const TIMEOUT_MS = 15000;

async function checkUrl(originalUrl) {
  let path;
  try {
    const parsed = new URL(originalUrl);
    const stripped = parsed.pathname === '/' ? '/' : parsed.pathname.replace(/\/$/, '');
    path = stripped + (parsed.search || '');
  } catch {
    return { original_url: originalUrl, eds_url: '', status: 'INVALID_URL', redirect_location: '' };
  }

  const edsUrl = `${edsBase}${path}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(edsUrl, {
      method: 'HEAD',
      redirect: 'manual',
      headers: authHeaders,
      signal: controller.signal,
    });
    clearTimeout(timer);

    const status = response.status;
    let category;
    if (status === 200) category = '200';
    else if (status === 301 || status === 302 || status === 307 || status === 308) category = `REDIRECT_${status}`;
    else if (status === 404) category = '404';
    else category = `OTHER_${status}`;

    const redirectLocation = (status >= 300 && status < 400) ? (response.headers.get('location') || '') : '';

    return { original_url: originalUrl, eds_url: edsUrl, status: category, redirect_location: redirectLocation };
  } catch (err) {
    const errType = err.name === 'AbortError' ? 'TIMEOUT' : `ERROR: ${err.message.slice(0, 60)}`;
    return { original_url: originalUrl, eds_url: edsUrl, status: errType, redirect_location: '' };
  }
}

async function runWithConcurrency(items, fn, concurrency) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
      const pct = Math.round(((idx + 1) / items.length) * 100);
      process.stderr.write(`\r  Checking URLs: ${idx + 1}/${items.length} (${pct}%)`);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  process.stderr.write('\n');
  return results;
}

console.error(`\nChecking ${urls.length} URLs against EDS domain: ${edsBase}`);
const results = await runWithConcurrency(urls, checkUrl, CONCURRENCY);

// Write CSV
const header = 'original_url,eds_url,status,redirect_location';
const rows = results.map(r =>
  [r.original_url, r.eds_url, r.status, r.redirect_location]
    .map(v => `"${String(v).replace(/"/g, '""')}"`)
    .join(',')
);
writeFileSync(outputCsvFile, [header, ...rows].join('\n') + '\n');

// Summary
const total = results.length;
const ok = results.filter(r => r.status === '200').length;
const notFound = results.filter(r => r.status === '404').length;
const redirects = results.filter(r => r.status.startsWith('REDIRECT_')).length;
const errors = total - ok - notFound - redirects;

console.log('\n=== URL Check Summary ===');
console.log(`Total pages:  ${total}`);
console.log(`200 OK:       ${ok}`);
console.log(`404 Not Found:${notFound}`);
console.log(`Redirects:    ${redirects}`);
console.log(`Other errors: ${errors}`);
console.log(`\nCSV written to: ${outputCsvFile}`);

if (notFound > 0) {
  console.log('\n--- 404 URLs ---');
  results.filter(r => r.status === '404').forEach(r => console.log(`  ${r.eds_url}`));
}
if (redirects > 0) {
  console.log('\n--- Redirects ---');
  results.filter(r => r.status.startsWith('REDIRECT_')).forEach(r =>
    console.log(`  ${r.eds_url} → ${r.redirect_location} (${r.status})`)
  );
}
if (errors > 0) {
  console.log('\n--- Other Errors ---');
  results.filter(r => r.status !== '200' && r.status !== '404' && !r.status.startsWith('REDIRECT_')).forEach(r =>
    console.log(`  ${r.eds_url} [${r.status}]`)
  );
}

// ─── HTML report ──────────────────────────────────────────────────────────────
const htmlPath = outputCsvFile.replace(/\.csv$/i, '.html');

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const statusLabel = r => {
  if (r.status === '200') return `<span class="label label-live">LIVE</span>`;
  if (r.status === '404') return `<span class="label label-404">404</span>`;
  if (r.status.startsWith('REDIRECT_')) return `<span class="label label-redirect">REDIRECT</span>`;
  return `<span class="label label-error">ERROR</span>`;
};

const rowClass = r => {
  if (r.status === '200') return 'row-live';
  if (r.status === '404') return 'row-404';
  if (r.status.startsWith('REDIRECT_')) return 'row-redirect';
  return 'row-error';
};

const sortPriority = r => {
  if (r.status === '404') return 0;
  if (r.status.startsWith('REDIRECT_')) return 1;
  if (r.status !== '200') return 2;
  return 3;
};

const allRows = [...results]
  .sort((a, b) => sortPriority(a) - sortPriority(b))
  .map(r => {
    const path = (() => { try { return new URL(r.eds_url).pathname; } catch (_) { return r.eds_url; } })();
    const redirectCell = r.redirect_location
      ? `<a href="${esc(r.redirect_location)}" target="_blank">${esc(r.redirect_location)}</a>` : '';
    return `
      <tr class="${rowClass(r)}">
        <td>${statusLabel(r)}</td>
        <td><a href="${esc(r.eds_url)}" target="_blank">${esc(path)}</a></td>
        <td style="text-align:center">${esc(r.status)}</td>
        <td>${redirectCell}</td>
      </tr>`;
  }).join('');

const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>EDS Sitemap Checker</title>
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
  table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)}
  th{background:#1B1B1B;color:#fff;padding:9px 12px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
  td{padding:8px 12px;border-bottom:1px solid #f0f0f0;vertical-align:top;font-size:12px}
  tr.row-live td{background:#f0faf4}
  tr.row-404 td{background:#fff5f5}
  tr.row-redirect td{background:#fffbf0}
  tr.row-error td{background:#f8f8f8;color:#999}
  .label{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;letter-spacing:.4px}
  .label-live{background:#2D9D78;color:#fff}
  .label-404{background:#FF0000;color:#fff}
  .label-redirect{background:#E68619;color:#fff}
  .label-error{background:#8E8E8E;color:#fff}
  a{color:#1473E6}
</style>
</head>
<body>
<div class="page-header">
  <div class="eyebrow">AEM Edge Delivery Services</div>
  <h1>EDS Sitemap Checker</h1>
  <div class="meta">Generated ${new Date().toISOString()} &nbsp;·&nbsp; ${total} URLs &nbsp;·&nbsp; ${edsBase}</div>
</div>
<div class="content">
<div class="stats">
  <div class="stat"><div class="n">${total}</div><div class="l">Total URLs</div></div>
  <div class="stat"><div class="n" style="color:#2D9D78">${ok}</div><div class="l">Live (200)</div></div>
  <div class="stat"><div class="n" style="color:#FF0000">${notFound}</div><div class="l">Not Found (404)</div></div>
  <div class="stat"><div class="n" style="color:#E68619">${redirects}</div><div class="l">Redirects</div></div>
  <div class="stat"><div class="n" style="color:#8E8E8E">${errors}</div><div class="l">Errors / Timeouts</div></div>
</div>
<h2>All URLs (${total})</h2>
<table>
  <thead><tr><th>Result</th><th>EDS URL</th><th>Status</th><th>Redirect Target</th></tr></thead>
  <tbody>${allRows}</tbody>
</table>
</div>
</body>
</html>`;

writeFileSync(htmlPath, htmlContent);
console.log(`HTML report: ${htmlPath}`);
