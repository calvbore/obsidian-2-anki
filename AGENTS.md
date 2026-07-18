# Obsidian_to_Anki

> **Fork**: This is a fork of [ObsidianToAnki/Obsidian_to_Anki](https://github.com/ObsidianToAnki/Obsidian_to_Anki). The upstream repo has the original wiki and documentation.

## Project structure

- **Dual codebase**: Obsidian plugin (TypeScript, `main.ts`, built by rollup) + standalone Python CLI (`obsidian_to_anki.py`)
- **Plugin entrypoint**: `main.ts`, output `main.js` (CJS, rollup). `obsidian` is an external dependency
- **Python entrypoint**: `obsidian_to_anki.py` — communicates with AnkiConnect on port 8765, optional Gooey GUI
- **Config**: `obsidian_to_anki_config.ini` (Python) / plugin settings UI (Obsidian)
- **Data file**: `obsidian_to_anki_data.json` — tracks added media, file hashes, note IDs

## Build

```sh
npm run build        # rollup → main.js
npm run dev          # rollup watch
```

No lint, no typecheck, no formatter configured. `tsconfig.json` excludes `tests/**/*.ts`.

## Interactive sandbox (Docker-based)

Runs Obsidian + Anki in a container with VNC access at `http://localhost:8080`.

| Command | Use |
|---------|-----|
| `npm run sandbox` | Quick mode — build once, start container |
| `npm run sandbox -- --dev` | Dev mode — rollup watch + hot-reload |
| `npm run sandbox -- --dry-run` | Setup vault/config only, no Docker |
| `npm run kill-sandbox` | Kill a running sandbox container (when Ctrl+C fails) |

Key files: `scripts/interactive-test.sh`, `scripts/interactive-autostart`, `scripts/kill-sandbox.sh`. See `tests/README.md` for full documentation.

## Tests — two suites run sequentially

See `tests/README.md` for full details. Quick reference:

- **E2E** (`npm run test-wdio`): Docker container (Obsidian + Anki + Chrome), WebdriverIO drives the UI, 27 spec files (25 auto-generated from `tests/defaults/test_vault_suites/`, 2 hand-written with `ng_` prefix). Output → `tests/test_outputs/<name>/`.
- **pytest** (`npm run test-py`): Reads Anki collections from `tests/test_outputs/`, validates note content, decks, tags, IDs.
- **Full**: `npm run test` (E2E → pytest sequentially).
- **Key conventions**: `<!-- CARD -->` markers in test markdown get `ID: <n>` written by plugin; E2E asserts every card has an ID. Python tests follow a 5-function pattern (`test_col_exists`, `test_deck_default_exists`, `test_cards_count`, `test_cards_ids_from_obsidian`, `test_cards_front_back_tag_type`). Exceptions: `ignore_setting` and `folder_scan` add a 6th zero-card test; `ng_delete_sync` has only `test_col_exists` (collection is empty). Suite dirs prefixed `ng_` skip auto-generation (hand-written spec required).

## Release

This fork publishes releases to GitHub; install via [BRAT](https://github.com/TfTHacker/obsidian42-brat) from `https://github.com/calvbore/obsidian-2-anki`.

### Prerequisites

Bump the version in these files (use `x.y.z` format, digits and dots only):
- `manifest.json` — `"version"` field
- `package.json` — `"version"` field
- `versions.json` — add `"x.y.z": "minAppVersion"` entry (e.g. `"3.6.1": "0.9.20"`)

Then commit:

```sh
git add manifest.json package.json versions.json
git commit -m "chore: prepare v<x.y.z> for BRAT release"
```

### Release workflow

`.github/workflows/obsidian-release.yml` triggers on **any tag push**.

1. **Tag and push**:
   ```sh
   git tag <x.y.z>
   git push origin <x.y.z>
   ```
2. The workflow:
   - Checks out the tag (`actions/checkout@v7`)
   - Runs `npm ci && npm run build` → produces `main.js`
   - Packages `main.js`, `manifest.json`, `styles.css`, `README.md` into `obsidian-2-anki-<x.y.z>.zip`
   - Creates a **draft** GitHub release via `softprops/action-gh-release@v3` with auto-generated release notes
3. **Publish the draft** at https://github.com/calvbore/obsidian-2-anki/releases:
   - Edit the draft
   - Write/review release notes (auto-generated from `generate_release_notes: true`)
   - Optionally mark as **Pre-release** (BRAT handles pre-releases the same as full releases)
   - Click **Publish release**

### Installing via BRAT

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Obsidian Community Plugins
2. BRAT Settings → Add Beta Plugin → paste `https://github.com/calvbore/obsidian-2-anki`
3. BRAT downloads the latest release (pre-release or not) and installs it

## Key conventions

- **Plugin ID**: `obsidian-2-anki`. Display name: `Obsidian 2 Anki`
- **Min Obsidian version**: `0.9.20`. Desktop-only
- **Default syntax**: `START`/`END` for notes, `STARTI`/`ENDI` for inline, `TARGET DECK`, `FILE TAGS`, `DELETE`, `FROZEN`
- **Default tag**: `Obsidian_to_Anki`. Default deck: `Default`
- **Obsidian tag syntax in tag lines**: The `#` prefix is automatically stripped from tags in `FILE TAGS` lines and `Tags:` lines (including inline and custom regex notes). This is independent of the `Add Obsidian Tags` setting (which controls `#tag` extraction from field text).
- **Ignored file globs** default: `**/*.excalidraw.md`
- **AnkiConnect port**: 8765
