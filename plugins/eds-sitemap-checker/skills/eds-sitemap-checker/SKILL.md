---
name: eds-sitemap-checker
description: Use this skill when the user wants to check, audit, or validate URLs from a live website against an AEM Edge Delivery Services (EDS) domain. Triggers on phrases like "check sitemap", "audit urls", "validate pages on EDS", "check which pages exist on EDS", "sitemap migration check", "page status check", or "which pages are 404 on EDS".
license: Apache-2.0
metadata:
  version: "1.0.0"
allowed-tools: Bash(curl:*) Bash(node:*) Read Write
---

# EDS Sitemap Checker

Fetch a live website's sitemap, extract all URLs, then check each one against the EDS domain for HTTP status (200, 404, redirect, or error). Outputs a CSV report and a summary.

## When to Use This Skill

Use this skill when:
- Auditing which pages from an existing site exist on the EDS domain
- Checking migration completeness (are all pages live on EDS?)
- Finding 404s or broken redirects on the EDS environment
- Validating a sitemap before go-live

**Do NOT use when:**
- You only need to check a single URL (just use curl)
- The user hasn't provided or confirmed a live site URL

## Workflow

### Step 1: Get the Live Site URL

Ask the user for the live website URL if not already provided:

> "What is the live website URL? I'll fetch the sitemap from `<url>/sitemap.xml` — let me know if the sitemap is at a different path."

Confirm the sitemap URL with the user before proceeding. Default assumption: `<live-site>/sitemap.xml`

---

### Step 2: Fetch and Parse the Sitemap

Fetch the sitemap XML and extract all `<loc>` URLs:

```bash
# Fetch sitemap
curl -s "<LIVE_SITE>/sitemap.xml" -o /tmp/sitemap.xml

# Check what we got
head -50 /tmp/sitemap.xml
```

**Handle these cases:**
- **Standard sitemap** (`<urlset>`): extract all `<loc>` values
- **Sitemap index** (`<sitemapindex>`): fetch each child sitemap and extract `<loc>` values from all of them
- **404 / not found**: ask the user for the correct sitemap URL
- **Gzipped** (`.xml.gz`): use `curl -s <url> | gunzip | ...`

Extract URLs to JSON:

```bash
# Extract <loc> URLs from sitemap XML into JSON array
node -e "
const fs = require('fs');
const xml = fs.readFileSync('/tmp/sitemap.xml', 'utf8');
const matches = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1].trim());
fs.writeFileSync('/tmp/sitemap-urls.json', JSON.stringify(matches, null, 2));
console.log('Found', matches.length, 'URLs');
"
```

Show the user: how many URLs were found, and a sample of the first 5.

---

### Step 3: Get the EDS Domain

Determine the EDS base URL. Derive it from the git repo info if possible:

```bash
# Get repo info
gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || git remote get-url origin
git branch --show-current
```

The EDS production URL pattern is: `https://main--{repo}--{owner}.aem.live`

Confirm the EDS base URL with the user before running checks.

---

### Step 4: Probe for HTTP Basic Auth

Before running the full check, probe the first URL to detect protection. Note EDS
serves pages **without** a trailing slash, so probe the slash-stripped path (this
mirrors what the checker sends — see the normalization note in Step 5):

```bash
node -e "
const urls = require('/tmp/sitemap-urls.json');
const base = '<EDS_BASE_URL>'.replace(/\/$/,'');
const { URL } = require('url');
const p = new URL(urls[0]).pathname;
const first = base + (p === '/' ? '/' : p.replace(/\/$/,''));
fetch(first, { method: 'HEAD' }).then(r => console.log(r.status));
"
```

- If the status is **401**: the environment is protected. Ask the user which
  applies, then pass the matching flag in Step 5:
  - **HTTP Basic auth** (htaccess): provide `user:password` → run with `--auth=user:password`.
  - **EDS/AEM sidekick token** (a value like `token hlxtst_...` or `Bearer ...`): provide the
    full `Authorization` header value → run with `--auth-header="<value>"`. For preview vs.
    production, check the token's `aud` claim — an `...aem.page` token authorizes the preview
    tier and an `...aem.live` token the production tier (many tokens work on both).
- If the status is **200**, **301/302**, or **404**: proceed without auth.

---

### Step 5: Dispatch sub-agent

Once sitemap file, EDS base URL, and optional auth credentials are confirmed, dispatch a `general-purpose` sub-agent via the Agent tool:

```
Run this command and return: full stdout output + structured summary (total, 200 count, 404 count, redirect count, error count, list of all 404 URLs, list of all redirect URLs with destinations) + CSV path.

node ~/.claude/skills/eds-sitemap-checker/scripts/check-urls.js \
  /tmp/sitemap-urls.json \
  "<EDS_BASE_URL>" \
  /tmp/eds-url-check.csv \
  [--auth=user:password] \
  [--auth-header="token hlxtst_..."]
```

The script:
- Maps each sitemap URL path onto the EDS base domain, **stripping any trailing
  slash** (except root `/`). EDS serves canonical paths without a trailing slash and
  returns 404 for the slash variant, so sitemaps whose `<loc>` values all end in `/`
  (common) would otherwise report false 404s.
- Sends a HEAD request to each URL (10 concurrent, 15s timeout)
- Classifies responses: `200`, `404`, `REDIRECT_301/302/307/308`, `TIMEOUT`, `ERROR: ...`
- Writes results to CSV with columns: `original_url`, `eds_url`, `status`, `redirect_location`
- Prints a summary and lists 404s, redirects, and errors

**Auth:** pass `--auth=user:password` for HTTP Basic, or `--auth-header="<value>"` to send
a raw `Authorization` header verbatim (EDS/AEM sidekick `token ...` / `Bearer ...` tokens).
The token can also be supplied via the `EDS_AUTH` env var to keep it out of the argument
list. `--auth-header` / `EDS_AUTH` take precedence over `--auth`.

**Note:** Requires Node.js 18+ (native fetch + ES module syntax).

---

### Step 5: Present Results

After the script runs, show the user:

1. **Summary table** (totals: 200 / 404 / redirects / errors)
2. **CSV file location** for full details
3. **Actionable insights**:
   - 404s = pages that need to be published/created on EDS
   - Redirects = may need redirect rules configured
   - Errors/timeouts = connectivity issues or misconfigured routes

**Offer next steps:**
- Share the CSV file path
- Filter and display specific categories (e.g., all 404s)
- Help configure redirect rules for redirect cases

---

## Output Format

### CSV columns
| Column | Description |
|--------|-------------|
| `original_url` | URL from the sitemap |
| `eds_url` | Mapped EDS URL that was checked |
| `status` | `200`, `404`, `REDIRECT_301`, `REDIRECT_302`, `TIMEOUT`, `ERROR: ...` |
| `redirect_location` | Where redirect points (empty for non-redirects) |

### Summary output
```
=== URL Check Summary ===
Total pages:   142
200 OK:        98
404 Not Found: 31
Redirects:     8
Other errors:  5
```

---

## Error Handling

| Situation | Action |
|-----------|--------|
| Sitemap not at `/sitemap.xml` | Ask user for correct path |
| Sitemap is an index file | Fetch all child sitemaps and merge |
| Node.js < 18 | Fall back to curl loop: `while IFS= read -r url; do ...` |
| EDS domain unknown | Derive from `gh repo view` or ask user |
| Large sitemaps (1000+ URLs) | Warn user it may take a few minutes; script handles concurrency |

---

## Example Session

```
User: Check which pages from our live site exist on EDS

Skill: What's the live website URL? I'll fetch the sitemap from <url>/sitemap.xml
       — let me know if the sitemap path is different.

User: https://www.example.com

Skill: [fetches https://www.example.com/sitemap.xml]
       Found 142 URLs. EDS domain: https://main--example--owner.aem.live
       Checking all 142 URLs...

       === Summary ===
       Total: 142 | 200: 98 | 404: 31 | Redirects: 8 | Errors: 5

       CSV saved to: /tmp/eds-url-check.csv

       31 pages return 404 on EDS — these need to be published.
       8 redirects detected — review redirect_location column in CSV.
```
