#!/bin/bash
set -euo pipefail

if docker kill obsidian-to-anki-sandbox 2>/dev/null; then
    echo "Container 'obsidian-to-anki-sandbox' killed."
else
    echo "No sandbox container found."
fi
