#!/usr/bin/env node
/**
 * Fast content comparison: HTTP fetch + text extraction + Jaccard similarity.
 * No browser dependencies — uses Node.js built-in fetch.
 *
 * Usage:
 *   node check-content.mjs <sitemap-json> <prod-base-url> <eds-base-url> <output-dir>
 *     [--threshold=90] [--concurrency=5] [--max=N] [--offset=N]
 *     [--auth-prod=user:pass] [--auth-eds=user:pass]
 */

import { writeFileSync, mkdirSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { URL as URLClass } from 'url';

const require = createRequire(import.meta.url);

const [,, SITEMAP_JSON, PROD_BASE, EDS_BASE, OUTPUT_DIR, ...flags] = process.argv;

if (!SITEMAP_JSON || !PROD_BASE || !EDS_BASE || !OUTPUT_DIR) {
  console.error('Usage: node check-content.mjs <sitemap-json> <prod-base> <eds-base> <output-dir> [options]');
  console.error('Options: --threshold=90 --concurrency=5 --max=N --offset=N');
  console.error('  Basic auth:  --auth-prod=user:pass --auth-eds=user:pass');
  console.error('  Token auth:  --auth-header-prod="token ..." --auth-header-eds="token ..." (or env PROD_AUTH / EDS_AUTH)');
  process.exit(1);
}

const opt = name => {
  const f = flags.find(f => f.startsWith(`--${name}=`));
  return f ? f.split('=').slice(1).join('=') : null;
};

const THRESHOLD    = parseFloat(opt('threshold') ?? '90');
const CONCURRENCY  = parseInt(opt('concurrency') ?? '5');
const MAX_PAGES    = parseInt(opt('max') ?? '999999');
const OFFSET       = parseInt(opt('offset') ?? '0');
const AUTH_PROD    = opt('auth-prod');
const AUTH_EDS     = opt('auth-eds');
// Raw Authorization header (EDS/AEM sidekick "token ..." / "Bearer ..." tokens).
// Flags take precedence, then env vars. Raw header wins over Basic user:pass.
const AUTH_HEADER_PROD = opt('auth-header-prod') ?? process.env.PROD_AUTH ?? null;
const AUTH_HEADER_EDS  = opt('auth-header-eds')  ?? process.env.EDS_AUTH  ?? null;

const allUrls = require(path.resolve(SITEMAP_JSON));
const urls    = allUrls.slice(OFFSET, OFFSET + MAX_PAGES);

mkdirSync(OUTPUT_DIR, { recursive: true });

// ─── HTTP fetch ───────────────────────────────────────────────────────────────

const WAF_SIGNALS = ['Request Rejected', 'Access Denied', '403 Forbidden', 'blocked', 'Forbidden'];

function basicHeader(creds) {
  if (!creds) return null;
  const [user, ...rest] = creds.split(':');
  return 'Basic ' + Buffer.from(`${user}:${rest.join(':')}`).toString('base64');
}

// Resolve the Authorization header value for a target: raw token header if given,
// otherwise a Basic header built from user:pass. Returns null when neither is set.
const PROD_AUTH_VALUE = AUTH_HEADER_PROD || basicHeader(AUTH_PROD);
const EDS_AUTH_VALUE  = AUTH_HEADER_EDS  || basicHeader(AUTH_EDS);

async function fetchHtml(url, authValue) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml',
  };
  if (authValue) headers['Authorization'] = authValue;

  try {
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), 25000);
    const res = await fetch(url, { headers, signal: ac.signal, redirect: 'follow' });
    clearTimeout(tid);
    const text = await res.text();
    const blocked = res.status === 403 || WAF_SIGNALS.some(s => text.includes(s));
    return { status: res.status, html: blocked ? null : text, blocked };
  } catch (err) {
    return { status: 0, html: null, error: err.message };
  }
}

// ─── Text extraction ──────────────────────────────────────────────────────────

function stripBlocks(html, ...tags) {
  let h = html;
  for (const tag of tags) {
    h = h.replace(new RegExp(`<${tag}[\\s>][\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
  }
  return h;
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, ' ');
}

function wordSet(text) {
  return new Set(
    decodeEntities(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2),
  );
}

function jaccard(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1.0;
  if (setA.size === 0 || setB.size === 0) return 0.0;
  let inter = 0;
  for (const w of setA) if (setB.has(w)) inter++;
  return inter / (setA.size + setB.size - inter);
}

function extractMain(html) {
  const m = html.match(/<main[\s>]([\s\S]*?)<\/main>/i);
  return m ? m[1] : html;
}

function extractContent(html) {
  let h = stripBlocks(extractMain(html), 'script', 'style', 'nav', 'header', 'footer', 'noscript', 'iframe', 'svg', 'sup');

  // Headings
  const headings = [];
  for (const m of h.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const text = decodeEntities(stripTags(m[2])).replace(/\s+/g, ' ').trim();
    if (text) headings.push({ level: parseInt(m[1]), text });
  }

  // CTAs — buttons and standalone links (not nav links already stripped)
  const ctas = [];
  for (const m of h.matchAll(/<(?:button|a)[^>]*>([\s\S]*?)<\/(?:button|a)>/gi)) {
    const text = decodeEntities(stripTags(m[1])).replace(/\s+/g, ' ').trim();
    if (text && text.length > 1 && text.length < 120) ctas.push(text);
  }

  const fullText = decodeEntities(stripTags(h)).replace(/\s+/g, ' ').trim();
  const words = wordSet(fullText);
  const wordCount = fullText.split(/\s+/).filter(Boolean).length;

  return { headings, ctas, words, wordCount };
}

// Extract sections: heading (H1–H3) + text content that follows it
function extractSections(html) {
  let h = stripBlocks(extractMain(html), 'script', 'style', 'nav', 'header', 'footer', 'noscript', 'iframe', 'sup');

  const positions = [];
  for (const m of h.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const text = decodeEntities(stripTags(m[2])).replace(/\s+/g, ' ').trim();
    if (text) positions.push({ pos: m.index, end: m.index + m[0].length, level: parseInt(m[1]), text });
  }

  return positions.map((p, i) => {
    const sliceEnd = i + 1 < positions.length ? positions[i + 1].pos : h.length;
    const content = decodeEntities(stripTags(h.slice(p.end, sliceEnd))).replace(/\s+/g, ' ').trim();
    return { heading: p.text, level: p.level, content };
  });
}

// ─── Comparison ───────────────────────────────────────────────────────────────

function compareContent(prodHtml, edsHtml, threshold) {
  const prod = extractContent(prodHtml);
  const eds  = extractContent(edsHtml);

  const overallSim = jaccard(prod.words, eds.words) * 100;

  // Heading match
  const prodHeadingTexts = prod.headings.map(h => h.text.toLowerCase());
  const edsHeadingSet    = new Set(eds.headings.map(h => h.text.toLowerCase()));
  const missingHeadings  = prod.headings
    .filter(h => !edsHeadingSet.has(h.text.toLowerCase()))
    .map(h => h.text);

  // Word count delta
  const wordCountDelta = prod.wordCount > 0
    ? ((eds.wordCount - prod.wordCount) / prod.wordCount * 100)
    : 0;

  // CTA match rate
  const edsCtas    = new Set(eds.ctas.map(c => c.toLowerCase()));
  const ctaMatches = prod.ctas.filter(c => edsCtas.has(c.toLowerCase()));
  const ctaMatchRate = prod.ctas.length > 0
    ? (ctaMatches.length / prod.ctas.length * 100)
    : 100;

  // Section-level comparison
  const prodSections = extractSections(prodHtml);
  const edsSections  = extractSections(edsHtml);
  const edsSectionMap = new Map(edsSections.map(s => [s.heading.toLowerCase(), s]));

  const sectionResults = prodSections.map(ps => {
    const es  = edsSectionMap.get(ps.heading.toLowerCase());
    if (!es) return { heading: ps.heading, status: 'MISSING', sim: 0 };
    // Skip sections with too few words — Jaccard is unreliable on very short text
    if (wordSet(ps.content).size < 8) return { heading: ps.heading, status: 'SKIPPED', sim: null };
    const sim = jaccard(wordSet(ps.content), wordSet(es.content)) * 100;
    const status = sim >= threshold ? 'MATCH' : sim >= 50 ? 'PARTIAL' : 'MISMATCH';
    return { heading: ps.heading, status, sim };
  });

  let status;
  if (overallSim >= threshold) status = 'MATCH';
  else if (overallSim >= 50)   status = 'PARTIAL';
  else                          status = 'MISMATCH';

  return {
    status,
    overallSim,
    prodWordCount: prod.wordCount,
    edsWordCount:  eds.wordCount,
    wordCountDelta,
    prodHeadingCount:   prod.headings.length,
    edsHeadingCount:    eds.headings.length,
    matchedHeadingCount: prod.headings.length - missingHeadings.length,
    missingHeadings,
    ctaMatchRate,
    prodCtaCount: prod.ctas.length,
    edsCtaCount:  eds.ctas.length,
    prodH1: prod.headings.find(h => h.level === 1)?.text ?? '',
    edsH1:  eds.headings.find(h => h.level === 1)?.text ?? '',
    sectionResults,
  };
}

// ─── Process URLs ─────────────────────────────────────────────────────────────

async function processUrl(url, idx) {
  const urlPath = new URLClass(url).pathname;
  const edsPath = urlPath.length > 1 ? urlPath.replace(/\/$/, '') : urlPath;
  const prodUrl = PROD_BASE.replace(/\/$/, '') + urlPath;
  const edsUrl  = EDS_BASE.replace(/\/$/, '') + edsPath;
  const slug    = `page-${String(OFFSET + idx + 1).padStart(4, '0')}`;

  process.stderr.write(`[${OFFSET + idx + 1}/${OFFSET + urls.length}] ${urlPath}\n`);

  const [prodRes, edsRes] = await Promise.all([
    fetchHtml(prodUrl, PROD_AUTH_VALUE),
    fetchHtml(edsUrl,  EDS_AUTH_VALUE),
  ]);

  if (prodRes.blocked) {
    return { slug, urlPath, prodUrl, edsUrl, status: 'PROD_BLOCKED', overallSim: null };
  }
  if (prodRes.error || !prodRes.html) {
    return { slug, urlPath, prodUrl, edsUrl, status: 'ERROR', error: prodRes.error ?? 'no html', overallSim: null };
  }
  if (edsRes.status === 404) {
    return { slug, urlPath, prodUrl, edsUrl, status: 'EDS_NOT_FOUND', edsStatus: 404, overallSim: null };
  }
  if (edsRes.error || !edsRes.html) {
    return { slug, urlPath, prodUrl, edsUrl, status: 'ERROR', error: edsRes.error ?? 'no html', overallSim: null };
  }

  try {
    const comparison = compareContent(prodRes.html, edsRes.html, THRESHOLD);
    return { slug, urlPath, prodUrl, edsUrl, ...comparison };
  } catch (err) {
    return { slug, urlPath, prodUrl, edsUrl, status: 'COMPARE_ERROR', error: err.message, overallSim: null };
  }
}

// ─── Batched concurrency ──────────────────────────────────────────────────────

const results = [];
for (let i = 0; i < urls.length; i += CONCURRENCY) {
  const batch = urls.slice(i, i + CONCURRENCY);
  const batchResults = await Promise.all(batch.map((url, j) => processUrl(url, i + j)));
  results.push(...batchResults);
}

// ─── CSV output ───────────────────────────────────────────────────────────────

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
const csvRows = results.map(r => [
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

const csvPath = path.join(OUTPUT_DIR, 'content-report.csv');
writeFileSync(csvPath, [csvHeaders.join(','), ...csvRows].join('\n'));

// ─── results.json ─────────────────────────────────────────────────────────────

writeFileSync(path.join(OUTPUT_DIR, 'results.json'), JSON.stringify({
  meta: {
    prodBase: PROD_BASE, edsBase: EDS_BASE,
    threshold: THRESHOLD, mode: 'fast',
    offset: OFFSET, generatedAt: new Date().toISOString(),
  },
  pages: results,
}, null, 2));

// ─── HTML report ──────────────────────────────────────────────────────────────

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const BADGE = {
  MATCH:         ['#2D9D78', 'MATCH'],
  PARTIAL:       ['#E68619', 'PARTIAL'],
  MISMATCH:      ['#FF0000', 'MISMATCH'],
  PROD_BLOCKED:  ['#E68619', 'PROD BLOCKED'],
  EDS_NOT_FOUND: ['#9c27b0', 'EDS 404'],
  ERROR:         ['#8E8E8E', 'ERROR'],
  COMPARE_ERROR: ['#8E8E8E', 'COMPARE ERROR'],
};

const badge = (status, sim) => {
  const [color, label] = BADGE[status] ?? ['#8E8E8E', status];
  const text = sim != null ? `${label}&nbsp;${sim.toFixed(1)}%` : label;
  return `<span class="badge" style="background:${color}">${text}</span>`;
};

const sectionRows = (sections = []) => sections.map(s => {
  const color = { MATCH: '#2D9D78', PARTIAL: '#E68619', MISMATCH: '#FF0000', MISSING: '#FF0000' }[s.status] ?? '#8E8E8E';
  return `<tr>
    <td class="sec-heading">${esc(s.heading)}</td>
    <td><span style="background:${color};color:#fff;padding:1px 6px;border-radius:8px;font-size:11px">${s.status}${s.sim != null ? ` ${s.sim.toFixed(0)}%` : ''}</span></td>
  </tr>`;
}).join('');

const pageRows = results.map(r => {
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

const matched   = results.filter(r => r.status === 'MATCH').length;
const partial   = results.filter(r => r.status === 'PARTIAL').length;
const mismatched = results.filter(r => r.status === 'MISMATCH').length;
const blocked   = results.filter(r => r.status === 'PROD_BLOCKED').length;
const errors    = results.filter(r => ['ERROR', 'COMPARE_ERROR', 'EDS_NOT_FOUND'].includes(r.status)).length;
const simPages  = results.filter(r => r.overallSim != null);
const avgSim    = simPages.length ? simPages.reduce((s, r) => s + r.overallSim, 0) / simPages.length : 0;

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Content Comparison — EDS vs Prod</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f4f4f4;color:#222}
.header{background:#1B1B1B;color:#fff;padding:24px 32px}
.header .eyebrow{font-size:11px;color:#FF0000;text-transform:uppercase;letter-spacing:1px;font-weight:700;margin-bottom:6px}
.header h1{font-size:22px;font-weight:600;margin-bottom:4px}
.header p{font-size:12px;color:#aaa;margin-top:3px}
.stats{display:flex;gap:12px;padding:20px 32px;flex-wrap:wrap}
.stat{background:#fff;border-radius:8px;padding:14px 20px;box-shadow:0 1px 3px rgba(0,0,0,.1);min-width:110px;text-align:center}
.stat .val{font-size:26px;font-weight:700}
.stat .lbl{font-size:11px;color:#888;margin-top:3px;text-transform:uppercase;letter-spacing:.5px}
.stat.s-match .val{color:#2D9D78}.stat.s-partial .val{color:#E68619}.stat.s-fail .val{color:#FF0000}
.content{padding:0 32px 40px}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.1);overflow:hidden;margin-bottom:2px}
th{background:#1B1B1B;padding:9px 12px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;color:#fff;letter-spacing:.5px;border-bottom:none}
td{padding:8px 12px;border-bottom:1px solid #f0f0f0;vertical-align:top;font-size:13px}
.page-header td{padding:10px 12px;font-weight:600;font-size:13px;border-top:3px solid #e0e0e0}
.page-pass{background:#f8fff8}.page-fail{background:#fff6f6}
.page-path{font-family:monospace;font-size:13px}
.sim-pct{font-size:11px;color:#888;font-weight:400;margin-left:10px;font-family:monospace}
.err-note{font-size:11px;color:#FF0000;font-weight:400;margin-left:6px}
.badge{display:inline-block;color:#fff;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700;white-space:nowrap}
.num{font-family:monospace;font-size:12px;white-space:nowrap}
.tog{cursor:pointer;font-size:12px;color:#1473E6;user-select:none}
.tog::-webkit-details-marker{display:none}
.missing-list{font-size:12px;padding:4px 0 4px 16px;color:#FF0000}
.sec-table{margin-top:4px;box-shadow:none}
.sec-heading{font-size:12px;color:#555}
</style>
</head>
<body>
<div class="header">
  <div class="eyebrow">AEM Edge Delivery Services</div>
  <h1>Content Comparison — EDS vs Prod</h1>
  <p>Mode: fast (HTTP fetch + Jaccard) &nbsp;·&nbsp; Generated ${new Date().toLocaleString()} &nbsp;·&nbsp; Threshold: ${THRESHOLD}%</p>
  <p>Prod: ${esc(PROD_BASE)} &rarr; EDS: ${esc(EDS_BASE)}</p>
</div>
<div class="stats">
  <div class="stat"><div class="val">${results.length}</div><div class="lbl">Pages</div></div>
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

writeFileSync(path.join(OUTPUT_DIR, 'index.html'), html);

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log('\n=== Content Comparison Summary (Fast Mode) ===');
console.log(`Pages checked:       ${results.length}`);
console.log(`Match (≥${THRESHOLD}%):    ${matched}`);
console.log(`Partial (50–${THRESHOLD}%): ${partial}`);
console.log(`Mismatch (<50%):     ${mismatched}`);
console.log(`Prod blocked (WAF):  ${blocked}`);
console.log(`Errors:              ${errors}`);
console.log(`Avg similarity:      ${avgSim.toFixed(1)}%`);

const worst = [...simPages].sort((a, b) => a.overallSim - b.overallSim).slice(0, 10);
if (worst.length) {
  console.log('\n--- Pages with lowest content similarity ---');
  worst.forEach(r => {
    const note = r.missingHeadings?.length ? ` (${r.missingHeadings.length} missing headings)` : '';
    console.log(`  ${r.urlPath} — ${r.overallSim.toFixed(1)}%${note}`);
  });
}

console.log(`\nReport: ${path.join(OUTPUT_DIR, 'index.html')}`);
console.log(`CSV:    ${csvPath}`);
