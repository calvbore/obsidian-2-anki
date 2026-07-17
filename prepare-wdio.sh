#!/bin/bash

mkdir -p tests/test_config
mkdir -p tests/test_vault
mkdir -p tests/specs_gen
mkdir -p tests/test_outputs

# Copy Built plugin
rm -rf tests/defaults/test_vault/.obsidian/plugins/obsidian-to-anki-plugin 
mkdir -p tests/defaults/test_vault/.obsidian/plugins/obsidian-to-anki-plugin 
cp manifest.json styles.css main.js tests/defaults/test_vault/.obsidian/plugins/obsidian-to-anki-plugin/

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
