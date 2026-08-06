#!/bin/bash

mkdir -p tests/test_config
mkdir -p tests/test_vault
mkdir -p tests/specs_gen
mkdir -p tests/test_outputs

# Copy Built plugin into the default vault.
# NOTE: copy the plugin files OVER an existing dir — do NOT rm -rf the dir, because suite
# vaults keep a tracked per-suite plugin config at .obsidian/plugins/obsidian-2-anki/data.json
# that must be preserved (cp overwrites only the named files).
mkdir -p tests/defaults/test_vault/.obsidian/plugins/obsidian-2-anki 
copy_plugin() {
    mkdir -p "$1/.obsidian/plugins/obsidian-2-anki"
    cp manifest.json styles.css main.js "$1/.obsidian/plugins/obsidian-2-anki/"
}
copy_plugin "tests/defaults/test_vault"
# ALSO refresh every suite vault's plugin copy. Each suite ships its own .obsidian/plugins/
# and the per-spec template copies it over the fresh vault (overwrite:true), so a stale
# suite main.js would silently override the freshly-built plugin for that suite. Keep them
# in lockstep with the current build to avoid testing a stale plugin (see D1 in DIAGNOSTICS).
for suite in tests/defaults/test_vault_suites/*/; do
    [ -d "$suite/.obsidian/plugins/obsidian-2-anki" ] && copy_plugin "${suite%/}"
done

# Setup docker volumes
docker run --rm -v "$(pwd):/repo" alpine sh -c 'rm -rf /repo/tests/test_vault /repo/tests/test_config /repo/tests/test_outputs /repo/tests/specs_gen' 2>/dev/null || true
rm -rf tests/test_vault 
rm -rf tests/test_config 

cp -Rf tests/defaults/test_vault tests/ 
cp -Rf tests/defaults/test_config tests/

# Generate spec files for each test vault suite
rm -rf tests/specs_gen/*
mkdir -p tests/specs_gen
for suite in tests/defaults/test_vault_suites/*/; do
    name=$(basename "$suite")
    if [[ $name != ng_* ]]; then
        cp "tests/defaults/specs/template.e2e.ts" "tests/specs_gen/${name}.e2e.ts"
    fi
done
