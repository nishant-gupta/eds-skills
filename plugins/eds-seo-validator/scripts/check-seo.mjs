#!/usr/bin/env node
/**
 * EDS SEO Validator
 * Usage: node check-seo.mjs <sitemap-json-file> <eds-base-url> <output-csv-file>
 *
 * For each URL in the JSON array, maps it to the EDS domain, fetches HTML,
 * extracts meta tags, validates against SEO guidelines, and writes a CSV report.
 *
 * Requires Node.js 18+ (native fetch).
 */

import { readFileSync, writeFileSync } from 'fs';
import { URL } from 'url';

const [,, sitemapJsonFile, edsBaseUrl, outputCsvFile, ...flags] = process.argv;

if (!sitemapJsonFile || !edsBaseUrl || !outputCsvFile) {
  console.error('Usage: node check-seo.mjs <sitemap-json-file> <eds-base-url> <output-csv-file> [--auth=user:pass] [--auth-header="token ..."]');
  process.exit(1);
}

const urls = JSON.parse(readFileSync(sitemapJsonFile, 'utf8'));
const edsBase = edsBaseUrl.replace(/\/$/, '');

// Auth: raw Authorization header (EDS/AEM sidekick "token ..." / "Bearer ..."
// tokens) via --auth-header or EDS_AUTH env var, else HTTP Basic via --auth.
// Raw header takes precedence.
const rawAuthHeader = flags.find(f => f.startsWith('--auth-header='))?.slice('--auth-header='.length)
  || process.env.EDS_AUTH || '';
const authFlag = flags.find(f => f.startsWith('--auth='))?.slice(7) || '';
const authHeaders = rawAuthHeader
  ? { Authorization: rawAuthHeader }
  : authFlag
    ? { Authorization: 'Basic ' + Buffer.from(authFlag).toString('base64') }
    : {};
const CONCURRENCY = 5; // lower concurrency — full page fetches are heavier
const TIMEOUT_MS = 20000;

// ─── SEO Guidelines ──────────────────────────────────────────────────────────
const RULES = {
  title:              { min: 30, max: 60,  required: true  },
  description:        { min: 120, max: 160, required: true  },
  keywords:           { maxTerms: 10,       required: false },
  ogTitle:            { min: 30, max: 90,  required: true  },
  ogDescription:      { min: 120, max: 200, required: true  },
  ogImage:            { required: true, checkStatus: true   },
  ogUrl:              { required: true                       },
  ogType:             { required: true                       },
  twitterCard:        { required: true, validValues: ['summary', 'summary_large_image', 'app', 'player'] },
  twitterTitle:       { min: 30, max: 70,  required: false  },
  twitterDescription: { min: 120, max: 200, required: false  },
  twitterImage:       { required: false, checkStatus: true   },
};

// ─── HTML parser (no dependencies — regex-based) ──────────────────────────────
function extractMeta(html) {
  const get = (pattern) => {
    const m = html.match(pattern);
    return m ? m[1].trim() : '';
  };

  const metaContent = (nameOrProp, attr = 'name') => {
    const re = new RegExp(
      `<meta[^>]+${attr}=["']${nameOrProp}["'][^>]*content=["']([^"']*?)["']`,
      'i'
    );
    const re2 = new RegExp(
      `<meta[^>]+content=["']([^"']*?)["'][^>]*${attr}=["']${nameOrProp}["']`,
      'i'
    );
    return (html.match(re) || html.match(re2) || [])[1]?.trim() || '';
  };

  return {
    title:              get(/<title[^>]*>([\s\S]*?)<\/title>/i).replace(/\s+/g, ' '),
    description:        metaContent('description'),
    keywords:           metaContent('keywords'),
    ogTitle:            metaContent('og:title',            'property'),
    ogDescription:      metaContent('og:description',      'property'),
    ogImage:            metaContent('og:image',            'property'),
    ogUrl:              metaContent('og:url',              'property'),
    ogType:             metaContent('og:type',             'property'),
    twitterCard:        metaContent('twitter:card',        'name') || metaContent('twitter:card', 'property'),
    twitterTitle:       metaContent('twitter:title',       'name') || metaContent('twitter:title', 'property'),
    twitterDescription: metaContent('twitter:description', 'name') || metaContent('twitter:description', 'property'),
    twitterImage:       metaContent('twitter:image',       'name') || metaContent('twitter:image', 'property'),
  };
}

// ─── Validate meta against rules ─────────────────────────────────────────────
function validate(meta, imageStatuses) {
  const issues = [];

  const checkLength = (field, label, value) => {
    const rule = RULES[field];
    if (!value) {
      if (rule.required) issues.push(`MISSING: ${label}`);
      return;
    }
    if (rule.min && value.length < rule.min)
      issues.push(`${label} too short (${value.length} chars, min ${rule.min})`);
    if (rule.max && value.length > rule.max)
      issues.push(`${label} too long (${value.length} chars, max ${rule.max})`);
  };

  checkLength('title',              'title',              meta.title);
  checkLength('description',        'description',        meta.description);
  checkLength('ogTitle',            'og:title',           meta.ogTitle);
  checkLength('ogDescription',      'og:description',     meta.ogDescription);
  checkLength('twitterTitle',       'twitter:title',      meta.twitterTitle);
  checkLength('twitterDescription', 'twitter:description',meta.twitterDescription);

  // keywords — optional, but warn if excessive
  if (meta.keywords) {
    const terms = meta.keywords.split(',').map(k => k.trim()).filter(Boolean);
    if (terms.length > RULES.keywords.maxTerms)
      issues.push(`keywords: too many terms (${terms.length}, max ${RULES.keywords.maxTerms})`);
  }

  // required presence checks
  if (!meta.ogImage)   issues.push('MISSING: og:image');
  if (!meta.ogUrl)     issues.push('MISSING: og:url');
  if (!meta.ogType)    issues.push('MISSING: og:type');
  if (!meta.twitterCard) issues.push('MISSING: twitter:card');

  // twitter:card valid values
  if (meta.twitterCard && !RULES.twitterCard.validValues.includes(meta.twitterCard))
    issues.push(`twitter:card invalid value: "${meta.twitterCard}"`);

  // image URL status checks
  if (meta.ogImage) {
    const s = imageStatuses[meta.ogImage];
    if (s && s !== 200) issues.push(`og:image not accessible (HTTP ${s})`);
    if (!s)             issues.push(`og:image fetch failed`);
  }
  if (meta.twitterImage && meta.twitterImage !== meta.ogImage) {
    const s = imageStatuses[meta.twitterImage];
    if (s && s !== 200) issues.push(`twitter:image not accessible (HTTP ${s})`);
    if (!s)             issues.push(`twitter:image fetch failed`);
  }

  return issues;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'EDS-SEO-Validator/1.0', ...authHeaders },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { status: res.status, html: '' };
    const html = await res.text();
    return { status: res.status, html };
  } catch (err) {
    clearTimeout(timer);
    return { status: err.name === 'AbortError' ? 'TIMEOUT' : `ERROR`, html: '' };
  }
}

async function checkImageUrl(url) {
  if (!url) return null;
  // resolve relative URLs — if relative, skip
  try { new URL(url); } catch { return 'RELATIVE_URL'; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow', headers: authHeaders, signal: controller.signal });
    clearTimeout(timer);
    return res.status;
  } catch {
    clearTimeout(timer);
    return 'ERROR';
  }
}

// ─── Process one URL ──────────────────────────────────────────────────────────
async function processUrl(originalUrl) {
  let path;
  try {
    const parsed = new URL(originalUrl);
    path = parsed.pathname.replace(/\/$/, '') + (parsed.search || '');
  } catch {
    return { original_url: originalUrl, eds_url: '', http_status: 'INVALID_URL', meta: {}, issues: ['Invalid URL'] };
  }

  const edsUrl = `${edsBase}${path}`;
  const { status, html } = await fetchHtml(edsUrl);

  if (!html) {
    return { original_url: originalUrl, eds_url: edsUrl, http_status: status, meta: {}, issues: [`Page not fetched (${status})`] };
  }

  const meta = extractMeta(html);

  // collect unique image URLs to check
  const imageUrls = [...new Set([meta.ogImage, meta.twitterImage].filter(Boolean))];
  const imageStatuses = {};
  await Promise.all(imageUrls.map(async (imgUrl) => {
    imageStatuses[imgUrl] = await checkImageUrl(imgUrl);
  }));

  const issues = validate(meta, imageStatuses);

  return {
    original_url: originalUrl,
    eds_url: edsUrl,
    http_status: status,
    meta,
    og_image_status: meta.ogImage ? (imageStatuses[meta.ogImage] ?? '') : '',
    twitter_image_status: meta.twitterImage ? (imageStatuses[meta.twitterImage] ?? '') : '',
    issues,
  };
}

// ─── Concurrency runner ───────────────────────────────────────────────────────
async function runWithConcurrency(items, fn, concurrency) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
      process.stderr.write(`\r  Validating: ${idx + 1}/${items.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  process.stderr.write('\n');
  return results;
}

// ─── CSV helpers ──────────────────────────────────────────────────────────────
function csvCell(v) {
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
console.error(`\nSEO-validating ${urls.length} URLs against ${edsBase}`);
const results = await runWithConcurrency(urls, processUrl, CONCURRENCY);

const CSV_COLUMNS = [
  'original_url', 'eds_url', 'http_status',
  'title', 'title_length',
  'description', 'description_length',
  'keywords',
  'og_title', 'og_title_length',
  'og_description', 'og_description_length',
  'og_image', 'og_image_status',
  'og_url', 'og_type',
  'twitter_card',
  'twitter_title', 'twitter_title_length',
  'twitter_description', 'twitter_description_length',
  'twitter_image', 'twitter_image_status',
  'issues_count', 'issues',
];

const rows = results.map(r => {
  const m = r.meta;
  return [
    r.original_url,
    r.eds_url,
    r.http_status,
    m.title ?? '',              (m.title ?? '').length,
    m.description ?? '',        (m.description ?? '').length,
    m.keywords ?? '',
    m.ogTitle ?? '',            (m.ogTitle ?? '').length,
    m.ogDescription ?? '',      (m.ogDescription ?? '').length,
    m.ogImage ?? '',            r.og_image_status ?? '',
    m.ogUrl ?? '',              m.ogType ?? '',
    m.twitterCard ?? '',
    m.twitterTitle ?? '',       (m.twitterTitle ?? '').length,
    m.twitterDescription ?? '', (m.twitterDescription ?? '').length,
    m.twitterImage ?? '',       r.twitter_image_status ?? '',
    r.issues.length,
    r.issues.join(' | '),
  ].map(csvCell).join(',');
});

writeFileSync(outputCsvFile, [CSV_COLUMNS.map(csvCell).join(','), ...rows].join('\n') + '\n');

// ─── Summary ──────────────────────────────────────────────────────────────────
const total = results.length;
const passed   = results.filter(r => r.issues.length === 0).length;
const withIssues = total - passed;
const notFetched = results.filter(r => r.http_status !== 200).length;

// issue frequency
const issueFreq = {};
results.forEach(r => r.issues.forEach(i => {
  const key = i.replace(/\d+ chars.*/, 'N chars…').replace(/".*?"/, '"X"');
  issueFreq[key] = (issueFreq[key] || 0) + 1;
}));

console.log('\n=== SEO Validation Summary ===');
console.log(`Total pages:    ${total}`);
console.log(`Passed (no issues): ${passed}`);
console.log(`Pages with issues:  ${withIssues}`);
console.log(`Not fetched / non-200: ${notFetched}`);
console.log(`\nCSV report: ${outputCsvFile}`);

if (Object.keys(issueFreq).length) {
  console.log('\n--- Most Common Issues ---');
  Object.entries(issueFreq)
    .sort((a, b) => b[1] - a[1])
    .forEach(([issue, count]) => console.log(`  [${count}x] ${issue}`));
}

const worst = results.filter(r => r.issues.length > 0).sort((a, b) => b.issues.length - a.issues.length).slice(0, 5);
if (worst.length) {
  console.log('\n--- Pages with Most Issues ---');
  worst.forEach(r => console.log(`  ${r.eds_url} (${r.issues.length} issues)`));
}

// ─── HTML report ──────────────────────────────────────────────────────────────
const htmlPath = outputCsvFile.replace(/\.csv$/i, '.html');

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const pageLabel = r => {
  if (r.http_status !== 200) return `<span class="label label-error">ERROR</span>`;
  if (r.issues.length === 0) return `<span class="label label-pass">PASS</span>`;
  return `<span class="label label-fail">FAILED</span>`;
};

const issueBadge = issue => {
  let cat = 'other';
  if (issue.startsWith('MISSING:')) cat = 'missing';
  else if (issue.includes('too short') || issue.includes('too long')) cat = 'length';
  else if (issue.includes('not accessible') || issue.includes('fetch failed')) cat = 'image';
  const colours = { missing: '#FF0000', length: '#E68619', image: '#7326D3', other: '#1473E6' };
  return `<span style="background:${colours[cat]};color:#fff;padding:1px 5px;border-radius:3px;font-size:10px">${cat.toUpperCase()}</span> ${esc(issue)}`;
};

const sortedResults = [...results].sort((a, b) => {
  const aErr = a.http_status !== 200;
  const bErr = b.http_status !== 200;
  if (!aErr && a.issues.length > 0 && !bErr && b.issues.length > 0) return b.issues.length - a.issues.length;
  if (!aErr && a.issues.length > 0) return -1;
  if (!bErr && b.issues.length > 0) return 1;
  if (aErr && !bErr) return 1;
  if (!aErr && bErr) return -1;
  return 0;
});

const allRows = sortedResults.map(r => {
  const path = (() => { try { return new URL(r.eds_url || r.original_url).pathname; } catch (_) { return r.eds_url || r.original_url; } })();
  const issueHtml = r.issues.length
    ? `<ul style="margin:0;padding-left:16px">${r.issues.map(i => `<li>${issueBadge(i)}</li>`).join('')}</ul>`
    : '';
  const rc = r.http_status !== 200 ? 'row-error' : r.issues.length === 0 ? 'row-pass' : 'row-fail';
  return `
    <tr class="${rc}">
      <td>${pageLabel(r)}</td>
      <td><a href="${esc(r.eds_url)}" target="_blank">${esc(path)}</a></td>
      <td style="text-align:center">${r.issues.length || ''}</td>
      <td style="text-align:center">${esc(String(r.http_status))}</td>
      <td>${issueHtml}</td>
    </tr>`;
}).join('');

const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>EDS SEO Validator</title>
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
</style>
</head>
<body>
<div class="page-header">
  <div class="eyebrow">AEM Edge Delivery Services</div>
  <h1>EDS SEO Validator</h1>
  <div class="meta">Generated ${new Date().toISOString()} &nbsp;·&nbsp; ${total} pages &nbsp;·&nbsp; ${edsBase}</div>
</div>
<div class="content">
<div class="stats">
  <div class="stat"><div class="n">${total}</div><div class="l">Total Pages</div></div>
  <div class="stat"><div class="n" style="color:#2D9D78">${passed}</div><div class="l">Passed</div></div>
  <div class="stat"><div class="n" style="color:#FF0000">${withIssues - notFetched}</div><div class="l">Failed</div></div>
  <div class="stat"><div class="n" style="color:#8E8E8E">${notFetched}</div><div class="l">Not Fetched</div></div>
</div>
<h2>All pages (${total})</h2>
<table>
  <thead><tr><th>Result</th><th>Page</th><th>Issues</th><th>HTTP</th><th>Details</th></tr></thead>
  <tbody>${allRows}</tbody>
</table>
</div>
</body>
</html>`;

writeFileSync(htmlPath, htmlContent);
console.log(`\nHTML report: ${htmlPath}`);
