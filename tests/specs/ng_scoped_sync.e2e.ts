import { readFileSync } from 'fs';
import { browser } from '@wdio/globals';

const fse = require('fs-extra');
const path = require('path');
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
            if (msg.includes('[TRACE]')) console.log(`[${label || 'sync'}] TRACE:`, msg);
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

// Count ID comments written into a test_vault file by the plugin.
function idCount(relPath: string): number {
    const abs = path.join(__dirname, `./../../tests/test_vault/${test_name}`, relPath);
    const content = readFileSync(abs, 'utf-8');
    return (content.match(/ID: \d+/g) || []).length;
}

// Append a new card (with <!-- CARD --> marker, no ID) to a note via the Obsidian API.
async function appendCard(relPath: string, front: string, back: string): Promise<void> {
    await browser.execute(async (filePath, frontText, backText) => {
        var app = (window as any).app;
        var file = app.vault.getAbstractFileByPath(filePath);
        if (file) {
            var content = await app.vault.read(file);
            content += `\n\n<!-- CARD -->\nSTART\nBasic\n${frontText}\nBack: ${backText}\nEND\n`;
            await app.vault.modify(file, content);
        }
    }, relPath, front, back);
}

// Open a note so it becomes the active file (getActiveFile()).
// Verifies the active file actually changed to the target before returning.
async function openNote(relPath: string): Promise<void> {
    const active = await browser.execute(async (filePath) => {
        var app = (window as any).app;
        var file = app.vault.getAbstractFileByPath(filePath);
        if (!file) return 'missing-file';
        var leaf = app.workspace.getLeaf(true);
        await leaf.openFile(file);
        await new Promise(r => setTimeout(r, 500));
        var act = app.workspace.getActiveFile();
        return act ? act.path : 'no-active-file';
    }, relPath);
    assert(active === relPath, `openNote: expected active file "${relPath}", got "${active}"`);
}

// Run a plugin command via the real command registry and await its full sync.
async function runCommand(commandId: string): Promise<void> {
    await browser.execute((id) => {
        var app = (window as any).app;
        app.commands.executeCommandById(id);
    }, commandId);
}

describe(test_name_fmt, () => {
    it('should send All-done message to console post sync', async () => {
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

        await delay(2000);
        await browser.reloadSession(); // Fresh session for restarted Obsidian
        await browser.execute( () => { var btn = [...document.querySelectorAll('button')].find(btn => btn.textContent.includes('Trust')); if(btn) btn.click(); } );
        
        await delay(3000);
        await browser.execute( () => { return dispatchEvent(new KeyboardEvent('keydown', {'key': 'Escape'})); } );
        await browser.execute( () => { return dispatchEvent(new KeyboardEvent('keydown', {'key': 'r', ctrlKey: true, shiftKey: true})); } );
        await delay(5000);
        // Expand folders so nav titles are rendered (needed for context-menu right-clicks)
        var rootFolder = await $('.nav-folder-title[data-path="ng_scoped_sync"]');
        await expect(rootFolder).toExist();
        await rootFolder.click();
        await delay(500);
        var subdir = await $('.nav-folder-title[data-path="ng_scoped_sync/subdir"]');
        await expect(subdir).toExist();
        await subdir.click();
        await delay(100);

        // Baseline full-vault sync so every initial card has an ID
        const syncButton = await $('aria/Obsidian 2 Anki - Sync Vault');
        await expect(syncButton).toExist();
        await $(syncButton).click();
        const hasChanges = await waitForSyncDone('baseline');
        assert(hasChanges === true, 'Baseline full-vault sync should detect initial cards');

        // All 3 initial cards now have IDs
        await delay(1000);
        assert(idCount('ng_scoped_sync.md') === 1, `root file should have 1 ID after baseline sync, got ${idCount('ng_scoped_sync.md')}`);
        assert(idCount('subdir/card1.md') === 1, `card1 should have 1 ID after baseline sync, got ${idCount('subdir/card1.md')}`);
        assert(idCount('subdir/card2.md') === 1, `card2 should have 1 ID after baseline sync, got ${idCount('subdir/card2.md')}`);
    })

    it('command palette "Sync Current File" should sync only the active file', async () => {
        // Pending cards: one in card1 (the target), and DECOYS in root + card2 that must stay unsynced
        await appendCard('ng_scoped_sync/subdir/card1.md', 'C1b front', 'C1b back');
        await appendCard('ng_scoped_sync/ng_scoped_sync.md', 'Root 2 front', 'Root 2 back');
        await appendCard('ng_scoped_sync/subdir/card2.md', 'C2b front', 'C2b back');
        await delay(1000);

        await openNote('ng_scoped_sync/subdir/card1.md');
        await runCommand('obsidian-2-anki:anki-sync-current-file');
        const cmdFileDone = await waitForSyncDone('cmd-current-file');
        assert(cmdFileDone === true, 'Sync Current File should detect the new card in card1');

        await delay(1000);
        assert(idCount('subdir/card1.md') === 2, `card1 should have 2 IDs after Sync Current File, got ${idCount('subdir/card1.md')}`);
        assert(idCount('ng_scoped_sync.md') === 1, `root DECOY should stay at 1 ID (unsynced), got ${idCount('ng_scoped_sync.md')}`);
        assert(idCount('subdir/card2.md') === 1, `card2 DECOY should stay at 1 ID (unsynced), got ${idCount('subdir/card2.md')}`);
    })

    it('command palette "Sync Current Folder" should sync only files in the active folder', async () => {
        // card2 gets a new card; the root DECOY from the previous test must remain unsynced
        await appendCard('ng_scoped_sync/subdir/card2.md', 'C2c front', 'C2c back');
        await delay(1000);

        await openNote('ng_scoped_sync/subdir/card2.md');
        await runCommand('obsidian-2-anki:anki-sync-current-folder');
        const cmdFolderDone = await waitForSyncDone('cmd-current-folder');
        assert(cmdFolderDone === true, 'Sync Current Folder should detect the new card in card2');

        await delay(1000);
        assert(idCount('subdir/card2.md') === 3, `card2 should have 3 IDs after Sync Current Folder, got ${idCount('subdir/card2.md')}`);
        assert(idCount('subdir/card1.md') === 2, `card1 should be unchanged at 2 IDs, got ${idCount('subdir/card1.md')}`);
        assert(idCount('ng_scoped_sync.md') === 1, `root DECOY should stay at 1 ID (outside subdir), got ${idCount('ng_scoped_sync.md')}`);
    })

    it('context menu "Sync to Anki" on a file should sync only that file', async () => {
        // Right-click the root file, click the plugin's "Sync to Anki" menu item
        const fileTitle = await $('.nav-file-title[data-path="ng_scoped_sync/ng_scoped_sync.md"]');
        await expect(fileTitle).toExist();
        await fileTitle.click({ button: 2 });

        const menuItem = await $('div.menu-item*=Sync to Anki');
        await menuItem.waitForDisplayed({ timeout: 5000 });
        await menuItem.click();

        const hasChanges = await waitForSyncDone('ctx-current-file');
        assert(hasChanges === true, 'Context menu "Sync to Anki" should detect the pending root card');

        await delay(1000);
        assert(idCount('ng_scoped_sync.md') === 2, `root file should have 2 IDs after file context-menu sync, got ${idCount('ng_scoped_sync.md')}`);
        assert(idCount('subdir/card1.md') === 2, `card1 should be unchanged at 2 IDs, got ${idCount('subdir/card1.md')}`);
        assert(idCount('subdir/card2.md') === 3, `card2 should be unchanged at 3 IDs, got ${idCount('subdir/card2.md')}`);
    })

    it('context menu "Sync Folder to Anki" on a folder should sync only files in that folder', async () => {
        // New pending cards in both subdir files; root DECOY must remain unsynced
        await appendCard('ng_scoped_sync/subdir/card1.md', 'C1c front', 'C1c back');
        await appendCard('ng_scoped_sync/subdir/card2.md', 'C2d front', 'C2d back');
        await delay(1000);

        const folderTitle = await $('.nav-folder-title[data-path="ng_scoped_sync/subdir"]');
        await expect(folderTitle).toExist();
        await folderTitle.click({ button: 2 });

        const menuItem = await $('div.menu-item*=Sync Folder to Anki');
        await menuItem.waitForDisplayed({ timeout: 5000 });
        await menuItem.click();

        const hasChanges = await waitForSyncDone('ctx-current-folder');
        assert(hasChanges === true, 'Context menu "Sync Folder to Anki" should detect the pending subdir cards');

        await delay(1000);
        assert(idCount('subdir/card1.md') === 3, `card1 should have 3 IDs after folder context-menu sync, got ${idCount('subdir/card1.md')}`);
        assert(idCount('subdir/card2.md') === 4, `card2 should have 4 IDs after folder context-menu sync, got ${idCount('subdir/card2.md')}`);
        assert(idCount('ng_scoped_sync.md') === 2, `root DECOY should stay at 2 IDs (outside subdir), got ${idCount('ng_scoped_sync.md')}`);
    })

    it('post scoped sync, it should not give any errors', async () => {
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
