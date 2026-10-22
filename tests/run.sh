#!/bin/bash
# Runs the browser tests against a throwaway Lumen server (own data dir, port 3101) plus the fake SearXNG.
#   tests/run.sh              all steps
#   tests/run.sh 1 5 7        only these steps
# Needs: Node 22+, Google Chrome (or set CHROME=/path/to/chromium) and Ollama running with a model that supports
# vision, tools and thinking. Tests use the first model Lumen lists (may be a CLOUD model: prompts then leave this
# machine); pin a local one with LUMEN_TEST_MODEL=gemma4:latest tests/run.sh
# Works with macOS's default bash 3.2 (no associative arrays).
set -u
cd "$(dirname "$0")/.."
export LUMEN_TEST_TMP="${LUMEN_TEST_TMP:-$(mktemp -d)}"
export LUMEN_URL="http://localhost:3101"
# The throwaway data folder of the test server (and where the tests look for it).
export LUMEN_DATA="$LUMEN_TEST_TMP/data/chats.json"
# The Claude Desktop folders are fixtures: the tests never touch the real ones.
export LUMEN_CLAUDE_CONFIG="$LUMEN_TEST_TMP/claude/claude_desktop_config.json"
export LUMEN_CLAUDE_EXTENSIONS="$LUMEN_TEST_TMP/claude/extensions"
PORT=3101 node server.js > "$LUMEN_TEST_TMP/server.log" 2>&1 &
SERVER=$!
node tests/fake-searxng.js > "$LUMEN_TEST_TMP/searx.log" 2>&1 &
SEARX=$!
trap 'kill $SERVER $SEARX 2>/dev/null' EXIT
for i in $(seq 1 40); do curl -s -o /dev/null "$LUMEN_URL/api/config" && break; sleep 0.25; done

name_of() {
  case "$1" in
    1) echo step1-attachments ;;     2) echo step2-artifacts ;;      3) echo step3-projects ;;
    4) echo step4-thinking-branches ;; 5) echo step5-styles-memory ;; 6) echo step6-mcp-tools ;;
    7) echo step7-desktop-polish ;;  8) echo step8-quickwins ;;  9) echo step9-claude-import ;;
    10) echo step10-skills ;; 11) echo step11-side-split ;;  *) echo "" ;;
  esac
}
STEPS=("$@"); [ ${#STEPS[@]} -eq 0 ] && STEPS=(1 2 3 4 5 6 7 8 9 10 11)
FAILED=()
for n in "${STEPS[@]}"; do
  f="$(name_of "$n")"; [ -z "$f" ] && { echo "unknown step $n"; FAILED+=("$n"); continue; }
  echo; echo "=== step $n: $f ==="
  node "tests/$f.js" || FAILED+=("$n")
done
echo
if [ ${#FAILED[@]} -eq 0 ]; then echo "ALL REQUESTED STEPS PASSED"; else echo "FAILED STEPS: ${FAILED[*]}"; exit 1; fi
