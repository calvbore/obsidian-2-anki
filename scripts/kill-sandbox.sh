#!/bin/bash
set -euo pipefail

if docker kill obsidian-2-anki-sandbox 2>/dev/null; then
    echo "Container 'obsidian-2-anki-sandbox' killed."
else
    echo "No sandbox container found."
fi