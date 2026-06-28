# Obsidian_to_Anki

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

### 1. E2E (WebdriverIO) — `npm run test-wdio`

Requires Docker. Builds image `anki-obsidian`, runs Obsidian + Anki in a container with Chrome.

**Flow**:
1. `npm run prep-wdio` — copies default vault/config, `main.js` into test vault
2. Builds Docker image, launches container, runs specs via WebdriverIO

**Specs** auto-generated from `tests/defaults/test_vault_suites/`: each subdirectory (not prefixed `ng_`) generates a spec file in `tests/specs_gen/` by copying `tests/defaults/specs/template.e2e.ts`.
Hand-written specs in `tests/specs/` use `ng_` prefix to prevent auto-generation.

**Writes output** to `tests/test_outputs/<test_name>/` (Anki collection + Obsidian markdown files).

### 2. Python/pytest — `npm run test-py`

```sh
pip install pytest anki
pytest -vvvs tests/anki/
```

Reads Anki collections from `tests/test_outputs/` (produced by e2e step). Requires `anki` Python package (the actual Anki library, not a thin client).

### Full test command

```sh
npm run test         # runs test-wdio then test-py
```

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
