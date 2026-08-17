
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

function delay(ms: number) {
    return new Promise( resolve => setTimeout(resolve, ms) );
}

const suite_dir = `tests/test_vault/${test_name}`
const io_file = `${suite_dir}/${test_name}.excalidraw.md`

function rewriteIoFile(replacements: Array<[string, string]>) {
    let content = fse.readFileSync(io_file, 'utf-8');
    for (const [from, to] of replacements) {
        assert(content.includes(from), `expected to find "${from}" in io file`);
        content = content.replace(from, to);
    }
    fse.writeFileSync(io_file, content);
    console.log('Rewrote io file with', replacements.length, 'replacement(s)');
}

function countIds(content: string): number {
    return (content.match(/<!--ID: \d+-->/g) || []).length;
}

async function syncAndGetMessage(): Promise<string> {
    const SyncButton = await $('aria/Obsidian 2 Anki - Sync Vault')
    await expect(SyncButton).toExist()
    await $(SyncButton).click()

    let logs: Array<Object> = [];
    do
    {
        logs = logs.concat( await browser.getLogs('browser'));
        console.log(logs);
        await delay(100);
    }
    while (!logs.find( e => (e['message'] as string).includes('All done!') || (e['message'] as string).includes('No changes detected!') ));

    let warningsLogs = logs.filter( e => { return e['level'] == 'WARNING' });
    let errorLogs = logs.filter( e => { return e['level'] == 'ERROR' || e['level'] == 'SEVERE' });

    if (warningsLogs.length > 0 )
    {
        console.warn(`${FgYellow}Warnings: `)
        console.warn(warningsLogs);
        console.warn(Reset)
    }
    if (errorLogs.length > 0 )
    {
        console.error(`${FgRed}Errors: `);
        console.error(errorLogs);
        console.error(Reset)
    }

    const last = logs.filter( e => (e['message'] as string).includes('All done!') || (e['message'] as string).includes('No changes detected!') );
    const msg = last[last.length - 1]['message'] as string;
    console.log('Sync message:', msg);
    return msg;
}

describe(test_name_fmt, () => {

    it('first sync should add Image Occlusion cards from the drawing', async () => {
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
        await browser.execute( () => { var btn = [...document.querySelectorAll('button')].find(btn => btn.textContent.includes('Trust')); if(btn) btn.click(); } );

        await delay(5000);
        await browser.execute( () => { return dispatchEvent(new KeyboardEvent('keydown', {'key': 'Escape'})); } );

        let folder = await $(`.nav-folder-title*=${test_name}`)
        await expect(folder).toExist();
        await folder.click(); // Should drop down files

        let file = await $('.nav-file-title*=.excalidraw')
        await expect(file).toExist();
        await file.click(); // Should open file in Editor

        await delay(100);

        await browser.saveScreenshot(`logs/${test_name}/Obsidian PreTest.png`)

        const msg = await syncAndGetMessage();
        assert(msg.includes('All done!'), `expected first sync to complete, got: ${msg}`);

        await browser.saveScreenshot(`logs/${test_name}/Obsidian PostTest1.png`)

        // Let Obsidian's disk write of the IDs settle before reading back
        await delay(2000);

        // Both frames should now have IDs written into the note
        const post1 = fse.readFileSync(io_file, 'utf-8');
        assert(countIds(post1) === 2, `expected 2 IDs after first sync, got ${countIds(post1)}`);
        assert(post1.includes('Header: Original header'));
        await delay(1000);
    })

    it('second sync should report no changes (no duplicates)', async () => {
        const msg = await syncAndGetMessage();
        assert(msg.includes('No changes detected!'), `expected no changes, got: ${msg}`);
        const content = fse.readFileSync(io_file, 'utf-8');
        assert(countIds(content) === 2, `expected 2 IDs still, got ${countIds(content)}`);
        await delay(1000);
    })

    it('text edit should update the note in place', async () => {
        rewriteIoFile([['Header: Original header', 'Header: Edited header']]);
        // Give Obsidian's file watcher time to pick up the external change
        await delay(3000);

        const msg = await syncAndGetMessage();
        assert(msg.includes('All done!'), `expected in-place update sync, got: ${msg}`);

        const content = fse.readFileSync(io_file, 'utf-8');
        // Same two cards, IDs unchanged
        assert(countIds(content) === 2, `expected 2 IDs after update, got ${countIds(content)}`);
        await delay(1000);
    })

    it('FROZEN line should prevent updates', async () => {
        rewriteIoFile([
            ['Header: Edited header', 'Header: Frozen header'],
            ['Comments: Original comment\n', 'Comments: Original comment\nFROZEN\n'],
        ]);
        await delay(3000);

        const msg = await syncAndGetMessage();
        assert(msg.includes('All done!'), `expected sync while frozen, got: ${msg}`);

        const content = fse.readFileSync(io_file, 'utf-8');
        assert(content.includes('FROZEN'));
        assert(countIds(content) === 2, `expected 2 IDs after frozen sync, got ${countIds(content)}`);
        await delay(1000);
    })

    it('adding a new image-less frame later should create its note', async () => {
        // Reproduces the sandbox report: an already-synced drawing gains a NEW
        // frame containing only a freehand (pencil/pen) stroke + an ellipse
        // mask — no embedded image. The new frame must still get its own note.
        let content = fse.readFileSync(io_file, 'utf-8');
        assert(!content.includes('## Frame 3 Notes'), 'fixture must start without frame 3');
        const frame3Elements =
            '{"id":"frame3","type":"frame","name":"Image Occlusion","x":0,"y":700,"width":300,"height":200,"angle":0},' +
            '{"id":"scribble3","type":"freedraw","x":10,"y":710,"width":150,"height":80,"angle":0,"frameId":"frame3","points":[[0,0],[40,12],[90,40],[150,80]],"strokeColor":"#e03131","strokeWidth":2},' +
            '{"id":"mask3b","type":"ellipse","x":100,"y":720,"width":80,"height":60,"angle":0,"frameId":"frame3","backgroundColor":"#ff0000"}';
        rewriteIoFile([
            ['],"files":{}}', ',' + frame3Elements + '],"files":{}}'],
            ['frame2: [[#Frame 2 Notes]]', 'frame2: [[#Frame 2 Notes]]\nframe3: [[#Frame 3 Notes]]'],
        ]);
        fse.appendFileSync(io_file, '\n## Frame 3 Notes\n\nTags: later-tag\nHeader: Added frame header\nBack Extra: Added frame back extra\nComments: Added frame comment\n');
        await delay(3000);

        const msg = await syncAndGetMessage();
        assert(msg.includes('All done!'), `expected the new frame to sync, got: ${msg}`);

        content = fse.readFileSync(io_file, 'utf-8');
        assert(countIds(content) === 3, `expected 3 IDs after adding frame 3, got ${countIds(content)}`);
        assert(content.includes('Header: Added frame header'));
        assert(content.includes('## Frame 3 Notes'));
        await delay(1000);
    })

    it('DELETE line should remove the frame note and strip its section', async () => {
        rewriteIoFile([['Comments: Frame two comment\n', 'Comments: Frame two comment\n\nDELETE\n']]);
        await delay(3000);

        const msg = await syncAndGetMessage();
        assert(msg.includes('All done!'), `expected delete sync, got: ${msg}`);

        const content = fse.readFileSync(io_file, 'utf-8');
        assert(countIds(content) === 2, `expected 2 IDs after delete, got ${countIds(content)}`);
        assert(!content.includes('## Frame 2 Notes'), 'frame 2 section should be stripped after delete');
        assert(content.includes('## Frame 1 Notes'));
        assert(content.includes('## Frame 3 Notes'));
        await delay(1000);

        await browser.saveScreenshot(`logs/${test_name}/Obsidian PostTest_Final.png`)
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
