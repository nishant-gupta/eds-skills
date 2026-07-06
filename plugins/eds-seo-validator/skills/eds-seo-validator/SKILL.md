---
name: eds-seo-validator
description: Use this skill when the user wants to validate, audit, or check SEO metadata on AEM Edge Delivery Services (EDS) pages. Triggers on phrases like "SEO validation", "check meta tags", "validate metadata", "check title and description", "OG tags audit", "twitter card check", "SEO audit EDS pages", "check page metadata", "deep SEO check", "detailed SEO validation", "full SEO audit", "core web vitals", "CWV check", "lighthouse audit", "PageSpeed Insights", "compare seo", "seo migration check", "seo parity", "nothing missed in migration".
license: Apache-2.0
metadata:
  version: "4.0.0"
---

# EDS SEO Validator

Four modes depending on depth required:

| Mode | Script | How | Speed | Use For |
|------|--------|-----|-------|---------|
| **Fast** | `check-seo.mjs` | HTTP fetch + regex | ~2–3 min / 100 pages | Metadata + OG/Twitter tags on EDS |
| **Deep** | `check-seo-deep.js` | Playwright Chromium | ~8–10 min / 73 pages | 68/80 checklist items incl. CWV, JSON-LD, headings, mobile, accessibility |
| **CWV** | `check-cwv.js` | PageSpeed Insights API | ~1–3 min / 20 pages | Lighthouse lab scores + CrUX real-user field data (LCP, FCP, CLS, INP, TTFB) |
| **Compare** | `check-seo-compare.mjs` | HTTP fetch + regex (both sites) | ~3–5 min / 100 pages | Side-by-side diff: production vs EDS — surfaces migration gaps |

Use **fast mode** for a quick EDS metadata check. Use **deep mode** for a full pre-launch SEO audit. Use **CWV mode** for Lighthouse scores. Use **compare mode** to verify SEO parity between production and EDS during migration.

---

## When to Use This Skill

Use this skill when:
- Auditing SEO readiness of an EDS site before go-live
- Checking that meta tags are correctly set across all pages
- Validating OG/Twitter images are accessible (200 status)
- Running a full checklist audit (deep mode) including CWV, structured data, headings, mobile
- Getting Lighthouse performance scores and real-user CWV field data (CWV mode)
- **Verifying SEO parity between the live production site and the EDS migration** (compare mode)
- Checking "nothing is missed" in the migration in terms of SEO

**Do NOT use when:**
- You only need to check a single page (use `curl` + manual inspection)
- The sitemap hasn't been fetched yet — run `eds-sitemap-checker` first to get `/tmp/sitemap-urls.json`

---

## Execution Model

This skill uses a **two-phase approach**:

1. **Input gathering** (main agent) — confirm sitemap, probe for auth, determine mode, collect any missing parameters
2. **Background Bash execution** — once all inputs are known, run scripts directly using `run_in_background: true` Bash commands

> **IMPORTANT: Do NOT use the Agent tool to dispatch script runs.** Sub-agents launched via the Agent tool run in fully isolated sessions with no Bash permissions, regardless of settings.json. Always use background Bash commands directly instead — they inherit the current session's permissions and work reliably.

For batched parallel execution, fire multiple `run_in_background: true` Bash calls in a single message (one per batch), then wait for all to complete before merging results.

### Bash dispatch template

After all inputs are collected, use the Bash tool with `run_in_background: true`:

Use the Bash tool with `run_in_background: true` and `timeout: 600000`. Redirect stdout to a log file so you can read results after completion:

> **IMPORTANT: The output path MUST end in `.csv`.**
> The script writes the CSV to that exact path, then derives the HTML path by replacing `.csv` → `.html`.
> If you omit `.csv`, the HTML report overwrites the CSV and you lose the CSV entirely.

```bash
# Single run example (fast/CWV/compare):
cd ~/.claude/skills/eds-seo-validator && node scripts/check-seo-deep.js \
  <SITEMAP_JSON> \
  "<BASE_URL>" \
  /tmp/eds-seo-deep-report.csv \
  [--auth=user:pass] \
  [--auth-header="token ..."] \
  > /tmp/seo-deep.log 2>&1
# Auth: --auth-header (or env EDS_AUTH) is a raw Authorization header (EDS/AEM token / Bearer); wins over Basic.
# Produces: /tmp/eds-seo-deep-report.csv  AND  /tmp/eds-seo-deep-report.html

# For check-cwv.mjs (no cd needed):
node ~/.claude/skills/eds-seo-validator/scripts/check-cwv.mjs \
  <SITEMAP_JSON> \
  /tmp/eds-cwv-report.csv \
  --base-url="<BASE_URL>" \
  [--key=API_KEY] \
  [--strategy=both] > /tmp/cwv.log 2>&1
# Produces: /tmp/eds-cwv-report.csv  AND  /tmp/eds-cwv-report.html
```

**For batched parallel runs**, always use numbered `.csv` paths:
```bash
# Batch 1:  /tmp/seo-batch-1.csv  → also produces /tmp/seo-batch-1.html
# Batch 2:  /tmp/seo-batch-2.csv  → also produces /tmp/seo-batch-2.html
# ...and so on
```

After the background command completes, read the log file for results.

**Parallel batch execution:** Send multiple `run_in_background: true` Bash tool calls in a single message (one per batch). After all complete, read each log and merge results.

### Step: Merge batch HTML reports into one

After all batches complete, merge the individual batch HTML files into a single report using the merge script:

```bash
node ~/.claude/skills/eds-seo-validator/scripts/merge-seo-reports.mjs \
  /tmp/seo-merged/index.html \
  /tmp/seo-batch-1.html \
  /tmp/seo-batch-2.html \
  [/tmp/seo-batch-3.html ...]
```

Arguments: `<output-path> <batch1.html> [batch2.html ...]`

The title and base URL are auto-detected from the batch HTML `meta` line — no hardcoded project names.

**What the merge script preserves from individual batch reports:**
- Exact CSS: dark `#1B1B1B` header bar, `.stat` cards, `.label-pass`/`.label-fail`/`.label-error` badges
- Row backgrounds: `row-fail` (red-tinted `#fff5f5`), `row-pass` (green `#f0faf4`), `row-error` (grey)
- Colored category `<span>` badges inline in Details cells (METADATA `#E68619`, OG/TWITTER `#d35400`, HEADINGS `#1473E6`, LINKS `#2471a3`, CWV `#CC0000`, IMAGES/A11Y `#5C1EA8`)
- All 1546 rows sorted worst-first by issue count

**What the merge script adds:**
- Aggregated stat cards across all batches (total pages, passed, failed, errors, per-category counts)
- Top 30 most common issues table
- SEO checklist at bottom (§1.1–§13.4) mapping every section reference to its description, marked CHECKED or SKIPPED

**Column widths in the merged pages table:**

| Column | Width |
|--------|-------|
| Status | 60px |
| URL | 280px |
| Issues | 50px |
| HTTP | 50px |
| Details | auto (majority of remaining space) |

**Important:** Do NOT zip the output twice. Always `rm -f` the old zip before recreating it — otherwise `zip -r` appends and creates duplicate entries (e.g. two `index.html` files at different paths), causing the user to open the stale one.

```bash
rm -f /path/to/report.zip
zip -r /path/to/report.zip /tmp/merged-dir/ /tmp/seo-batch-*.html
```

---

## Step 0: Confirm Sitemap URLs + Probe for Auth

```bash
test -f /tmp/sitemap-urls.json \
  && node -e "const u=require('/tmp/sitemap-urls.json'); console.log(u.length, 'URLs ready')" \
  || echo "MISSING — run eds-sitemap-checker first"
```

Once URLs are confirmed, **probe the first URL** against the target domain before running any check:

```bash
node -e "
const urls = require('/tmp/sitemap-urls.json');
const base = '<TARGET_BASE_URL>'.replace(/\/$/,'');
const { URL } = require('url');
const first = base + new URL(urls[0]).pathname;
fetch(first, { method: 'HEAD' }).then(r => {
  console.log('Probe status:', r.status, first);
});
"
```

- **401 returned** → the environment is protected. Ask which auth applies:
  - **HTTP Basic** (htaccess): credentials as `user:password` → pass `--auth=user:password`
    (or `--auth-eds` / `--auth-prod` for the compare script).
  - **EDS/AEM sidekick token** (value like `token hlxtst_...` or `Bearer ...`): pass the full
    `Authorization` header via `--auth-header="<value>"` (or `--auth-header-eds` / `--auth-header-prod`
    for compare), or via env vars `EDS_AUTH` / `PROD_AUTH` to keep the token out of the argument list.
    Raw header wins over Basic. A token's `aud` claim ends in `...aem.page` (preview) or `...aem.live` (prod).
- **Any other status** → proceed without auth.

**Note:** The CWV script (`check-cwv.mjs`) cannot use htaccess credentials **or tokens** — PageSpeed Insights crawls from Google's servers, which cannot present a sidekick token. Warn the user if they try to run CWV against a protected URL; use deep mode instead.

If missing, fetch the sitemap:

```bash
curl -s "<LIVE_SITE>/sitemap.xml" -o /tmp/sitemap.xml
node -e "
const fs = require('fs');
const xml = fs.readFileSync('/tmp/sitemap.xml', 'utf8');
const matches = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1].trim());
fs.writeFileSync('/tmp/sitemap-urls.json', JSON.stringify(matches, null, 2));
console.log('Found', matches.length, 'URLs');
"
```

---

## Mode 1: Fast SEO Check (`check-seo.mjs`)

### When to use
- Quick metadata scan
- No Playwright dependency required
- Good for iterative checks during development

### Dispatch sub-agent

Once sitemap file, base URL, and optional auth are confirmed, dispatch a sub-agent:

```
Run this command and return: full output + summary (total, passed, issue counts, top issues, worst pages) + CSV path.

node ~/.claude/skills/eds-seo-validator/scripts/check-seo.mjs \
  <SITEMAP_JSON> \
  "<BASE_URL>" \
  /tmp/eds-seo-report.csv \
  [--auth=user:pass] \
  [--auth-header="token ..."]   # or set env EDS_AUTH; wins over Basic
```

### What it checks

| Field | Rule |
|-------|------|
| `<title>` | Required · 30–60 chars |
| `meta description` | Required · 120–160 chars |
| `meta keywords` | Optional · max 10 terms |
| `og:title` | Required · 30–90 chars |
| `og:description` | Required · 120–200 chars |
| `og:image` | Required · HEAD request must return 200 |
| `og:url`, `og:type` | Required · must be present |
| `twitter:card` | Required · `summary`, `summary_large_image`, `app`, or `player` |
| `twitter:title/description` | Optional · length-checked if present |
| `twitter:image` | Optional · HEAD check if present |

### How it works
- Fetches full HTML (5 concurrent, 20s timeout)
- Regex-based meta tag extraction — no external dependencies
- HEAD requests to validate `og:image` and `twitter:image` URLs
- Aggregate check: duplicate titles and descriptions across all pages

### CSV output: `eds-seo-report.csv`

| Column | Description |
|--------|-------------|
| `original_url` | Sitemap URL |
| `eds_url` | Target URL checked |
| `http_status` | Page HTTP status |
| `title` / `title_length` | Title value and character count |
| `description` / `description_length` | Description value and character count |
| `keywords` | Keywords meta content |
| `og_title` / `og_title_length` | OG title and length |
| `og_description` / `og_description_length` | OG description and length |
| `og_image` / `og_image_status` | OG image URL and HTTP status |
| `og_url` / `og_type` | OG URL and type |
| `twitter_card` / `twitter_title` / `twitter_description` / `twitter_image` / `twitter_image_status` | Twitter card fields |
| `issues_count` / `issues` | Count and pipe-separated issue list |

---

## Mode 2: Deep SEO Check (`check-seo-deep.js`)

### When to use
- Full pre-launch SEO audit
- Need Core Web Vitals, JSON-LD, heading structure, mobile, accessibility checks
- Validating against the full 80-item SEO Validation Checklist

### Prerequisites

Playwright and Chromium must be installed in the skill directory:

```bash
# Check playwright is installed
cd ~/.claude/skills/eds-seo-validator && node -e "require('playwright'); console.log('OK')"

# Install if missing
cd ~/.claude/skills/eds-seo-validator && npm install playwright && npx playwright install chromium
```

### Dispatch sub-agent

Once sitemap file, base URL, and optional auth are confirmed, dispatch a sub-agent:

```
Run this command and return: full output + structured summary (total, passed, issue counts by section, top 20 most common issues with counts, top 5 worst pages, site-level check results, CWV averages) + CSV and HTML paths.

cd ~/.claude/skills/eds-seo-validator && node scripts/check-seo-deep.js \
  <SITEMAP_JSON> \
  "<BASE_URL>" \
  /tmp/eds-seo-deep-report.csv \
  [--auth=user:pass] \
  [--auth-header="token ..."]   # or set env EDS_AUTH; wins over Basic

# Produces two files:
#   /tmp/eds-seo-deep-report.csv  — per-page CSV with all metric columns
#   /tmp/eds-seo-deep-report.html — interactive HTML report
# IMPORTANT: always pass a path ending in .csv — the script derives the .html path
# automatically. Omitting .csv causes HTML to overwrite the CSV.
```

**For batched parallel runs**, use numbered `.csv` paths per batch:
```bash
# Batch 1 → produces /tmp/seo-batch-1.csv + /tmp/seo-batch-1.html
cd ~/.claude/skills/eds-seo-validator && node scripts/check-seo-deep.js \
  /tmp/sitemap-batch-1.json "<BASE_URL>" /tmp/seo-batch-1.csv > /tmp/seo-batch-1.log 2>&1

# Batch 2 → produces /tmp/seo-batch-2.csv + /tmp/seo-batch-2.html
cd ~/.claude/skills/eds-seo-validator && node scripts/check-seo-deep.js \
  /tmp/sitemap-batch-2.json "<BASE_URL>" /tmp/seo-batch-2.csv > /tmp/seo-batch-2.log 2>&1
```

**Note:** Must run from `~/.claude/skills/eds-seo-validator/` so Node.js resolves the local `playwright` package.

### What it checks (68 of 80 checklist items)

| Section | Checks |
|---------|--------|
| §1 Metadata | title (presence, 50–60 chars), description (presence, 140–160 chars), keywords tag removal, robots meta |
| §2 JSON-LD / Structured Data | WebSite schema, BreadcrumbList on non-homepage pages, required fields per schema type, placement in `<head>`, parse errors |
| §3 Heading Structure | Single H1, no skipped heading levels (H1→H2→H3 etc.) |
| §4 Canonical | Present, HTTPS, self-referencing path |
| §5 Crawlability | robots.txt present + sitemap referenced, custom 404 page |
| §6 URL Structure | Lowercase, hyphens not underscores |
| §7 Internal Links | Generic anchor text ("click here"), image links without alt, non-HTTPS internal links, breadcrumb navigation |
| §8 Redirects | HTTP→HTTPS (301 only), www/non-www consistency |
| §9 OG + Twitter | All required tags, `og:image` HTTP status + **pixel dimensions** (1200×630 check), `twitter:site` handle |
| §10 Core Web Vitals | TTFB ≤800ms, FCP ≤1800ms, LCP ≤2500ms, CLS ≤0.1 — injected via PerformanceObserver before page load |
| §11 Images + Accessibility | Images missing `alt`, buttons missing accessible labels, favicon |
| §12 Mobile | `width=device-width` viewport meta, horizontal scroll at 390px viewport |
| §13 Pagination | `rel=next/rel=prev` on paginated URLs |
| Aggregate | Duplicate titles, descriptions, H1 text across all pages |

### Site-level checks (run once in parallel)

- `robots.txt` present, sitemap referenced, no `Disallow: /`
- HTTP → HTTPS redirect (checks for 301 specifically)
- www vs non-www redirect consistency
- Custom 404 page (non-200 check)

### Skipped checks (12 of 80)

| Checks | Reason |
|--------|--------|
| §1.4, §1.8, §3.5 — keyword matching | No per-page keyword map provided |
| §5.3, §5.5, §5.8 — GSC checks | Requires Google Search Console API |
| §5.9, §5.10 — crawl depth / orphaned pages | Requires full site crawl from homepage |
| §7.5 — navigation without JS | Playwright always executes JavaScript |
| §10.3 — INP | Requires real user interaction events |
| §11.2 — decorative image intent | Cannot determine programmatically |
| §11.5 — password paste | No login on this site type |
| §12.5 — touch target spacing | Requires complex layout geometry |
| §13.2–13.4 — Googlebot / dynamic indexing | Requires Googlebot UA simulation |

### Output files

The deep mode writes two files side-by-side:
- **`eds-seo-deep-report.csv`** — per-page CSV with all metric columns
- **`eds-seo-deep-report.html`** — interactive HTML report with stat cards, category badges, and a per-page issue breakdown table (PASS / FAILED / ERROR rows, sorted worst-first)

### CSV output: `eds-seo-deep-report.csv`

All fast mode columns, plus:

| Column | Description |
|--------|-------------|
| `is_https` | Page served over HTTPS |
| `canonical` | Canonical URL value |
| `h1_count` / `h1_text` | H1 count and text |
| `heading_hierarchy_ok` | Boolean — no skipped heading levels |
| `json_ld_types` / `json_ld_in_head` | Comma-separated schema types and head placement |
| `og_image_dimensions` | Image pixel dimensions e.g. `1200x630` |
| `og_site_name` | `og:site_name` value |
| `twitter_site` | `twitter:site` handle |
| `ttfb_ms` / `fcp_ms` / `lcp_ms` / `cls` | Core Web Vitals per page |
| `images_total` / `images_missing_alt` | Image accessibility counts |
| `buttons_missing_label` | Buttons without accessible labels |
| `favicon_present` | Boolean |
| `internal_links_total` / `internal_links_generic_anchor` | Link quality counts |
| `breadcrumb_present` | Boolean |
| `viewport_meta_ok` / `mobile_horizontal_scroll` | Mobile checks |
| `url_lowercase` / `url_no_underscores` | URL structure checks |

---

## Mode 3: CWV Check (`check-cwv.js`)

### When to use
- Getting authoritative Lighthouse performance scores (what Google sees)
- Checking real-user CrUX field data (LCP, FCP, CLS, INP, TTFB at 75th percentile)
- Pre-launch performance sign-off — INP is only measurable here (not in deep mode)
- Comparing lab vs. field data to identify real-world performance gaps

**Note:** The PSI API crawls from Google's servers — URLs must be **publicly accessible** (live or preview domain, not localhost).

### Prerequisites

No additional dependencies. Uses Node.js 18+ native `fetch`.

Optional: Get a free Google API key to avoid rate limiting (1 req/2s without key):
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Enable the **PageSpeed Insights API**
3. Create an API key under Credentials

### Dispatch sub-agent

Once sitemap file, optional base URL, and API key are confirmed, dispatch a sub-agent:

```
Run this command and return: full stdout output + structured summary per strategy (mobile and desktop): avg Lighthouse perf score, LCP/FCP/TTFB/TBT averages, score distribution (Excellent/Good/Needs Work/Poor), top 5 worst pages with scores and issues, error count. Also return the CSV and HTML file paths.

node ~/.claude/skills/eds-seo-validator/scripts/check-cwv.mjs \
  <SITEMAP_JSON> \
  <OUTPUT_CSV> \
  [--base-url="<EDS_BASE_URL>"] \
  [--key=API_KEY] \
  [--strategy=mobile|desktop|both]
```

Default strategy is `both` — omit `--strategy` to run mobile then desktop automatically. Output is a **single combined CSV** (with a `strategy` column) and a **single combined HTML** (per-strategy stat cards + one table with a Strategy badge column). Use `--strategy=mobile` or `--strategy=desktop` for a single-strategy run.

**Note:** Use `.mjs` extension — the skill directory's `package.json` sets `"type": "commonjs"` for the Playwright deep script; `.mjs` bypasses this per-file. The script can run from any directory.

**Note:** CWV mode cannot use `--auth` — PageSpeed Insights crawls from Google's servers and cannot pass htaccess credentials. If the target requires auth, warn the user and use deep mode instead.

### What it checks

| Data Source | Metrics |
|-------------|---------|
| **Lab (Lighthouse)** | Performance score (0–100), LCP, FCP, CLS, TTFB, TBT, Speed Index, TTI |
| **Field (CrUX p75)** | LCP, FCP, CLS, **INP** (real-user interaction), TTFB — with GOOD/NEEDS_IMPROVEMENT/POOR rating |

INP (Interaction to Next Paint) is only available here via CrUX field data — not measurable in deep mode or Playwright.

### Thresholds

| Metric | GOOD | NEEDS IMPROVEMENT | POOR |
|--------|------|-------------------|------|
| LCP | ≤ 2,500ms | ≤ 4,000ms | > 4,000ms |
| FCP | ≤ 1,800ms | ≤ 3,000ms | > 3,000ms |
| CLS | ≤ 0.10 | ≤ 0.25 | > 0.25 |
| TTFB | ≤ 800ms | ≤ 1,800ms | > 1,800ms |
| TBT | ≤ 200ms | ≤ 600ms | > 600ms |
| INP | ≤ 200ms | ≤ 500ms | > 500ms |

### CSV output: `eds-cwv-report.csv`

| Column | Description |
|--------|-------------|
| `url` | URL checked |
| `lab_perf_score` | Lighthouse performance score (0–100) |
| `lab_lcp_ms` / `lab_lcp_rating` / `lab_lcp_display` | LCP value, GOOD/NEEDS_IMPROVEMENT/POOR, display string |
| `lab_fcp_ms` / `lab_fcp_rating` / `lab_fcp_display` | FCP value, rating, display string |
| `lab_cls` / `lab_cls_rating` / `lab_cls_display` | CLS value, rating, display string |
| `lab_ttfb_ms` / `lab_ttfb_rating` / `lab_ttfb_display` | TTFB value, rating, display string |
| `lab_tbt_ms` / `lab_tbt_rating` | Total Blocking Time and rating |
| `lab_speed_index_ms` / `lab_tti_ms` | Speed Index and Time to Interactive |
| `field_overall` | CrUX overall category (FAST / AVERAGE / SLOW / NO_DATA) |
| `field_lcp_p75_ms` / `field_lcp_category` | CrUX 75th percentile LCP and category |
| `field_fcp_p75_ms` / `field_fcp_category` | CrUX 75th percentile FCP and category |
| `field_cls_p75` / `field_cls_category` | CrUX 75th percentile CLS and category |
| `field_inp_p75_ms` / `field_inp_category` | CrUX 75th percentile INP and category |
| `field_ttfb_p75_ms` | CrUX 75th percentile TTFB |
| `issues_count` / `issues` | Count and pipe-separated list of failing metrics |
| `error` | API error message if the check failed |

### Rate limits

| Mode | Concurrency | Delay | ~Time / 100 pages |
|------|-------------|-------|-------------------|
| No API key | 1 | 2s | ~3–4 min |
| With API key | 3 | 300ms | ~1 min |

---

## Mode 4: SEO Migration Comparison (`check-seo-compare.js`)

### When to use
- Verifying SEO parity between the live production site and EDS during or after migration
- Ensuring "nothing is missed" — that every page's title, description, OG tags, H1, and canonical match prod
- Producing a field-by-field diff CSV for editorial/content teams to act on

### Dispatch sub-agent

Once sitemap file, prod base URL, and EDS base URL are confirmed, dispatch a sub-agent:

```
Run this command and return: full stdout output + structured summary (total, fully matched, has gaps count, not migrated count, top gaps by field, worst pages list) + CSV path.

node ~/.claude/skills/eds-seo-validator/scripts/check-seo-compare.mjs \
  <SITEMAP_JSON> \
  "<PROD_BASE_URL>" \
  "<EDS_BASE_URL>" \
  /tmp/eds-seo-compare-report.csv \
  [--auth-eds=user:pass] \
  [--auth-prod=user:pass] \
  [--auth-header-eds="token ..."] [--auth-header-prod="token ..."]   # or env EDS_AUTH / PROD_AUTH; win over Basic
```

### What it compares per page

| Field | Critical? |
|-------|-----------|
| `title` | Yes |
| `meta description` | Yes |
| `h1` | Yes |
| `canonical` | Yes |
| `og:title` | Yes |
| `og:description` | Yes |
| `og:image` | Yes |
| `og:url` | No |
| `og:type` | No |
| `og:site_name` | No |
| `twitter:card` | No |
| `twitter:title` | No |
| `twitter:description` | No |
| `twitter:image` | No |
| `twitter:site` | No |
| `keywords` | No |
| `robots meta` | No |

**Canonical and og:image URL comparison** normalises to path only — so `https://www.example.com/mortgage/` and `https://main--mysite--myorg.aem.live/mortgage/` are treated as matching.

### Per-field diff values

| Value | Meaning |
|-------|---------|
| `MATCH` | Identical values (normalised whitespace) |
| `DIFFERENT` | Both present but values differ |
| `MISSING_ON_EDS` | Prod has the value, EDS does not |
| `MISSING_ON_PROD` | EDS has a value, prod does not |
| `BOTH_MISSING` | Neither side has it |
| `NOT_MIGRATED` | EDS returned non-200 |
| `PROD_404` | Prod page not found |

### Migration status per page

| Status | Meaning |
|--------|---------|
| `FULLY_MATCHED` | All compared fields match |
| `HAS_GAPS` | Page live on EDS but ≥1 field differs or is missing |
| `NOT_MIGRATED` | EDS returned non-200 for this path |
| `PROD_NOT_FOUND` | Production returned non-200 (skip comparison) |
| `BOTH_NOT_FOUND` | Both sides 404 |

### CSV output: `eds-seo-compare-report.csv`

Three column groups:

**Status columns:** `original_url`, `prod_url`, `eds_url`, `prod_status`, `eds_status`, `migration_status`, `gaps_count`, `critical_gaps_count`, `gaps`, `critical_gaps`

**Value columns (prefixed `prod_` and `eds_`):** title, description, keywords, canonical, h1, og_title, og_description, og_image, og_url, og_type, og_site_name, twitter_card, twitter_title, twitter_description, twitter_image, twitter_site, robots_meta

**Diff columns (prefixed `diff_`):** same fields — value is one of the diff statuses above

### No extra dependencies

Uses Node.js 18+ native `fetch` + regex — no Playwright needed.

---

## Choosing the Right Mode

```
Quick metadata check on EDS?                  → fast mode     (check-seo.mjs)
Pre-launch full audit on EDS?                 → deep mode     (check-seo-deep.js)
JSON-LD / headings / mobile / accessibility?  → deep mode
Just OG/Twitter tags on EDS?                  → fast mode
Lighthouse scores + INP?                      → CWV mode      (check-cwv.js)
Real-user field data (CrUX)?                  → CWV mode
Lab CWV (no API key needed)?                  → deep mode
SEO parity: prod vs EDS? Nothing missed?      → compare mode  (check-seo-compare.js)
```

---

## SEO Validation Checklist Reference

The full 80-item checklist is at `references/SEO_Validation_Checklist.md`.

Each section below shows which script covers it and which items are skipped (and why).

| § | Section | fast | deep | CWV | compare | Skipped items |
|---|---------|:----:|:----:|:---:|:-------:|---------------|
| 1 | **Metadata** — title, description, keywords, robots meta | ✓ | ✓ | — | ✓ (diff) | §1.4 §1.8 keyword matching (no keyword map) |
| 2 | **JSON-LD / Structured Data** — WebSite, Org, Breadcrumb, FAQ, Product, Video | — | ✓ | — | — | §2.8 Rich Results Test (requires external API) |
| 3 | **Heading Structure** — H1 count, uniqueness, hierarchy | — | ✓ | — | ✓ (H1 diff) | §3.5 keyword in heading (no keyword map) |
| 4 | **Canonical & Duplicate Prevention** — rel=canonical, www, HTTPS, trailing slash | — | ✓ | — | ✓ (canonical diff) | §4.3 parameterised URLs (requires crawl) |
| 5 | **Crawlability & Indexing** — robots.txt, sitemap, custom 404 | — | ✓ (site-level) | — | — | §5.3 §5.5 §5.8 GSC checks; §5.9 §5.10 crawl depth/orphans |
| 6 | **URL Structure** — lowercase, hyphens not underscores | — | ✓ | — | — | §6.3 §6.4 §6.5 keyword/IA/legacy (requires human review) |
| 7 | **Internal Links & Navigation** — 200 status, anchor text, breadcrumb | — | ✓ | — | — | §7.1 link 200-check (performance cost); §7.5 no-JS nav |
| 8 | **Redirects & Errors** — 404s, 301 vs 302, chains, custom 404 | — | ✓ (site-level) | — | — | §8.1 §8.3 full redirect audit (requires crawl) |
| 9 | **Social & OG Tags** — og:title/description/image/url/type/site_name, twitter:* | ✓ | ✓ | — | ✓ (diff) | — (all 6 items covered) |
| 10 | **Core Web Vitals** — LCP, FCP, INP, CLS, TTFB | — | ✓ (lab, synthetic) | ✓ (lab + CrUX real-user) | — | §10.3 INP (deep/lab only; use CWV mode for real INP) |
| 11 | **Images & Accessibility** — alt text, button labels, favicon | — | ✓ | — | — | §11.2 decorative intent; §11.5 password paste |
| 12 | **Mobile & Responsive** — viewport, horizontal scroll, content parity | — | ✓ | — | — | §12.5 touch target spacing; §12.6 Googlebot content parity |
| 13 | **Pagination & JS Content** — rel=next/prev, dynamic content | — | ✓ (partial) | — | — | §13.2 §13.3 §13.4 Googlebot/dynamic indexing |

**Total checklist items: 80 — deep mode covers 68, skips 12** (see `check-seo-deep.js` header for the full skip list with reasons).

### Items requiring human review (cannot be automated)
- **§1.4 §1.8 §3.5** — keyword targeting (requires a per-page keyword map)
- **§2.8** — Google Rich Results Test validation
- **§5.3 §5.5 §5.8** — Google Search Console submission and coverage reports
- **§6.3** — URLs are keyword-rich and aligned to IA
- **§11.2** — distinguishing decorative images from content images
- **§12.6** — Googlebot sees same content as users (requires Googlebot UA testing)
- **§13.2–13.4** — JS-rendered content accessible to Googlebot

---

## Related Skills

- **eds-sitemap-checker** — fetch sitemap and check page availability (run first)
- **aem-edge-delivery-services:code-review** — review block code quality before go-live
