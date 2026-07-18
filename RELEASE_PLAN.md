# Release Plan — Obsidian 2 Anki (fork)

Create a GitHub Release so the plugin can be installed via [BRAT](https://github.com/TfTHacker/obsidian42-brat) from `https://github.com/calvbore/obsidian-2-anki`.

## Prerequisites

| # | Step | Why |
|---|------|-----|
| 1 | ✅ Actions enabled on fork | Done — verified at `https://github.com/calvbore/obsidian-2-anki/actions` |
| 2 | Regenerate `package-lock.json` | Lockfile still has stale name `obsidian-to-anki-plugin` (pre-rename). Run `rm package-lock.json && npm install` to produce one matching current `package.json`. |
| 3 | Bump `manifest.json` version to `3.6.1` | Distinguish fork release from upstream's `3.6.0` tag |
| 4 | Bump `package.json` version to `3.6.1` | Keep consistent with `manifest.json` |
| 5 | Add `"3.6.1": "0.9.20"` to `versions.json` | Obsidian needs this for plugin compatibility checking |
| 6 | Fix workflow `Get Version` step | Replace fragile `git describe` pipeline with `${{ github.ref_name }}` |
| 7 | Delete stale tag `3.6.0` locally and on remote | It points to upstream, not fork HEAD. Would push with `--tags` otherwise. |

## Release steps

### 1. Commit all pre-requisite changes

```bash
git add -A
git commit -m "chore: prepare v3.6.1 for BRAT release"
```

### 2. Tag and push

```bash
git tag 3.6.1
git push origin main --tags
```

### 3. Wait for CI

Go to `https://github.com/calvbore/obsidian-2-anki/actions` and wait for the workflow to finish (creates a draft release).

### 4. Publish the draft

At `https://github.com/calvbore/obsidian-2-anki/releases`, find the draft `3.6.1`, click **Edit** → **Publish release**.

### 5. Install via BRAT

- Install BRAT from Obsidian Community Plugins
- BRAT Settings → Add Beta Plugin → paste `https://github.com/calvbore/obsidian-2-anki`
- Enable the plugin in Community Plugins settings

## Skipped (not worth churn now)

- `npm install` / `npm ci` redundancy in workflow — works fine
- `author`/`authorUrl` in `manifest.json` — cosmetic, can update later
