import { Notice, Plugin, addIcon, TFile, TFolder, Menu, TAbstractFile } from 'obsidian'
import * as AnkiConnect from './src/anki'
import { PluginSettings, ParsedSettings } from './src/interfaces/settings-interface'
import { DEFAULT_IGNORED_FILE_GLOBS, SettingsTab } from './src/settings'
import { ANKI_ICON } from './src/constants'
import { settingToData } from './src/setting-to-data'
import { FileManager, fileHasIOMarker } from './src/files-manager'
import { ProgressModal } from './src/ui/ProgressModal'
import { IOFrameRecord } from './src/io'
import { setIOMarker, clearIOMarker } from './src/excalidraw'

export default class MyPlugin extends Plugin {

	settings: PluginSettings
	note_types: Array<string>
	fields_dict: Record<string, string[]>
	added_media: string[]
	file_hashes: Record<string, string>
	io_frame_records: Record<string, IOFrameRecord>
	statusBarItem: HTMLElement
	isSyncing: boolean = false
	syncAborted: boolean = false
	syncPhase: 'setup' | 'writing' = 'setup'
	settingsTab: SettingsTab | undefined
	renameQueue: Array<{ oldPath: string; newPath: string; isFolder: boolean }> = []

	async getDefaultSettings(): Promise<PluginSettings> {
		let settings: PluginSettings = {
			CUSTOM_REGEXPS: {},
			FILE_LINK_FIELDS: {},
			CONTEXT_FIELDS: {},
			FOLDER_DECKS: {},
			FOLDER_TAGS: {},
			Syntax: {
				"Begin Note": "START",
				"End Note": "END",
				"Begin Inline Note": "STARTI",
				"End Inline Note": "ENDI",
				"Target Deck Line": "TARGET DECK",
				"File Tags Line": "FILE TAGS",
				"Delete Note Line": "DELETE",
				"Frozen Fields Line": "FROZEN",
				"Hide All Line": "Hide all"
			},
			Defaults: {
				"Scan Directory": "",
				"Tag": "Obsidian_to_Anki",
				"Deck": "Default",
				"Scheduling Interval": 0,
				"Add File Link": false,
				"Add Context": false,
				"CurlyCloze": false,
				"CurlyCloze - Highlights to Clozes": false,
				"ID Comments": true,
				"Add Obsidian Tags": false,
			},
			IGNORED_FILE_GLOBS: DEFAULT_IGNORED_FILE_GLOBS,
		}
		/*Making settings from scratch, so need note types*/
		this.note_types = await AnkiConnect.invoke('modelNames') as Array<string>
		this.fields_dict = await this.generateFieldsDict()
		for (let note_type of this.note_types) {
			settings["CUSTOM_REGEXPS"][note_type] = ""
			const field_names: string[] = await AnkiConnect.invoke(
				'modelFieldNames', {modelName: note_type}
			) as string[]
			this.fields_dict[note_type] = field_names
			settings["FILE_LINK_FIELDS"][note_type] = field_names[0]
		}
		return settings
	}

	async generateFieldsDict(): Promise<Record<string, string[]>> {
		let fields_dict = {}
		for (let note_type of this.note_types) {
			const field_names: string[] = await AnkiConnect.invoke(
				'modelFieldNames', {modelName: note_type}
			) as string[]
			fields_dict[note_type] = field_names
		}
		return fields_dict
	}

	async saveDefault(): Promise<void> {
		const default_sets = await this.getDefaultSettings()
		this.saveData(
			{
				settings: default_sets,
				"Added Media": [],
				"File Hashes": {},
				fields_dict: {},
				"IO Frame Records": {}
			}
		)
	}

	async loadSettings(): Promise<PluginSettings> {
		let current_data = await this.loadData()
		if (current_data == null || !(current_data.hasOwnProperty("settings")) || !(current_data.hasOwnProperty("Added Media"))) {
			new Notice("Need to connect to Anki generate default settings...")
			const default_sets = await this.getDefaultSettings()
			this.saveData(
				{
					settings: default_sets,
					"Added Media": [],
					"File Hashes": {},
					fields_dict: {},
					"IO Frame Records": {}
				}
			)
			new Notice("Default settings successfully generated!")
			return default_sets
		} else {
			return current_data.settings
		}
	}

	async loadAddedMedia(): Promise<string[]> {
		let current_data = await this.loadData()
		if (current_data == null) {
			await this.saveDefault()
			return []
		} else {
			return current_data["Added Media"]
		}
	}

	async loadFileHashes(): Promise<Record<string, string>> {
		let current_data = await this.loadData()
		if (current_data == null) {
			await this.saveDefault()
			return {}
		} else {
			return current_data["File Hashes"]
		}
	}

	async loadFieldsDict(): Promise<Record<string, string[]>> {
		let current_data = await this.loadData()
		if (current_data == null) {
			await this.saveDefault()
			const fields_dict = await this.generateFieldsDict()
			return fields_dict
		}
		return current_data.fields_dict
	}

	async loadIOFrameRecords(): Promise<Record<string, IOFrameRecord>> {
		let current_data = await this.loadData()
		if (current_data == null || current_data["IO Frame Records"] == null) {
			return {}
		} else {
			return current_data["IO Frame Records"]
		}
	}

	async saveAllData(): Promise<void> {
		await this.saveData(
			{
				settings: this.settings,
				"Added Media": this.added_media,
				"File Hashes": this.file_hashes,
				fields_dict: this.fields_dict,
				"IO Frame Records": this.io_frame_records
			}
		)
	}

	regenerateSettingsRegexps() {
		let regexp_section = this.settings["CUSTOM_REGEXPS"]
		// For new note types
		for (let note_type of this.note_types) {
			this.settings["CUSTOM_REGEXPS"][note_type] = regexp_section.hasOwnProperty(note_type) ? regexp_section[note_type] : ""
		}
		// Removing old note types
		for (let note_type of Object.keys(this.settings["CUSTOM_REGEXPS"])) {
			if (!this.note_types.includes(note_type)) {
				delete this.settings["CUSTOM_REGEXPS"][note_type]
			}
		}
	}

	/**
	 * Recursively traverse a TFolder and return all TFiles.
	 * @param tfolder - The TFolder to start the traversal from.
	 * @returns An array of TFiles found within the folder and its subfolders.
	 */
	getAllTFilesInFolder(tfolder) {
		const allTFiles = [];
		// Check if the provided object is a TFolder
		if (!(tfolder instanceof TFolder)) {
			return allTFiles;
		}
		// Iterate through the contents of the folder
		tfolder.children.forEach((child) => {
			// If it's a TFile, add it to the result
			if (child instanceof TFile) {
				allTFiles.push(child);
			} else if (child instanceof TFolder) {
				// If it's a TFolder, recursively call the function on it
				const filesInSubfolder = this.getAllTFilesInFolder(child);
				allTFiles.push(...filesInSubfolder);
			}
			// Ignore other types of files or objects
		});
		return allTFiles;
	}

	async scanVault() {
		await this.syncFiles(null, "vault")
	}

	async syncCurrentFile() {
		const activeFile = this.app.workspace.getActiveFile()
		if (!activeFile) {
			new Notice("No active file")
			return
		}
		if (activeFile.extension !== 'md') {
			new Notice("Active file is not a markdown file")
			return
		}
		await this.syncFiles([activeFile], "current file")
	}

	async syncCurrentFolder() {
		const activeFile = this.app.workspace.getActiveFile()
		if (!activeFile) {
			new Notice("No active file to determine folder")
			return
		}
		const folder = activeFile.parent
		if (!folder) {
			new Notice("Could not determine current folder")
			return
		}
		const filesInFolder = this.getAllTFilesInFolder(folder)
		await this.syncFiles(filesInFolder, `folder: ${folder.path}`)
	}

	async syncFiles(files: TFile[] | null, scope: string) {
		if (this.isSyncing) {
			new Notice("Sync already in progress...")
			return
		}

		this.isSyncing = true
		this.syncAborted = false
		this.updateStatusBar("syncing")

		const progressModal = new ProgressModal(this.app, () => {
			// Once the AnkiConnect write phase starts it cannot be interrupted.
			// Ignore Cancel so the hashes/IDs written past this point always persist,
			// otherwise the next sync would re-add the same notes as duplicates.
			if (this.syncPhase === 'writing') {
				new Notice("Sync is already writing to Anki and can't be cancelled. It will finish shortly.")
				return
			}
			this.syncAborted = true
			progressModal.close()
			this.updateStatusBar("idle")
		})
		progressModal.open()

		try {
			progressModal.setStatus("Checking connection to Anki...")
			console.info("Checking connection to Anki...")

			try {
				await AnkiConnect.invoke('modelNames')
			} catch(e) {
				new Notice("Error: couldn't connect to Anki! Make sure Anki is running.")
				console.error(e)
				progressModal.close()
				this.isSyncing = false
				this.updateStatusBar("error")
				return
			}

			progressModal.setStatus("Connected to Anki! Preparing files...")
			if (this.syncAborted) { return }

			const data: ParsedSettings = await settingToData(this.app, this.settings, this.fields_dict, this.io_frame_records)
			if (this.syncAborted) { return }

			let filesToSync: TFile[]
			if (files === null) {
				// Scan vault or custom directory
				const scanDir = this.app.vault.getAbstractFileByPath(this.settings.Defaults["Scan Directory"])
				if (scanDir !== null) {
					if (scanDir instanceof TFolder) {
						console.info("Using custom scan directory: " + scanDir.path)
						filesToSync = this.getAllTFilesInFolder(scanDir)
					} else {
						new Notice("Error: incorrect path for scan directory")
						progressModal.close()
						this.isSyncing = false
						this.updateStatusBar("error")
						return
					}
				} else {
					filesToSync = this.app.vault.getMarkdownFiles()
				}
			} else {
				filesToSync = files
			}

			progressModal.setStatus(`Syncing ${scope}...`)
			progressModal.setProgress(0, 1, `Found ${filesToSync.length} file(s)`)

			const manager = new FileManager(this.app, data, filesToSync, this.file_hashes, this.added_media)

			progressModal.setStatus("Scanning files for changes...")
			await manager.initialiseFiles()
			if (this.syncAborted) { return }

			let skippedIO: string[] = []
			for (let file of manager.ownFiles) {
				if (file.io_skip_reasons && file.io_skip_reasons.length > 0) {
					skippedIO.push(...file.io_skip_reasons)
				}
			}

			const changedFilesCount = manager.ownFiles.length
			if (changedFilesCount === 0) {
				new Notice("No changes detected!")
				console.info("No changes detected!")
				progressModal.close()
				this.isSyncing = false
				this.updateStatusBar("idle")
				return
			}

			progressModal.setProgress(1, 2, `Processing ${changedFilesCount} changed file(s)...`)

			this.syncPhase = 'writing'
			await manager.requests_1()

			this.added_media = Array.from(manager.added_media_set)
			const hashes = manager.getHashes()
			for (let key in hashes) {
				this.file_hashes[key] = hashes[key]
			}

			progressModal.setProgress(2, 2, "Saving changes...")
			await this.saveAllData()
			if (this.syncAborted) { return }

			if (!this.syncAborted) {
				progressModal.close()
				new Notice(`Successfully synced ${changedFilesCount} file(s) to Anki!`)
				this.updateStatusBar("success")

				if (skippedIO.length > 0) {
					new Notice(`${skippedIO.length} Image Occlusion frame(s) skipped. Check the console for the reason.`)
					console.warn("Image Occlusion frames skipped:", skippedIO)
				}

				// Reset to idle after 3 seconds
				setTimeout(() => {
					this.updateStatusBar("idle")
				}, 3000)
			}

		} catch(e) {
			console.error("Error during sync:", e)
			new Notice("Error during sync. Check console for details.")
			progressModal.close()
			this.updateStatusBar("error")
		} finally {
			this.isSyncing = false
			this.syncAborted = false
			this.syncPhase = 'setup'

			// Process any queued rename migrations
			while (this.renameQueue.length > 0) {
				const item = this.renameQueue.shift()!
				await this.applyMigration(item.oldPath, item.newPath, item.isFolder)
			}
		}
	}

	private async applyMigration(oldPath: string, newPath: string, isFolder: boolean): Promise<void> {
		console.log(`[applyMigration] ${oldPath} -> ${newPath} (folder: ${isFolder})`)
		const migrateRecord = (rec: Record<string, string>) => {
			if (!rec) return
			for (const key of Object.keys(rec)) {
				if (key === oldPath || key.startsWith(oldPath + '/')) {
					const suffix = key.slice(oldPath.length)
					rec[newPath + suffix] = rec[key]
					delete rec[key]
				}
			}
		}
		const oldPrefix = oldPath + '/'

		if (isFolder) {
			migrateRecord(this.settings.FOLDER_DECKS)
			migrateRecord(this.settings.FOLDER_TAGS)

			// Auto-update Scan Directory if it points into the renamed folder
			const scanDir = this.settings.Defaults["Scan Directory"]
			if (scanDir && (scanDir === oldPath || scanDir.startsWith(oldPrefix))) {
				this.settings.Defaults["Scan Directory"] = newPath + scanDir.slice(oldPath.length)
			}

			// Migrate file_hashes for all files inside the renamed folder.
			// Obsidian does NOT fire individual 'rename' events for child files
			// when a folder is renamed — the folder event is the only one.
			for (const key of Object.keys(this.file_hashes)) {
				if (key.startsWith(oldPrefix)) {
					this.file_hashes[newPath + key.slice(oldPath.length)] = this.file_hashes[key]
					delete this.file_hashes[key]
				}
			}

			// Refresh settings UI if open — folder paths changed
			this.settingsTab?.refreshFolderSettings()
		} else if (this.file_hashes[oldPath]) {
			this.file_hashes[newPath] = this.file_hashes[oldPath]
			delete this.file_hashes[oldPath]
		}
		await this.saveAllData()
	}

	updateStatusBar(state: "idle" | "syncing" | "success" | "error") {
		if (!this.statusBarItem) return

		this.statusBarItem.empty()

		const container = this.statusBarItem.createDiv({ cls: 'anki-status-bar-item' })

		let text = "Anki"
		let className = ""

		switch(state) {
			case "syncing":
				text = "Syncing..."
				className = "anki-status-syncing"
				break
			case "success":
				text = "Synced"
				className = "anki-status-success"
				break
			case "error":
				text = "Error"
				className = "anki-status-error"
				break
			default:
				text = "Anki"
		}

		container.createSpan({ text: text, cls: className })
	}

	/**Resolves once Obsidian has re-indexed `file`'s metadata. Obsidian re-parses
	frontmatter asynchronously after a `vault.modify`, and `getFileCache`/
	`getCache` are synchronous, so without waiting here a just-written marker
	would be invisible to `hasIOMarker`/`fileHasIOMarker` and the sync would
	drop the file again.*/
	private waitForMetadataRefresh(file: TFile): Promise<void> {
		return new Promise((resolve) => {
			let timeout: number
			const handler = (changedFile: TFile) => {
				if (changedFile.path === file.path) {
					window.clearTimeout(timeout)
					this.app.metadataCache.off('changed', handler)
					resolve()
				}
			}
			timeout = window.setTimeout(() => {
				// Safety net: never hang the sync if the event doesn't fire.
				this.app.metadataCache.off('changed', handler)
				resolve()
			}, 2000)
			this.app.metadataCache.on('changed', handler)
		})
	}

	/**Opt an Excalidraw drawing in/out of Image Occlusion sync by writing (or
	removing) the `anki-occlusion: true` frontmatter marker. No-op when the
	file is already in the requested state.*/
	private async setIOOptIn(file: TFile, enabled: boolean): Promise<void> {
		const content: string = await this.app.vault.read(file)
		const updated: string = enabled ? setIOMarker(content) : clearIOMarker(content)
		if (updated === content) {
			return
		}
		const refreshed = this.waitForMetadataRefresh(file)
		await this.app.vault.modify(file, updated)
		await refreshed
		new Notice(enabled ? "Enabled Image Occlusion sync" : "Disabled Image Occlusion sync")
	}

	async onload() {
		console.log('loading Obsidian 2 Anki...');
		addIcon('anki', ANKI_ICON)

		try {
			this.settings = await this.loadSettings()
		}
		catch(e) {
			new Notice("Couldn't connect to Anki! Check console for error message.")
			return
		}

		this.note_types = Object.keys(this.settings["CUSTOM_REGEXPS"])
		this.fields_dict = await this.loadFieldsDict()
		if (Object.keys(this.fields_dict).length == 0) {
			new Notice('Need to connect to Anki to generate fields dictionary...')
			try {
				this.fields_dict = await this.generateFieldsDict()
				new Notice("Fields dictionary successfully generated!")
			}
			catch(e) {
				new Notice("Couldn't connect to Anki! Check console for error message.")
				return
			}
		}
		this.added_media = await this.loadAddedMedia()
		this.file_hashes = await this.loadFileHashes()
		this.io_frame_records = await this.loadIOFrameRecords()

		// Add status bar
		this.statusBarItem = this.addStatusBarItem()
		this.updateStatusBar("idle")

		this.settingsTab = new SettingsTab(this.app, this)
		this.addSettingTab(this.settingsTab);

		// Rename event handler — migrate FOLDER_DECKS, FOLDER_TAGS, file_hashes, Scan Directory
		this.registerEvent(
			this.app.vault.on('rename', async (file: TAbstractFile, oldPath: string) => {
				console.log(`[rename handler] ${oldPath} -> ${file.path} (folder: ${file instanceof TFolder})`)
				// If a sync is in progress, queue the migration to run after sync completes.
				// In-flight sync closures hold ref-copies of FOLDER_DECKS/FOLDER_TAGS;
				// mutating them mid-sync would silently drop overrides for files at old paths.
				if (this.isSyncing) {
					this.renameQueue.push({ oldPath, newPath: file.path, isFolder: file instanceof TFolder })
					new Notice(`${file instanceof TFolder ? 'Folder' : 'File'} rename queued — migration will apply after sync completes`)
					return
				}
				await this.applyMigration(oldPath, file.path, file instanceof TFolder)
			})
		)

		this.addRibbonIcon('anki', 'Obsidian 2 Anki - Sync Vault', async () => {
			await this.scanVault()
		})

		// Commands
		this.addCommand({
			id: 'anki-sync-vault',
			name: 'Sync Entire Vault',
			callback: async () => {
				await this.scanVault()
			}
		})

		this.addCommand({
			id: 'anki-sync-current-file',
			name: 'Sync Current File',
			callback: async () => {
				await this.syncCurrentFile()
			}
		})

		this.addCommand({
			id: 'anki-sync-current-folder',
			name: 'Sync Current Folder',
			callback: async () => {
				await this.syncCurrentFolder()
			}
		})

		// Context menu for files
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu: Menu, file: TAbstractFile) => {
				if (file instanceof TFile && file.extension === 'md') {
					const isIO = file.name.endsWith('.excalidraw.md')
					menu.addItem((item) => {
						item
							.setTitle('Sync to Anki')
							.setIcon('anki')
							.onClick(async () => {
								// Right-clicking an unmarked Excalidraw drawing and
								// choosing "Sync to Anki" opts it in automatically.
								if (isIO && !fileHasIOMarker(this.app, file)) {
									await this.setIOOptIn(file, true)
								}
								await this.syncFiles([file], `file: ${file.name}`)
							})
					})
					if (isIO) {
						menu.addItem((item) => {
							const enabled = fileHasIOMarker(this.app, file)
							item
								.setTitle(enabled ? "Disable Image Occlusion sync" : "Enable Image Occlusion sync")
								.onClick(async () => {
									await this.setIOOptIn(file, !enabled)
								})
						})
					}
				} else if (file instanceof TFolder) {
					menu.addItem((item) => {
						item
							.setTitle('Sync Folder to Anki')
							.setIcon('anki')
							.onClick(async () => {
								const filesInFolder = this.getAllTFilesInFolder(file)
								await this.syncFiles(filesInFolder, `folder: ${file.path}`)
							})
					})
				}
			})
		)
	}

	async onunload() {
		console.log("Saving settings for Obsidian 2 Anki...")
		await this.saveAllData()
		console.log('unloading Obsidian 2 Anki...');
	}
}
