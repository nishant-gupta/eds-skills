#!/usr/bin/env node
/**
 * EDS Site Audit: Content completeness, media/assets, links, quality, spelling, and grammar checks.
 * Runs against the EDS site only — no prod comparison required.
 *
 * Usage:
 *   node check-content-audit.mjs <sitemap-json> <eds-base-url> <output-dir>
 *     [--concurrency=5] [--max=N] [--offset=N]
 *     [--auth=user:pass]         (HTTP Basic auth)
 *     [--auth-header="token ..."] (raw Authorization header — EDS/AEM token/Bearer; or env EDS_AUTH)
 *     [--check-links]            (HEAD-check all unique internal href targets)
 *     [--check-spelling]         (spell-check page text using English dictionary)
 *     [--old-domain=example.com] (extra domain to flag as old CMS, repeatable)
 *     [--nav-path=/nav]          (nav doc path to audit, default: /nav)
 *     [--footer-path=/footer]    (footer doc path to audit, default: /footer)
 */

import { writeFileSync, mkdirSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { URL as URLClass } from 'url';

const require = createRequire(import.meta.url);

const [,, SITEMAP_JSON, EDS_BASE, OUTPUT_DIR, ...flags] = process.argv;

if (!SITEMAP_JSON || !EDS_BASE || !OUTPUT_DIR) {
  console.error('Usage: node check-content-audit.mjs <sitemap-json> <eds-base-url> <output-dir> [options]');
  process.exit(1);
}

const opt = name => {
  const f = flags.find(f => f.startsWith(`--${name}=`));
  return f ? f.split('=').slice(1).join('=') : null;
};
const hasFlag = name => flags.includes(`--${name}`);
const optAll = name => flags.filter(f => f.startsWith(`--${name}=`)).map(f => f.split('=').slice(1).join('='));

const CONCURRENCY    = parseInt(opt('concurrency') ?? '5');
const MAX_PAGES      = parseInt(opt('max') ?? '999999');
const OFFSET         = parseInt(opt('offset') ?? '0');
const AUTH           = opt('auth');
// Raw Authorization header (EDS/AEM sidekick "token ..." / "Bearer ..." tokens);
// flag first, then EDS_AUTH env var. Takes precedence over Basic --auth.
const AUTH_HEADER    = opt('auth-header') ?? process.env.EDS_AUTH ?? null;
const CHECK_LINKS    = hasFlag('check-links');
const CHECK_SPELLING = hasFlag('check-spelling');
const NAV_PATH       = opt('nav-path') ?? '/nav';
const FOOTER_PATH    = opt('footer-path') ?? '/footer';
const OLD_DOMAINS    = [
  'www17.wellsfargomedia.com',
  'wellsfargomedia.com',
  ...optAll('old-domain'),
];

// ─── Spell checker (lazy-loaded only when --check-spelling is set) ────────────

let spellChecker = null;

async function initSpellChecker() {
  if (spellChecker) return spellChecker;
  const nspell = (await import('nspell')).default;
  const dict   = (await import('dictionary-en')).default;
  spellChecker = await new Promise((resolve, reject) => {
    dict((err, d) => {
      if (err) reject(err);
      else resolve(nspell(d));
    });
  });
  return spellChecker;
}

// Words to always skip in spell checking (brand names, automotive terms, Indian English, abbreviations)
const SPELL_ALLOWLIST = new Set([
  // Maruti / Suzuki brand and model names
  'maruti', 'suzuki', 'baleno', 'brezza', 'ciaz', 'celerio', 'dzire', 'ertiga', 'fronx',
  'ignis', 'jimny', 'nexa', 'spresso', 'vitara', 'wagonr', 'xl6', 'eeco', 'kizashi',
  'ritz', 'alto', 'swift', 'swift', 'omni', 'versa', 'gypsy',
  // Common automotive terms
  'suv', 'cng', 'lpg', 'mileage', 'powertrain', 'torque', 'turbo', 'petrol', 'diesel',
  'adas', 'esp', 'abs', 'ebd', 'hev', 'phev', 'bev', 'agm', 'vvt', 'crdi',
  // Indian English / proper nouns
  'lakh', 'crore', 'rupee', 'rupees', 'india', 'indian', 'gujarat', 'haryana', 'manesar',
  'gurugram', 'gurgaon', 'mundra', 'nexa', 'msil', 'mou', 'rnd', 'fy', 'q1', 'q2', 'q3', 'q4',
  // Common abbreviations and acronyms
  'csr', 'ipo', 'agm', 'egm', 'idi', 'idtr', 'adtt', 'iti', 'iim', 'iit',
  'ceo', 'cfo', 'coo', 'md', 'vp', 'hr', 'pr', 'ev', 'oe',
  // Tech / web
  'html', 'css', 'url', 'seo', 'pdf', 'jpg', 'png', 'svg', 'api', 'ui', 'ux',
]);

const EDS_BASE_CLEAN = EDS_BASE.replace(/\/$/, '');
let edsHostname;
try { edsHostname = new URLClass(EDS_BASE_CLEAN).hostname; } catch (_) { edsHostname = ''; }

const allUrls = require(path.resolve(SITEMAP_JSON));
const urls    = allUrls.slice(OFFSET, OFFSET + MAX_PAGES);

mkdirSync(OUTPUT_DIR, { recursive: true });

// ─── Fetch ────────────────────────────────────────────────────────────────────

function basicHeader(creds) {
  if (!creds) return null;
  const [user, ...rest] = creds.split(':');
  return 'Basic ' + Buffer.from(`${user}:${rest.join(':')}`).toString('base64');
}

// Resolved Authorization header value: raw token header if given, else Basic.
const AUTH_VALUE = AUTH_HEADER || basicHeader(AUTH);

async function fetchHtml(url, auth = AUTH_VALUE, timeout = 20000) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml',
  };
  if (auth) headers['Authorization'] = auth;
  try {
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), timeout);
    const res = await fetch(url, { headers, signal: ac.signal, redirect: 'follow' });
    clearTimeout(tid);
    if (res.status === 404) return { status: 404, html: null };
    if (!res.ok) return { status: res.status, html: null };
    const html = await res.text();
    return { status: res.status, html };
  } catch (err) {
    return { status: 0, html: null, error: err.message };
  }
}

async function headCheck(url, timeout = 10000) {
  const headers = { 'User-Agent': 'EDS-Audit/1.0' };
  // Only send credentials to the EDS host — never leak the token to external links.
  let sameOrigin = false;
  try { sameOrigin = new URLClass(url).hostname === edsHostname; } catch (_) {}
  if (AUTH_VALUE && sameOrigin) headers['Authorization'] = AUTH_VALUE;
  try {
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), timeout);
    const res = await fetch(url, { method: 'HEAD', headers, signal: ac.signal, redirect: 'follow' });
    clearTimeout(tid);
    return res.status;
  } catch (_) {
    return 0;
  }
}

// ─── HTML parsing helpers ─────────────────────────────────────────────────────

function stripTags(html) { return html.replace(/<[^>]+>/g, ' '); }

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function extractMain(html) {
  const m = html.match(/<main[\s>]([\s\S]*?)<\/main>/i);
  return m ? m[1] : html;
}

function extractAttr(tag, attr) {
  const re = new RegExp(`\\b${attr}=(?:"([^"]*?)"|'([^']*?)'|([^\\s>]+))`, 'i');
  const m = re.exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
}

// ─── Grammar check (always-on, pattern-based) ────────────────────────────────

const GRAMMAR_RULES = [
  // Missing apostrophes in common contractions
  { re: /\bdont\b/g,     fix: "don't",    label: "Missing apostrophe" },
  { re: /\bcant\b/g,     fix: "can't",    label: "Missing apostrophe" },
  { re: /\bwont\b/g,     fix: "won't",    label: "Missing apostrophe" },
  { re: /\bdidnt\b/g,    fix: "didn't",   label: "Missing apostrophe" },
  { re: /\bdoesnt\b/g,   fix: "doesn't",  label: "Missing apostrophe" },
  { re: /\bisnt\b/g,     fix: "isn't",    label: "Missing apostrophe" },
  { re: /\barent\b/g,    fix: "aren't",   label: "Missing apostrophe" },
  { re: /\bwasnt\b/g,    fix: "wasn't",   label: "Missing apostrophe" },
  { re: /\bwerent\b/g,   fix: "weren't",  label: "Missing apostrophe" },
  { re: /\bhavent\b/g,   fix: "haven't",  label: "Missing apostrophe" },
  { re: /\bhasnt\b/g,    fix: "hasn't",   label: "Missing apostrophe" },
  { re: /\bhadnt\b/g,    fix: "hadn't",   label: "Missing apostrophe" },
  { re: /\bshouldnt\b/g, fix: "shouldn't",label: "Missing apostrophe" },
  { re: /\bwouldnt\b/g,  fix: "wouldn't", label: "Missing apostrophe" },
  { re: /\bcouldnt\b/g,  fix: "couldn't", label: "Missing apostrophe" },
  { re: /\bim\b/g,       fix: "I'm",      label: "Missing apostrophe" },
  { re: /\bweve\b/g,     fix: "we've",    label: "Missing apostrophe" },
  { re: /\btheyre\b/g,   fix: "they're",  label: "Missing apostrophe" },
  // a vs an
  { re: /\ba ([aeiouAEIOU][a-z])/g, fix: null, label: 'Possible "a/an" error' },
  // double spaces
  { re: /  +/g, fix: ' ', label: 'Double space' },
  // sentence ending without space before next capital
  { re: /[.!?][A-Z]/g, fix: null, label: 'Missing space after sentence-ending punctuation' },
];

// Common word confusions (context-free — flag for review)
const WORD_CONFUSIONS = [
  { re: /\bteh\b/gi,        correct: 'the' },
  { re: /\brecieve\b/gi,    correct: 'receive' },
  { re: /\boccured\b/gi,    correct: 'occurred' },
  { re: /\bseperate\b/gi,   correct: 'separate' },
  { re: /\bdefinate\b/gi,   correct: 'definite' },
  { re: /\baccomodate\b/gi, correct: 'accommodate' },
  { re: /\bachive\b/gi,     correct: 'achieve' },
  { re: /\badress\b/gi,     correct: 'address' },
  { re: /\bcalender\b/gi,   correct: 'calendar' },
  { re: /\bcommited\b/gi,   correct: 'committed' },
  { re: /\bconsious\b/gi,   correct: 'conscious' },
  { re: /\bdefinately\b/gi, correct: 'definitely' },
  { re: /\benviroment\b/gi, correct: 'environment' },
  { re: /\bexistance\b/gi,  correct: 'existence' },
  { re: /\bexplaination\b/gi, correct: 'explanation' },
  { re: /\bfullfilment\b/gi, correct: 'fulfilment' },
  { re: /\bgoverment\b/gi,  correct: 'government' },
  { re: /\bgurantee\b/gi,   correct: 'guarantee' },
  { re: /\bheirarchy\b/gi,  correct: 'hierarchy' },
  { re: /\bindependance\b/gi, correct: 'independence' },
  { re: /\bmanintenance\b/gi, correct: 'maintenance' },
  { re: /\bmanufactring\b/gi, correct: 'manufacturing' },
  { re: /\bneccesary\b/gi,  correct: 'necessary' },
  { re: /\boppertunity\b/gi, correct: 'opportunity' },
  { re: /\bpersistance\b/gi, correct: 'persistence' },
  { re: /\bprivelege\b/gi,  correct: 'privilege' },
  { re: /\bprocede\b/gi,    correct: 'proceed' },
  { re: /\bprofessionaly\b/gi, correct: 'professionally' },
  { re: /\bpublically\b/gi, correct: 'publicly' },
  { re: /\brecomend\b/gi,   correct: 'recommend' },
  { re: /\bresponsability\b/gi, correct: 'responsibility' },
  { re: /\bsimiler\b/gi,    correct: 'similar' },
  { re: /\bsucceed\b/gi,    correct: null }, // valid
  { re: /\bsurprise\b/gi,   correct: null }, // valid
  { re: /\btransferance\b/gi, correct: 'transference' },
  { re: /\buntill\b/gi,     correct: 'until' },
  { re: /\bvehicel\b/gi,    correct: 'vehicle' },
  { re: /\bwether\b/gi,     correct: 'whether' },
];

function checkGrammar(bodyText) {
  const issues = [];

  // Double word detection ("the the", "and and", etc.)
  // Text from separate HTML elements is separated by newlines (see extraction above),
  // so matching only within a single line avoids cross-element false positives.
  const doubleWordRe = /\b(\w{3,}) \1\b/gi;
  const validDoubles = new Set(['had', 'that', 'very', 'so']); // "had had", "that that" are valid
  for (const m of bodyText.matchAll(doubleWordRe)) {
    if (!validDoubles.has(m[1])) {
      issues.push({ issue: `Repeated word: "${m[0].slice(0, 50)}"`, category: 'GRAMMAR' });
      if (issues.filter(i => i.category === 'GRAMMAR' && i.issue.startsWith('Repeated')).length >= 3) break;
    }
  }

  // Missing apostrophes / contraction errors
  for (const rule of GRAMMAR_RULES) {
    if (rule.label === 'Missing apostrophe' && rule.re.test(bodyText)) {
      rule.re.lastIndex = 0;
      const match = bodyText.match(rule.re);
      if (match) {
        issues.push({ issue: `${rule.label}: "${match[0]}" → "${rule.fix}"`, category: 'GRAMMAR' });
      }
    }
    rule.re.lastIndex = 0;
  }

  // Double space check (capped at 1 issue)
  if (/  +/.test(bodyText)) {
    issues.push({ issue: 'Double spaces found in content', category: 'GRAMMAR' });
  }

  // Known misspellings (curated list — context-free, high confidence)
  for (const { re, correct } of WORD_CONFUSIONS) {
    if (correct === null) continue; // skip valid words used as anchors
    const match = bodyText.match(re);
    if (match) {
      issues.push({ issue: `Likely misspelling: "${match[0]}" → "${correct}"`, category: 'SPELLING' });
    }
    re.lastIndex = 0;
  }

  return issues;
}

// ─── Spell check using nspell dictionary ──────────────────────────────────────

async function checkSpelling(bodyText) {
  const sc = await initSpellChecker();
  const issues = [];

  // Extract only lowercase words, skip short words, numbers, URLs, and proper nouns
  const words = bodyText
    .replace(/https?:\/\/\S+/g, '')          // remove URLs
    .replace(/\b\d[\d.,%-]*\b/g, '')         // remove numbers
    .match(/\b[a-z]{4,}\b/g) ?? [];          // only lowercase words ≥4 chars

  const checked = new Set();
  const misspelled = [];

  for (const word of words) {
    if (checked.has(word)) continue;
    checked.add(word);
    if (SPELL_ALLOWLIST.has(word)) continue;
    if (!sc.correct(word)) {
      const suggestions = sc.suggest(word).slice(0, 2);
      misspelled.push({ word, suggestions });
      if (misspelled.length >= 10) break; // cap at 10 per page to avoid noise
    }
  }

  for (const { word, suggestions } of misspelled) {
    const hint = suggestions.length ? ` (did you mean: ${suggestions.join(', ')}?)` : '';
    issues.push({ issue: `Possible misspelling: "${word}"${hint}`, category: 'SPELLING' });
  }

  return issues;
}

// ─── Check functions ──────────────────────────────────────────────────────────

const PLACEHOLDER_PATTERNS = [
  { re: /\blorem\s+ipsum\b/i,                         label: 'Lorem ipsum text' },
  { re: /\bplaceholder\b/i,                           label: 'Placeholder text' },
  { re: /\b(?:todo|tbd|fixme)\b/i,                   label: 'TODO/TBD/FIXME marker' },
  { re: /\[\[[\s\S]{1,80}?\]\]/,                      label: 'Unclosed template [[...]]' },
  { re: /\{\{[\s\S]{1,80}?\}\}/,                      label: 'Unclosed template {{...}}' },
  { re: /\[INSERT\s+\w/i,                             label: '[INSERT ...] placeholder' },
  { re: /\[COPY\s+\w/i,                               label: '[COPY ...] placeholder' },
  { re: /sample text/i,                               label: 'Sample text' },
  { re: /dummy\s+(?:text|content|copy)/i,             label: 'Dummy text/content' },
];

// Checks content text for placeholder patterns; returns array of matched labels
function checkPlaceholderText(bodyText) {
  const found = [];
  for (const { re, label } of PLACEHOLDER_PATTERNS) {
    if (re.test(bodyText)) found.push(label);
  }
  return found;
}

// Returns array of issues per image: { src, issue }
function checkImages(mainHtml) {
  const issues = [];
  const imgRe = /<img(\s[^>]*?)?(?:\/>|>)/gi;

  for (const m of mainHtml.matchAll(imgRe)) {
    const attrs = m[1] ?? '';
    const src   = extractAttr(attrs, 'src') ?? '';
    const alt   = extractAttr(attrs, 'alt');  // null = attribute absent

    if (alt === null || alt.trim() === '') {
      issues.push({ src, issue: 'Missing alt text', category: 'IMAGES' });
    }
  }

  // Collect all image srcs for 404 checking (returned separately)
  const imgSrcs = [];
  for (const m of mainHtml.matchAll(/<img\s[^>]*?src=(?:"([^"]*?)"|'([^']*?)'|([^\s>]+))/gi)) {
    const src = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (src && !src.startsWith('data:')) imgSrcs.push(src);
  }

  return { issues, imgSrcs };
}

// Returns array of video issues (poster attribute check)
function checkVideos(mainHtml) {
  const issues = [];
  const videoRe = /<video(\s[^>]*)?>[\s\S]*?<\/video>/gi;
  for (const m of mainHtml.matchAll(videoRe)) {
    const attrs = m[1] ?? '';
    const poster = extractAttr(attrs, 'poster');
    if (poster === null || poster.trim() === '') {
      issues.push({ issue: 'Video missing poster attribute', category: 'VIDEOS' });
    }
  }
  return issues;
}

// Returns array of link issues + list of internal hrefs to check
function checkLinks(mainHtml) {
  const issues = [];
  const internalHrefs = [];
  const linkRe = /<a\s([^>]*?)>/gi;

  for (const m of mainHtml.matchAll(linkRe)) {
    const attrs = m[1] ?? '';
    const href  = extractAttr(attrs, 'href') ?? '';
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;

    // Absolute links to the prod domain that should be relative
    if (/https?:\/\/(?:www\.)?wellsfargo\.com\//i.test(href)) {
      issues.push({ href, issue: 'Absolute link to prod domain (should be relative)', category: 'LINKS' });
      internalHrefs.push(href);
      continue;
    }

    // Links to old CMS / media domains
    for (const domain of OLD_DOMAINS) {
      if (href.includes(domain)) {
        issues.push({ href, issue: `Link to old CMS domain: ${domain}`, category: 'LINKS' });
      }
    }

    // Links to EDS absolute URL (should be relative)
    if (href.startsWith(EDS_BASE_CLEAN + '/') || href === EDS_BASE_CLEAN) {
      issues.push({ href, issue: 'Absolute link to EDS domain (should be relative)', category: 'LINKS' });
      const p = new URLClass(href).pathname.replace(/\/$/, '') || '/';
      internalHrefs.push(EDS_BASE_CLEAN + p);
      continue;
    }

    // Relative internal links — collect for optional HEAD check
    if (href.startsWith('/') && CHECK_LINKS) {
      internalHrefs.push(EDS_BASE_CLEAN + (href.length > 1 ? href.replace(/\/$/, '') : href));
    }
  }

  // Generic/weak anchor text
  const genericAnchors = ['click here', 'here', 'read more', 'learn more', 'more info', 'link'];
  for (const m of mainHtml.matchAll(/<a\s[^>]*?>([\s\S]*?)<\/a>/gi)) {
    const text = decodeEntities(stripTags(m[1])).replace(/\s+/g, ' ').trim().toLowerCase();
    if (genericAnchors.includes(text)) {
      issues.push({ href: extractAttr(m[0], 'href') ?? '', issue: `Generic/weak anchor text: "${text}"`, category: 'LINKS' });
    }
  }

  return { issues, internalHrefs };
}

// Returns array of content quality issues
function checkQuality(mainHtml) {
  const issues = [];

  // Strip scripts/styles before text analysis
  let cleaned = mainHtml
    .replace(/<script[\s>][\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s>][\s\S]*?<\/style>/gi, ' ');

  const bodyText = decodeEntities(stripTags(cleaned)).replace(/\s+/g, ' ');

  // H1 presence
  const h1Count = (mainHtml.match(/<h1[\s>]/gi) || []).length;
  if (h1Count === 0) issues.push({ issue: 'No H1 heading found', category: 'QUALITY' });
  if (h1Count > 1)  issues.push({ issue: `Multiple H1 headings (${h1Count})`, category: 'QUALITY' });

  // Placeholder patterns
  const placeholders = checkPlaceholderText(bodyText);
  for (const p of placeholders) {
    issues.push({ issue: p, category: 'COMPLETENESS' });
  }

  // ALL CAPS blocks (3+ consecutive uppercase words — likely unreplaced placeholder)
  const capsMatches = bodyText.match(/\b[A-Z]{3,}(?:\s+[A-Z]{3,}){2,}\b/g) ?? [];
  for (const caps of capsMatches.slice(0, 3)) {
    if (!['LLC', 'FDIC', 'APR', 'ATM', 'IRA', 'HSA', 'ETF', 'CEO', 'USA', 'SSN'].some(a => caps.includes(a))) {
      issues.push({ issue: `ALL CAPS block detected: "${caps.slice(0, 60)}"`, category: 'COMPLETENESS' });
    }
  }

  // Very short word count (page body under 20 words = likely stub)
  const wordCount = bodyText.split(/\s+/).filter(w => w.length > 2).length;
  if (wordCount < 20) {
    issues.push({ issue: `Very low word count (${wordCount} words) — possible stub page`, category: 'COMPLETENESS' });
  }

  return issues;
}

// ─── Per-page audit ───────────────────────────────────────────────────────────

async function auditPage(html) {
  const main = extractMain(html);
  const allIssues = [];
  const assetUrls = { images: [], links: [] };

  // Images
  const { issues: imgIssues, imgSrcs } = checkImages(main);
  allIssues.push(...imgIssues);
  assetUrls.images.push(...imgSrcs);

  // Videos
  allIssues.push(...checkVideos(main));

  // Links
  const { issues: linkIssues, internalHrefs } = checkLinks(main);
  allIssues.push(...linkIssues);
  assetUrls.links.push(...internalHrefs);

  // Quality & completeness
  allIssues.push(...checkQuality(main));

  // Grammar (always-on, pattern-based)
  // Insert newlines at block element boundaries before stripping tags so that text from
  // separate elements (e.g. <h3>Tests</h3><p>Tests passed</p>) doesn't run together
  // and produce false "repeated word" matches.
  const cleanedText = decodeEntities(stripTags(
    main.replace(/<script[\s>][\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s>][\s\S]*?<\/style>/gi, ' ')
        .replace(/<\/(p|h[1-6]|li|td|th|div|section|article|header|footer|blockquote|dt|dd)>/gi, '\n')
  )).replace(/[^\S\n]+/g, ' ').replace(/\n /g, '\n').trim();
  allIssues.push(...checkGrammar(cleanedText));

  // Spelling (opt-in via --check-spelling)
  if (CHECK_SPELLING) {
    allIssues.push(...await checkSpelling(cleanedText));
  }

  return { issues: allIssues, assetUrls };
}

// ─── Resolve image URLs to absolute ──────────────────────────────────────────

function resolveUrl(src, pageUrl) {
  if (!src) return null;
  if (src.startsWith('data:')) return null;
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith('//')) return 'https:' + src;
  try {
    return new URLClass(src, pageUrl).href;
  } catch (_) {
    return null;
  }
}

// ─── Batch async HEAD checks ──────────────────────────────────────────────────

async function batchHead(urlList, label) {
  const unique = [...new Set(urlList.filter(Boolean))];
  const results = new Map();
  let done = 0;

  for (let i = 0; i < unique.length; i += CONCURRENCY) {
    const batch = unique.slice(i, i + CONCURRENCY);
    const statuses = await Promise.all(batch.map(u => headCheck(u)));
    batch.forEach((u, j) => results.set(u, statuses[j]));
    done += batch.length;
    process.stdout.write(`\r  ${label}: ${done}/${unique.length}`);
  }
  if (unique.length > 0) console.log();
  return results;
}

// ─── Nav / Footer audit ───────────────────────────────────────────────────────

async function auditNavFooter() {
  const results = {};
  for (const [name, docPath] of [['nav', NAV_PATH], ['footer', FOOTER_PATH]]) {
    const url = EDS_BASE_CLEAN + docPath;
    const { status, html } = await fetchHtml(url);
    if (!html) {
      results[name] = { url, status, issues: [`${name} page returned ${status}`] };
      continue;
    }
    const linkIssues = [];
    const broken = [];
    const linkRe = /<a\s([^>]*?)>/gi;
    const hrefs = [];
    for (const m of html.matchAll(linkRe)) {
      const href = extractAttr(m[1] ?? '', 'href') ?? '';
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
      if (/^https?:\/\//i.test(href)) {
        // External absolute — check if it should be relative (same EDS hostname)
        try {
          const h = new URLClass(href).hostname;
          if (h === edsHostname) linkIssues.push(`Absolute link in ${name}: ${href}`);
        } catch (_) {}
      }
      // OLD domain check
      for (const domain of OLD_DOMAINS) {
        if (href.includes(domain)) linkIssues.push(`Old CMS domain in ${name}: ${href}`);
      }
      if (href.startsWith('/')) hrefs.push(EDS_BASE_CLEAN + (href.length > 1 ? href.replace(/\/$/, '') : href));
    }
    // HEAD check all nav/footer links
    if (hrefs.length > 0) {
      console.log(`  Checking ${hrefs.length} ${name} links...`);
      const statuses = await batchHead(hrefs, name);
      for (const [u, s] of statuses) {
        if (s === 404 || s === 0) broken.push({ url: u, status: s });
      }
    }
    results[name] = { url, status, issues: linkIssues, brokenLinks: broken };
  }
  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log(`\nEDS Site Audit — ${urls.length} pages | EDS: ${EDS_BASE_CLEAN}`);
console.log(`Concurrency: ${CONCURRENCY} | Check links: ${CHECK_LINKS}\n`);

const pageResults = [];
const allImageUrls = [];
const allInternalLinks = [];

// Phase 1: Fetch & static-analyse all pages
let done = 0;
for (let i = 0; i < urls.length; i += CONCURRENCY) {
  const batch = urls.slice(i, i + CONCURRENCY);

  const batchResults = await Promise.all(batch.map(async (originalUrl) => {
    let pathname;
    try { pathname = new URLClass(originalUrl).pathname; } catch (_) { pathname = originalUrl; }
    // EDS serves pages without trailing slash (e.g. /checking not /checking/)
    const normalizedPath = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
    const edsUrl = EDS_BASE_CLEAN + normalizedPath;

    const { status, html, error } = await fetchHtml(edsUrl);
    if (!html) {
      return {
        originalUrl, edsUrl, status,
        issues: [{ issue: error ?? `Page returned ${status}`, category: 'FETCH' }],
        issueCount: 1, assetUrls: { images: [], links: [] },
      };
    }

    const { issues, assetUrls } = await auditPage(html);
    return { originalUrl, edsUrl, status, issues, issueCount: issues.length, assetUrls };
  }));

  for (const r of batchResults) {
    pageResults.push(r);
    for (const src of r.assetUrls.images) {
      const abs = resolveUrl(src, r.edsUrl);
      if (abs) allImageUrls.push({ src: abs, pageUrl: r.edsUrl });
    }
    for (const href of r.assetUrls.links) allInternalLinks.push(href);
  }

  done += batch.length;
  process.stdout.write(`\rFetched ${done}/${urls.length} pages`);
}
console.log('\n');

// Phase 2: HEAD-check all images
console.log(`Checking ${allImageUrls.length} image URLs...`);
const uniqueImgUrls = [...new Set(allImageUrls.map(u => u.src))];
const imgStatuses = await batchHead(uniqueImgUrls, 'images');

// Attach image 404 issues back to pages
const imgToPages = new Map();
for (const { src, pageUrl } of allImageUrls) {
  if (!imgToPages.has(src)) imgToPages.set(src, []);
  imgToPages.get(src).push(pageUrl);
}
const imgNotFound = new Map();
for (const [src, status] of imgStatuses) {
  if (status === 404 || status === 0) {
    imgNotFound.set(src, status);
    // Add issue to each page that uses this image
    for (const pr of pageResults) {
      if (allImageUrls.some(u => u.src === src && u.pageUrl === pr.edsUrl)) {
        pr.issues.push({ src, issue: `Image not found (${status}): ${src}`, category: 'IMAGES' });
        pr.issueCount++;
      }
    }
  }
}
console.log(`  Image 404s: ${imgNotFound.size}`);

// Phase 3: HEAD-check internal links (if --check-links)
if (CHECK_LINKS && allInternalLinks.length > 0) {
  console.log(`\nChecking ${allInternalLinks.length} internal links...`);
  const linkStatuses = await batchHead([...new Set(allInternalLinks)], 'links');
  for (const [href, status] of linkStatuses) {
    if (status === 404 || status === 0) {
      for (const pr of pageResults) {
        if (pr.assetUrls.links.includes(href)) {
          pr.issues.push({ href, issue: `Broken internal link (${status}): ${href}`, category: 'LINKS' });
          pr.issueCount++;
        }
      }
    }
  }
}

// Phase 4: Nav + Footer audit
console.log('\nAuditing nav and footer...');
const navFooterResults = await auditNavFooter();

// ─── Stats ────────────────────────────────────────────────────────────────────

const total     = pageResults.length;
const passed    = pageResults.filter(r => r.issueCount === 0).length;
const withIssues = total - passed;

const categoryCounts = {};
for (const pr of pageResults) {
  for (const iss of pr.issues) {
    const cat = iss.category ?? 'OTHER';
    categoryCounts[cat] = (categoryCounts[cat] ?? 0) + 1;
  }
}

const issueCounts = {};
for (const pr of pageResults) {
  for (const iss of pr.issues) {
    issueCounts[iss.issue] = (issueCounts[iss.issue] ?? 0) + 1;
  }
}
const topIssues = Object.entries(issueCounts)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 15);

const worstPages = [...pageResults]
  .filter(r => r.issueCount > 0)
  .sort((a, b) => b.issueCount - a.issueCount)
  .slice(0, 10);

// ─── Console summary ──────────────────────────────────────────────────────────

console.log('\n╔══════════════════════════════════════════════════════════╗');
console.log('║              EDS SITE AUDIT — SUMMARY                   ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');
console.log(`Pages audited : ${total}`);
console.log(`Passed (0 issues): ${passed}  (${(passed / total * 100).toFixed(1)}%)`);
console.log(`With issues   : ${withIssues}\n`);

console.log('Issues by category:');
for (const [cat, count] of Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${cat.padEnd(18)} ${count}`);
}

console.log('\nTop 15 most common issues:');
for (const [issue, count] of topIssues) {
  console.log(`  ${String(count).padStart(4)}×  ${issue.slice(0, 100)}`);
}

console.log('\nTop 10 pages by issue count:');
for (const pr of worstPages) {
  const path = pr.edsUrl.replace(EDS_BASE_CLEAN, '');
  console.log(`  ${String(pr.issueCount).padStart(3)} issues  ${path}`);
}

console.log('\nNav / Footer:');
for (const [name, r] of Object.entries(navFooterResults)) {
  const issCount = (r.issues?.length ?? 0) + (r.brokenLinks?.length ?? 0);
  console.log(`  ${name}: ${r.status} | ${issCount} issues`);
  for (const iss of (r.issues ?? [])) console.log(`    • ${iss}`);
  for (const b of (r.brokenLinks ?? [])) console.log(`    • Broken link (${b.status}): ${b.url}`);
}

// ─── CSV output ───────────────────────────────────────────────────────────────

const CSV_PATH = path.join(OUTPUT_DIR, 'audit-report.csv');
const csvHeader = [
  'url_path', 'eds_url', 'http_status',
  'issues_count', 'completeness_issues', 'image_issues', 'link_issues', 'quality_issues', 'video_issues', 'grammar_issues', 'spelling_issues',
  'issues',
].join(',');

function csvCell(v) {
  const s = String(v ?? '');
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"` : s;
}

const csvRows = pageResults.map(pr => {
  const pathname = (() => { try { return new URLClass(pr.originalUrl).pathname; } catch (_) { return pr.originalUrl; } })();
  const bycat = cat => pr.issues.filter(i => i.category === cat).map(i => i.issue).join(' | ');
  return [
    csvCell(pathname),
    csvCell(pr.edsUrl),
    csvCell(pr.status),
    csvCell(pr.issueCount),
    csvCell(bycat('COMPLETENESS')),
    csvCell(bycat('IMAGES')),
    csvCell(bycat('LINKS')),
    csvCell(bycat('QUALITY')),
    csvCell(bycat('VIDEOS')),
    csvCell(bycat('GRAMMAR')),
    csvCell(bycat('SPELLING')),
    csvCell(pr.issues.map(i => i.issue).join(' | ')),
  ].join(',');
});

writeFileSync(CSV_PATH, [csvHeader, ...csvRows].join('\n'));
console.log(`\nCSV saved: ${CSV_PATH}`);

// ─── HTML report ──────────────────────────────────────────────────────────────

const HTML_PATH = path.join(OUTPUT_DIR, 'index.html');

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

const categoryBadge = cat => {
  const colours = { COMPLETENESS: '#E68619', IMAGES: '#7326D3', LINKS: '#1473E6', QUALITY: '#2D9D78', VIDEOS: '#CC0000', GRAMMAR: '#D2691E', SPELLING: '#8B008B', FETCH: '#6E6E6E' };
  const bg = colours[cat] ?? '#8E8E8E';
  return `<span style="background:${bg};color:#fff;padding:1px 6px;border-radius:3px;font-size:11px;font-weight:600">${esc(cat)}</span>`;
};

const pageLabel = pr => {
  if (pr.issues.some(i => i.category === 'FETCH')) {
    return `<span class="label label-error">ERROR</span>`;
  }
  if (pr.issueCount === 0) {
    return `<span class="label label-pass">PASS</span>`;
  }
  return `<span class="label label-fail">FAILED</span>`;
};

const allRows = [...pageResults]
  .sort((a, b) => {
    // Order: FAILED (most issues first), then ERROR, then PASS
    const aErr = a.issues.some(i => i.category === 'FETCH');
    const bErr = b.issues.some(i => i.category === 'FETCH');
    if (!aErr && !bErr) return b.issueCount - a.issueCount;
    if (aErr && bErr) return 0;
    if (!aErr && a.issueCount > 0) return -1; // FAILED before ERROR
    if (!bErr && b.issueCount > 0) return 1;
    if (a.issueCount === 0) return 1;  // PASS last
    if (b.issueCount === 0) return -1;
    return 0;
  })
  .map(pr => {
    const pathname = (() => { try { return new URLClass(pr.originalUrl).pathname; } catch (_) { return pr.originalUrl; } })();
    const issueHtml = pr.issues.length
      ? `<ul style="margin:0;padding-left:16px">${pr.issues.map(i => `<li>${categoryBadge(i.category)} ${esc(i.issue)}</li>`).join('')}</ul>`
      : '';
    const rowClass = pr.issues.some(i => i.category === 'FETCH') ? 'row-error' : pr.issueCount === 0 ? 'row-pass' : 'row-fail';
    return `
      <tr class="${rowClass}">
        <td>${pageLabel(pr)}</td>
        <td><a href="${esc(pr.edsUrl)}" target="_blank">${esc(pathname)}</a></td>
        <td style="text-align:center">${pr.issueCount || ''}</td>
        <td style="text-align:center">${pr.status}</td>
        <td>${issueHtml}</td>
      </tr>`;
  }).join('');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>EDS Site Audit</title>
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
  <h1>EDS Site Audit</h1>
  <div class="meta">Generated ${new Date().toISOString()} &nbsp;·&nbsp; ${total} pages &nbsp;·&nbsp; ${EDS_BASE_CLEAN}</div>
</div>
<div class="content">
<div class="stats">
  <div class="stat"><div class="n">${total}</div><div class="l">Pages audited</div></div>
  <div class="stat"><div class="n" style="color:#2D9D78">${passed}</div><div class="l">Passed</div></div>
  <div class="stat"><div class="n" style="color:#FF0000">${pageResults.filter(r => r.issueCount > 0 && !r.issues.some(i => i.category === 'FETCH')).length}</div><div class="l">Failed</div></div>
  <div class="stat"><div class="n" style="color:#8E8E8E">${pageResults.filter(r => r.issues.some(i => i.category === 'FETCH')).length}</div><div class="l">Error (404)</div></div>
  ${Object.entries(categoryCounts).filter(([cat]) => cat !== 'FETCH').map(([cat, n]) => `<div class="stat"><div class="n" style="color:#7326D3">${n}</div><div class="l">${cat} issues</div></div>`).join('')}
</div>
<h2>All pages (${total})</h2>
<table>
  <thead><tr><th>Result</th><th>Page</th><th>Issues</th><th>HTTP</th><th>Details</th></tr></thead>
  <tbody>${allRows}</tbody>
</table>
</div>
</body>
</html>`;

writeFileSync(HTML_PATH, html);
console.log(`HTML report: ${HTML_PATH}`);
console.log('\nDone.\n');
