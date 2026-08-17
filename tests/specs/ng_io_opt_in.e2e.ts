import { readFileSync } from 'fs';
import { browser } from '@wdio/globals';

import * as fse from 'fs-extra';
import * as path from 'path';
const assert = require('assert');

const test_name = (path.basename(__filename) as string).split('.')[0]
const test_name_fmt = test_name.split('_').reduce((acc,s) => { return acc + ' ' + s.charAt(0).toUpperCase() + s.slice(1)}) + " Test"

function delay(ms: number) {
    return new Promise( resolve => setTimeout(resolve, ms) );
}

// Poll browser logs for sync completion WITHOUT clicking the ribbon sync button.
// Used for scoped syncs (command palette + context menu), which have their own entry points.
// Returns true for "All done!", false for "No changes detected!".
async function waitForSyncDone(label: string): Promise<boolean> {
    let logs: Array<Object> = [];
    for (let i = 0; i < 300; i++) { // 30 second timeout
        logs = await browser.getLogs('browser');
        for (const log of logs) {
            const msg = log['message'] as string;
            if (msg.includes('couldn\'t connect')) console.log(`[${label || 'sync'}] ANKI_ERROR:`, msg);
        }
        const done = logs.find(e => (e['message'] as string).includes('All done!'));
        const noChanges = logs.find(e => (e['message'] as string).includes('No changes detected!'));
        if (done) { console.log(`[${label || 'sync'}] Found "All done!"`); return true; }
        if (noChanges) { console.log(`[${label || 'sync'}] Found "No changes detected!"`); return false; }
        await delay(100);
    }
    throw new Error(`Sync [${label}] did not complete within 30 seconds`);
}

const suite_dir = `tests/test_vault/${test_name}`
const io_file = `${suite_dir}/${test_name}.excalidraw.md`

function ioContent(): string {
    return fse.readFileSync(io_file, 'utf-8');
}

function countIds(content: string): number {
    return (content.match(/<!--ID: \d+-->/g) || []).length;
}

describe(test_name_fmt, () => {
    it('right-click "Sync to Anki" auto-opts an unmarked drawing in', async () => {
        try {
            while (fse.pathExistsSync('tests/test_vault/unlock'))
            {
                console.log('tests/test_vault still exists. Waiting for it be removed ...');
                await delay(100);
            }

            fse.copySync(`tests/defaults/test_vault`, `tests/test_vault`, { overwrite: true });
            fse.copySync(`tests/defaults/test_vault_suites/${test_name}`, `tests/test_vault/${test_name}`, { overwrite: true });

            if (fse.pathExistsSync(`tests/defaults/test_vault_suites/${test_name}/.obsidian`))
                fse.copySync(`tests/defaults/test_vault_suites/${test_name}/.obsidian`, `tests/test_vault/.obsidian`, { overwrite: true });

            fse.writeFile('tests/test_config/reset_perms', 'meow', (err) => {
                if (err)
                    console.log('reset_perms file could not be created. Err: ', err);
            });
        } catch (err) {
            console.error(err)
        }

        await delay(5000);
        await browser.reloadSession(); // Fresh session for restarted Obsidian
        await browser.execute( () => { var btn = [...document.querySelectorAll('button')].find(btn => btn.textContent.includes('Trust')); if(btn) btn.click(); } );

        await delay(3000);
        await browser.execute( () => { return dispatchEvent(new KeyboardEvent('keydown', {'key': 'Escape'})); } );
        await browser.execute( () => { return dispatchEvent(new KeyboardEvent('keydown', {'key': 'r', ctrlKey: true, shiftKey: true})); } );
        await delay(5000);

        // The drawing is initially NOT opted in.
        const pre = ioContent();
        assert(!pre.includes('anki-occlusion'), `fixture must start unmarked, got:\n${pre}`);

        let folder = await $(`.nav-folder-title*=${test_name}`)
        await expect(folder).toExist();
        await folder.click(); // Should drop down files
        await delay(100);

        // Right-click the drawing file -> context menu -> "Sync to Anki".
        // This must opt the file in (write the marker) and then sync it.
        const fileTitle = await $(`.nav-file-title[data-path="${test_name}/${test_name}.excalidraw.md"]`);
        await expect(fileTitle).toExist();
        await fileTitle.click({ button: 2 });

        const menuItem = await $('div.menu-item*=Sync to Anki');
        await menuItem.waitForDisplayed({ timeout: 5000 });
        await menuItem.click();

        const allDone = await waitForSyncDone('ctx-opt-in');
        assert(allDone === true, 'context-menu "Sync to Anki" on an unmarked drawing should sync');

        await delay(2000);

        // The marker was written and the frame note got an ID.
        const post = ioContent();
        assert(post.includes('anki-occlusion: true'), `marker should be written, got:\n${post}`);
        assert(countIds(post) === 1, `expected 1 ID after auto opt-in, got ${countIds(post)}`);
        await delay(1000);
    })

    it('context menu toggle should disable and re-enable Image Occlusion sync', async () => {
        // Toggle off: remove the marker.
        const fileTitleOn = await $(`.nav-file-title[data-path="${test_name}/${test_name}.excalidraw.md"]`);
        await expect(fileTitleOn).toExist();
        await fileTitleOn.click({ button: 2 });
        const disableItem = await $('div.menu-item*=Disable Image Occlusion sync');
        await disableItem.waitForDisplayed({ timeout: 5000 });
        await disableItem.click();
        await delay(2000);

        let content = ioContent();
        assert(!content.includes('anki-occlusion'), `marker should be removed, got:\n${content}`);

        // Toggle back on: the marker returns, file body and IDs are intact.
        const fileTitleOff = await $(`.nav-file-title[data-path="${test_name}/${test_name}.excalidraw.md"]`);
        await expect(fileTitleOff).toExist();
        await fileTitleOff.click({ button: 2 });
        const enableItem = await $('div.menu-item*=Enable Image Occlusion sync');
        await enableItem.waitForDisplayed({ timeout: 5000 });
        await enableItem.click();
        await delay(2000);

        content = ioContent();
        assert(content.includes('anki-occlusion: true'), `marker should be restored, got:\n${content}`);
        assert(content.includes('Header: Opted in header'), 'note fields should be intact');
        assert(countIds(content) === 1, `expected the ID to survive the toggle cycle, got ${countIds(content)}`);
        await delay(1000);
    })

    it('full-vault sync after the opt-in cycle reports no changes', async () => {
        // The drawing is still marked, the note exists in Anki with its ID and
        // matching hash, so a full sync is a no-op (no duplicates).
        const syncButton = await $('aria/Obsidian 2 Anki - Sync Vault');
        await expect(syncButton).toExist();
        await $(syncButton).click();

        const hasChanges = await waitForSyncDone('full-after-optin');
        assert(hasChanges === false, 'full sync should report no changes');

        const content = ioContent();
        assert(countIds(content) === 1, `expected 1 ID still, got ${countIds(content)}`);

        await delay(1000);
        await browser.closeWindow();

        await delay(3000);

        try {
            function errHandler(err) {
                if (err) {
                    console.log(`Error on trying to copy vault_suite ${test_name}:`, err);
                }
            }
            fse.copyFile(`tests/test_config/Anki PreTest_${test_name}.png`, `logs/${test_name}/Anki PreTest_${test_name}.png`, errHandler);
            fse.copyFile(`tests/test_config/Anki PostTest_${test_name}.png`, `logs/${test_name}/Anki PostTest_${test_name}.png`, errHandler);
        }
        catch( e ) {
            console.error( "We've thrown! Whoops!", e );
        }

        fse.writeFile('tests/test_vault/unlock', 'meow', (err) => {
            if (err)
                console.log('reset_perms file could not be created. Err: ', err);
        });
        await delay(5000);
    })
})