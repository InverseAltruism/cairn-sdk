#!/usr/bin/env bash
# Activate this repo's committed git hooks. Run once per fresh clone:
#     bash .githooks/install.sh
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath .githooks
chmod +x .githooks/pre-commit .githooks/install.sh 2>/dev/null || true
echo "✓ git hooks active (core.hooksPath=.githooks). Secret-scan pre-commit is live."
if ! command -v gitleaks >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/gitleaks" ]; then
  echo "  note: gitleaks not found — the hook will warn-and-skip until you install it."
  echo "        https://github.com/gitleaks/gitleaks#installing"
fi
