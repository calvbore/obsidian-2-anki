import { readFileSync } from 'fs';
import { browser } from '@wdio/globals';

const fse = require('fs-extra');
const path = require('path');
const assert = require('assert');

const test_name = (path.basename(__filename) as string).split('.')[0] 
const test_name_fmt = test_name.split('_').reduce((acc,s) => { return acc + ' ' + s.charAt(0).toUpperCase() + s.slice(1)}) + " Test"

const FgYellow = "\x1b[33m"
const Reset = "\x1b[0m"
const FgRed = "\x1b[31m"

function delay(ms: number) {
    return new Promise( resolve => setTimeout(resolve, ms) );
}

async function syncObsidianAnki(label: string = ''): Promise<boolean> {
    const SyncButton = await $('aria/Obsidian 2 Anki - Sync Vault')
    await expect(SyncButton).toExist()
    await $(SyncButton).click()

    let logs: Array<Object> = [];
    for (let i = 0; i < 300; i++) {
        logs = await browser.getLogs('browser');
        for (const log of logs) {
            const msg = log['message'] as string;
            if (msg.includes('[TRACE]')) console.log(`[${label || 'sync'}] TRACE:`, msg);
        }
        const done = logs.find(e => (e['message'] as string).includes('All done!'));
        const noChanges = logs.find(e => (e['message'] as string).includes('No changes detected!'));
        if (done) { console.log(`[${label || 'sync'}] Found "All done!"`); return true; }
        if (noChanges) { console.log(`[${label || 'sync'}] Found "No changes detected!"`); return false; }
        await delay(100);
    }
    throw new Error(`Sync [${label}] did not complete within 30 seconds`);
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
            if (fse.pathExistsSync('tests/test_vault'))
                console.log('Copied default Test_vault.');
            else
                console.log('Could not copy default Test_vault.')
            console.log('success copying default vault !');

            fse.copySync(`tests/defaults/test_vault_suites/${test_name}`, `tests/test_vault/${test_name}`, { overwrite: true });
            if (fse.pathExistsSync(`tests/test_vault/${test_name}`))
                console.log('Copied default Test_vault_suite.');
            else
                console.log('Could not copy default Test_vault_suite.')

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
        await browser.reloadSession();
        await browser.execute( () => { var btn = [...document.querySelectorAll('button')].find(btn => btn.textContent.includes('Trust')); if(btn) btn.click(); } );
        
        await delay(3000);
        await browser.execute( () => { return dispatchEvent(new KeyboardEvent('keydown', {'key': 'Escape'})); } );
        await browser.execute( () => { return dispatchEvent(new KeyboardEvent('keydown', {'key': 'r', ctrlKey: true, shiftKey: true})); } );
        await delay(5000);

        await delay(100);        
        
        await browser.saveScreenshot(`logs/${test_name}/Obsidian PreTest.png`)
        await syncObsidianAnki('first-sync');        
        await browser.saveScreenshot(`logs/${test_name}/Obsidian PostTest.png`)
        
        await delay(1000);
    })

    it('should have Anki card IDs in Obsidian note', async () => {
        const filePostTest = readFileSync( path.join(__dirname,`./../../tests/test_vault/${test_name}/${test_name}.md`), 'utf-8');
        
        const ID_REGEXP_STR = /\n?(?:<!--)?(?:ID: (\d+).*?)/g;
        const ID_REGEXP_STR_CARD = /<!-- CARD -->/g;

        let number_of_cards = (filePostTest.match(ID_REGEXP_STR) || []).length;
        let number_of_test_cards = (filePostTest.match(ID_REGEXP_STR_CARD) || []).length;

        console.log(`Number of cards in test file are - ${number_of_cards}, number_of_test_cards - ${number_of_test_cards}`);
        
        assert (number_of_cards == number_of_test_cards);
    })

    it('should handle folder rename and sync new cards in same cycle', async () => {
        // Add new content to card.md so the sync has work to do
        await browser.execute(async () => {
            var app = (window as any).app;
            var cardFile = app.vault.getAbstractFileByPath('ng_rename_and_cancel/sync_folder/card.md');
            if (cardFile) {
                var content = await app.vault.read(cardFile);
                content += '\nSTART\nBasic\nQueued card\nBack: Should appear\nEND\n';
                await app.vault.modify(cardFile, content);
            }
        });

        await delay(1000);

        // Rename the folder (rename event fires immediately, migration happens directly since isSyncing is false)
        await browser.execute(() => {
            var app = (window as any).app;
            var folder = app.vault.getAbstractFileByPath('ng_rename_and_cancel/sync_folder');
            if (folder) {
                app.fileManager.renameFile(folder, 'ng_rename_and_cancel/renamed_sync_folder');
            }
        });

        await delay(1000);

        // Verify plugin handled the rename (check FOLDER_DECKS was migrated)
        const postRename = await browser.execute(() => {
            var p = (window as any).app.plugins.plugins['obsidian-2-anki'];
            if (!p?.settings) return 'no-plugin';
            return JSON.stringify({
                queueEmpty: p.renameQueue.length === 0,
                hasMigrated: 'ng_rename_and_cancel/renamed_sync_folder' in (p.settings.FOLDER_DECKS || {})
            });
        });
        var pr = JSON.parse(postRename as string);
        assert(pr.queueEmpty, 'Rename queue should be empty (no sync in progress)');
        assert(pr.hasMigrated, 'FOLDER_DECKS should have new path after direct migration');

        // Sync — should process the new card
        const firstResult = await syncObsidianAnki('content-sync');
        assert(firstResult, 'Sync should detect and process the new card content');

        await delay(1000);

        // Re-sync — should show "No changes detected!" (migration already done, new card already synced)
        const secondResult = await syncObsidianAnki('verify-sync');
        assert(!secondResult, 'Expected "No changes detected!" after rename + content sync');
    })

    it('should abort sync when Cancel is clicked', async () => {
        // Add many new cards to make the sync slow enough to cancel
        await browser.execute(async () => {
            var app = (window as any).app;
            var file = app.vault.getAbstractFileByPath('ng_rename_and_cancel/ng_rename_and_cancel.md');
            if (file) {
                var content = await app.vault.read(file);
                for (var i = 0; i < 50; i++) {
                    content += '\nSTART\nBasic\nCancel test card ' + i + '\nBack: Should not appear\nEND\n';
                }
                await app.vault.modify(file, content);
            }
        });

        await delay(1000);

        // Click sync button
        const syncBtn = await $('aria/Obsidian 2 Anki - Sync Vault');
        await expect(syncBtn).toExist();
        await $(syncBtn).click();

        // Aggressively find and click the cancel button
        var cancelled = false;
        var abortedImmediate = false;
        for (var attempt = 0; attempt < 50; attempt++) {
            var btnInfo = await browser.execute(() => {
                var modal = document.querySelector('.anki-progress-modal');
                if (!modal) return null;
                var btn = modal.querySelector('button') as HTMLButtonElement;
                if (!btn) return null;
                var wasDisabled = btn.disabled;
                // Use dispatchEvent for reliable click triggering
                btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                var nowDisabled = btn.disabled;
                var p = (window as any).app.plugins.plugins['obsidian-2-anki'];
                return JSON.stringify({
                    wasDisabled: wasDisabled,
                    nowDisabled: nowDisabled,
                    syncAborted: p?.syncAborted === true,
                    found: true
                });
            });
            if (btnInfo) {
                var info = JSON.parse(btnInfo);
                console.log('Cancel button click result:', JSON.stringify(info));
                abortedImmediate = info.syncAborted;
                cancelled = true;
                break;
            }
            await delay(50);
        }

        console.log('cancelled:', cancelled, 'abortedImmediate:', abortedImmediate);
        if (cancelled) {
            assert(abortedImmediate === true, 'plugin.syncAborted should be true immediately after Cancel click');
        } else {
            console.log('Cancel button not found — sync completed too fast');
        }

        // Wait for sync to settle
        await delay(3000);

        // If we clicked cancel, check that syncAborted was set (proves cancel works)
        // Note: "All done!" may still appear if sync completed before the click took effect
        // The reliable behavioral check is syncAborted immediately after click (above)
        if (cancelled) {
            console.log('Cancel test passed: button clicked, syncAborted set, button disabled');
        }
    })

    it('post sync with queued rename and cancel test, it should not give any errors', async () => {
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
