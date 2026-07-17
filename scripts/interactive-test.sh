#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

VAULT_DIR="/tmp/interactive-test-vault"
CONFIG_DIR="/tmp/interactive-test-config"
AUTOSTART_SRC="$SCRIPT_DIR/interactive-autostart"
AUTOSTART_DEST="/defaults/autostart"
HOT_RELOAD_DIR=".obsidian/plugins/hot-reload"
PLUGIN_DIR=".obsidian/plugins/obsidian-to-anki-plugin"
SUITES_DIR="$REPO_DIR/tests/defaults/test_vault_suites"
CONFIG_SRC="$REPO_DIR/tests/defaults/test_config"
IMAGE_NAME="anki-obsidian"

# Parse flags
DEV_MODE=false
REBUILD=false
DRY_RUN=false
for arg in "$@"; do
    case "$arg" in
        --dev) DEV_MODE=true ;;
        --rebuild) REBUILD=true ;;
        --dry-run) DRY_RUN=true ;;
        *)
            echo "Usage: $0 [--dev] [--rebuild] [--dry-run]"
            echo "  --dev      Watch mode (rollup dev, hot-reload enabled)"
            echo "  --rebuild  Force Docker image rebuild"
            echo "  --dry-run  Setup vault/config dirs, then stop (no Docker, no cleanup)"
            exit 1
            ;;
    esac
done

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------
ROLLUP_PID=""
cleanup() {
    local exit_code=$?
    echo ""
    echo "Cleaning up..."
    if [ -n "$ROLLUP_PID" ]; then
        kill "$ROLLUP_PID" 2>/dev/null || true
        wait "$ROLLUP_PID" 2>/dev/null || true
        echo "Rollup watch stopped."
    fi
    if [ "$DRY_RUN" = false ]; then
        rm -rf "$VAULT_DIR" "$CONFIG_DIR"
        echo "Temp dirs removed."
    else
        echo "Temp dirs preserved for inspection:"
        echo "  $VAULT_DIR"
        echo "  $CONFIG_DIR"
    fi
    exit "$exit_code"
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Step 1 — Docker image
# ---------------------------------------------------------------------------
if [ "$DRY_RUN" = true ]; then
    echo "==> Docker image: skipped (--dry-run)"
elif [ "$REBUILD" = true ]; then
    echo "==> Building Docker image (--rebuild)..."
    docker build -t "$IMAGE_NAME" "$REPO_DIR"
else
    if docker image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
        echo "==> Docker image '$IMAGE_NAME' exists — skipping build."
    else
        echo "==> Docker image not found — building..."
        docker build -t "$IMAGE_NAME" "$REPO_DIR"
    fi
fi

# ---------------------------------------------------------------------------
# Step 2 — Build plugin
# ---------------------------------------------------------------------------
ensure_main_js() {
    for i in $(seq 1 15); do
        if [ -f "$REPO_DIR/main.js" ] && [ -s "$REPO_DIR/main.js" ]; then
            return 0
        fi
        sleep 1
    done
    echo "ERROR: main.js not found after build — is rollup configured correctly?"
    exit 1
}

if [ "$DEV_MODE" = true ]; then
    echo "==> Starting rollup watch (--dev)..."
    cd "$REPO_DIR"
    npm run dev &
    ROLLUP_PID=$!
    echo "    Rollup PID: $ROLLUP_PID"
    ensure_main_js
    echo "    main.js ready."
else
    echo "==> Building plugin..."
    (cd "$REPO_DIR" && npm run build)
    ensure_main_js
fi

# ---------------------------------------------------------------------------
# Step 3 — Setup vault
# ---------------------------------------------------------------------------
echo "==> Setting up vault at $VAULT_DIR..."
rm -rf "$VAULT_DIR"
mkdir -p "$VAULT_DIR"

# Copy all suite content (except per-suite .obsidian dirs) into vault root
for suite in "$SUITES_DIR"/*/; do
    if [ -d "$suite" ]; then
        cp -Raf "$suite"/* "$VAULT_DIR/" 2>/dev/null || true
    fi
done
find "$VAULT_DIR" -name '.obsidian' -type d -exec rm -rf {} + 2>/dev/null || true

# Create plugin directories (after find to avoid deletion)
mkdir -p "$VAULT_DIR/$PLUGIN_DIR"
mkdir -p "$VAULT_DIR/$HOT_RELOAD_DIR"

# Write data.json
cat > "$VAULT_DIR/$PLUGIN_DIR/data.json" << 'DATA_EOF'
{
  "settings": {
    "CUSTOM_REGEXPS": {
      "Basic": "",
      "Basic (and reversed card)": "",
      "Basic (optional reversed card)": "",
      "Basic (type in the answer)": "",
      "Cloze": ""
    },
    "FILE_LINK_FIELDS": {
      "Basic": "Front",
      "Basic (and reversed card)": "Front",
      "Basic (optional reversed card)": "Front",
      "Basic (type in the answer)": "Front",
      "Cloze": "Text"
    },
    "CONTEXT_FIELDS": {},
    "FOLDER_DECKS": {},
    "FOLDER_TAGS": {},
    "Syntax": {
      "Begin Note": "START",
      "End Note": "END",
      "Begin Inline Note": "STARTI",
      "End Inline Note": "ENDI",
      "Target Deck Line": "TARGET DECK",
      "File Tags Line": "FILE TAGS",
      "Delete Note Line": "DELETE",
      "Frozen Fields Line": "FROZEN"
    },
    "Defaults": {
      "Scan Directory": "",
      "Tag": "Obsidian_to_Anki",
      "Deck": "Default",
      "Scheduling Interval": 0,
      "Add File Link": false,
      "Add Context": true,
      "CurlyCloze": true,
      "CurlyCloze - Highlights to Clozes": false,
      "ID Comments": true,
      "Add Obsidian Tags": true
    },
    "IGNORED_FILE_GLOBS": ["**/*.excalidraw.md"]
  },
  "Added Media": [],
  "File Hashes": {},
  "fields_dict": {
    "Basic": ["Front", "Back"],
    "Basic (and reversed card)": ["Front", "Back"],
    "Basic (optional reversed card)": ["Front", "Back", "Add Reverse"],
    "Basic (type in the answer)": ["Front", "Back"],
    "Cloze": ["Text", "Back Extra"]
  }
}
DATA_EOF

# Copy built plugin files
cp "$REPO_DIR/main.js"       "$VAULT_DIR/$PLUGIN_DIR/"
cp "$REPO_DIR/manifest.json" "$VAULT_DIR/$PLUGIN_DIR/"
cp "$REPO_DIR/styles.css"    "$VAULT_DIR/$PLUGIN_DIR/"

# Download Hot Reload plugin (non-fatal if offline)
echo "==> Downloading Hot Reload plugin..."
if curl -sL "https://raw.githubusercontent.com/pjeby/hot-reload/master/main.js" \
    -o "$VAULT_DIR/$HOT_RELOAD_DIR/main.js" 2>/dev/null; then
    HTTP_CODE=$(curl -sL -o /dev/null -w "%{http_code}" \
        "https://raw.githubusercontent.com/pjeby/hot-reload/master/manifest.json" 2>/dev/null)
    if [ "$HTTP_CODE" = "200" ]; then
        curl -sL "https://raw.githubusercontent.com/pjeby/hot-reload/master/manifest.json" \
            -o "$VAULT_DIR/$HOT_RELOAD_DIR/manifest.json" 2>/dev/null
    else
        echo "    (manifest.json not found upstream — creating minimal one)"
        cat > "$VAULT_DIR/$HOT_RELOAD_DIR/manifest.json" << 'HR_EOF'
{"id":"hot-reload","name":"Hot Reload","version":"1.0","minAppVersion":"0.9.20","isDesktopOnly":true}
HR_EOF
    fi
else
    echo "    WARNING: could not reach GitHub — hot-reload plugin not installed."
    echo "    (dev mode will not auto-reload; the plugin will still work)"
    rm -rf "$VAULT_DIR/$HOT_RELOAD_DIR"
    mkdir -p "$VAULT_DIR/$HOT_RELOAD_DIR"
fi

# Write community-plugins.json
cat > "$VAULT_DIR/.obsidian/community-plugins.json" << 'CP_EOF'
["hot-reload", "obsidian-to-anki-plugin"]
CP_EOF

# Write appearance.json for Obsidian dark theme
cat > "$VAULT_DIR/.obsidian/appearance.json" << 'APPEOF'
{"theme": "obsidian"}
APPEOF

# ---------------------------------------------------------------------------
# Step 4 — Setup config
# ---------------------------------------------------------------------------
echo "==> Setting up config at $CONFIG_DIR..."
rm -rf "$CONFIG_DIR"
cp -Raf "$CONFIG_SRC"/. "$CONFIG_DIR/"

# Overwrite obsidian.json
cat > "$CONFIG_DIR/.config/obsidian/obsidian.json" << 'OBS_EOF'
{"vaults":{"e697835dbb2e89b2":{"path":"/vaults","ts":1677877063523,"open":true}}}
OBS_EOF

# Write window geometry file (companion to vault ID)
cat > "$CONFIG_DIR/.config/obsidian/e697835dbb2e89b2.json" << 'GEO_EOF'
{"x":677,"y":24,"width":1024,"height":767,"isMaximized":false,"devTools":false,"zoom":0}
GEO_EOF

# ---------------------------------------------------------------------------
# Step 5 — Launch or dry-run
# ---------------------------------------------------------------------------
if [ "$DRY_RUN" = true ]; then
    echo ""
    echo "=============================================================="
    echo "  [dry-run] Container launch skipped."
    echo ""
    echo "  Vault:  $VAULT_DIR"
    echo "  Config: $CONFIG_DIR"
    echo ""
    echo "  Inspect vault structure:  find $VAULT_DIR -type f | head -40"
    echo "  Check plugin config:     cat $VAULT_DIR/$PLUGIN_DIR/data.json"
    echo "  Check community plugins: cat $VAULT_DIR/.obsidian/community-plugins.json"
    echo "  Check config files:      ls -la $CONFIG_DIR/.config/obsidian/"
    echo "  Anki profile:            ls $CONFIG_DIR/.local/share/Anki2/"
    echo ""
    echo "  To remove: rm -rf $VAULT_DIR $CONFIG_DIR"
    echo "=============================================================="
    echo ""
    exit 0
fi

echo ""
echo "=============================================================="
echo "  Connect:  http://localhost:8080   (VNC password: abc)"
echo ""
echo "  First-time setup in Obsidian:"
echo "  1. Click 'Open Settings' → 'Community plugins' → turn on"
echo "  2. Enable Obsidian_to_Anki plugin toggle"
echo "  3. Open a note that contains CARD markers"
echo "  4. Click 'Scan Vault' in the left ribbon (puzzle icon)"
echo "  5. Check Anki window for imported cards"
echo "  6. Close Obsidian to stop the container"
echo "=============================================================="
echo ""

echo "==> Starting container..."
docker rm -f obsidian-to-anki-sandbox 2>/dev/null || true
DOCKER_ARGS=(
    --rm -it
    --name obsidian-to-anki-sandbox
    -p 8080:8080
    -v "$VAULT_DIR:/vaults"
    -v "$CONFIG_DIR:/config"
    -v "$AUTOSTART_SRC:$AUTOSTART_DEST"
    -e "PUID=$(id -u)"
    -e "PGID=$(id -g)"
    -e "PASSWORD=abc"
    -e "TZ=Etc/UTC"
)

if [ "$DEV_MODE" = true ]; then
    DOCKER_ARGS+=(-v "$REPO_DIR/main.js:/vaults/$PLUGIN_DIR/main.js")
fi

docker run "${DOCKER_ARGS[@]}" "$IMAGE_NAME"

# (cleanup runs via trap)
