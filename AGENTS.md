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
```

No lint, no typecheck, no formatter configured. `tsconfig.json` excludes `tests/**/*.ts`.

## Tests — two suites run sequentially

See `tests/README.md` for full details. Quick reference:

- **E2E** (`npm run test-wdio`): Docker container (Obsidian + Anki + Chrome), WebdriverIO drives the UI, 27 spec files (25 auto-generated from `tests/defaults/test_vault_suites/`, 2 hand-written with `ng_` prefix). Output → `tests/test_outputs/<name>/`.
- **pytest** (`npm run test-py`): Reads Anki collections from `tests/test_outputs/`, validates note content, decks, tags, IDs.
- **Full**: `npm run test` (E2E → pytest sequentially).
- **Key conventions**: `<!-- CARD -->` markers in test markdown get `ID: <n>` written by plugin; E2E asserts every card has an ID. Python tests follow a 5-function pattern (`test_col_exists`, `test_deck_default_exists`, `test_cards_count`, `test_cards_ids_from_obsidian`, `test_cards_front_back_tag_type`). Exceptions: `ignore_setting` and `folder_scan` add a 6th zero-card test; `ng_delete_sync` has only `test_col_exists` (collection is empty). Suite dirs prefixed `ng_` skip auto-generation (hand-written spec required).

## Release

Tag-pushed release workflow packages `main.js`, `manifest.json`, `styles.css` into a zip and creates a draft GitHub release.

## Key conventions

- **Plugin ID**: `obsidian-to-anki-plugin`. Display name: `Obsidian_to_Anki`
- **Min Obsidian version**: `0.9.20`. Desktop-only
- **Default syntax**: `START`/`END` for notes, `STARTI`/`ENDI` for inline, `TARGET DECK`, `FILE TAGS`, `DELETE`, `FROZEN`
- **Default tag**: `Obsidian_to_Anki`. Default deck: `Default`
- **Obsidian tag syntax in tag lines**: The `#` prefix is automatically stripped from tags in `FILE TAGS` lines and `Tags:` lines (including inline and custom regex notes). This is independent of the `Add Obsidian Tags` setting (which controls `#tag` extraction from field text).
- **Ignored file globs** default: `**/*.excalidraw.md`
- **AnkiConnect port**: 8765
