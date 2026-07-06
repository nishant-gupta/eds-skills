# EDS Skills for Claude Code

AEM Edge Delivery Services audit and validation skills for [Claude Code](https://claude.ai/code).

## Skills

| Skill | Description |
|-------|-------------|
| **eds-sitemap-checker** | Fetch a live site's sitemap and check each URL against the EDS domain for HTTP status (200, 404, redirect) |
| **eds-seo-validator** | Fast, deep, CWV, and comparison SEO audits — 68-point checklist, Core Web Vitals, migration parity |
| **eds-content-validator** | Content parity and quality audit between production and EDS — Jaccard similarity, placeholder detection, link checks |
| **eds-visual-compare** | Screenshot diff to catch visual and layout regressions between prod and EDS |

## Installation

### Option A — Install script (recommended)

```bash
git clone https://github.com/YOUR_USER/eds-skills.git
cd eds-skills
./install.sh
```

This copies all skills to `~/.claude/skills/`, runs `npm install` where needed, and registers this repo as a marketplace source in `~/.claude/settings.json`.

Install specific skills only:

```bash
./install.sh eds-seo-validator eds-sitemap-checker
```

### Option B — Claude Code marketplace

Once the repo is public, add it as a marketplace source in `~/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "eds-skills": {
      "source": {
        "source": "github",
        "repo": "YOUR_USER/eds-skills"
      }
    }
  }
}
```

Then install via Claude Code:

```
/plugin install eds-seo-validator@eds-skills
/plugin install eds-content-validator@eds-skills
/plugin install eds-sitemap-checker@eds-skills
/plugin install eds-visual-compare@eds-skills
```

## Usage

After installation, Claude Code will automatically invoke the right skill based on your request:

- "Check which pages from marutisuzuki.com exist on EDS" → `eds-sitemap-checker`
- "Run a deep SEO audit on our EDS site" → `eds-seo-validator`
- "Compare content parity between prod and EDS" → `eds-content-validator`
- "Screenshot diff between prod and EDS pages" → `eds-visual-compare`

## Prerequisites

- Node.js 18+
- For deep SEO and deep content checks: Playwright Chromium (installed automatically by the install script via `npm install`, then run `npx playwright install chromium` in the skill directory)

## Updating

```bash
cd eds-skills
git pull
./install.sh
```

## Structure

```
eds-skills/
├── .claude-plugin/
│   └── marketplace.json        # Claude Code marketplace registry
├── plugins/
│   ├── eds-sitemap-checker/
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json     # Plugin metadata
│   │   ├── skills/
│   │   │   └── eds-sitemap-checker/
│   │   │       └── SKILL.md    # Skill definition (instructions for Claude)
│   │   └── scripts/
│   │       └── check-urls.js   # Node.js script
│   ├── eds-seo-validator/      # Same structure
│   ├── eds-content-validator/  # Same structure
│   └── eds-visual-compare/     # Same structure
├── install.sh                  # Local installation script
└── README.md
```

## License

Apache-2.0
