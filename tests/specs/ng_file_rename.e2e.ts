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

    // Wait for sync to complete by checking browser logs
    // Returns true if "All done!" (changes detected), false if "No changes detected!" (no changes)
    let logs: Array<Object> = [];
    for (let i = 0; i < 300; i++) { // 30 second timeout
        logs = await browser.getLogs('browser');
        // Print all trace logs
        for (const log of logs) {
            const msg = log['message'] as string;
            if (msg.includes('[TRACE]')) console.log(`[${label || 'sync'}] TRACE:`, msg);
            if (msg.includes('couldn\'t connect')) console.log(`[${label || 'sync'}] ANKI_ERROR:`, msg);
        }
        const errorLog = logs.find(e => (e['message'] as string).includes('Error during sync'));
        if (errorLog) console.log(`[${label || 'sync'}] ERROR:`, errorLog['message']);
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
        await browser.reloadSession(); // Fresh session for restarted Obsidian
        await browser.execute( () => { var btn = [...document.querySelectorAll('button')].find(btn => btn.textContent.includes('Trust')); if(btn) btn.click(); } );
        
        await delay(3000);
        await browser.execute( () => { return dispatchEvent(new KeyboardEvent('keydown', {'key': 'Escape'})); } );
        // Reload Obsidian to pick up newly-built plugin
        await browser.execute( () => { return dispatchEvent(new KeyboardEvent('keydown', {'key': 'r', ctrlKey: true, shiftKey: true})); } );
        await delay(5000);
        // File click is unnecessary — sync scans all vault files.

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

    it('should migrate file_hashes on file rename', async () => {
        // Rename file2.md to renamed_file2.md
        await browser.execute( async () => { 
            var app = (window as any).app;
            var file = app.vault.getAbstractFileByPath('ng_file_rename/file2.md');
            if (file) {
                await app.fileManager.renameFile(file, 'ng_file_rename/renamed_file2.md');
            }
        });

        await delay(2000);

        // Verify the plugin's rename handler migrated file_hashes
        await delay(1000);
        const hashState = await browser.execute(() => {
            var p = (window as any).app.plugins.plugins['obsidian-2-anki'];
            if (!p?.file_hashes) return 'no-plugin';
            return JSON.stringify({
                oldExists: 'ng_file_rename/file2.md' in p.file_hashes,
                newExists: 'ng_file_rename/renamed_file2.md' in p.file_hashes
            });
        });
        var h = JSON.parse(hashState as string);
        assert(!h.oldExists, 'Old file_hashes key should be removed by plugin');
        assert(h.newExists, 'New file_hashes key should be created by plugin');

        // Re-sync - should show "No changes detected!" because file_hashes were migrated
        const hasChanges = await syncObsidianAnki('second-sync');
        assert(!hasChanges, 'Expected "No changes detected!" after file rename - file_hashes should have been migrated');
    })

    it('post file rename sync, it should not give any errors', async () => {
        await delay(1000);
        await browser.closeWindow();
        
        await delay(3000); // esp for PostTest ss of Anki and wait for obsidian teardown
        
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
        await delay(5000); // >3000ms req; the last test of this spec, wait for anki and obsidian to close properly
    })
})