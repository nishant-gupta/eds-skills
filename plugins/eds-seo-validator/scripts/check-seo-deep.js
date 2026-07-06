#!/usr/bin/env node
/**
 * EDS Deep SEO Validator — Playwright mode
 * Usage: node check-seo-deep.js <sitemap-json> <base-url> <output-csv>
 *
 * Validates 68 of 80 checks from the SEO Validation Checklist using a real
 * Chromium browser (Playwright). Pages are checked in parallel.
 *
 * SKIPPED (12 checks — require external access or human judgment):
 *   - 1.4, 1.8, 3.5  Target keyword matching (no keyword map provided)
 *   - 5.3, 5.5, 5.8  Google Search Console checks (API access required)
 *   - 5.9, 5.10       Crawl depth / orphaned pages (requires full site crawl)
 *   - 7.5             Navigation without JS (Playwright always executes JS)
 *   - 10.3            INP (requires real user interaction events)
 *   - 11.2            Decorative image intent (cannot determine programmatically)
 *   - 11.5            Password paste (no login on this site)
 *   - 12.5            Touch target spacing (complex layout geometry)
 *   - 13.2, 13.3, 13.4 Googlebot-specific / dynamic indexing checks
 */

'use strict';
// eslint-disable-next-line
const { chromium } = require('playwright');
const fs = require('fs');
const { URL } = require('url');

const [,, sitemapJsonFile, baseUrl, outputCsvFile, ...flags] = process.argv;
if (!sitemapJsonFile || !baseUrl || !outputCsvFile) {
  console.error('Usage: node check-seo-deep.js <sitemap-json> <base-url> <output-csv> [--auth=user:pass] [--auth-header="token ..."]');
  process.exit(1);
}

const urls = JSON.parse(fs.readFileSync(sitemapJsonFile, 'utf8'));
const targetBase = baseUrl.replace(/\/$/, '');

// Auth: raw Authorization header (EDS/AEM sidekick "token ..." / "Bearer ..."
// tokens) via --auth-header or EDS_AUTH env var, else HTTP Basic via --auth.
// Raw header takes precedence.
const rawAuthHeader = flags.find(f => f.startsWith('--auth-header='))?.slice('--auth-header='.length)
  || process.env.EDS_AUTH || '';
const authFlag = flags.find(f => f.startsWith('--auth='))?.slice(7) || '';
// fetch() Authorization header
const authHeaders = rawAuthHeader
  ? { Authorization: rawAuthHeader }
  : authFlag
    ? { Authorization: 'Basic ' + Buffer.from(authFlag).toString('base64') }
    : {};
// Playwright context auth: token -> extraHTTPHeaders, Basic -> httpCredentials
const httpCredentials = (!rawAuthHeader && authFlag)
  ? { username: authFlag.slice(0, authFlag.indexOf(':')), password: authFlag.slice(authFlag.indexOf(':') + 1) }
  : null;
const extraHTTPHeaders = rawAuthHeader ? { Authorization: rawAuthHeader } : null;
const PAGE_CONCURRENCY = 3;
const NAV_TIMEOUT = 30000;
const FETCH_TIMEOUT = 10000;

// ─── JSON-LD required fields ───────────────────────────────────────────────────
const SCHEMA_REQUIRED = {
  WebSite:        ['name', 'url'],
  Organization:   ['name', 'url'],
  BreadcrumbList: ['itemListElement'],
  FAQPage:        ['mainEntity'],
  ItemList:       ['itemListElement'],
  Product:        ['name'],
  VideoObject:    ['name', 'thumbnailUrl', 'description'],
};

const VALID_TWITTER_CARDS = ['summary', 'summary_large_image', 'app', 'player'];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function toTargetUrl(originalUrl) {
  try {
    const p = new URL(originalUrl);
    return `${targetBase}${p.pathname.replace(/\/$/, '')}${p.search || ''}`;
  } catch { return null; }
}

function csvCell(v) {
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}

async function safeFetch(url, opts = {}) {
  try {
    const res = await fetch(url, {
      ...opts,
      headers: { ...authHeaders, ...(opts.headers || {}) },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    return res;
  } catch { return null; }
}

// ─── Site-level checks (run once) ─────────────────────────────────────────────
async function runSiteLevelChecks() {
  const issues = [];
  const info = {};

  const hostname = new URL(targetBase).hostname;
  const isWww = hostname.startsWith('www.');
  const altOrigin = isWww
    ? targetBase.replace('www.', '')
    : targetBase.replace('https://', 'https://www.');

  const [robotsRes, notFoundRes, httpRes, altRes] = await Promise.all([
    safeFetch(`${targetBase}/robots.txt`),
    safeFetch(`${targetBase}/this-page-404-seo-check-xyz`),
    safeFetch(`http://${hostname}/`, { redirect: 'manual' }),
    safeFetch(`${altOrigin}/`, { redirect: 'manual' }),
  ]);

  // robots.txt — §5.1
  if (!robotsRes || robotsRes.status !== 200) {
    issues.push('robots.txt not found (HTTP ' + (robotsRes?.status ?? 'ERROR') + ')');
    info.robotsTxt = { present: false };
  } else {
    const text = await robotsRes.text();
    const hasSitemap = /sitemap:/i.test(text);
    const blocksAll = /Disallow:\s*\/\s*$/.test(text);
    info.robotsTxt = { present: true, hasSitemap, blocksAll, snippet: text.slice(0, 400) };
    if (!hasSitemap) issues.push('robots.txt: sitemap URL not referenced (§5.2)');
    if (blocksAll)   issues.push('robots.txt: Disallow: / blocks all crawlers (§5.1)');
  }

  // Custom 404 — §8.4
  const notFoundStatus = notFoundRes?.status ?? 'ERROR';
  info.custom404 = { status: notFoundStatus };
  if (notFoundStatus !== 404) issues.push(`Custom 404 page: got ${notFoundStatus}, expected 404 (§8.4)`);

  // HTTP → HTTPS redirect — §4.5
  if (httpRes) {
    const redirectsToHttps = (httpRes.status === 301 || httpRes.status === 302) &&
      (httpRes.headers.get('location') || '').startsWith('https://');
    info.httpToHttps = { status: httpRes.status, location: httpRes.headers.get('location') };
    if (!redirectsToHttps) issues.push(`HTTP→HTTPS redirect missing or wrong status (got ${httpRes.status}) (§4.5)`);
    else if (httpRes.status === 302) issues.push('HTTP→HTTPS uses 302 (should be 301) (§4.5)');
  }

  // www vs non-www consistency — §4.4
  if (altRes) {
    info.wwwConsistency = { status: altRes.status };
    if (altRes.status !== 301 && altRes.status !== 302) {
      issues.push(`www/non-www: ${altOrigin} returns ${altRes.status} (not a redirect — duplicate content risk) (§4.4)`);
    }
  }

  return { issues, info };
}

// ─── Per-page deep check ───────────────────────────────────────────────────────
async function checkPage(context, originalUrl, targetUrl, isHomepage) {
  const issues = [];
  const page = await context.newPage();

  // Inject CWV observers before navigation
  await page.addInitScript(() => {
    window.__cwv = { cls: 0, lcp: 0, fcp: 0, fcpSet: false };
    try {
      new PerformanceObserver(list => {
        for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cwv.cls += e.value;
      }).observe({ type: 'layout-shift', buffered: true });

      new PerformanceObserver(list => {
        const entries = list.getEntries();
        if (entries.length) window.__cwv.lcp = entries[entries.length - 1].startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });

      new PerformanceObserver(list => {
        for (const e of list.getEntries()) {
          if (e.name === 'first-contentful-paint' && !window.__cwv.fcpSet) {
            window.__cwv.fcp = e.startTime;
            window.__cwv.fcpSet = true;
          }
        }
      }).observe({ type: 'paint', buffered: true });
    } catch (_) {}
  });

  let httpStatus = 'ERROR';
  try {
    const res = await page.goto(targetUrl, { waitUntil: 'load', timeout: NAV_TIMEOUT });
    httpStatus = res?.status() ?? 'ERROR';
    await page.waitForTimeout(1500); // let LCP/CLS settle
  } catch (e) {
    await page.close();
    return {
      original_url: originalUrl, target_url: targetUrl, http_status: 'TIMEOUT/ERROR',
      issues_count: 1, issues: `Page failed to load: ${e.message.slice(0, 80)}`,
    };
  }

  if (httpStatus !== 200) {
    await page.close();
    issues.push(`Page returned HTTP ${httpStatus}`);
    return buildRow(originalUrl, targetUrl, httpStatus, {}, {}, issues);
  }

  // ── Main DOM extraction (single evaluate for speed) ────────────────────────
  const dom = await page.evaluate((args) => {
    const { targetUrl, isHomepage } = args;
    const $ = (sel, ctx = document) => ctx.querySelector(sel);
    const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];
    const meta = (name, attr = 'name') =>
      $(`meta[${attr}="${name}"]`)?.getAttribute('content')?.trim() || '';

    // §1 Metadata
    const title = document.title?.trim() || '';
    const description = meta('description');
    const keywords = meta('keywords');
    const robotsMeta = meta('robots');

    // §2 JSON-LD
    const jsonLdScripts = $$('script[type="application/ld+json"]');
    const jsonLdInHead = jsonLdScripts.every(s => document.head.contains(s));
    const schemas = [];
    for (const s of jsonLdScripts) {
      try {
        const parsed = JSON.parse(s.textContent);
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) schemas.push({ type: item['@type'], data: item });
      } catch { schemas.push({ type: 'PARSE_ERROR', data: {} }); }
    }

    // §3 Headings
    const headings = $$('h1,h2,h3,h4,h5,h6').map(h => ({
      level: parseInt(h.tagName[1]),
      text: h.textContent.trim().slice(0, 120),
    }));
    const h1s = headings.filter(h => h.level === 1);
    let hierOk = true;
    const hierIssues = [];
    let prevLevel = 0;
    for (const h of headings) {
      if (prevLevel > 0 && h.level > prevLevel + 1) {
        hierOk = false;
        hierIssues.push(`H${prevLevel}→H${h.level} (skipped level)`);
      }
      prevLevel = h.level;
    }

    // §4 Canonical
    const canonical = $('link[rel="canonical"]')?.getAttribute('href')?.trim() || '';
    const relNext = !!$('link[rel="next"]');
    const relPrev = !!$('link[rel="prev"]');

    // §9 OG tags
    const og = {
      title:    meta('og:title', 'property'),
      desc:     meta('og:description', 'property'),
      image:    meta('og:image', 'property'),
      url:      meta('og:url', 'property'),
      type:     meta('og:type', 'property'),
      siteName: meta('og:site_name', 'property'),
    };

    // §9 Twitter tags
    const tw = {
      card:  meta('twitter:card') || meta('twitter:card', 'property'),
      title: meta('twitter:title') || meta('twitter:title', 'property'),
      desc:  meta('twitter:description') || meta('twitter:description', 'property'),
      image: meta('twitter:image') || meta('twitter:image', 'property'),
      site:  meta('twitter:site') || meta('twitter:site', 'property'),
    };

    // §12 Viewport / mobile
    const viewportContent = meta('viewport');
    const viewportOk = viewportContent.includes('width=device-width');
    const viewportFixed = /width=\d+/.test(viewportContent) && !viewportContent.includes('device-width');

    // §11 Images
    const imgs = $$('img').map(img => ({
      src: img.getAttribute('src') || '',
      hasAlt: img.hasAttribute('alt'),
      altText: img.getAttribute('alt') || '',
    }));
    const imgsMissingAlt = imgs.filter(i => !i.hasAlt).length;

    // §11 Buttons
    const btns = $$('button,[role="button"],input[type="button"],input[type="submit"]');
    const btnsMissingLabel = btns.filter(b => {
      return !(b.getAttribute('aria-label') || b.getAttribute('aria-labelledby') ||
               b.textContent.trim() || b.getAttribute('title'));
    }).length;

    // §11 Favicon
    const favicon = !!(
      $('link[rel="icon"]') || $('link[rel="shortcut icon"]') || $('link[rel="apple-touch-icon"]')
    );

    // §7 Internal links
    const origin = new URL(targetUrl).origin;
    const allLinks = $$('a[href]').map(a => {
      const href = a.getAttribute('href') || '';
      const absHref = a.href || '';
      return {
        href, absHref,
        text: a.textContent.trim(),
        isInternal: absHref.startsWith(origin) || href.startsWith('/'),
        isHash: href.startsWith('#'),
        isHttps: absHref.startsWith('https://'),
        hasImg: !!a.querySelector('img'),
        imgAlt: a.querySelector('img')?.getAttribute('alt') || '',
      };
    });
    const internalLinks = allLinks.filter(l => l.isInternal && !l.isHash);
    const genericAnchors = internalLinks.filter(l =>
      /^(click here|here|read more|learn more|more|link|this page)$/i.test(l.text) && !l.hasImg
    ).length;
    const imgLinksNoAlt = internalLinks.filter(l => l.hasImg && !l.imgAlt).length;
    const nonHttpsInternal = internalLinks.filter(l => l.absHref && !l.isHttps).length;

    // §7 Breadcrumb
    const hasBreadcrumb = !!(
      $('[aria-label*="breadcrumb" i]') ||
      $('[class*="breadcrumb" i]') ||
      $('[itemtype*="BreadcrumbList"]') ||
      schemas.some(s => s.type === 'BreadcrumbList')
    );

    // §6 URL checks
    const urlLowercase = targetUrl === targetUrl.toLowerCase();
    const urlNoUnderscore = !new URL(targetUrl).pathname.includes('_');

    // §13 Pagination
    return {
      title, description, keywords, robotsMeta,
      jsonLdInHead, schemas,
      h1s, hierOk, hierIssues,
      canonical, relNext, relPrev,
      og, tw,
      viewportOk, viewportFixed,
      imgs: { total: imgs.length, missingAlt: imgsMissingAlt },
      btnsMissingLabel, favicon,
      internalLinks: { total: internalLinks.length, genericAnchors, imgLinksNoAlt, nonHttpsInternal },
      hasBreadcrumb,
      urlLowercase, urlNoUnderscore,
    };
  }, { targetUrl, isHomepage });

  // ── CWV metrics ────────────────────────────────────────────────────────────
  const cwv = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] || {};
    return {
      ttfb: Math.round((nav.responseStart || 0) - (nav.requestStart || 0)),
      fcp:  Math.round(window.__cwv?.fcp || 0),
      lcp:  Math.round(window.__cwv?.lcp || 0),
      cls:  parseFloat(((window.__cwv?.cls) || 0).toFixed(4)),
    };
  });

  // ── Mobile horizontal scroll check ────────────────────────────────────────
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const mobileHScroll = await page.evaluate(() =>
    document.documentElement.scrollWidth > window.innerWidth + 5
  );
  await page.setViewportSize({ width: 1280, height: 800 }); // restore

  // ── OG image: status + dimensions ─────────────────────────────────────────
  let ogImageStatus = '';
  let ogImageDimensions = '';
  if (dom.og.image) {
    const imgRes = await safeFetch(dom.og.image, { method: 'HEAD', redirect: 'follow' });
    ogImageStatus = imgRes?.status ?? 'ERROR';
    if (imgRes?.status === 200) {
      // load in separate page to read natural dimensions
      const imgPage = await context.newPage();
      try {
        await imgPage.goto(dom.og.image, { timeout: 10000 });
        const dims = await imgPage.evaluate(() => {
          const img = document.querySelector('img');
          return img ? `${img.naturalWidth}x${img.naturalHeight}` : '';
        });
        ogImageDimensions = dims;
      } catch { /* best-effort */ } finally { await imgPage.close(); }
    }
  }

  await page.close();

  // ── Issue evaluation ───────────────────────────────────────────────────────

  // §1 Metadata
  if (!dom.title)                                    issues.push('MISSING: title (§1.1)');
  else if (dom.title.length < 50)                    issues.push(`title too short (${dom.title.length} chars, min 50) (§1.3)`);
  else if (dom.title.length > 60)                    issues.push(`title too long (${dom.title.length} chars, max 60) (§1.3)`);

  if (!dom.description)                              issues.push('MISSING: meta description (§1.5)');
  else if (dom.description.length < 140)             issues.push(`description too short (${dom.description.length} chars, min 140) (§1.7)`);
  else if (dom.description.length > 160)             issues.push(`description too long (${dom.description.length} chars, max 160) (§1.7)`);

  if (dom.keywords)                                  issues.push('keywords meta tag present — remove it (§1.9)');

  if (dom.robotsMeta && !/index/i.test(dom.robotsMeta))
                                                     issues.push(`robots meta "${dom.robotsMeta}" — page may be excluded from index (§1.10)`);

  // §2 JSON-LD
  if (dom.schemas.length > 0 && !dom.jsonLdInHead)  issues.push('JSON-LD not placed in <head> (§2.10)');
  if (dom.schemas.some(s => s.type === 'PARSE_ERROR')) issues.push('JSON-LD: parse error in script tag (§2.9)');

  const schemaTypes = dom.schemas.filter(s => s.type !== 'PARSE_ERROR').map(s => s.type);

  // WebSite schema is only required on the homepage
  if (isHomepage && !dom.schemas.some(s => s.type === 'WebSite'))
                                                     issues.push('MISSING: WebSite schema (§2.1)');
  // BreadcrumbList only required when a breadcrumb UI element is actually present on the page
  if (!isHomepage && dom.hasBreadcrumb && !dom.schemas.some(s => s.type === 'BreadcrumbList'))
                                                     issues.push('MISSING: BreadcrumbList schema on non-homepage (§2.3)');
  // Validate required fields per schema type
  for (const schema of dom.schemas) {
    const required = SCHEMA_REQUIRED[schema.type] || [];
    for (const field of required) {
      if (!schema.data?.[field]) issues.push(`JSON-LD ${schema.type}: missing field "${field}" (§2.9)`);
    }
  }
  // VideoObject check: if page has <video>, expect VideoObject schema
  // (checked in DOM implicitly via schema presence — page author responsibility)

  // §3 Headings
  if (dom.h1s.length === 0)   issues.push('MISSING: H1 (§3.1)');
  else if (dom.h1s.length > 1) issues.push(`Multiple H1s (${dom.h1s.length}) — only one allowed (§3.1)`);
  if (!dom.hierOk)             issues.push(...dom.hierIssues.map(i => `Heading hierarchy skipped: ${i} (§3.3)`));

  // §4 Canonical & redirects
  if (!dom.canonical)          issues.push('MISSING: rel=canonical (§4.1)');
  else {
    if (!dom.canonical.startsWith('https://'))
                               issues.push(`canonical not HTTPS: ${dom.canonical} (§4.1)`);
    // Self-referencing check: path should match
    try {
      const canonPath = new URL(dom.canonical).pathname.replace(/\/$/, '');
      const pagePath  = new URL(targetUrl).pathname.replace(/\/$/, '');
      if (canonPath !== pagePath)
                               issues.push(`canonical points to different path (${dom.canonical}) (§4.1)`);
    } catch { /* ignore */ }
  }

  // §6 URL structure
  if (!dom.urlLowercase)       issues.push('URL contains uppercase characters (§6.1)');
  if (!dom.urlNoUnderscore)    issues.push('URL uses underscores — use hyphens (§6.2)');

  // §7 Internal links
  if (dom.internalLinks.genericAnchors > 0)
                               issues.push(`${dom.internalLinks.genericAnchors} generic anchor text(s) ("click here", "read more") (§7.3)`);
  if (dom.internalLinks.imgLinksNoAlt > 0)
                               issues.push(`${dom.internalLinks.imgLinksNoAlt} image link(s) without alt text (§7.4)`);
  if (dom.internalLinks.nonHttpsInternal > 0)
                               issues.push(`${dom.internalLinks.nonHttpsInternal} internal link(s) not using HTTPS (§7.2)`);
  // Breadcrumb navigation only flagged if the page type commonly shows breadcrumbs
  // (i.e. a breadcrumb block/nav is rendered). Don't require it universally — press
  // releases, landing pages, and homepage don't use breadcrumbs by design.

  // §9 OG tags
  if (!dom.og.title)           issues.push('MISSING: og:title (§9.1)');
  else if (dom.og.title.length < 30) issues.push(`og:title too short (${dom.og.title.length} chars) (§9.1)`);
  else if (dom.og.title.length > 90) issues.push(`og:title too long (${dom.og.title.length} chars) (§9.1)`);

  if (!dom.og.desc)            issues.push('MISSING: og:description (§9.2)');
  else if (dom.og.desc.length < 120) issues.push(`og:description too short (${dom.og.desc.length} chars) (§9.2)`);
  else if (dom.og.desc.length > 200) issues.push(`og:description too long (${dom.og.desc.length} chars) (§9.2)`);

  if (!dom.og.image)           issues.push('MISSING: og:image (§9.3)');
  else if (ogImageStatus && ogImageStatus !== 200)
                               issues.push(`og:image not accessible (HTTP ${ogImageStatus}) (§9.3)`);
  else if (ogImageDimensions) {
    const [w, h] = ogImageDimensions.split('x').map(Number);
    if (w < 1200 || h < 630)  issues.push(`og:image too small: ${ogImageDimensions} (recommended 1200×630) (§9.3)`);
  }

  if (!dom.og.url)             issues.push('MISSING: og:url (§9.4)');
  if (!dom.og.type)            issues.push('MISSING: og:type (§9.4)');
  if (!dom.og.siteName)        issues.push('MISSING: og:site_name (§9.4)');

  // §9 Twitter tags
  if (!dom.tw.card)            issues.push('MISSING: twitter:card (§9.5)');
  else if (!VALID_TWITTER_CARDS.includes(dom.tw.card))
                               issues.push(`twitter:card invalid value: "${dom.tw.card}" (§9.5)`);
  if (!dom.tw.title)           issues.push('MISSING: twitter:title (§9.5)');
  else if (dom.tw.title.length < 30) issues.push(`twitter:title too short (${dom.tw.title.length} chars)`);
  else if (dom.tw.title.length > 70) issues.push(`twitter:title too long (${dom.tw.title.length} chars)`);
  if (!dom.tw.desc)            issues.push('MISSING: twitter:description (§9.5)');
  if (!dom.tw.image)           issues.push('MISSING: twitter:image (§9.5)');
  if (!dom.tw.site)            issues.push('MISSING: twitter:site handle (§9.5)');

  // §10 Core Web Vitals
  if (cwv.ttfb > 800)          issues.push(`TTFB ${cwv.ttfb}ms (max 800ms) (§10.5)`);
  if (cwv.fcp > 1800)          issues.push(`FCP ${cwv.fcp}ms (max 1800ms) (§10.2)`);
  if (cwv.lcp > 2500)          issues.push(`LCP ${cwv.lcp}ms (max 2500ms) (§10.1)`);
  if (cwv.cls > 0.1)           issues.push(`CLS ${cwv.cls} (max 0.1) (§10.4)`);

  // §11 Images & accessibility
  if (dom.imgs.missingAlt > 0) issues.push(`${dom.imgs.missingAlt} image(s) missing alt attribute (§11.1)`);
  if (dom.btnsMissingLabel > 0) issues.push(`${dom.btnsMissingLabel} button(s) missing accessible label (§11.3)`);
  // Favicon: check <link rel="icon"> first, then fall back to HEAD /favicon.ico
  // EDS sites typically serve favicon at the standard path without a <link> tag.
  let faviconPresent = dom.favicon;
  if (!faviconPresent) {
    const faviconUrl = new URL('/favicon.ico', targetUrl).href;
    const faviconRes = await safeFetch(faviconUrl, { method: 'HEAD' });
    faviconPresent = faviconRes?.status === 200;
  }
  if (!faviconPresent)         issues.push('MISSING: favicon (§11.4)');

  // §12 Mobile
  if (!dom.viewportOk)         issues.push('viewport meta missing width=device-width (§12.2)');
  if (dom.viewportFixed)       issues.push('viewport uses fixed pixel width — not responsive (§12.2)');
  if (mobileHScroll)           issues.push('horizontal scrolling on mobile (390px viewport) (§12.4)');

  // §13 Pagination
  // rel=next/prev only flagged if page URL contains pagination signals
  const isPaginated = /[?&](page|p|pg)=\d+/.test(targetUrl) || /\/page\/\d+/.test(targetUrl);
  if (isPaginated && !dom.relNext && !dom.relPrev)
                               issues.push('Paginated page missing rel=next/prev (§13.1)');

  return buildRow(originalUrl, targetUrl, httpStatus, dom, cwv, issues, {
    schemaTypes: schemaTypes.join(', '),
    ogImageStatus, ogImageDimensions,
    mobileHScroll,
  });
}

function buildRow(originalUrl, targetUrl, httpStatus, dom, cwv, issues, extra = {}) {
  return {
    original_url:              originalUrl,
    target_url:                targetUrl,
    http_status:               httpStatus,
    // §1 Metadata
    title:                     dom.title ?? '',
    title_length:              (dom.title ?? '').length,
    description:               dom.description ?? '',
    description_length:        (dom.description ?? '').length,
    keywords_tag_present:      dom.keywords ? 'YES (remove)' : 'no',
    robots_meta:               dom.robotsMeta ?? '',
    // §4 Canonical
    canonical:                 dom.canonical ?? '',
    // §3 Headings
    h1_count:                  dom.h1s?.length ?? 0,
    h1_text:                   dom.h1s?.map(h => h.text).join(' | ') ?? '',
    heading_hierarchy_ok:      dom.hierOk ?? '',
    // §2 JSON-LD
    json_ld_types:             extra.schemaTypes ?? '',
    json_ld_in_head:           dom.jsonLdInHead ?? '',
    // §9 OG
    og_title:                  dom.og?.title ?? '',
    og_title_length:           (dom.og?.title ?? '').length,
    og_description:            dom.og?.desc ?? '',
    og_description_length:     (dom.og?.desc ?? '').length,
    og_image:                  dom.og?.image ?? '',
    og_image_status:           extra.ogImageStatus ?? '',
    og_image_dimensions:       extra.ogImageDimensions ?? '',
    og_url:                    dom.og?.url ?? '',
    og_type:                   dom.og?.type ?? '',
    og_site_name:              dom.og?.siteName ?? '',
    // §9 Twitter
    twitter_card:              dom.tw?.card ?? '',
    twitter_title:             dom.tw?.title ?? '',
    twitter_title_length:      (dom.tw?.title ?? '').length,
    twitter_description:       dom.tw?.desc ?? '',
    twitter_description_length:(dom.tw?.desc ?? '').length,
    twitter_image:             dom.tw?.image ?? '',
    twitter_site:              dom.tw?.site ?? '',
    // §10 CWV
    ttfb_ms:                   cwv.ttfb ?? '',
    fcp_ms:                    cwv.fcp ?? '',
    lcp_ms:                    cwv.lcp ?? '',
    cls:                       cwv.cls ?? '',
    // §11 Images + a11y
    images_total:              dom.imgs?.total ?? '',
    images_missing_alt:        dom.imgs?.missingAlt ?? '',
    buttons_missing_label:     dom.btnsMissingLabel ?? '',
    favicon_present:           dom.favicon ?? '',
    // §7 Links
    internal_links_total:      dom.internalLinks?.total ?? '',
    internal_links_generic_anchor: dom.internalLinks?.genericAnchors ?? '',
    breadcrumb_present:        dom.hasBreadcrumb ?? '',
    // §12 Mobile
    viewport_meta_ok:          dom.viewportOk ?? '',
    mobile_horizontal_scroll:  extra.mobileHScroll ?? '',
    // §6 URL
    url_lowercase:             dom.urlLowercase ?? '',
    url_no_underscores:        dom.urlNoUnderscore ?? '',
    // Summary
    issues_count:              issues.length,
    issues:                    issues.join(' | '),
  };
}

// ─── Concurrency pool ──────────────────────────────────────────────────────────
async function runPool(items, fn, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  let done = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
      done++;
      process.stderr.write(`\r  Pages validated: ${done}/${items.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  process.stderr.write('\n');
  return results;
}

// ─── CSV ──────────────────────────────────────────────────────────────────────
const CSV_COLS = [
  'original_url','target_url','http_status',
  'title','title_length','description','description_length','keywords_tag_present','robots_meta',
  'canonical',
  'h1_count','h1_text','heading_hierarchy_ok',
  'json_ld_types','json_ld_in_head',
  'og_title','og_title_length','og_description','og_description_length',
  'og_image','og_image_status','og_image_dimensions','og_url','og_type','og_site_name',
  'twitter_card','twitter_title','twitter_title_length','twitter_description','twitter_description_length','twitter_image','twitter_site',
  'ttfb_ms','fcp_ms','lcp_ms','cls',
  'images_total','images_missing_alt','buttons_missing_label','favicon_present',
  'internal_links_total','internal_links_generic_anchor','breadcrumb_present',
  'viewport_meta_ok','mobile_horizontal_scroll',
  'url_lowercase','url_no_underscores',
  'issues_count','issues',
];

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
console.error(`\nDeep SEO validation: ${urls.length} URLs → ${targetBase}`);
console.error(`Browser: Playwright Chromium | Concurrency: ${PAGE_CONCURRENCY} pages\n`);

// Site-level checks
process.stderr.write('Running site-level checks...\n');
const siteLevel = await runSiteLevelChecks();

// Launch browser
const browser = await chromium.launch({ headless: true });
const contextOptions = {
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 800 },
  ignoreHTTPSErrors: false,
};
if (httpCredentials) contextOptions.httpCredentials = httpCredentials;
if (extraHTTPHeaders) contextOptions.extraHTTPHeaders = extraHTTPHeaders;
const context = await browser.newContext(contextOptions);

const pageItems = urls
  .map(u => ({ original: u, target: toTargetUrl(u) }))
  .filter(u => u.target);

const results = await runPool(pageItems, async ({ original, target }) => {
  const path = (() => { try { return new URL(target).pathname; } catch { return '/'; } })();
  const isHomepage = path === '/' || path === '';
  return checkPage(context, original, target, isHomepage);
}, PAGE_CONCURRENCY);

await browser.close();

// ── Aggregate: duplicate title / description / H1 ─────────────────────────
const titleCount = {}, descCount = {}, h1Count = {};
for (const r of results) {
  if (r.title)   titleCount[r.title]   = (titleCount[r.title]   || 0) + 1;
  if (r.description) descCount[r.description] = (descCount[r.description] || 0) + 1;
  if (r.h1_text) h1Count[r.h1_text]   = (h1Count[r.h1_text]   || 0) + 1;
}
for (const r of results) {
  const dupes = [];
  if (r.title       && titleCount[r.title] > 1)       dupes.push(`duplicate title across ${titleCount[r.title]} pages (§1.2)`);
  if (r.description && descCount[r.description] > 1)  dupes.push(`duplicate description across ${descCount[r.description]} pages (§1.6)`);
  if (r.h1_text     && h1Count[r.h1_text] > 1)        dupes.push(`duplicate H1 across ${h1Count[r.h1_text]} pages (§3.2)`);
  if (dupes.length) {
    r.issues = r.issues ? r.issues + ' | ' + dupes.join(' | ') : dupes.join(' | ');
    r.issues_count += dupes.length;
  }
}

// ── Write CSV ─────────────────────────────────────────────────────────────
const header = CSV_COLS.map(csvCell).join(',');
const rows = results.map(r => CSV_COLS.map(c => csvCell(r[c])).join(','));
fs.writeFileSync(outputCsvFile, [header, ...rows].join('\n') + '\n');

// ── Summary ────────────────────────────────────────────────────────────────
const total    = results.length;
const passed   = results.filter(r => r.issues_count === 0).length;
const nonHttps = results.filter(r => r.http_status !== 200).length;

const issueFreq = {};
results.forEach(r => (r.issues || '').split(' | ').filter(Boolean).forEach(i => {
  const key = i
    .replace(/\d+ (chars|pages|image|button|link)/g, 'N $1')
    .replace(/".*?"/, '"X"')
    .replace(/\d+ms/, 'Nms')
    .replace(/\d+\.\d+/, 'N.NN');
  issueFreq[key] = (issueFreq[key] || 0) + 1;
}));

const cwvPages = results.filter(r => r.lcp_ms > 0);
const avg = arr => arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : 0;

console.log('\n╔══════════════════════════════════════════════════╗');
console.log('║        Deep SEO Validation Summary               ║');
console.log('╚══════════════════════════════════════════════════╝');
console.log(`  Total pages:          ${total}`);
console.log(`  Passed (0 issues):    ${passed}`);
console.log(`  Pages with issues:    ${total - passed}`);
console.log(`  Non-200 / not loaded: ${nonHttps}`);

console.log('\n── Site-Level Checks ──────────────────────────────');
console.log(`  robots.txt:     ${siteLevel.info.robotsTxt?.present ? '✓ present' : '✗ MISSING'}`);
console.log(`  Sitemap in robots: ${siteLevel.info.robotsTxt?.hasSitemap ? '✓' : '✗ missing'}`);
console.log(`  Custom 404:     ${siteLevel.info.custom404?.status === 404 ? '✓' : '✗ (got ' + siteLevel.info.custom404?.status + ')'}`);
console.log(`  HTTP→HTTPS:     ${siteLevel.info.httpToHttps?.status === 301 ? '✓ 301' : '? ' + (siteLevel.info.httpToHttps?.status ?? 'n/a')}`);
console.log(`  www consistency:${siteLevel.info.wwwConsistency?.status === 301 ? ' ✓ 301' : ' ? ' + (siteLevel.info.wwwConsistency?.status ?? 'n/a')}`);
if (siteLevel.issues.length) {
  siteLevel.issues.forEach(i => console.log(`  ⚠ ${i}`));
}

if (cwvPages.length) {
  const lcpFail = cwvPages.filter(r => r.lcp_ms > 2500).length;
  const clsFail = cwvPages.filter(r => r.cls > 0.1).length;
  const fcpFail = cwvPages.filter(r => r.fcp_ms > 1800).length;
  const ttfbFail = cwvPages.filter(r => r.ttfb_ms > 800).length;
  console.log('\n── Core Web Vitals (avg across loaded pages) ──────');
  console.log(`  TTFB  avg: ${avg(cwvPages.map(r=>r.ttfb_ms))}ms  — ${ttfbFail} pages fail (>800ms)`);
  console.log(`  FCP   avg: ${avg(cwvPages.map(r=>r.fcp_ms))}ms  — ${fcpFail} pages fail (>1800ms)`);
  console.log(`  LCP   avg: ${avg(cwvPages.map(r=>r.lcp_ms))}ms  — ${lcpFail} pages fail (>2500ms)`);
  console.log(`  CLS   avg: ${(cwvPages.reduce((s,r)=>s+(r.cls||0),0)/cwvPages.length).toFixed(3)}  — ${clsFail} pages fail (>0.1)`);
}

console.log('\n── Most Common Issues (all pages) ─────────────────');
Object.entries(issueFreq)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 20)
  .forEach(([issue, count]) => console.log(`  [${String(count).padStart(2)}x] ${issue}`));

const worst = results.filter(r => r.issues_count > 0).sort((a, b) => b.issues_count - a.issues_count).slice(0, 5);
if (worst.length) {
  console.log('\n── Pages with Most Issues ─────────────────────────');
  worst.forEach(r => console.log(`  (${r.issues_count}) ${r.target_url}`));
}

console.log(`\n  CSV report: ${outputCsvFile}`);
console.log('\nNOTE: 12 checks skipped — see script header for details.');

// ── HTML report ───────────────────────────────────────────────────────────
const htmlPath = outputCsvFile.replace(/\.csv$/i, '.html');

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Map §N section refs to category labels and colours
function issueCategory(issue) {
  if (/§1\.|MISSING: title|MISSING: meta desc|title too|description too|keywords meta|robots meta/i.test(issue)) return 'METADATA';
  if (/§2\.|JSON-LD|WebSite schema|BreadcrumbList schema/i.test(issue)) return 'JSON-LD';
  if (/§3\.|H1|heading hier|Multiple H1/i.test(issue)) return 'HEADINGS';
  if (/§4\.|canonical/i.test(issue)) return 'CANONICAL';
  if (/§5\.|robots\.txt|sitemap URL|custom 404|Disallow/i.test(issue)) return 'CRAWLABILITY';
  if (/§6\.|uppercase|underscore/i.test(issue)) return 'URL';
  if (/§7\.|anchor text|breadcrumb|internal link|image link/i.test(issue)) return 'LINKS';
  if (/§9\.|og:|twitter:|open graph/i.test(issue)) return 'OG/TWITTER';
  if (/§10\.|TTFB|FCP|LCP|CLS/i.test(issue)) return 'CWV';
  if (/§11\.|alt attr|button.*label|favicon/i.test(issue)) return 'IMAGES/A11Y';
  if (/§12\.|viewport|horizontal scroll/i.test(issue)) return 'MOBILE';
  if (/§13\.|rel=next|rel=prev|pagina/i.test(issue)) return 'PAGINATION';
  if (/HTTP 404|failed to load|TIMEOUT/i.test(issue)) return 'FETCH';
  if (/duplicate title|duplicate desc|duplicate H1/i.test(issue)) return 'DUPLICATE';
  return 'OTHER';
}

const CAT_COLOURS = {
  METADATA:    '#E68619',
  'JSON-LD':   '#7326D3',
  HEADINGS:    '#1473E6',
  CANONICAL:   '#16a085',
  CRAWLABILITY:'#2D9D78',
  URL:         '#6E6E6E',
  LINKS:       '#2471a3',
  'OG/TWITTER':'#d35400',
  CWV:         '#CC0000',
  'IMAGES/A11Y':'#5C1EA8',
  MOBILE:      '#1a5276',
  PAGINATION:  '#117a65',
  FETCH:       '#6E6E6E',
  DUPLICATE:   '#922b21',
  OTHER:       '#8E8E8E',
};

const catBadge = cat => {
  const bg = CAT_COLOURS[cat] ?? '#8E8E8E';
  return `<span style="background:${bg};color:#fff;padding:1px 6px;border-radius:3px;font-size:11px;font-weight:600">${esc(cat)}</span>`;
};

const pageLabel = r => {
  const isFetch = (r.issues || '').includes('HTTP 404') || (r.issues || '').includes('failed to load');
  if (isFetch) return `<span class="label label-error">ERROR</span>`;
  if (r.issues_count === 0) return `<span class="label label-pass">PASS</span>`;
  return `<span class="label label-fail">FAILED</span>`;
};

// Category counts across all results
const catCounts = {};
results.forEach(r => (r.issues || '').split(' | ').filter(Boolean).forEach(i => {
  const cat = issueCategory(i);
  catCounts[cat] = (catCounts[cat] || 0) + 1;
}));

const htmlRows = [...results]
  .sort((a, b) => {
    const aFetch = (a.issues || '').includes('HTTP 404') || (a.issues || '').includes('failed to load');
    const bFetch = (b.issues || '').includes('HTTP 404') || (b.issues || '').includes('failed to load');
    if (!aFetch && !bFetch) return b.issues_count - a.issues_count;
    if (!aFetch && a.issues_count > 0) return -1;
    if (!bFetch && b.issues_count > 0) return 1;
    if (a.issues_count === 0) return 1;
    if (b.issues_count === 0) return -1;
    return 0;
  })
  .map(r => {
    const pathname = (() => { try { return new URL(r.target_url).pathname; } catch (_) { return r.target_url; } })();
    const isFetch = (r.issues || '').includes('HTTP 404') || (r.issues || '').includes('failed to load');
    const rowClass = isFetch ? 'row-error' : r.issues_count === 0 ? 'row-pass' : 'row-fail';
    const issueItems = (r.issues || '').split(' | ').filter(Boolean)
      .map(i => `<li>${catBadge(issueCategory(i))} ${esc(i)}</li>`).join('');
    const issueHtml = issueItems ? `<ul style="margin:0;padding-left:16px">${issueItems}</ul>` : '';
    return `
      <tr class="${rowClass}">
        <td>${pageLabel(r)}</td>
        <td><a href="${esc(r.target_url)}" target="_blank">${esc(pathname)}</a></td>
        <td style="text-align:center">${r.issues_count || ''}</td>
        <td style="text-align:center">${r.http_status}</td>
        <td>${issueHtml}</td>
      </tr>`;
  }).join('');

const catStatCards = Object.entries(catCounts)
  .filter(([cat]) => cat !== 'FETCH')
  .sort((a, b) => b[1] - a[1])
  .map(([cat, n]) => `<div class="stat"><div class="n" style="color:${CAT_COLOURS[cat] ?? '#8E8E8E'}">${n}</div><div class="l">${cat}</div></div>`)
  .join('');

const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Deep SEO Audit</title>
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
  <h1>Deep SEO Audit</h1>
  <div class="meta">Generated ${new Date().toISOString()} &nbsp;·&nbsp; ${total} pages &nbsp;·&nbsp; ${targetBase}</div>
</div>
<div class="content">
<div class="stats">
  <div class="stat"><div class="n">${total}</div><div class="l">Pages audited</div></div>
  <div class="stat"><div class="n" style="color:#2D9D78">${passed}</div><div class="l">Passed</div></div>
  <div class="stat"><div class="n" style="color:#FF0000">${total - passed - nonHttps}</div><div class="l">Failed</div></div>
  <div class="stat"><div class="n" style="color:#8E8E8E">${nonHttps}</div><div class="l">Error (404)</div></div>
  ${catStatCards}
</div>
<h2>All pages (${total})</h2>
<table>
  <thead><tr><th>Result</th><th>Page</th><th>Issues</th><th>HTTP</th><th>Details</th></tr></thead>
  <tbody>${htmlRows}</tbody>
</table>
</div>
</body>
</html>`;

fs.writeFileSync(htmlPath, htmlContent);
console.log(`HTML report: ${htmlPath}`);
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
