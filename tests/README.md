# Tests

This project has two test suites that run sequentially: **E2E (WebdriverIO)** produces Anki collections, then **pytest** validates them.

## Quickstart

```sh
npm run build          # build main.js first
npm run test-wdio      # E2E only (requires Docker)
npm run test-py        # pytest only (requires E2E output in tests/test_outputs/)
npm run test           # full suite: E2E → pytest
```

Prerequisites: Docker, an X server (`$DISPLAY`), and `node_modules` installed (`npm ci`).

## Architecture

```
npm run test
├── npm run test-wdio
│   ├── npm run prep-wdio    # prepare vault/config, copy plugin build, generate specs from test_vault_suites/
│   ├── docker build          # build anki-obsidian image (Obsidian + Anki + Chrome)
│   └── wdio run              # 26 parallel workers, 1 spec each
│       ├── per spec:
│       │   ├── copy suite files into vault
│       │   ├── trigger permission reset
│       │   ├── browser.reloadSession()
│       │   ├── open Obsidian, click "Scan Vault"
│       │   ├── wait for "All done!" console log
│       │   ├── assert every <!-- CARD --> has an ID: <n> comment
│       │   └── close window
│       └── onWorkerEnd: copySync test_outputs from container → host
│
└── npm run test-py
    └── uv run pytest -vvvs tests/anki/ --junitxml logs/test-reports/pytest.xml
        └── each test opens collection.anki2 from test_outputs/<name>/
            ├── test_col_exists
            ├── test_deck_default_exists
            ├── test_cards_count
            ├── test_cards_ids_from_obsidian
            └── test_cards_front_back_tag_type
```

## How It Works — Full Pipeline

### 1. Prep (`prepare-wdio.sh`)
- Creates `tests/test_config/`, `tests/test_vault/`, `tests/specs_gen/`, `tests/test_outputs/`
- Copies `main.js`, `manifest.json`, `styles.css` into the default vault's plugin directory
- Runs an alpine container as root to scrub all runtime artifacts (test_vault, test_config, test_outputs, specs_gen) leftover from prior runs
- Deletes and re-copies from `tests/defaults/` to get clean state

### 2. Docker image (`Dockerfile`)
Based on `ghcr.io/linuxserver/baseimage-rdesktop-web:focal-1.2.0-ls101` with:
- **Anki 2.1.60** (Qt6)
- **Obsidian 1.5.3** (extracted AppImage)
- Chrome, SSH, X11 utilities, `gnome-screenshot`
- Ports: `8080` (VNC web), `8888` (Chrome DevTools)

### 3. WebdriverIO (`wdio.conf.ts`)

**Spec auto-generation** (`prepare-wdio.sh`): Before wdio starts, `prepare-wdio.sh` iterates `tests/defaults/test_vault_suites/`. For each subdirectory NOT prefixed `ng_`, copies `tests/defaults/specs/template.e2e.ts` → `tests/specs_gen/<name>.e2e.ts`. The `ng_` prefix means "no generate" — these suites have hand-written specs in `tests/specs/`.

**Container lifecycle**: The `wdio-docker-service` spawns a container per run. The container's `autostart` script:
1. Starts `reset_perms.sh` daemon (watches for `/config/reset_perms` signal → `chmod -R 777`)
2. Launches Anki
3. Takes Anki PreTest screenshot
4. Launches `obsidian_anki.sh` (runs Obsidian with remote debugging on port 8890)
5. Starts SSH tunnel mapping `8888:8890` for Chrome debugging

**Per-spec flow** (from `template.e2e.ts`):
1. Wait for previous spec's `unlock` file to be removed
2. Alpine `chown` fix for stale permissions from prior container runs
3. Copy default vault + suite-specific files into `tests/test_vault/`
4. Copy suite-specific `.obsidian/` (plugin `data.json`) if present
5. Write `reset_perms` signal file → container sets world-writable
6. `browser.reloadSession()` — fresh WebDriver session for restarted Obsidian
7. Trust the plugin (click "Trust" button), dismiss any dialogs
8. Find Scan Vault button, reload vault (Ctrl+Shift+R), navigate to suite file, find Scan Vault again, take PreTest screenshot, then click Scan Vault
9. Poll browser console logs for "All done!" message
10. Screenshots (PostTest, and Error if warnings/errors present)
11. Close window, delete session
12. Copy Anki screenshots from container to `logs/<test_name>/`

**Post-spec assertions** (second `it` block):
- Read all `.md` files from `tests/test_vault/<name>/`
- Count `<!-- CARD -->` markers vs `ID: <n>` comments
- Assert every card got an ID (plugin wrote it back)

**Container teardown** (`onWorkerEnd`): Copies `test_outputs/<name>/` from container to `tests/test_outputs/` via `copySync` + `docker exec rm`. The container's `obsidian_anki.sh` handles:
1. Renames screenshots taken by `autostart` (Anki PostTest, Anki PreTest for next suite)
2. Moves Anki collection to `test_outputs/<name>/`
3. Copies fresh Anki profile from `Anki2default` (preserves the pristine backup)
4. Waits for `unlock` signal (written by spec's second `it` block)
5. Copies Obsidian vault to `test_outputs/<name>/Obsidian/`
6. Clears vault, then re-executes `/defaults/autostart` to begin the next iteration

**Cleanup** (`onComplete`): Kills orphaned `dockerEvents` child process; `process.exit()` after 30s safety net.

### 4. pytest (`tests/anki/`)

Each `test_<name>.py` reads `tests/test_outputs/<name>/Anki2/User 1/collection.anki2` using the actual `anki` library.

**Standard test functions** (most files):
| Function | Purpose |
|---|---|
| `test_col_exists(col)` | Verify collection is not empty |
| `test_deck_default_exists(col)` | Verify expected decks exist |
| `test_cards_count(col)` | Assert correct card/note count |
| `test_cards_ids_from_obsidian(col)` | Match Anki note IDs to `ID:` comments in Obsidian markdown |
| `test_cards_front_back_tag_type(col)` | Assert exact field content, tags, and note type |

Exceptions:
- `test_ignore_setting.py` and `test_folder_scan.py` add a 6th test for files that should produce zero cards
- `test_ng_delete_sync.py` has only `test_col_exists` (asserts collection is empty — the delete removed everything)

**Conventions:**
- Module-level `col_path` points to the Anki collection file (string literal or derived via `os.path.basename(__file__)[5:-3]`)
- Module-level `test_file_path(s)` point to post-sync Obsidian markdown
- `conftest.py` provides the `col` fixture (opens/close `Collection`)
- `test_cards_ids_from_obsidian` reads `ID:` regex matches from markdown and compares to `col.find_notes()`
- Some tests use `find_note_with_1st_field()` helper to locate notes by front field content

### Hand-written E2E specs

| File | What it tests |
|---|---|
| `tests/specs/ng_basic_update.e2e.ts` | Update a note: sync → modify content via DOM (`innerText`) → save (Ctrl+S) → re-sync → verify no errors |
| `tests/specs/ng_delete_sync.e2e.ts` | Delete a note: sync → add `DELETE` line to DOM → save → re-sync → verify note removed |

These use `ng_` prefix in the suite directory name to prevent auto-generation, and have custom E2E logic beyond the template.

## Adding a New Test

1. **Create suite directory**: `tests/defaults/test_vault_suites/<name>/`
   - Add `.md` files with note content using the syntax you want to test
   - Mark card locations with `<!-- CARD -->` comments
   - If needed, add `.obsidian/plugins/obsidian-to-anki-plugin/data.json` with custom plugin settings
   - If the test needs special E2E behavior, prefix directory name with `ng_` and write a custom spec

2. **E2E spec**: If no `ng_` prefix, one is auto-generated from the template. It will:
   - Copy your suite files into the vault
   - Run "Scan Vault"
   - Assert `<!-- CARD -->` ↔ `ID:` match
   
   If `ng_` prefix, write `tests/specs/ng_<name>.e2e.ts` (copy `ng_basic_update.e2e.ts` as a reference).

3. **Python validation**: Create `tests/anki/test_<name>.py` with the standard 5 test functions.
   - Set `col_path` and `test_file_path` (or `test_file_paths` for multiple files)
   - Assert exact field content, tags, note types, deck membership

## Test Output Layout

```
tests/test_outputs/<name>/
├── Anki2/
│   └── User 1/
│       └── collection.anki2     # Anki collection with created notes
└── Obsidian/
    └── <name>/
        └── *.md                 # Post-sync markdown with ID: comments

logs/<test_name>/
├── Anki PreTest_<name>.png
├── Anki PostTest_<name>.png
├── Obsidian PreTest.png
├── Obsidian PostTest.png
└── (Obsidian PostTest_Error.png if warnings/errors)
```

## Feature Coverage

| Suite | Feature / Syntax Tested | Cards | Settings Key |
|---|---|---|---|
| `basic_para` | Header-as-front via custom regex `^#{2,}` | 4 Basic | `CUSTOM_REGEXPS` |
| `basic_para_3` | `###`-only headers via `^#{3,}` | 4 Basic | `CUSTOM_REGEXPS` |
| `basic_sync` | START/END syntax, explicit fields, multi-line, `<br />` | 3 Basic | — |
| `cloze_highlight` | `==highlight==` → cloze via CurlyCloze | 3 Cloze | `CurlyCloze - Highlights to Clozes` |
| `cloze_para` | Custom cloze paragraph regex | 5 Cloze | `CUSTOM_REGEXPS` + `CurlyCloze` |
| `cloze_sync` | START Cloze ... END, `{{c1::}}` custom IDs | 16 Cloze | — |
| `context_test` | Context fields (file path + heading in Back) | 1 Basic | `AddContext` + `CONTEXT_FIELDS` |
| `folder_deck` | `FOLDER_DECKS` maps subdirs to decks | 4 Basic | `FOLDER_DECKS` |
| `folder_deck_tags` | `FOLDER_DECKS` + `FOLDER_TAGS` together | 4 Basic | `FOLDER_DECKS` + `FOLDER_TAGS` |
| `folder_scan` | `ScanDirectory` subfolder restriction | 8 Basic | `ScanDirectory` |
| `frozen_notes` | FROZEN syntax (prepends text to Front) | 1 Basic | — |
| `ignore_setting` | `IGNORED_FILE_GLOBS` pattern exclusion | 6 Basic | `ScanDirectory` + `IGNORED_FILE_GLOBS` |
| `image_sync` | HTML `<img>` in cloze notes | 1 Cloze | — |
| `inline_notes` | STARTI/ENDI inline syntax | 1 Basic | — |
| `markdown_table` | Custom regex for `\|...\|` table rows | 2 Basic | `CUSTOM_REGEXPS` |
| `markdown_test` | Full markdown → HTML (italics, bold, headers, lists, links, code, tables) | 1 Basic | — |
| `math_test` | LaTeX `\(...\)` inline and `\[...\]` display | 2 Basic | — |
| `music_embed` | `[sound:]` audio tag + media file sync | 1 Cloze | — |
| `neuracache_sync` | `#flashcard` suffix → neuracache-style notes | 3 Basic | `CUSTOM_REGEXPS` |
| `obsidian_tags` | `#`-prefixed tags in `Tags:` line and `FILE TAGS`, inline note tags, double-`##`, hyphenated tags, edge-case tag tokens | 13 Basic | `AddObsidianTags` (set to `false`) |
| `question_answer` | Default Q:/A: syntax | 5 Basic | — |
| `remnote_inline` | `::` separator → remnote-style inline | 2 Basic | `CUSTOM_REGEXPS` |
| `ruled_style` | `---` separator → front/back | 2 Basic | `CUSTOM_REGEXPS` |
| `tag_sync` | Tags: line, #tag in field, FILE TAGS, AddObsidianTags | 7 Basic | `AddObsidianTags` |
| `target_deck` | TARGET DECK directive (same/next line) | 2 Basic | — |
| `ng_basic_update` | Note update lifecycle (re-sync after content change) | 1 Basic | — |
| `ng_delete_sync` | Note delete via DELETE line | 0 (empty) | — |

## Key Infrastructure Details

### Permission model
- `wdio.conf.ts` passes `PUID`/`PGID` env vars so the container's `abc` user matches the host UID — no stale uid-911 files on bind mounts
- `reset_perms.sh` runs in a container background loop: on signal (`/config/reset_perms`), runs `chmod -R 777 /vaults /config`
- `prepare-wdio.sh` runs an alpine container as root before the host `rm -rf` to scrub all runtime artifacts (test_vault, test_config, test_outputs, specs_gen) leftover from prior runs
- Template specs start with an alpine `chown` for stale permissions from prior runs
- `obsidian_anki.sh` uses `sudo` internally with password `abc` for privileged operations

### Concurrency
- `maxInstances: 1` — one worker per spec, clean per-spec pass/fail reporting
- Specs array is flat (not nested), so each spec gets its own worker process
- The container processes specs sequentially: `obsidian_anki.sh` processes a suite, then re-executes `/defaults/autostart` for the next iteration. (Note: the `while [ ! testFound ]` condition evaluates the literal string `testFound` — a non-empty truthy value — so `! testFound` is always false and the loop body never executes. **This is intentional.** Fixing either loop to use `"$testFound"` causes a deadlock: the first loop would block on vault files that don't exist at initial boot, and the second loop would wait for vault files that the next spec can only copy *after* the WebDriver session connects.)

### Container orchestration
- `autostart` scripts launch Anki → PreTest screenshot → Obsidian → SSH tunnel in staggered `sleep` steps
- `obsidian_anki.sh` handles: launching Obsidian, renaming screenshots taken by `autostart`, copying the Anki collection to test outputs, copying a fresh profile from `Anki2default`, copying vault outputs, and triggering the next iteration via re-executing `autostart`
- `onWorkerEnd` copies test outputs via `fse.copySync()` (not `rename()`, which fails cross-filesystem) then `docker exec rm` inside container

### Session creation retry budget

`connectionRetryTimeout: 120000` / `connectionRetryCount: 3` in `wdio.conf.ts` must be kept at these values. Chromedriver has an internal ~60s timeout when connecting to Chrome's DevTools Protocol via `debuggerAddress` (across the SSH tunnel `8888:8890`). Reducing `connectionRetryTimeout` below 60s causes `got`'s HTTP response timeout to fire before chromedriver responds; each `got` retry chain exhausts `connectionRetryCount + 1` rounds of `connectionRetryTimeout`, and the cascading WebDriver retries compound the delay — every subsequent spec's session creation fails.

### Process safety
- `onComplete` runs `pkill -f "dockerEvents"` to kill orphaned child from `wdio-docker-service`
- `setTimeout(() => process.exit(exitCode), 30000)` forces exit after 30s if the event loop stays alive

## CI (`test-e2e.yml`)

Two parallel jobs run similar steps (differ in checkout strategy, event variables, and screenshot formatting):
- `checkout-trusted` — runs on PRs from the same repo; flat screenshot display
- `checkout-signed` — runs on `/ok-to-test` slash commands from fork PRs; collapsible `<details>` screenshot sections

Both build the plugin, run `test-wdio` and `test-py` with `sudo`, publish JUnit XML results to a PR comment, publish screenshots via CML, and upload build artifacts. JUnit reports land in `logs/test-reports/`.

## File Layout Reference

| Path | Purpose |
|---|---|
| `tests/defaults/test_vault/` | Clean Obsidian vault template (with plugin registered) |
| `tests/defaults/test_config/` | Clean Obsidian/Anki config template (with empty Anki collection) |
| `tests/defaults/test_config/.local/share/Anki2default/` | Pristine Anki profile (copied fresh between tests, preserved as source) |
| `tests/defaults/test_vault_suites/<name>/` | Per-suite markdown files + optional `.obsidian/` plugin config |
| `tests/defaults/specs/template.e2e.ts` | Base E2E spec template |
| `tests/specs_gen/` | Auto-generated E2E specs (gitignored) |
| `tests/specs/` | Hand-written E2E specs (`ng_` prefix) |
| `wdio.conf.ts` | WebdriverIO configuration (at project root) |
| `tests/anki/` | Python/pytest validation files |
| `tests/test_outputs/` | Per-suite Anki collections + Obsidian markdown (gitignored) |
| `tests/test_vault/` | Runtime vault mount (gitignored, bind-mounted into container) |
| `tests/test_config/` | Runtime config mount (gitignored, bind-mounted into container) |
| `logs/` | Per-spec screenshots, container logs, test reports (gitignored) |
| `root/` | Docker overlay (autostart, obsidian_anki.sh, reset_perms.sh) |
| `scripts/interactive-test.sh` | Interactive sandbox driver — see below |
| `scripts/interactive-autostart` | Custom container entrypoint for sandbox (replaces baked-in autostart) |
| `scripts/kill-sandbox.sh` | Kill a stuck sandbox container |

## Interactive Sandbox (development tool)

A separate entrypoint (`scripts/interactive-test.sh`) runs the same Docker image with a custom `autostart` that launches Obsidian + Anki without WebDriver automation. Connect via VNC at `http://localhost:8080` for manual testing.

```sh
npm run sandbox            # Build plugin, start container
npm run sandbox -- --dev   # Rollup watch + hot-reload (bind-mounts main.js)
npm run sandbox -- --dry-run  # Setup vault/config only, no Docker
npm run kill-sandbox       # Kill container when Ctrl+C fails
```

**Key differences from the E2E pipeline:**
- No WebDriver/Chrome — you interact via noVNC in the browser
- No per-spec isolation — all 27 suites are copied into a single vault
- Plugin `data.json` uses curated defaults (not per-suite configs)
- Vault is at `/tmp/interactive-test-vault/`, config at `/tmp/interactive-test-config/` — both cleaned up on exit (pass `--dry-run` to preserve)
- `docker rm -f` before start clears stale containers from interrupted runs
- Container named `obsidian-to-anki-sandbox` for easy `docker kill`

See `PLAN.md` for full documentation.

## How It Works

1. Script builds the plugin and preps vault/config dirs in `/tmp/`
2. Docker image is built (if missing)
3. Container starts with S6 init (handles X11, VNC, window manager)
4. Custom `autostart` restores pristine Anki profile, launches Anki (background), waits for AnkiConnect, then launches Obsidian (background) and blocks on it. After Obsidian closes it kills Anki gracefully, then signals S6 init to stop the container.
5. `obsidian.json` has `"open":true` — Obsidian auto-opens the vault
6. Vault has the plugin installed, Hot Reload plugin installed, and markdown notes from all 27 test suites
7. User connects via browser at `localhost:8080` (VNC password: `abc`)
8. User enables community plugins, trusts both plugins, opens notes, clicks "Scan Vault", sees cards in Anki
9. Closing Obsidian stops the container
10. All state in `/tmp/` — nothing touches real vaults/Anki

## Notes

- VNC default password `abc` is from the base image (`linuxserver/baseimage-rdesktop-web`)
- The `--disable-gpu --disable-software-rasterizer` flags avoid Docker rendering issues
- AnkiConnect communicates on `localhost:8765` inside the container — no port exposure needed
- `netcat-openbsd` is pre-installed in the image (provides `nc`)
- `sudo` is available in the image (not used by autostart — 50-config already handles ownership as root)
- Hot Reload plugin is fetched from GitHub raw at runtime — requires internet on first run
- `scripts/interactive-autostart` must be `chmod +x` on the host (Docker bind-mount preserves permissions)
- `export HOME=/config` is set explicitly in the autostart because the Dockerfile overrides `HOME` to `/vaults`, but the `abc` user's `/etc/passwd` home is `/config`. Both Obsidian (Electron) and Anki (Python) resolve `~` via the passwd database, so config/data live under `/config/.config/obsidian/` and `/config/.local/share/Anki2/` regardless of `$HOME`. The explicit export covers any tool that reads `$HOME` directly.
- The `-it` flag forwards terminal signals to the container; Ctrl+C sends SIGINT to S6-init, triggering graceful container shutdown. If run without a TTY, omit `-it` but note that manual shutdown via `docker stop` is required.
- Temp dirs `/tmp/interactive-test-vault/` and `/tmp/interactive-test-config/` are removed after each run. Pass `--dry-run` to keep them for inspection — the script exits after setup without launching Docker or cleaning up.
- Anki launches in dark mode by default (theme patched in test config).
