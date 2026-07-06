#!/usr/bin/env bash
# install.sh — install EDS skills to ~/.claude/skills/
#
# Usage:
#   ./install.sh              # install all skills
#   ./install.sh eds-seo-validator eds-sitemap-checker  # install specific skills
#
# What it does:
#   1. Copies scripts and SKILL.md to ~/.claude/skills/<skill-name>/
#   2. Runs npm install for skills that have a package.json (Playwright etc.)
#   3. Registers this repo as a marketplace source in ~/.claude/settings.json

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="${HOME}/.claude/skills"
SETTINGS="${HOME}/.claude/settings.json"

# Determine which skills to install
if [ $# -eq 0 ]; then
  SKILLS=(eds-sitemap-checker eds-seo-validator eds-content-validator eds-visual-compare)
else
  SKILLS=("$@")
fi

echo "=== EDS Skills Installer ==="
echo "Installing to: ${SKILLS_DIR}"
echo ""

for SKILL in "${SKILLS[@]}"; do
  PLUGIN_DIR="${SCRIPT_DIR}/plugins/${SKILL}"
  TARGET_DIR="${SKILLS_DIR}/${SKILL}"

  if [ ! -d "${PLUGIN_DIR}" ]; then
    echo "  ✗ Unknown skill: ${SKILL} (no plugin directory found)"
    continue
  fi

  echo "  Installing ${SKILL}..."

  # Create target directory
  mkdir -p "${TARGET_DIR}"

  # Copy SKILL.md
  if [ -f "${PLUGIN_DIR}/skills/${SKILL}/SKILL.md" ]; then
    cp "${PLUGIN_DIR}/skills/${SKILL}/SKILL.md" "${TARGET_DIR}/SKILL.md"
  fi

  # Copy scripts
  if [ -d "${PLUGIN_DIR}/scripts" ]; then
    mkdir -p "${TARGET_DIR}/scripts"
    cp "${PLUGIN_DIR}/scripts/"* "${TARGET_DIR}/scripts/"
  fi

  # Copy package.json and run npm install
  if [ -f "${PLUGIN_DIR}/package.json" ]; then
    cp "${PLUGIN_DIR}/package.json" "${TARGET_DIR}/package.json"
    echo "    Running npm install in ${TARGET_DIR}..."
    (cd "${TARGET_DIR}" && npm install --silent)
    echo "    npm install complete"
  fi

  # Copy any extra reference docs (e.g. SEO checklist)
  for f in "${PLUGIN_DIR}"/*.md; do
    [ -f "$f" ] && cp "$f" "${TARGET_DIR}/"
  done

  echo "  ✓ ${SKILL} installed"
done

echo ""
echo "=== Registering marketplace source ==="

# Get the GitHub remote URL from git (if available)
REPO_URL=""
if command -v git &>/dev/null && git -C "${SCRIPT_DIR}" rev-parse --is-inside-work-tree &>/dev/null; then
  REMOTE=$(git -C "${SCRIPT_DIR}" remote get-url origin 2>/dev/null || echo "")
  if [[ "${REMOTE}" =~ github\.com[:/]([^/]+/[^/.]+) ]]; then
    REPO_SLUG="${BASH_REMATCH[1]}"
    REPO_URL="https://github.com/${REPO_SLUG}"
  fi
fi

if [ -n "${REPO_URL}" ] && command -v node &>/dev/null; then
  MARKETPLACE_NAME="eds-skills"
  node -e "
const fs = require('fs');
const path = '${SETTINGS}';
const settings = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : {};
settings.extraKnownMarketplaces = settings.extraKnownMarketplaces || {};
settings.extraKnownMarketplaces['${MARKETPLACE_NAME}'] = {
  source: { source: 'github', repo: '${REPO_SLUG}' }
};
fs.writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
console.log('  ✓ Registered ${MARKETPLACE_NAME} → ${REPO_SLUG} in ~/.claude/settings.json');
"
else
  echo "  (skipped — no git remote or node not found)"
  echo "  To register manually, add this to ~/.claude/settings.json under extraKnownMarketplaces:"
  echo '  "eds-skills": { "source": { "source": "github", "repo": "YOUR_GITHUB_USER/eds-skills" } }'
fi

echo ""
echo "=== Done ==="
echo "Skills available at ${SKILLS_DIR}:"
for SKILL in "${SKILLS[@]}"; do
  [ -d "${SKILLS_DIR}/${SKILL}" ] && echo "  - ${SKILL}"
done
echo ""
echo "Restart Claude Code to load new skills."
