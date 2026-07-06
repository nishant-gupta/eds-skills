#!/usr/bin/env node
/**
 * Visual Regression Compare — Prod vs EDS
 * Usage: node check-visual.mjs <sitemap-json> <prod-base-url> <eds-base-url> <output-dir>
 *        [--threshold=5] [--concurrency=2] [--max=N] [--offset=N]
 *        [--viewports=desktop,tablet,mobile]
 *        [--auth-prod=user:pass] [--auth-eds=user:pass]
 *
 * Captures full-page screenshots of each URL on prod and EDS across desktop,
 * tablet, and mobile viewports, diffs them with pixelmatch, and generates an
 * HTML report with before / after / diff images.
 *
 * Requires Node.js 18+ and Playwright Chromium installed:
 *   cd .claude/skills/eds-visual-compare && npm install && npx playwright install chromium
 */

import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { URL } from 'url';
import path from 'path';

// ─── CLI args ─────────────────────────────────────────────────────────────────
const [,, sitemapJsonFile, prodBaseUrl, edsBaseUrl, outputDir, ...flags] = process.argv;

if (!sitemapJsonFile || !prodBaseUrl || !edsBaseUrl || !outputDir) {
  console.error(
    'Usage: node check-visual.mjs <sitemap-json> <prod-base-url> <eds-base-url> <output-dir>\n' +
    '       [--threshold=5] [--concurrency=2] [--max=N]\n' +
    '       [--viewports=desktop,tablet,mobile]\n' +
    '       [--auth-prod=user:pass] [--auth-eds=user:pass]\n' +
    '       [--auth-header-prod="token ..."] [--auth-header-eds="token ..."]  (or env PROD_AUTH / EDS_AUTH)'
  );
  process.exit(1);
}

const getFlag = (name, def) =>
  flags.find(f => f.startsWith(`--${name}=`))?.slice(name.length + 3) ?? def;

const THRESHOLD   = parseFloat(getFlag('threshold',   '5'));
const CONCURRENCY = parseInt(getFlag('concurrency',   '2'), 10);
const MAX_PAGES   = parseInt(getFlag('max',           '9999'), 10);
const OFFSET      = parseInt(getFlag('offset',        '0'),   10);
const VP_STR      = getFlag('viewports', 'desktop,tablet,mobile');
const AUTH_PROD   = getFlag('auth-prod', '');
const AUTH_EDS    = getFlag('auth-eds',  '');
// Raw Authorization header (EDS/AEM sidekick "token ..." / "Bearer ..." tokens);
// flag first, then env var. Takes precedence over Basic user:pass.
const AUTH_HEADER_PROD = getFlag('auth-header-prod', '') || process.env.PROD_AUTH || '';
const AUTH_HEADER_EDS  = getFlag('auth-header-eds',  '') || process.env.EDS_AUTH  || '';

const SELECTED_VIEWPORTS = VP_STR.split(',').map(v => v.trim()).filter(Boolean);

// ─── Viewport definitions ─────────────────────────────────────────────────────
const VIEWPORTS = {
  desktop: { width: 1440, height: 900,  deviceScaleFactor: 1 },
  tablet:  { width: 768,  height: 1024, deviceScaleFactor: 1 },
  mobile:  { width: 390,  height: 844,  deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

// ─── WAF / bot-block titles ───────────────────────────────────────────────────
const WAF_TITLES = new Set([
  'request rejected', 'access denied', 'forbidden',
  '403 forbidden', '401 unauthorized', 'blocked', 'error',
]);

// ─── Setup ────────────────────────────────────────────────────────────────────
const prodBase = prodBaseUrl.replace(/\/$/, '');
const edsBase  = edsBaseUrl.replace(/\/$/, '');

mkdirSync(path.join(outputDir, 'screenshots'), { recursive: true });

const allUrls = JSON.parse(readFileSync(sitemapJsonFile, 'utf8'));
const urls    = allUrls.slice(OFFSET, OFFSET + MAX_PAGES);

function toPath(originalUrl) {
  try {
    const p = new URL(originalUrl);
    return (p.pathname.replace(/\/$/, '') || '/') + (p.search || '');
  } catch { return '/'; }
}

// Playwright context auth options: a raw token header goes in extraHTTPHeaders,
// Basic user:pass goes in httpCredentials.
function authContextOpts(cred, rawHeader) {
  if (rawHeader) return { extraHTTPHeaders: { Authorization: rawHeader } };
  if (cred) {
    const [user, ...rest] = cred.split(':');
    return { httpCredentials: { username: user, password: rest.join(':') } };
  }
  return {};
}

// ─── Scroll helper: scrolls full page to trigger lazy-loading ─────────────────
async function scrollAndLoad(page) {
  await page.evaluate(async () => {
    const SCROLL_STEP = 600;   // px per step
    const STEP_DELAY  = 200;   // ms between steps
    const MAX_STEPS   = 100;   // safety limit for very tall pages

    let steps = 0;
    while (steps < MAX_STEPS) {
      const prevY = window.scrollY;
      window.scrollBy(0, SCROLL_STEP);
      await new Promise(r => setTimeout(r, STEP_DELAY));
      const atBottom = window.scrollY + window.innerHeight >= document.body.scrollHeight;
      if (atBottom || window.scrollY === prevY) break;
      steps++;
    }
    // Scroll back to top and let final render settle
    window.scrollTo(0, 0);
    await new Promise(r => setTimeout(r, 600));
  });
  await page.waitForTimeout(400);
}

// ─── Capture a full-page screenshot ───────────────────────────────────────────
async function capture(browser, url, vpName, authCred, authHeaderRaw) {
  const vp  = VIEWPORTS[vpName];
  const ctx = await browser.newContext({
    viewport:           { width: vp.width, height: vp.height },
    deviceScaleFactor:  vp.deviceScaleFactor ?? 1,
    isMobile:           vp.isMobile ?? false,
    hasTouch:           vp.hasTouch ?? false,
    ...authContextOpts(authCred, authHeaderRaw),
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/120.0.0.0 Safari/537.36',
  });

  const page = await ctx.newPage();

  try {
    const resp = await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    const status = resp?.status() ?? 0;

    // Detect WAF / bot block
    const title = (await page.title()).toLowerCase().trim();
    if (WAF_TITLES.has(title)) {
      await ctx.close();
      return { buf: null, status: 'WAF_BLOCKED', error: `WAF block: "${title}"` };
    }

    // Scroll to trigger lazy-loaded content
    await scrollAndLoad(page);

    const buf = await page.screenshot({ fullPage: true });
    await ctx.close();
    return { buf, status, error: null };

  } catch (err) {
    await ctx.close();
    return { buf: null, status: 'ERROR', error: err.message.slice(0, 120) };
  }
}

// ─── Image diff ───────────────────────────────────────────────────────────────
function diffImages(buf1, buf2) {
  const img1 = PNG.sync.read(buf1);
  const img2 = PNG.sync.read(buf2);

  const width  = Math.max(img1.width,  img2.width);
  const height = Math.max(img1.height, img2.height);

  // Pad both images to the same dimensions (fill with white)
  function pad(img) {
    if (img.width === width && img.height === height) return img;
    const out   = new PNG({ width, height });
    out.data    = Buffer.alloc(width * height * 4, 255);
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const si = (y * img.width  + x) * 4;
        const di = (y * width      + x) * 4;
        out.data[di]     = img.data[si];
        out.data[di + 1] = img.data[si + 1];
        out.data[di + 2] = img.data[si + 2];
        out.data[di + 3] = img.data[si + 3];
      }
    }
    return out;
  }

  const p1   = pad(img1);
  const p2   = pad(img2);
  const diff = new PNG({ width, height });
  diff.data  = Buffer.alloc(width * height * 4, 255);

  const diffPixels = pixelmatch(p1.data, p2.data, diff.data, width, height, {
    threshold: 0.1,   // per-pixel sensitivity (0 = exact, 1 = loose)
    alpha:     0.3,
    diffColor: [255, 0, 0],
  });

  const diffPct = (diffPixels / (width * height)) * 100;
  const diffBuf = PNG.sync.write(diff);

  return { diffPct, diffBuf, width, height, prodHeight: img1.height, edsHeight: img2.height };
}

// ─── Process one URL across all viewports ─────────────────────────────────────
async function processUrl(browser, originalUrl, urlIdx) {
  const urlPath = toPath(originalUrl);
  const prodUrl = `${prodBase}${urlPath}`;
  const edsUrl  = `${edsBase}${urlPath}`;
  const slug    = `page-${String(OFFSET + urlIdx + 1).padStart(4, '0')}`;
  const ssDir   = path.join(outputDir, 'screenshots', slug);

  mkdirSync(ssDir, { recursive: true });

  const result = { originalUrl, prodUrl, edsUrl, slug, urlPath, viewports: {} };

  for (const vpName of SELECTED_VIEWPORTS) {
    process.stderr.write(`  ${OFFSET + urlIdx + 1}/${OFFSET + urls.length} [${vpName}] ${urlPath}\n`);

    const [prod, eds] = await Promise.all([
      capture(browser, prodUrl, vpName, AUTH_PROD, AUTH_HEADER_PROD),
      capture(browser, edsUrl,  vpName, AUTH_EDS,  AUTH_HEADER_EDS),
    ]);

    const vr = {
      prodStatus: prod.status,
      edsStatus:  eds.status,
      prodError:  prod.error,
      edsError:   eds.error,
      diffPct:    null,
      status:     'ERROR',
      prodImg:    null,
      edsImg:     null,
      diffImg:    null,
      prodHeight: null,
      edsHeight:  null,
    };

    if (prod.status === 'WAF_BLOCKED') {
      vr.status = 'PROD_BLOCKED';
      // Still save EDS screenshot so we can see what it looks like
      if (eds.buf) {
        const edsFile = path.join(ssDir, `${vpName}-eds.png`);
        writeFileSync(edsFile, eds.buf);
        vr.edsImg = `screenshots/${slug}/${vpName}-eds.png`;
      }
    } else if (prod.buf && eds.buf) {
      try {
        const { diffPct, diffBuf, prodHeight, edsHeight } = diffImages(prod.buf, eds.buf);
        vr.diffPct    = diffPct;
        vr.status     = diffPct > THRESHOLD ? 'FAIL' : 'PASS';
        vr.prodHeight = prodHeight;
        vr.edsHeight  = edsHeight;

        const prodFile = path.join(ssDir, `${vpName}-prod.png`);
        const edsFile  = path.join(ssDir, `${vpName}-eds.png`);
        const diffFile = path.join(ssDir, `${vpName}-diff.png`);

        writeFileSync(prodFile, prod.buf);
        writeFileSync(edsFile,  eds.buf);
        writeFileSync(diffFile, diffBuf);

        vr.prodImg = `screenshots/${slug}/${vpName}-prod.png`;
        vr.edsImg  = `screenshots/${slug}/${vpName}-eds.png`;
        vr.diffImg = `screenshots/${slug}/${vpName}-diff.png`;
      } catch (err) {
        vr.status    = 'DIFF_ERROR';
        vr.prodError = err.message.slice(0, 120);
      }
    } else if (eds.status !== 200 && eds.status !== 'ERROR') {
      vr.status = 'EDS_NOT_FOUND';
    }

    result.viewports[vpName] = vr;
  }

  return result;
}

// ─── Concurrency runner ───────────────────────────────────────────────────────
async function runWithConcurrency(items, fn, c) {
  const results = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(c, items.length) }, worker));
  return results;
}

// ─── HTML report ──────────────────────────────────────────────────────────────
function generateReport(results) {
  const allVp    = results.flatMap(r => Object.values(r.viewports));
  const passed   = allVp.filter(v => v.status === 'PASS').length;
  const failed   = allVp.filter(v => v.status === 'FAIL').length;
  const blocked  = allVp.filter(v => v.status === 'PROD_BLOCKED').length;
  const errors   = allVp.filter(v => ['ERROR', 'DIFF_ERROR', 'EDS_NOT_FOUND'].includes(v.status)).length;

  const BADGE = {
    PASS:          ['#2D9D78', 'PASS'],
    FAIL:          ['#FF0000', 'FAIL'],
    PROD_BLOCKED:  ['#E68619', 'PROD BLOCKED'],
    EDS_NOT_FOUND: ['#9c27b0', 'EDS 404'],
    ERROR:         ['#8E8E8E', 'ERROR'],
    DIFF_ERROR:    ['#8E8E8E', 'DIFF ERROR'],
  };

  const badge = (status, pct) => {
    const [color, label] = BADGE[status] || ['#8E8E8E', status];
    const text = status === 'FAIL' && pct != null
      ? `FAIL &nbsp;${pct.toFixed(1)}%`
      : label;
    return `<span class="badge" style="background:${color}">${text}</span>`;
  };

  const imgPanel = (label, src, isHighlight) => {
    if (!src) return '';
    const border = isHighlight ? 'border:2px solid #FF0000' : 'border:1px solid #ddd';
    return `
      <div class="img-panel">
        <div class="img-label">${label}</div>
        <a href="${src}" target="_blank">
          <img src="${src}" loading="lazy" style="${border};border-radius:4px;width:100%;display:block">
        </a>
      </div>`;
  };

  const vpBlock = (vpName, vr) => {
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

  const pageRows = results.map(r => {
    const maxDiff   = Math.max(...Object.values(r.viewports).map(v => v.diffPct ?? 0));
    const hasIssue  = Object.values(r.viewports).some(v => ['FAIL', 'ERROR', 'EDS_NOT_FOUND'].includes(v.status));
    const rowClass  = hasIssue ? 'page-fail' : 'page-pass';

    return `
    <tbody>
      <tr class="page-header ${rowClass}">
        <td colspan="4">
          <span class="page-path">${r.urlPath}</span>
          ${maxDiff > 0 ? `<span class="max-diff">max diff: ${maxDiff.toFixed(1)}%</span>` : ''}
        </td>
      </tr>
      ${SELECTED_VIEWPORTS.map(vp => vpBlock(vp, r.viewports[vp] || {})).join('')}
    </tbody>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Visual Regression — EDS vs Prod</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:#f4f4f4;color:#222}
.header{background:#1B1B1B;color:#fff;padding:24px 32px}
.header .eyebrow{font-size:11px;color:#FF0000;text-transform:uppercase;letter-spacing:1px;font-weight:700;margin-bottom:6px}
.header h1{font-size:22px;font-weight:600;margin-bottom:4px}
.header p{font-size:12px;color:#aaa;margin-top:3px}
.stats{display:flex;gap:12px;padding:20px 32px;flex-wrap:wrap}
.stat{background:#fff;border-radius:8px;padding:14px 20px;box-shadow:0 1px 3px rgba(0,0,0,.1);min-width:110px;text-align:center}
.stat .val{font-size:26px;font-weight:700}
.stat .lbl{font-size:11px;color:#888;margin-top:3px;text-transform:uppercase;letter-spacing:.5px}
.stat.s-fail .val{color:#FF0000}
.stat.s-pass .val{color:#2D9D78}
.stat.s-warn .val{color:#E68619}
.content{padding:0 32px 40px}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.1);overflow:hidden;margin-bottom:2px}
th{background:#1B1B1B;padding:9px 12px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;color:#fff;letter-spacing:.5px;border-bottom:none}
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
.ss-toggle{cursor:pointer;font-size:12px;color:#1473E6;list-style:none;user-select:none}
.ss-toggle::-webkit-details-marker{display:none}
.ss-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:8px}
.img-panel .img-label{font-size:10px;font-weight:700;text-transform:uppercase;color:#888;margin-bottom:3px}
@media(max-width:900px){.ss-grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="header">
  <div class="eyebrow">AEM Edge Delivery Services</div>
  <h1>Visual Regression — EDS vs Prod</h1>
  <p>Generated ${new Date().toLocaleString()} &nbsp;·&nbsp; Threshold: ${THRESHOLD}% &nbsp;·&nbsp; Viewports: ${SELECTED_VIEWPORTS.join(', ')}</p>
  <p>Prod: ${prodBase} &rarr; EDS: ${edsBase}</p>
</div>
<div class="stats">
  <div class="stat"><div class="val">${results.length}</div><div class="lbl">Pages</div></div>
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
}

// ─── Main ──────────────────────────────────────────────────────────────────────
console.error(`\nVisual Compare: ${urls.length} URLs | viewports: ${SELECTED_VIEWPORTS.join(', ')} | threshold: ${THRESHOLD}%`);
console.error(`  Prod: ${prodBase}`);
console.error(`  EDS:  ${edsBase}\n`);

const browser = await chromium.launch({ headless: true });

const results = await runWithConcurrency(
  urls,
  (url, idx) => processUrl(browser, url, idx),
  CONCURRENCY
);

await browser.close();

// Write report
const reportPath = path.join(outputDir, 'index.html');
writeFileSync(reportPath, generateReport(results));

// Write machine-readable results for merge-reports.mjs
writeFileSync(path.join(outputDir, 'results.json'), JSON.stringify({
  meta: {
    prodBase,
    edsBase,
    threshold:  THRESHOLD,
    viewports:  SELECTED_VIEWPORTS,
    offset:     OFFSET,
    generatedAt: new Date().toISOString(),
  },
  pages: results,
}, null, 2));

// Summary
const allVp   = results.flatMap(r => Object.values(r.viewports));
const passed  = allVp.filter(v => v.status === 'PASS').length;
const failed  = allVp.filter(v => v.status === 'FAIL').length;
const blocked = allVp.filter(v => v.status === 'PROD_BLOCKED').length;
const errors  = allVp.filter(v => ['ERROR', 'DIFF_ERROR', 'EDS_NOT_FOUND'].includes(v.status)).length;

console.log('\n=== Visual Regression Summary ===');
console.log(`Pages checked:      ${results.length}`);
console.log(`Viewport checks:    ${allVp.length} (${SELECTED_VIEWPORTS.length}×${results.length})`);
console.log(`Passed:             ${passed}`);
console.log(`Failed (>${THRESHOLD}%):  ${failed}`);
console.log(`Prod blocked (WAF): ${blocked}`);
console.log(`Errors:             ${errors}`);

const failedPages = results
  .filter(r => Object.values(r.viewports).some(v => v.status === 'FAIL'))
  .sort((a, b) => {
    const worstA = Math.max(...Object.values(a.viewports).map(v => v.diffPct ?? 0));
    const worstB = Math.max(...Object.values(b.viewports).map(v => v.diffPct ?? 0));
    return worstB - worstA;
  })
  .slice(0, 10);

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
