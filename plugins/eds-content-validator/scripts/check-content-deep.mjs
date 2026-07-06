#!/usr/bin/env node
/**
 * Deep content comparison: Playwright + scroll (catches lazy-loaded content).
 * Must run from .claude/skills/eds-content-compare/ so Node.js finds playwright.
 *
 * Usage:
 *   cd .claude/skills/eds-content-compare && \
 *   node scripts/check-content-deep.mjs <sitemap-json> <prod-base-url> <eds-base-url> <output-dir>
 *     [--threshold=90] [--concurrency=2] [--max=N] [--offset=N]
 *     [--auth-prod=user:pass] [--auth-eds=user:pass]
 */

import { writeFileSync, mkdirSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { URL as URLClass } from 'url';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);

const [,, SITEMAP_JSON, PROD_BASE, EDS_BASE, OUTPUT_DIR, ...flags] = process.argv;

if (!SITEMAP_JSON || !PROD_BASE || !EDS_BASE || !OUTPUT_DIR) {
  console.error('Usage: node check-content-deep.mjs <sitemap-json> <prod-base> <eds-base> <output-dir> [options]');
  console.error('Options: --threshold=90 --concurrency=2 --max=N --offset=N');
  console.error('  Basic auth:  --auth-prod=user:pass --auth-eds=user:pass');
  console.error('  Token auth:  --auth-header-prod="token ..." --auth-header-eds="token ..." (or env PROD_AUTH / EDS_AUTH)');
  process.exit(1);
}

const opt = name => {
  const f = flags.find(f => f.startsWith(`--${name}=`));
  return f ? f.split('=').slice(1).join('=') : null;
};

const THRESHOLD   = parseFloat(opt('threshold') ?? '90');
const CONCURRENCY = parseInt(opt('concurrency') ?? '2');
const MAX_PAGES   = parseInt(opt('max') ?? '999999');
const OFFSET      = parseInt(opt('offset') ?? '0');
const AUTH_PROD   = opt('auth-prod');
const AUTH_EDS    = opt('auth-eds');
// Raw Authorization header (EDS/AEM sidekick "token ..." / "Bearer ..." tokens);
// flag first, then env var. Takes precedence over Basic user:pass.
const AUTH_HEADER_PROD = opt('auth-header-prod') ?? process.env.PROD_AUTH ?? null;
const AUTH_HEADER_EDS  = opt('auth-header-eds')  ?? process.env.EDS_AUTH  ?? null;

// Playwright context auth: a raw token header goes in extraHTTPHeaders,
// Basic user:pass goes in httpCredentials.
function authContextOpts(basic, rawHeader) {
  if (rawHeader) return { extraHTTPHeaders: { Authorization: rawHeader } };
  if (basic) {
    const [user, ...rest] = basic.split(':');
    return { httpCredentials: { username: user, password: rest.join(':') } };
  }
  return {};
}

const allUrls = require(path.resolve(SITEMAP_JSON));
const urls    = allUrls.slice(OFFSET, OFFSET + MAX_PAGES);

mkdirSync(OUTPUT_DIR, { recursive: true });

// ─── Playwright helpers ───────────────────────────────────────────────────────

const WAF_SIGNALS = ['Request Rejected', 'Access Denied', 'blocked', 'Forbidden'];
const SCROLL_STEP = 600;
const SCROLL_PAUSE = 200; // ms between scroll steps
const SETTLE_MS = 800;    // wait after scrolling for lazy content to render

async function scrollAndSettle(page) {
  let lastHeight = 0;
  while (true) {
    const height = await page.evaluate(() => document.body.scrollHeight);
    if (height === lastHeight) break;
    lastHeight = height;
    for (let y = 0; y <= height; y += SCROLL_STEP) {
      await page.evaluate(scrollY => window.scrollTo(0, scrollY), y);
      await page.waitForTimeout(SCROLL_PAUSE);
    }
  }
  await page.waitForTimeout(SETTLE_MS);
}

// Expand <details> elements and disclosure accordions
async function expandHidden(page) {
  await page.evaluate(() => {
    document.querySelectorAll('details').forEach(el => { el.open = true; });
    document.querySelectorAll('[aria-expanded="false"]').forEach(el => {
      try { el.click(); } catch { /* ignore */ }
    });
  });
  await page.waitForTimeout(300);
}

// Extract structured content from live DOM
async function extractDomContent(page) {
  return page.evaluate(() => {
    // Remove noise elements
    const noise = ['script', 'style', 'noscript', 'iframe', 'svg', 'nav', 'sup'];
    const root = document.querySelector('main') ?? document.body;
    const clone = root.cloneNode(true);
    noise.forEach(tag => clone.querySelectorAll(tag).forEach(el => el.remove()));
    // Remove cookie consent modals, share drawers, and language-switcher banners
    // that appear in prod DOM but not EDS — they inflate prod word counts
    const uiSelectors = [
      '[class*="cookie"]', '[id*="cookie"]',
      '[class*="consent"]', '[id*="consent"]',
      '[class*="privacy-manager"]', '[id*="privacy-manager"]',
      '[class*="share-this"]', '[id*="share-this"]',
      '[class*="share-page"]', '[id*="share-page"]',
      '[class*="language-selector"]', '[id*="language-selector"]',
      '[aria-label*="cookie" i]', '[aria-label*="consent" i]',
      '[aria-label*="share this page" i]',
    ];
    uiSelectors.forEach(sel => {
      try { clone.querySelectorAll(sel).forEach(el => el.remove()); } catch (_) {}
    });

    // Known prod-only UI noise headings (share widget, language banner, cookie sections)
    const noiseHeadings = new Set([
      'share this page',
      'esta página solo está disponible en inglés',
      'notice of the right to opt-out of sharing personal information for targeted advertising',
      'manage preferences',
      'strictly necessary, functional and performance & analytical',
      'strictly necessary',
      'performance & analytical',
      'functional',
    ]);

    // Headings
    const headings = [];
    clone.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(el => {
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      if (text && !noiseHeadings.has(text.toLowerCase())) headings.push({ level: parseInt(el.tagName[1]), text });
    });

    // CTAs — buttons and prominent links
    const ctas = [];
    clone.querySelectorAll('button, a.button, a.cta, .button a, [class*="cta"] a').forEach(el => {
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      if (text && text.length > 1 && text.length < 120) ctas.push(text);
    });

    // All links (for broader CTA check)
    const allLinks = [];
    clone.querySelectorAll('a[href]').forEach(el => {
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      if (text && text.length > 1 && text.length < 120) allLinks.push(text);
    });

    // Full visible text
    const fullText = clone.innerText
      ? clone.innerText.replace(/\s+/g, ' ').trim()
      : clone.textContent.replace(/\s+/g, ' ').trim();

    // Section-level content (heading + following sibling text until next heading)
    const sections = [];
    const allEls = [...clone.querySelectorAll('h1,h2,h3')];
    allEls.forEach((h, i) => {
      const headingText = h.textContent.replace(/\s+/g, ' ').trim();
      if (!headingText || noiseHeadings.has(headingText.toLowerCase())) return;

      // Collect text nodes until next h1/h2/h3
      const contentParts = [];
      let sibling = h.nextElementSibling;
      const nextHeadingPos = i + 1 < allEls.length ? allEls[i + 1] : null;

      while (sibling && sibling !== nextHeadingPos) {
        const t = sibling.textContent.replace(/\s+/g, ' ').trim();
        if (t) contentParts.push(t);
        sibling = sibling.nextElementSibling;
      }

      sections.push({
        heading: headingText,
        level: parseInt(h.tagName[1]),
        content: contentParts.join(' '),
      });
    });

    return { headings, ctas, allLinks, fullText, sections };
  });
}

// ─── Text utilities ───────────────────────────────────────────────────────────

function wordSet(text) {
  return new Set(
    text.toLowerCase()
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

// ─── Comparison ───────────────────────────────────────────────────────────────

function compareExtracted(prod, eds, threshold) {
  const prodWords = wordSet(prod.fullText);
  const edsWords  = wordSet(eds.fullText);
  const overallSim = jaccard(prodWords, edsWords) * 100;

  // Heading match
  const edsHeadingSet = new Set(eds.headings.map(h => h.text.toLowerCase()));
  const missingHeadings = prod.headings
    .filter(h => !edsHeadingSet.has(h.text.toLowerCase()))
    .map(h => h.text);

  // Word count delta
  const prodWordCount = prod.fullText.split(/\s+/).filter(Boolean).length;
  const edsWordCount  = eds.fullText.split(/\s+/).filter(Boolean).length;
  const wordCountDelta = prodWordCount > 0
    ? ((edsWordCount - prodWordCount) / prodWordCount * 100)
    : 0;

  // CTA match (check prod CTAs against all EDS links)
  const edsCtaSet = new Set([...eds.ctas, ...eds.allLinks].map(c => c.toLowerCase()));
  const ctaMatches = prod.ctas.filter(c => edsCtaSet.has(c.toLowerCase()));
  const ctaMatchRate = prod.ctas.length > 0
    ? (ctaMatches.length / prod.ctas.length * 100)
    : 100;

  // Section comparison
  const edsSectionMap = new Map(eds.sections.map(s => [s.heading.toLowerCase(), s]));
  const sectionResults = prod.sections.map(ps => {
    const es = edsSectionMap.get(ps.heading.toLowerCase());
    if (!es) return { heading: ps.heading, status: 'MISSING', sim: 0 };
    // Skip sections with too few words — Jaccard is unreliable on very short text
    if (wordSet(ps.content).size < 8) return { heading: ps.heading, status: 'SKIPPED', sim: null };
    const sim = jaccard(wordSet(ps.content), wordSet(es.content)) * 100;
    const status = sim >= threshold ? 'MATCH' : sim >= 50 ? 'PARTIAL' : 'MISMATCH';
    return { heading: ps.heading, status, sim };
  });

  let status;
  if (overallSim >= threshold)  status = 'MATCH';
  else if (overallSim >= 50)    status = 'PARTIAL';
  else                           status = 'MISMATCH';

  return {
    status, overallSim,
    prodWordCount, edsWordCount, wordCountDelta,
    prodHeadingCount: prod.headings.length,
    edsHeadingCount:  eds.headings.length,
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

// ─── Process one URL with Playwright ─────────────────────────────────────────

async function processUrl(browser, url, idx) {
  const urlPath = new URLClass(url).pathname;
  const edsPath = urlPath.length > 1 ? urlPath.replace(/\/$/, '') : urlPath;
  const prodUrl = PROD_BASE.replace(/\/$/, '') + urlPath;
  const edsUrl  = EDS_BASE.replace(/\/$/, '') + edsPath;
  const slug    = `page-${String(OFFSET + idx + 1).padStart(4, '0')}`;

  process.stderr.write(`[${OFFSET + idx + 1}/${OFFSET + urls.length}] ${urlPath}\n`);

  const ctxOpts = { viewport: { width: 1440, height: 900 }, ...authContextOpts(AUTH_PROD, AUTH_HEADER_PROD) };

  // Fetch prod
  const prodCtx  = await browser.newContext(ctxOpts);
  const prodPage = await prodCtx.newPage();
  let prodData = null;
  let prodBlocked = false;
  let prodError = null;

  try {
    const resp = await prodPage.goto(prodUrl, { waitUntil: 'load', timeout: 30000 });
    const status = resp?.status() ?? 0;
    if (status === 403) {
      prodBlocked = true;
    } else {
      const bodyText = await prodPage.evaluate(() => document.body?.innerText ?? '');
      if (WAF_SIGNALS.some(s => bodyText.includes(s))) {
        prodBlocked = true;
      } else {
        await scrollAndSettle(prodPage);
        await expandHidden(prodPage);
        prodData = await extractDomContent(prodPage);
      }
    }
  } catch (err) {
    prodError = err.message;
  } finally {
    await prodCtx.close();
  }

  if (prodBlocked) return { slug, urlPath, prodUrl, edsUrl, status: 'PROD_BLOCKED', overallSim: null };
  if (prodError)   return { slug, urlPath, prodUrl, edsUrl, status: 'ERROR', error: prodError, overallSim: null };

  // Fetch EDS
  const edsCtxOpts = { viewport: { width: 1440, height: 900 }, ...authContextOpts(AUTH_EDS, AUTH_HEADER_EDS) };

  const edsCtx  = await browser.newContext(edsCtxOpts);
  const edsPage = await edsCtx.newPage();
  let edsData = null;
  let edsError = null;
  let edsStatus = 0;

  try {
    const resp = await edsPage.goto(edsUrl, { waitUntil: 'load', timeout: 30000 });
    edsStatus = resp?.status() ?? 0;
    if (edsStatus === 404) {
      // handled below
    } else {
      await scrollAndSettle(edsPage);
      await expandHidden(edsPage);
      edsData = await extractDomContent(edsPage);
    }
  } catch (err) {
    edsError = err.message;
  } finally {
    await edsCtx.close();
  }

  if (edsStatus === 404) return { slug, urlPath, prodUrl, edsUrl, status: 'EDS_NOT_FOUND', edsStatus, overallSim: null };
  if (edsError)          return { slug, urlPath, prodUrl, edsUrl, status: 'ERROR', error: edsError, overallSim: null };

  try {
    const comparison = compareExtracted(prodData, edsData, THRESHOLD);
    return { slug, urlPath, prodUrl, edsUrl, ...comparison };
  } catch (err) {
    return { slug, urlPath, prodUrl, edsUrl, status: 'COMPARE_ERROR', error: err.message, overallSim: null };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const browser = await chromium.launch({ headless: true });
const results = [];

for (let i = 0; i < urls.length; i += CONCURRENCY) {
  const batch = urls.slice(i, i + CONCURRENCY);
  const batchResults = await Promise.all(
    batch.map((url, j) => processUrl(browser, url, i + j)),
  );
  results.push(...batchResults);
}

await browser.close();

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
    threshold: THRESHOLD, mode: 'deep',
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

const matched    = results.filter(r => r.status === 'MATCH').length;
const partial    = results.filter(r => r.status === 'PARTIAL').length;
const mismatched = results.filter(r => r.status === 'MISMATCH').length;
const blocked    = results.filter(r => r.status === 'PROD_BLOCKED').length;
const errors     = results.filter(r => ['ERROR', 'COMPARE_ERROR', 'EDS_NOT_FOUND'].includes(r.status)).length;
const simPages   = results.filter(r => r.overallSim != null);
const avgSim     = simPages.length ? simPages.reduce((s, r) => s + r.overallSim, 0) / simPages.length : 0;

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Content Comparison (Deep) — EDS vs Prod</title>
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
  <h1>Content Comparison — EDS vs Prod (Deep Mode)</h1>
  <p>Mode: deep (Playwright + scroll, lazy content) &nbsp;·&nbsp; Generated ${new Date().toLocaleString()} &nbsp;·&nbsp; Threshold: ${THRESHOLD}%</p>
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

console.log('\n=== Content Comparison Summary (Deep Mode) ===');
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
