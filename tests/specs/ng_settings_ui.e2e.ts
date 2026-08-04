import { browser } from '@wdio/globals';

const fse = require('fs-extra');
const path = require('path');
const assert = require('assert');

const test_name = (path.basename(__filename) as string).split('.')[0] 
const test_name_fmt = test_name.split('_').reduce((acc,s) => { return acc + ' ' + s.charAt(0).toUpperCase() + s.slice(1)}) + " Test"

function delay(ms: number) {
    return new Promise( resolve => setTimeout(resolve, ms) );
}

// Poll `fn` until it returns a truthy value or `timeout` ms elapses.
async function pollAsync<T>(fn: () => Promise<T>, timeout: number, interval = 250): Promise<T> {
    const end = Date.now() + timeout;
    let last: T;
    while (Date.now() < end) {
        last = await fn();
        if (last) return last;
        await delay(interval);
    }
    return last as T;
}

// Open Obsidian settings and navigate to the plugin's settings tab.
// Diagnostics: `app.setting.open()` alone does not open the settings modal in the
// pinned Obsidian 1.5.3 test image, and the `app:open-settings` command only works
// once the app has finished initializing after the vault reload (it silently
// no-ops when the command registry isn't ready yet, which the full-suite tail run
// exposed). So we wait for the command to be registered, then open the modal, with
// `app.setting.open()` and a gear-button click as fallbacks. `openTabById` (or a
// nav-item click) then selects the plugin tab, which is what actually renders the
// TabContainer's `.anki-tab-button` elements.
async function openPluginSettings(): Promise<void> {
    const modalOpen = () => browser.execute(() => !!document.querySelector('.modal.mod-settings'));

    // Strategy 1: built-in 'app:open-settings' command, once it is registered.
    let opened = await modalOpen();
    if (!opened) {
        const cmdReady = await pollAsync(() => browser.execute(() => {
            const app = (window as any).app;
            return !!(app?.commands?.commands && app.commands.commands['app:open-settings']);
        }), 10000);
        if (cmdReady) {
            await browser.execute(() => {
                const app = (window as any).app;
                app.commands.executeCommandById('app:open-settings');
            });
        } else {
            await browser.execute(() => {
                const app = (window as any).app;
                if (app.setting && typeof app.setting.open === 'function') app.setting.open();
            });
        }
        opened = await pollAsync(modalOpen, 12000);
        console.log('[openPluginSettings] command route opened modal:', opened);
    }

    // Strategy 2: internal app.setting.open()
    if (!opened) {
        await browser.execute(() => {
            const app = (window as any).app;
            if (app.setting && typeof app.setting.open === 'function') app.setting.open();
        });
        opened = await pollAsync(modalOpen, 8000);
        console.log('[openPluginSettings] app.setting.open() opened modal:', opened);
    }

    // Strategy 3: click the settings gear in the sidebar
    if (!opened) {
        await browser.execute(() => {
            const gear = document.querySelector('button[aria-label="Settings"]') as HTMLElement;
            if (gear) gear.click();
        });
        opened = await pollAsync(modalOpen, 8000);
        console.log('[openPluginSettings] gear click opened modal:', opened);
    }

    if (!opened) {
        const diag = await browser.execute(() => {
            const app = (window as any).app;
            const modals = Array.from(document.querySelectorAll('.modal')).map(m => (m as HTMLElement).className);
            const navItems = Array.from(document.querySelectorAll('.vertical-tab-nav-item')).map(n => n.textContent);
            return JSON.stringify({
                modals,
                navItems,
                settingPresent: !!app?.setting,
                settingKeys: app?.setting ? Object.keys(app.setting) : null,
                hasTrust: [...document.querySelectorAll('button')].some(b => (b.textContent || '').includes('Trust')),
                bodyLen: document.body.innerHTML.length
            });
        });
        assert.fail('Settings modal could not be opened by any strategy. DIAG=' + diag);
    }

    // Navigate to the plugin's settings tab; this renders the TabContainer buttons.
    await browser.execute(() => {
        const app = (window as any).app;
        if (app.setting && typeof app.setting.openTabById === 'function') {
            app.setting.openTabById('obsidian-2-anki');
        } else {
            const nav = Array.from(document.querySelectorAll('.vertical-tab-nav-item'))
                .find(n => n.textContent?.includes('Obsidian 2 Anki')) as HTMLElement;
            if (nav) nav.click();
        }
    });
    await delay(800);
}

// Read the current state of the plugin's settings tabs from the DOM.
async function tabState(): Promise<any> {
    const raw = await browser.execute(() => {
        const buttons = Array.from(document.querySelectorAll('.anki-tab-button')) as HTMLElement[];
        const contents = Array.from(document.querySelectorAll('.anki-tab-content')) as HTMLElement[];
        const visible = contents.filter(c => getComputedStyle(c).display !== 'none');
        const active = document.querySelector('.anki-tab-button.anki-tab-active');
        return JSON.stringify({
            names: buttons.map(b => b.textContent || ''),
            activeBtn: active ? (active as HTMLElement).textContent : '',
            visibleCount: visible.length,
            visibleText: visible.length ? (visible[0].textContent || '') : '',
            hasTable: visible.length ? !!visible[0].querySelector('.anki-settings-table') : false,
            hasSearch: visible.length ? !!visible[0].querySelector('.anki-search-input') : false,
            hasFolderPicker: visible.length ? !!visible[0].querySelector('.anki-folder-picker-container') : false,
            hasExportButton: visible.length ? (visible[0].textContent || '').includes('Export') : false,
            hasImportButton: visible.length ? (visible[0].textContent || '').includes('Import') : false
        });
    });
    return JSON.parse(raw as string);
}

// Click a settings tab button by its heading text.
async function clickTab(name: string): Promise<void> {
    const btn = await $(`button.anki-tab-button*=${name}`);
    await btn.waitForDisplayed({ timeout: 5000 });
    await btn.click();
    await delay(300);
}

describe(test_name_fmt, () => {
    it('should load the vault and plugin', async () => {
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
        await browser.reloadSession();
        await browser.execute( () => { var btn = [...document.querySelectorAll('button')].find(btn => btn.textContent.includes('Trust')); if(btn) btn.click(); } );
        
        await delay(3000);
        await browser.execute( () => { return dispatchEvent(new KeyboardEvent('keydown', {'key': 'Escape'})); } );
        await browser.execute( () => { return dispatchEvent(new KeyboardEvent('keydown', {'key': 'r', ctrlKey: true, shiftKey: true})); } );
        await delay(5000);
    })

    it('should render all five settings tabs in the correct order', async () => {
        await openPluginSettings();

        const state = await tabState();
        assert.deepStrictEqual(state.names, ['General', 'Note Types', 'Folders', 'Syntax', 'Advanced']);
    })

    it('should show General as the default active tab', async () => {
        const state = await tabState();
        assert.strictEqual(state.activeBtn, 'General');
        assert.strictEqual(state.visibleCount, 1, 'exactly one tab content should be visible');
        assert.strictEqual(state.hasFolderPicker, true, 'General tab should render the Scan Directory folder picker');
        assert.ok(state.visibleText.includes('Scan Directory'), 'General tab should show the Scan Directory setting');
    })

    it('should switch to the Note Types tab and render the searchable table', async () => {
        await clickTab('Note Types');

        const state = await tabState();
        assert.strictEqual(state.activeBtn, 'Note Types');
        assert.strictEqual(state.visibleCount, 1, 'exactly one tab content should be visible');
        assert.strictEqual(state.hasTable, true, 'Note Types tab should render .anki-settings-table');
        assert.strictEqual(state.hasSearch, true, 'Note Types tab should render the search input');
        assert.ok(state.visibleText.includes('Note Type Configuration'), 'Note Types tab should show its heading');

        // Behaviorally exercise SearchableTable so an empty/dead table or a dead search
        // input cannot pass. Drive the real 'input' event that filterRows() binds to
        // (SearchableTable.ts:23), scoped to the visible tab only.
        const searchResult = await browser.execute(() => {
            const contents = Array.from(document.querySelectorAll('.anki-tab-content')) as HTMLElement[];
            const visible = contents.find(c => getComputedStyle(c).display !== 'none');
            if (!visible) return JSON.stringify({ error: 'no-visible-tab' });
            const input = visible.querySelector('.anki-search-input') as HTMLInputElement;
            const table = visible.querySelector('.anki-settings-table');
            if (!input || !table) return JSON.stringify({ error: 'no-search-or-table' });
            const rows = Array.from(table.querySelectorAll('tbody tr')) as HTMLElement[];
            const visibleCount = () => rows.filter(r => r.style.display !== 'none').length;
            const firstTerm = (rows[0]?.textContent || '').trim();
            const totalRows = rows.length;
            const baseline = visibleCount();

            input.value = 'zz-xyzzy-no-match-774';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            const noMatch = visibleCount();

            const matchTerm = firstTerm.split(/\s+/)[0];
            input.value = matchTerm;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            const matchCount = visibleCount();

            input.value = '';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            const restored = visibleCount();

            return JSON.stringify({ error: '', baseline, noMatch, matchCount, restored, firstTerm, totalRows });
        });
        const st = JSON.parse(searchResult as string);
        assert(!st.error, 'Note Types tab should expose a searchable table: ' + st.error);
        assert(st.totalRows >= 1, 'Note Types table should render at least one tbody row');
        assert(st.baseline === st.totalRows, 'all rows should be visible before filtering');
        assert(st.noMatch === 0, 'a non-existent search term should hide every row (filterRows must be live)');
        assert(st.matchCount >= 1, `searching real term "${st.firstTerm}" should show at least one row`);
        assert(st.restored === st.baseline, 'clearing the search should restore all rows');
    })

    it('should switch to the Folders tab', async () => {
        await clickTab('Folders');

        const state = await tabState();
        assert.strictEqual(state.activeBtn, 'Folders');
        assert.strictEqual(state.visibleCount, 1, 'exactly one tab content should be visible');
        assert.strictEqual(state.hasTable, true, 'Folders tab should render .anki-settings-table');
        assert.ok(state.visibleText.includes('Folder Configuration'), 'Folders tab should show its heading');
    })

    it('should switch to the Syntax tab', async () => {
        await clickTab('Syntax');

        const state = await tabState();
        assert.strictEqual(state.activeBtn, 'Syntax');
        assert.strictEqual(state.visibleCount, 1, 'exactly one tab content should be visible');
        assert.ok(state.visibleText.includes('Syntax Settings'), 'Syntax tab should show its heading');
    })

    it('should switch to the Advanced tab with import/export buttons', async () => {
        await clickTab('Advanced');

        const state = await tabState();
        assert.strictEqual(state.activeBtn, 'Advanced');
        assert.strictEqual(state.visibleCount, 1, 'exactly one tab content should be visible');
        assert.strictEqual(state.hasExportButton, true, 'Advanced tab should show an Export button');
        assert.strictEqual(state.hasImportButton, true, 'Advanced tab should show an Import button');
        assert.ok(state.visibleText.includes('Import/Export Settings'), 'Advanced tab should show its heading');
    })

    it('should return to General tab after visiting others', async () => {
        await clickTab('General');

        const state = await tabState();
        assert.strictEqual(state.activeBtn, 'General');
        assert.strictEqual(state.visibleCount, 1, 'exactly one tab content should be visible');
        assert.strictEqual(state.hasFolderPicker, true, 'General tab should still render the folder picker');
    })

    it('post settings UI test, it should not give any errors', async () => {
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
