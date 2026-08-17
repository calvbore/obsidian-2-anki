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

The sandbox's plugin `data.json` (heredoc in `scripts/interactive-test.sh`) pre-seeds curated settings: an `Image Occlusion` row in `CUSTOM_REGEXPS`/`FILE_LINK_FIELDS` (so the note type shows up in Obsidian's **Note Types** settings without clicking "Regenerate Note Type Table"), and `Syntax > "Hide All Line"`. Anki boots **dark** by default — the committed `tests/defaults/test_config/.local/share/{Anki2,Anki2default}/prefs21.db` profile has `_global` meta `"theme": 2`.

## Tests — two suites run sequentially

See `tests/README.md` for full details. Quick reference:

- **E2E** (`npm run test-wdio`): Docker container (Obsidian + Anki + Chrome), WebdriverIO drives the UI, 36 spec files (27 auto-generated from `tests/defaults/test_vault_suites/`, 9 hand-written with `ng_` prefix). Output → `tests/test_outputs/<name>/`.
- **pytest** (`npm run test-py`): Reads Anki collections from `tests/test_outputs/`, validates note content, decks, tags, IDs.
- **Full**: `npm run test` (E2E → pytest sequentially).
- **Key conventions**: `<!-- CARD -->` markers in test markdown get `ID: <n>` written by plugin; E2E asserts every card has an ID. Python tests follow a 5-function pattern (`test_col_exists`, `test_deck_default_exists`, `test_cards_count`, `test_cards_ids_from_obsidian`, `test_cards_front_back_tag_type`). Exceptions: `ignore_setting` and `folder_scan` add a 6th zero-card test; `ng_delete_sync` has only `test_col_exists` (collection is empty); `cloze_brace` adds `test_rendered_cards_balanced` (rendered brace-balance via real Anki engine); `basic_brace` adds `test_non_cloze_text_not_altered` (direct `FormatConverter.format` gate checks) and imports `obsidian_to_anki`. Suite dirs prefixed `ng_` skip auto-generation (hand-written spec required).

### Test coverage gaps (post-redesign)

The redesign's new UI features are now covered by hand-written `ng_` specs. **No test coverage gaps remain** (G#1-G#6 all covered):

| Feature | Coverage |
|---|---|
| **ProgressModal** | `ng_rename_and_cancel` — asserts `h2`, progress bar, status, text during cancel |
| **Cancel button** | `ng_rename_and_cancel` — clicks Cancel mid-sync, asserts `syncAborted` + disabled button |
| **Cancel → no-duplicate regression (H2)** | `ng_rename_and_cancel` — cancelled sync followed by a re-sync commits the aborted notes exactly once then reports "No changes detected!" (L1 no-duplicate guard) |
| **Settings tabs** | `ng_settings_ui` — navigates General/Note Types/Folders/Syntax/Advanced, asserts active-tab switching + searchable table |
| **Settings import validation (H1)** | `ng_settings_ui` — drives the real file-input (via `DataTransfer`/`change`) with a missing-sections object → "Invalid settings file" Notice + settings unchanged; valid import → overwrites settings |
| **Context menu** | `ng_scoped_sync` — real right-click file/folder → "Sync to Anki" / "Sync Folder to Anki" |
| **"Sync Current File" command** | `ng_scoped_sync` — `executeCommandById('obsidian-2-anki:anki-sync-current-file')` |
| **"Sync Current Folder" command** | `ng_scoped_sync` — `executeCommandById('obsidian-2-anki:anki-sync-current-folder')` |
| **Status bar** | `ng_file_rename` — asserts idle `Anki` before sync and `Synced` (success) after |

### Image Occlusion (IO) feature

`.excalidraw.md` files opt in via frontmatter `anki-occlusion: true` (ignored otherwise even if the ignore-glob override is set). Frames named exactly `Image Occlusion` become stock Anki IO notes (23.10+). No image is required in the frame: every non-mask element inside the frame is composited into a self-contained SVG picture (`card + picture`) by a deterministic renderer that is byte-identical between TS (`src/excalidraw-svg.ts`) and Python (`render_scene_svg` in `obsidian_io.py`). The SVG's md5 is the Anki media filename, so the SVG is the referenceable external input in stock IO; the Image field is `<img src="{md5}.svg">`. Embedded images (via `## Embedded Files` or inline `dataURL`) ride inside the SVG as base64 `data:` URIs. Mask geometry, fill colours, opacity and image bytes all feed the frame hash, so any edit re-syncs.

Rects/ellipses become cloze masks `{{cN::image-occlusion:rect|ellipse:left=…:top=…:width=…:height=…[:rx=…][:ry=…][:fill=…]}}` only when geometry-viable and filled (opacity > 0, both dimensions ≥ 5px, opaque non-`transparent` `backgroundColor`, ≥ 1px² overlap with the frame bounds); unfilled/tiny/opacity-0 shapes and every other element type (text, arrows, lines, diamonds, images) are rendered into the picture instead. Geometry is normalized against the frame bounds (not the image): `left = (x − frame.x)/frame.width`, `top = (y − frame.y)/frame.height`. `:oi=1` is appended on every mask when `Hide all: true`. Card identity = the cloze ordinal, tracked via Excalidraw element IDs in `io_frame_records` (gaps preserved, no renumbering).

The back-of-note `## <section>` each frame links to (via `## Element Links`) holds `Key: value` fields — `Header`, `Back Extra`, `Comments` (`<div>`-wrapped except Comments) — plus a `Tags: a b` line (ultras last-match-wins, never a field), optional `DELETE`/`FROZEN` lines and a plugin-managed `<!--ID: <noteId>-->` line. The three field keys are **derived from the note type's real (localized) field names by ordinal 2/3/4** — there is no field-key setting (vanilla parity); the frame title is the hardcoded `Image Occlusion`, and the `Hide all` directive word is the configurable `Syntax > Hide All Line` setting (like `DELETE`/`FROZEN`). Missing field lines are left blank; a frame whose section link is missing, a block reference, or resolves to no heading is **skipped with a warning** (no note, no ID) — fields are never read from the whole back-of-note body or other frames' sections. Deck from frontmatter `deck:` or the plugin `Deck`; **file tags come from the vanilla `FILE TAGS:` line** (the frontmatter `tags:` block is unused for note tags — mirrors vanilla); frame hash gates no-op edits and is **tag-sensitive** (a `Tags:`/`#tag` edit alone re-syncs); `getChangeDecks`/`getAddTags`/`getClearTags` handle deck/tags on edit (EDIT merges note tags; file tags ride the add/clear-tags requests). When the plugin setting `Add Obsidian Tags` is on, Obsidian `#tag`s inside Header/Back Extra/Comments are extracted as note tags and stripped from the field text (TS plugin only; never the synthetic Occlusion field).

Unmarked `.excalidraw.md` files are skipped. Right-clicking one and choosing "Sync to Anki" **auto-opts it in** (writes `anki-occlusion: true`), and the file menu also has a state-dependent Enable/Disable "Image Occlusion sync" toggle; both refresh the metadata cache (via the `changed` event, not a sync `getFileCache` call) before the sync reads it. Toggle-off returns the file to the ignore glob (its Anki notes stay, standard §7.3 orphan behaviour). Key files: `src/io.ts` (builder), `src/excalidraw.ts` (scene parser + lz-string + `setIOMarker`/`clearIOMarker`), `src/excalidraw-svg.ts` (SVG renderer), `src/file.ts` (`IOFile`), `src/files-manager.ts` (`fileHasIOMarker`), `obsidian_io.py` (pure-stdlib Python parity), `tests/specs/ng_io_sync.e2e.ts` + `tests/anki/test_ng_io_sync.py` + `tests/specs/ng_io_opt_in.e2e.ts` + `tests/anki/test_ng_io_opt_in.py` (E2E gates) + `tests/anki/test_io_builder.py` (renderer golden tests).

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
- **Default syntax**: `START`/`END` for notes, `STARTI`/`ENDI` for inline, `TARGET DECK`, `FILE TAGS`, `DELETE`, `FROZEN`, `Hide All` (IO `Hide All Line`)
- **Default tag**: `Obsidian_to_Anki`. Default deck: `Default`
- **Obsidian tag syntax in tag lines**: The `#` prefix is automatically stripped from tags in `FILE TAGS` lines and `Tags:` lines (including inline and custom regex notes). This is independent of the `Add Obsidian Tags` setting (which controls `#tag` extraction from field text).
- **Ignored file globs** default: `**/*.excalidraw.md`
- **AnkiConnect port**: 8765
