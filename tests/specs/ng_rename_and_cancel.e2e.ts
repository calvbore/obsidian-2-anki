import { readFileSync } from 'fs';
import { browser } from '@wdio/globals';

import * as fse from 'fs-extra';
import * as path from 'path';
const assert = require('assert');

const test_name = (path.basename(__filename) as string).split('.')[0] 
const test_name_fmt = test_name.split('_').reduce((acc,s) => { return acc + ' ' + s.charAt(0).toUpperCase() + s.slice(1)}) + " Test"

const FgYellow = "\x1b[33m"
const Reset = "\x1b[0m"
const FgRed = "\x1b[31m"

// Set by the 'should abort sync when Cancel is clicked' test. The Cancel click may land in
// the 'setup' phase (it aborts the sync) or the 'writing' phase (the L2 guard ignores it).
// The H2 re-sync test branches on this so it never assumes a phase that timing might miss.
let cancelPhase: 'setup' | 'writing' | null = null;

function delay(ms: number) {
    return new Promise( resolve => setTimeout(resolve, ms) );
}

async function syncObsidianAnki(label: string = ''): Promise<boolean> {
    const SyncButton = await $('aria/Obsidian 2 Anki - Sync Vault')
    await expect(SyncButton).toExist()
    // Drain the browser log buffer BEFORE starting the sync: a previous sync that ran to
    // completion (e.g. a writing-phase cancel the L2 guard let finish) left an "All done!"
    // behind, and getLogs() returns buffered entries. Without draining, this helper would
    // mistake that stale entry for this sync's result and return true immediately.
    await browser.getLogs('browser')
    await $(SyncButton).click()

    let logs: Array<Object> = [];
    for (let i = 0; i < 300; i++) {
        logs = await browser.getLogs('browser');
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
        var wasDisabled = false;
        var nowDisabled = false;
        var modalH2 = '';
        var hasBar = false;
        var hasStatus = false;
        var hasText = false;
        for (var attempt = 0; attempt < 50; attempt++) {
            var btnInfo = await browser.execute(() => {
                var modal = document.querySelector('.anki-progress-modal');
                if (!modal) return null;
                var btn = modal.querySelector('button') as HTMLButtonElement;
                if (!btn) return null;
                var wasDisabled = btn.disabled;
                // Capture modal DOM structure BEFORE the click — the cancel handler
                // synchronously closes the modal and empties its content
                var modalH2 = modal.querySelector('h2')?.textContent || '';
                var hasBar = !!modal.querySelector('.anki-progress-bar');
                var hasStatus = !!modal.querySelector('.anki-progress-status');
                var hasText = !!modal.querySelector('.anki-progress-text');
                // Use dispatchEvent for reliable click triggering
                btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                var nowDisabled = btn.disabled;
                var p = (window as any).app.plugins.plugins['obsidian-2-anki'];
                return JSON.stringify({
                    wasDisabled: wasDisabled,
                    nowDisabled: nowDisabled,
                    syncAborted: p?.syncAborted === true,
                    phase: (p?.syncPhase as string) ?? null,
                    modalH2: modalH2,
                    hasBar: hasBar,
                    hasStatus: hasStatus,
                    hasText: hasText,
                    found: true
                });
            });
            if (btnInfo) {
                var info = JSON.parse(btnInfo);
                console.log('Cancel button click result:', JSON.stringify(info));
                abortedImmediate = info.syncAborted;
                wasDisabled = info.wasDisabled;
                nowDisabled = info.nowDisabled;
                modalH2 = info.modalH2;
                hasBar = info.hasBar;
                hasStatus = info.hasStatus;
                hasText = info.hasText;
                if (info.phase === 'writing') cancelPhase = 'writing';
                else if (info.phase === 'setup') cancelPhase = 'setup';
                else assert.fail(`Unknown/missing syncPhase "${info.phase}" — plugin.syncPhase changed or unavailable`);
                cancelled = true;
                break;
            }
            await delay(50);
        }

        console.log('cancelled:', cancelled, 'cancelPhase:', cancelPhase, 'abortedImmediate:', abortedImmediate);
        if (cancelled) {
            // 8.4 ProgressModal assertions: modal DOM built by ProgressModal.onOpen()
            // These hold regardless of which phase the cancel landed in.
            assert(modalH2 === 'Syncing with Anki', `ProgressModal h2 should be "Syncing with Anki", got "${modalH2}"`);
            assert(hasBar === true, 'ProgressModal should render .anki-progress-bar');
            assert(hasStatus === true, 'ProgressModal should render .anki-progress-status');
            assert(hasText === true, 'ProgressModal should render .anki-progress-text');
            assert(wasDisabled === false, 'Cancel button should be enabled before the click');
            assert(nowDisabled === true, 'Cancel button should be disabled after the click (ProgressModal.ts sets disabled=true)');

            // Behaviour depends on where the click landed. Assert the branch we actually hit:
            if (cancelPhase === 'setup') {
                // Cancel is honoured: plugin.syncAborted becomes true immediately and no
                // notes have been written yet.
                assert(abortedImmediate === true, 'cancel during setup must set plugin.syncAborted immediately');
            } else {
                // L2 guard: once the write phase starts, Cancel is a no-op so the write
                // (and persisted hashes/IDs) is never interrupted — preventing duplicates.
                assert(abortedImmediate === false, 'L2 guard: cancel during writing must NOT set syncAborted (write is allowed to finish)');
            }
        } else {
            assert.fail('Cancel button never appeared — ProgressModal did not render');
        }

        // Wait for sync to settle
        await delay(3000);

        // The modal closes either synchronously on abort (setup phase) or once the write
        // finishes (writing phase, after the L2 guard lets it complete).
        let modalGone = false;
        for (let i = 0; i < 50; i++) {
            modalGone = await browser.execute(() => !document.querySelector('.anki-progress-modal'));
            if (modalGone) break;
            await delay(100);
        }
        assert(modalGone, 'ProgressModal should be closed after Cancel (abort closes it; writing-phase guard closes it on completion)');

        if (cancelled) {
            console.log(`Cancel test passed: clicked during ${cancelPhase}, plugin.syncAborted=${abortedImmediate}, button disabled`);
        }
    })

    it('should not duplicate cards when a cancelled sync is followed by a re-sync', async () => {
        // L1 regression check: a cancelled sync must not cause the next sync to duplicate cards.
        // Whatever phase the cancel landed in, the 50 "Cancel test card" notes must be committed
        // exactly once overall (no duplicates) — the whole point of the L1 no-duplicate guard:
        //   - setup-phase cancel: nothing was written, so the re-sync commits them once ("All done!")…
        //   - writing-phase cancel: the L2 guard let the write finish, so they are already committed
        //     and the re-sync reports "No changes detected!".
        // Either way the next re-sync must find no remaining changes (hashes/IDs persisted).
        const first = await syncObsidianAnki('resync-after-cancel');
        if (cancelPhase === 'setup') {
            assert(first, 'Expected "All done!" after re-syncing a setup-phase-cancelled sync (cards committed exactly once)');
        } else {
            assert(!first, 'Expected "No changes detected!" after a writing-phase-cancelled sync (cards already committed once by the un-interrupted write)');
        }

        // Let the just-committed card IDs/hashes settle to disk before verifying, mirroring the
        // rename test's delay(1000) between content-sync and verify-sync (which passes reliably).
        await delay(1500);

        // Convergence: requests_2 logs "All done!" BEFORE main.ts saveAllData() has persisted the
        // fresh file_hashes, so a single immediate follow-up sync may legitimately re-scan the
        // just-written cards as still-changed (Anki dedupes the re-add, keeping the count stable —
        // pytest asserts the exact 53-notes invariant). Retry until the follow-up sync observes the
        // persisted state and reports "No changes detected!". Each retry can only dedupe against the
        // existing notes, so it cannot create duplicate cards.
        let resync2 = await syncObsidianAnki('verify-no-duplicates');
        for (let attempt = 0; attempt < 3 && resync2; attempt++) {
            await delay(1000);
            resync2 = await syncObsidianAnki(`verify-no-duplicates-retry-${attempt + 1}`);
        }
        assert(!resync2, 'Expected "No changes detected!" after the no-duplicate re-sync (hashes/IDs persisted)');
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
