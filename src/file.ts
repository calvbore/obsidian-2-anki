/*Performing plugin operations on markdown file contents*/

import { FROZEN_FIELDS_DICT } from './interfaces/field-interface'
import { AnkiConnectNote, AnkiConnectNoteAndID } from './interfaces/note-interface'
import { FileData } from './interfaces/settings-interface'
import { Note, InlineNote, RegexNote, CLOZE_ERROR, NOTE_TYPE_ERROR, TAG_SEP, ID_REGEXP_STR, TAG_REGEXP_STR, parseTagString, OBS_TAG_REGEXP } from './note'
import { Md5 } from 'ts-md5/dist/md5';
import * as AnkiConnect from './anki'
import * as c from './constants'
import { FormatConverter } from './format'
import { App, CachedMetadata, HeadingCache } from 'obsidian'
import { bytesToBase64 } from 'byte-base64'
import * as excalidraw from './excalidraw'
import * as excalidrawsvg from './excalidraw-svg'
import * as io from './io'

const double_regexp: RegExp = /(?:\r\n|\r|\n)((?:\r\n|\r|\n)(?:<!--)?ID: \d+)/g

function id_to_str(identifier:number, inline:boolean = false, comment:boolean = false): string {
    let result = "ID: " + identifier.toString()
    if (comment) {
        result = "<!--" + result + "-->"
    }
    if (inline) {
        result += " "
    } else {
        result += "\n"
    }
    return result
}

function string_insert(text: string, position_inserts: Array<[number, string]>): string {
	/*Insert strings in position_inserts into text, at indices.

    position_inserts will look like:
    [(0, "hi"), (3, "hello"), (5, "beep")]*/
	let offset = 0
	let sorted_inserts: Array<[number, string]> = position_inserts.sort((a, b):number => a[0] - b[0])
	for (let insertion of sorted_inserts) {
		let position = insertion[0]
		let insert_str = insertion[1]
		text = text.slice(0, position + offset) + insert_str + text.slice(position + offset)
		offset += insert_str.length
	}
	return text
}

function spans(pattern: RegExp, text: string): Array<[number, number]> {
	/*Return a list of span-tuples for matches of pattern in text.*/
	let output: Array<[number, number]> = []
	let matches = text.matchAll(pattern)
	for (let match of matches) {
		output.push(
			[match.index, match.index + match[0].length]
		)
	}
	return output
}

function contained_in(span: [number, number], spans: Array<[number, number]>): boolean {
	/*Return whether span is contained in spans (+- 1 leeway)*/
	return spans.some(
		(element) => span[0] >= element[0] - 1 && span[1] <= element[1] + 1
	)
}

function* findignore(pattern: RegExp, text: string, ignore_spans: Array<[number, number]>): IterableIterator<RegExpMatchArray> {
	let matches = text.matchAll(pattern)
	for (let match of matches) {
		if (!(contained_in([match.index, match.index + match[0].length], ignore_spans))) {
			yield match
		}
	}
}

export abstract class AbstractFile {
    file: string
    path: string
    url: string
    original_file: string
    data: FileData
    file_cache: CachedMetadata
    frozen_fields_dict: FROZEN_FIELDS_DICT
    target_deck: string
    global_tags: string

    notes_to_add: AnkiConnectNote[]
    id_indexes: number[]
    notes_to_edit: AnkiConnectNoteAndID[]
    notes_to_delete: number[]
    all_notes_to_add: AnkiConnectNote[]

    note_ids: Array<number | null>
    card_ids: number[]
    tags: string[]
    io_skip_reasons: string[] = []

    formatter: FormatConverter

    constructor(file_contents: string, path:string, url: string, data: FileData, file_cache: CachedMetadata) {
        this.data = data
        this.file = file_contents
        this.path = path
        this.url = url
        this.original_file = this.file
        this.file_cache = file_cache
        this.formatter = new FormatConverter(file_cache, this.data.vault_name)
    }

    setup_frozen_fields_dict() {
        let frozen_fields_dict: FROZEN_FIELDS_DICT = {}
        for (let note_type in this.data.fields_dict) {
            let fields: string[] = this.data.fields_dict[note_type]
            let temp_dict: Record<string, string> = {}
            for (let field of fields) {
                temp_dict[field] = ""
            }
            frozen_fields_dict[note_type] = temp_dict
        }
        for (let match of this.file.matchAll(this.data.FROZEN_REGEXP)) {
            const [note_type, fields]: [string, string] = [match[1], match[2]]
            const virtual_note = note_type + "\n" + fields
            const parsed_fields: Record<string, string> = new Note(
                virtual_note,
                this.data.fields_dict,
                this.data.curly_cloze,
                this.data.highlights_to_cloze,
                this.formatter
            ).getFields()
            frozen_fields_dict[note_type] = parsed_fields
        }
        this.frozen_fields_dict = frozen_fields_dict
    }

    setup_target_deck() {
        const result = this.file.match(this.data.DECK_REGEXP)
        this.target_deck = result ? result[1] : this.data.template["deckName"]
    }

    setup_global_tags() {
        const result = this.file.match(this.data.TAG_REGEXP)
        this.global_tags = result ? parseTagString(result[1]).join(TAG_SEP) : ""
    }

    getHash(): string {
        return Md5.hashStr(this.file) as string
    }

    abstract scanFile(): void

    scanDeletions() {
        for (let match of this.file.matchAll(this.data.EMPTY_REGEXP)) {
            this.notes_to_delete.push(parseInt(match[1]))
        }
    }

    getContextAtIndex(position: number): string {
        let result: string = this.path
        let currentContext: HeadingCache[] = []
        if (!(this.file_cache.hasOwnProperty('headings'))) {
            return result
        }
        for (let currentHeading of this.file_cache.headings) {
            if (position < currentHeading.position.start.offset) {
                //We've gone past position now with headings, so let's return!
                break
            }
            let insert_index: number = 0
            for (let contextHeading of currentContext) {
                if (currentHeading.level > contextHeading.level) {
                    insert_index += 1
                    continue
                }
                break
            }
            currentContext = currentContext.slice(0, insert_index)
            currentContext.push(currentHeading)
        }
        let heading_strs: string[] = []
        for (let contextHeading of currentContext) {
            heading_strs.push(contextHeading.heading)
        }
        let result_arr: string[] = [result]
        result_arr.push(...heading_strs)
        return result_arr.join(" > ")
    }

    abstract writeIDs(): void

    removeEmpties() {
        this.file = this.file.replace(this.data.EMPTY_REGEXP, "")
    }

    getCreateDecks(): AnkiConnect.AnkiConnectRequest {        
        let actions: AnkiConnect.AnkiConnectRequest[] = []
        for (let note of this.all_notes_to_add) {
            actions.push(AnkiConnect.createDeck(note.deckName))
        }
        return AnkiConnect.multi(actions)
    }

    getAddNotes(): AnkiConnect.AnkiConnectRequest {
        let actions: AnkiConnect.AnkiConnectRequest[] = []
        for (let note of this.all_notes_to_add) {
            actions.push(AnkiConnect.addNote(note))
        }
        return AnkiConnect.multi(actions)
    }

    getDeleteNotes(): AnkiConnect.AnkiConnectRequest {
        return AnkiConnect.deleteNotes(this.notes_to_delete)
    }

    getUpdateFields(): AnkiConnect.AnkiConnectRequest {
        let actions: AnkiConnect.AnkiConnectRequest[] = []
        for (let parsed of this.notes_to_edit) {
            actions.push(
                AnkiConnect.updateNoteFields(
                    parsed.identifier, parsed.note.fields
                )
            )
        }
        return AnkiConnect.multi(actions)
    }

    getNoteInfo(): AnkiConnect.AnkiConnectRequest {
        let IDs: number[] = []
        for (let parsed of this.notes_to_edit) {
            IDs.push(parsed.identifier)
        }
        return AnkiConnect.notesInfo(IDs)
    }

    getChangeDecks(): AnkiConnect.AnkiConnectRequest {
        return AnkiConnect.changeDeck(this.card_ids, this.target_deck)
    }

    getClearTags(): AnkiConnect.AnkiConnectRequest {
        let IDs: number[] = []
        for (let parsed of this.notes_to_edit) {
            IDs.push(parsed.identifier)
        }
        return AnkiConnect.removeTags(IDs, this.tags.join(" "))
    }

    getAddTags(): AnkiConnect.AnkiConnectRequest {
        let actions: AnkiConnect.AnkiConnectRequest[] = []
        for (let parsed of this.notes_to_edit) {
            actions.push(
                AnkiConnect.addTags([parsed.identifier], parsed.note.tags.join(" ") + " " + this.global_tags)
            )
        }
        return AnkiConnect.multi(actions)
    }

    getMedia(): { filename: string; data: string }[] {
        return []
    }

}

export class AllFile extends AbstractFile {
    ignore_spans: [number, number][]
    custom_regexps: Record<string, string>
    inline_notes_to_add: AnkiConnectNote[]
    inline_id_indexes: number[]
    regex_notes_to_add: AnkiConnectNote[]
    regex_id_indexes: number[]

    constructor(file_contents: string, path:string, url: string, data: FileData, file_cache: CachedMetadata) {
        super(file_contents, path, url, data, file_cache)
        this.custom_regexps = data.custom_regexps
    }

    add_spans_to_ignore() {
        this.ignore_spans = []
        this.ignore_spans.push(...spans(this.data.FROZEN_REGEXP, this.file))
        const deck_result = this.file.match(this.data.DECK_REGEXP)
        if (deck_result) {
            this.ignore_spans.push([deck_result.index, deck_result.index + deck_result[0].length])
        }
        const tag_result = this.file.match(this.data.TAG_REGEXP)
        if (tag_result) {
            this.ignore_spans.push([tag_result.index, tag_result.index + tag_result[0].length])
        }
        this.ignore_spans.push(...spans(this.data.NOTE_REGEXP, this.file))
        this.ignore_spans.push(...spans(this.data.INLINE_REGEXP, this.file))
        this.ignore_spans.push(...spans(c.OBS_INLINE_MATH_REGEXP, this.file))
        this.ignore_spans.push(...spans(c.OBS_DISPLAY_MATH_REGEXP, this.file))
        this.ignore_spans.push(...spans(c.OBS_CODE_REGEXP, this.file))
        this.ignore_spans.push(...spans(c.OBS_DISPLAY_CODE_REGEXP, this.file))
    }

    setupScan() {
        this.setup_frozen_fields_dict()
        this.setup_target_deck()
        this.setup_global_tags()
        this.add_spans_to_ignore()
        this.notes_to_add = []
        this.inline_notes_to_add = []
        this.regex_notes_to_add = []
        this.id_indexes = []
        this.inline_id_indexes = []
        this.regex_id_indexes = []
        this.notes_to_edit = []
        this.notes_to_delete = []
    }

    scanNotes() {
        for (let note_match of this.file.matchAll(this.data.NOTE_REGEXP)) {
            let [note, position]: [string, number] = [note_match[1], note_match.index + note_match[0].indexOf(note_match[1]) + note_match[1].length]
            // That second thing essentially gets the index of the end of the first capture group.
            let parsed = new Note(
                note,
                this.data.fields_dict,
                this.data.curly_cloze,
                this.data.highlights_to_cloze,
                this.formatter
            ).parse(
                this.target_deck,
                this.url,
                this.frozen_fields_dict,
                this.data,
                this.data.add_context ? this.getContextAtIndex(note_match.index) : ""
            )
            if (parsed.identifier == null) {
                // Need to make sure global_tags get added
                parsed.note.tags.push(...this.global_tags.split(TAG_SEP))
                this.notes_to_add.push(parsed.note)
                this.id_indexes.push(position)
            } else if (!this.data.EXISTING_IDS.includes(parsed.identifier)) {
                if (parsed.identifier == CLOZE_ERROR) {
                    continue
                }
                // Need to show an error otherwise
                else if (parsed.identifier == NOTE_TYPE_ERROR) {
                    console.warn("Did not recognise note type ", parsed.note.modelName, " in file ", this.path)
                } else {
                    console.warn("Note with id", parsed.identifier, " in file ", this.path, " does not exist in Anki!")
                }
            } else {
                this.notes_to_edit.push(parsed)
            }
        }
    }

    scanInlineNotes() {
        for (let note_match of this.file.matchAll(this.data.INLINE_REGEXP)) {
            let [note, position]: [string, number] = [note_match[1], note_match.index + note_match[0].indexOf(note_match[1]) + note_match[1].length]
            // That second thing essentially gets the index of the end of the first capture group.
            let parsed = new InlineNote(
                note,
                this.data.fields_dict,
                this.data.curly_cloze,
                this.data.highlights_to_cloze,
                this.formatter
            ).parse(
                this.target_deck,
                this.url,
                this.frozen_fields_dict,
                this.data,
                this.data.add_context ? this.getContextAtIndex(note_match.index) : ""
            )
            if (parsed.identifier == null) {
                // Need to make sure global_tags get added
                parsed.note.tags.push(...this.global_tags.split(TAG_SEP))
                this.inline_notes_to_add.push(parsed.note)
                this.inline_id_indexes.push(position)
            } else if (!this.data.EXISTING_IDS.includes(parsed.identifier)) {
                // Need to show an error
                if (parsed.identifier == CLOZE_ERROR) {
                    continue
                }
                console.warn("Note with id", parsed.identifier, " in file ", this.path, " does not exist in Anki!")
            } else {
                this.notes_to_edit.push(parsed)
            }
        }
    }

    search(note_type: string, regexp_str: string) {
        //Search the file for regex matches
        //ignoring matches inside ignore_spans,
        //and adding any matches to ignore_spans.
        for (let search_id of [true, false]) {
            for (let search_tags of [true, false]) {
                let id_str = search_id ? ID_REGEXP_STR : ""
                let tag_str = search_tags ? TAG_REGEXP_STR : ""
                let regexp: RegExp = new RegExp(regexp_str + tag_str + id_str, 'gm')
                for (let match of findignore(regexp, this.file, this.ignore_spans)) {
                    this.ignore_spans.push([match.index, match.index + match[0].length])
                    const parsed: AnkiConnectNoteAndID = new RegexNote(
                        match, note_type, this.data.fields_dict,
                        search_tags, search_id, this.data.curly_cloze, this.data.highlights_to_cloze, this.formatter
                    ).parse(
                        this.target_deck,
                        this.url,
                        this.frozen_fields_dict,
                        this.data,
                        this.data.add_context ? this.getContextAtIndex(match.index) : ""
                    )
                    if (search_id) {
                        if (!(this.data.EXISTING_IDS.includes(parsed.identifier))) {
                            if (parsed.identifier == CLOZE_ERROR) {
                                // This means it wasn't actually a note! So we should remove it from ignore_spans
                                this.ignore_spans.pop()
                                continue
                            }
                            console.warn("Note with id", parsed.identifier, " in file ", this.path, " does not exist in Anki!")
                        } else {
                            this.notes_to_edit.push(parsed)
                        }
                    } else {
                        if (parsed.identifier == CLOZE_ERROR) {
                            // This means it wasn't actually a note! So we should remove it from ignore_spans
                            this.ignore_spans.pop()
                            continue
                        }
                        parsed.note.tags.push(...this.global_tags.split(TAG_SEP))
                        this.regex_notes_to_add.push(parsed.note)
                        this.regex_id_indexes.push(match.index + match[0].length)
                    }
                }
            }
        }
    }

    scanFile() {
        this.setupScan()
        this.scanNotes()
        this.scanInlineNotes()
        for (let note_type in this.custom_regexps) {
            const regexp_str: string = this.custom_regexps[note_type]
            if (regexp_str) {
                this.search(note_type, regexp_str)
            }
        }
        this.all_notes_to_add = this.notes_to_add.concat(this.inline_notes_to_add).concat(this.regex_notes_to_add)
        this.scanDeletions()
    }

    fix_newline_ids() {
        this.file = this.file.replace(double_regexp, "$1")
    }

    writeIDs() {
        let normal_inserts: [number, string][] = []
        this.id_indexes.forEach(
            (id_position: number, index: number) => {
                const identifier: number | null = this.note_ids[index]
                if (identifier) {
                    normal_inserts.push([id_position, id_to_str(identifier, false, this.data.comment)])
                }
            }
        )
        let inline_inserts: [number, string][] = []
        this.inline_id_indexes.forEach(
            (id_position: number, index: number) => {
                const identifier: number | null = this.note_ids[index + this.notes_to_add.length] //Since regular then inline
                if (identifier) {
                    inline_inserts.push([id_position, id_to_str(identifier, true, this.data.comment)])
                }
            }
        )
        let regex_inserts: [number, string][] = []
        this.regex_id_indexes.forEach(
            (id_position: number, index: number) => {
                const identifier: number | null = this.note_ids[index + this.notes_to_add.length + this.inline_notes_to_add.length] // Since regular then inline then regex
                if (identifier) {
                    regex_inserts.push([id_position, "\n" + id_to_str(identifier, false, this.data.comment)])
                }
            }
        )
        this.file = string_insert(this.file, normal_inserts.concat(inline_inserts).concat(regex_inserts))
        this.fix_newline_ids()
    }
}

export class IOFile extends AbstractFile {
    app: App
    io_config: io.IOConfig
    delete_word: string
    frozen_word: string
    io_media: { filename: string; data: string }[]
    normal_id_indexes: number[]
    io_add_frame_keys: string[]
    io_add_frame_hashes: string[]
    delete_spans: [number, number][]

    constructor(file_contents: string, path: string, url: string, data: FileData, file_cache: CachedMetadata, app: App) {
        super(file_contents, path, url, data, file_cache)
        this.app = app
        const ioSettings: io.IOSyncSettings | undefined = data.io_settings
        this.io_config = ioSettings ? {
            hideAllKey: ioSettings.hideAllKey
        } : io.defaultIOConfig()
        this.delete_word = ioSettings ? ioSettings.deleteWord : "DELETE"
        this.frozen_word = ioSettings ? ioSettings.frozenWord : "FROZEN"
        this.io_media = []
        this.normal_id_indexes = []
        this.io_add_frame_keys = []
        this.io_add_frame_hashes = []
        this.delete_spans = []
    }

    isIOFile(): boolean {
        return true
    }

    ioSkip(reason: string): void {
        const line = "Image Occlusion (" + this.path + "): " + reason
        console.warn(line)
        this.io_skip_reasons.push(line)
    }

    setup_target_deck() {
        const frontmatter = this.file_cache.frontmatter
        const deck = frontmatter && frontmatter["deck"]
        this.target_deck = typeof deck === "string" && deck ? deck : this.data.template["deckName"]
    }

    getMedia(): { filename: string; data: string }[] {
        return this.io_media
    }

    async readImageBytes(
        drawing: excalidraw.ParsedDrawing,
        image: excalidraw.ExcalidrawElement
    ): Promise<{ data: string; mimeType: string } | null> {
        const fileId: string = image && (image as any).fileId ? (image as any).fileId : ""
        if (!fileId) {
            return null
        }
        const vaultPath: string | null = io.embeddedFileVaultPath(drawing, fileId)
        if (vaultPath) {
            try {
                const dataFile = this.app.metadataCache.getFirstLinkpathDest(vaultPath, this.path)
                if (!dataFile) {
                    console.warn("Couldn't locate excalidraw image ", vaultPath, " in file ", this.path)
                    return null
                }
                const arrayBuffer = await this.app.vault.readBinary(dataFile)
                const bytes = new Uint8Array(arrayBuffer)
                const data: string = bytesToBase64(bytes)
                const mimeType = dataFile.extension === "jpg" || dataFile.extension === "jpeg" ? "image/jpeg"
                    : dataFile.extension === "png" ? "image/png"
                    : dataFile.extension === "gif" ? "image/gif"
                    : dataFile.extension === "webp" ? "image/webp"
                    : dataFile.extension === "svg" ? "image/svg+xml"
                    : "image/png"
                return { data, mimeType }
            } catch (e) {
                console.warn("Failed to read excalidraw image ", vaultPath, e)
                return null
            }
        }
        const fileData: excalidraw.ExcalidrawFileData | undefined = drawing.files[fileId]
        if (fileData && fileData.dataURL) {
            const comma: number = fileData.dataURL.indexOf(",")
            const data: string = comma >= 0 ? fileData.dataURL.slice(comma + 1) : fileData.dataURL
            const mimeType: string = fileData.mimeType || "image/png"
            return { data, mimeType }
        }
        // Fall back to Excalidraw 2.12.x's attachment convention: the file is a
        // vault file named `<fileId>.<ext>` (no `## Embedded Files` section).
        const attachment = this.app.vault.getFiles()
            .find(file => file.name.startsWith(fileId + "."))
        if (attachment) {
            try {
                const arrayBuffer = await this.app.vault.readBinary(attachment)
                const bytes = new Uint8Array(arrayBuffer)
                const data: string = bytesToBase64(bytes)
                const mimeType = attachment.extension === "jpg" || attachment.extension === "jpeg" ? "image/jpeg"
                    : attachment.extension === "png" ? "image/png"
                    : attachment.extension === "gif" ? "image/gif"
                    : attachment.extension === "webp" ? "image/webp"
                    : attachment.extension === "svg" ? "image/svg+xml"
                    : "image/png"
                return { data, mimeType }
            } catch (e) {
                console.warn("Failed to read excalidraw image attachment ", attachment.path, e)
                return null
            }
        }
        return null
    }

    async scanFile() {
        this.setup_target_deck()
        this.setup_global_tags()
        this.notes_to_add = []
        this.notes_to_edit = []
        this.notes_to_delete = []
        this.id_indexes = []
        this.normal_id_indexes = []
        this.io_add_frame_keys = []
        this.io_add_frame_hashes = []
        this.io_media = []
        this.delete_spans = []
        this.io_skip_reasons = []
        const drawing: excalidraw.ParsedDrawing | null = excalidraw.parseDrawing(this.file)
        if (!drawing) {
            this.all_notes_to_add = []
            return
        }
        const bodyInfo = excalidraw.findBackOfNote(this.file)
        const frames = io.occlusionFrames(drawing)
        const frameElements = drawing.elements.filter(e => !e.isDeleted && e.type === "frame")
        if (frames.length === 0 && frameElements.length > 0) {
            const names = frameElements.map(f => JSON.stringify(f.name || "")).join(", ")
            this.ioSkip(`file has ${frameElements.length} Excalidraw frame(s) but none titled "${io.IO_FRAME_TITLE}" (frame names: ${names}); rename a frame to "${io.IO_FRAME_TITLE}" to sync it`)
        }
        const fieldNames: string[] = this.data.fields_dict["Image Occlusion"] || []
        if (fieldNames.length < io.IO_FIELD_COUNT) {
            // The section field keys are derived from the note type; without a
            // complete model there is nothing to derive from (mirrors the guard
            // in buildOcclusionNote).
            this.ioSkip(`file skipped: Anki's "${io.IO_FRAME_TITLE}" note type is missing or has fewer than ${io.IO_FIELD_COUNT} fields; cannot derive the section field keys (is Anki 23.10+ connected?)`)
            this.all_notes_to_add = []
            return
        }
        const fieldKeys: io.IOFieldKeys = io.ioFieldKeys(fieldNames)
        const deleteWord: string = this.delete_word
        const frozenWord: string = this.frozen_word
        const currentFrameIds: string[] = []
        for (let frame of frames) {
            currentFrameIds.push(frame.id)
            const recordKey: string = this.path + "::" + frame.id
            const record: io.IOFrameRecord = this.data.io_frame_records[recordKey] || {
                maskOrdinals: {},
                noteId: null,
                lastHash: null
            }
            const link: string | null = io.elementLink(drawing, frame.id)
            const section = io.findSection(this.file, link, bodyInfo)
            if (!section) {
                this.ioSkip(`frame "${frame.id}" skipped: ${link ? `element link "${link}" does not resolve to a back-of-note heading` : "has no element link to a back-of-note section"}; add/check the element link (e.g. \`${frame.id}: [[#Section Name]]\`) pointing to a "## " section above "# Excalidraw Data"`)
                continue
            }
            const sectionParsed = io.parseSection(section.text, fieldKeys, this.io_config, deleteWord, frozenWord)
            const idLineOffset: number = section.start + section.text.replace(/\s+$/, "").length
            const masks: io.IOMask[] = []
            for (let maskElement of io.frameMasks(drawing, frame)) {
                const geometry = io.maskGeometry(maskElement, frame)
                if (!geometry) {
                    continue
                }
                masks.push({
                    elementId: maskElement.id,
                    type: maskElement.type === "ellipse" ? "ellipse" : "rectangle",
                    ordinal: 0,
                    left: geometry.left,
                    top: geometry.top,
                    width: geometry.width,
                    height: geometry.height,
                    rx: geometry.rx,
                    ry: geometry.ry,
                    fill: geometry.fill
                })
            }
            const maskOrdinals: Record<string, number> = io.assignOrdinals(
                masks.map(mask => mask.elementId),
                record
            )
            for (let mask of masks) {
                mask.ordinal = maskOrdinals[mask.elementId]
            }
            // Compose the card's picture: the frame's non-mask objects as a
            // deterministic SVG (image bytes ride along as data: URIs).
            const objects: excalidraw.ExcalidrawElement[] = io.frameRenderObjects(drawing, frame, masks)
            const imageData: Record<string, excalidrawsvg.ImageData> = {}
            for (let objectEl of objects) {
                if (objectEl.type === "image") {
                    const bytes = await this.readImageBytes(drawing, objectEl)
                    if (bytes) {
                        imageData[objectEl.id] = { mimeType: bytes.mimeType, data: bytes.data }
                    }
                }
            }
            const svg: string = excalidrawsvg.renderSceneSvg(frame, objects, imageData)
            const svgFilename: string = io.mediaFilename(svg, "image/svg+xml")
            let header = sectionParsed.fieldValues[fieldKeys.headerKey] || ""
            let backExtra = sectionParsed.fieldValues[fieldKeys.backExtraKey] || ""
            let comments = sectionParsed.fieldValues[fieldKeys.commentsKey] || ""
            const hideAll = sectionParsed.hideAll
            // Tag parity (§14): the frame's note tags = the section's `Tags:`
            // line(s), plus (TS plugin only, when Add Obsidian Tags is enabled)
            // Obsidian `#tag`s stripped out of the Header/Back Extra/Comments
            // values. Never applied to the synthetic Occlusion field (it would
            // mint bogus tags from `:fill=#…` geometry and corrupt the cloze).
            const noteTags: string[] = sectionParsed.tags.slice()
            if (this.data.add_obs_tags) {
                for (let value of [header, backExtra, comments]) {
                    for (let match of value.matchAll(OBS_TAG_REGEXP)) {
                        noteTags.push(match[1])
                    }
                }
                header = header.replace(OBS_TAG_REGEXP, "").trim()
                backExtra = backExtra.replace(OBS_TAG_REGEXP, "").trim()
                comments = comments.replace(OBS_TAG_REGEXP, "").trim()
            }
            // The effective tag string feeds the frame hash so a Tags:/#tag
            // edit alone re-syncs. `[global_tags, ...noteTags]` mirrors vanilla
            // ADD (template + noteTags + global_tags) and EDIT (noteTags +
            // global_tags) tag sets — concatenated, not deduped.
            const effectiveTags = [this.global_tags, ...noteTags].filter(t => t).join(TAG_SEP)
            const frameHash = io.frameHash(
                masks,
                svg,
                { [fieldKeys.headerKey]: header, [fieldKeys.backExtraKey]: backExtra, [fieldKeys.commentsKey]: comments, [this.io_config.hideAllKey]: hideAll ? "true" : "false" },
                hideAll,
                this.target_deck,
                effectiveTags
            )
            const identifier: number | null = sectionParsed.identifier
            if (!this.data.io_frame_records[recordKey]) {
                this.data.io_frame_records[recordKey] = record
            }

            if (sectionParsed.deleteNote && identifier !== null) {
                this.notes_to_delete.push(identifier)
                this.delete_spans.push([section.start, section.end])
                record.noteId = null
                record.lastHash = null
                continue
            }
            if (sectionParsed.frozen) {
                continue
            }
            if (identifier === null) {
                const note = io.buildOcclusionNote(
                    fieldNames,
                    this.data.template,
                    masks,
                    svgFilename,
                    header,
                    backExtra,
                    comments,
                    hideAll
                )
                if (!note) {
                    this.ioSkip(`frame "${frame.id}" skipped: ${masks.length === 0 ? "no usable occlusion mask (add a filled rectangle/ellipse, opacity > 0, both dimensions ≥ 5px, overlapping the frame)" : "could not build the note (is Anki's \"Image Occlusion\" model available?)"}`)
                    continue
                }
                note["deckName"] = this.target_deck
                note["tags"].push(...noteTags)
                note["tags"].push(...this.global_tags.split(TAG_SEP).filter(t => t))
                this.notes_to_add.push(note)
                this.id_indexes.push(idLineOffset)
                this.io_add_frame_keys.push(recordKey)
                this.io_add_frame_hashes.push(frameHash)
                this.io_media.push({ filename: svgFilename, data: bytesToBase64(new TextEncoder().encode(svg)) })
                continue
            }
            if (!this.data.EXISTING_IDS.includes(identifier)) {
                this.ioSkip(`frame "${frame.id}" skipped: section references note ID ${identifier} which does not exist in Anki`)
                continue
            }
            if (frameHash === record.lastHash && record.noteId === identifier) {
                // Nothing changed in this frame -- skip the no-op update.
                continue
            }
            const note = io.buildOcclusionNote(
                fieldNames,
                this.data.template,
                masks,
                svgFilename,
                header,
                backExtra,
                comments,
                hideAll
            )
            if (!note) {
                this.ioSkip(`frame "${frame.id}" skipped: ${masks.length === 0 ? "no usable occlusion mask (add a filled rectangle/ellipse, opacity > 0, both dimensions ≥ 5px, overlapping the frame)" : "could not build the note (is Anki's \"Image Occlusion\" model available?)"}`)
                continue
            }
            note["deckName"] = this.target_deck
            // EDIT: Anki's note already carries the file tags (from the ADD
            // path); the clear/add-tags requests re-apply them. Here only the
            // section's note tags are (re)merged so a gained/lost `Tags:` line
            // propagates even without a field change.
            note["tags"] = note["tags"].concat(noteTags)
            const noteWithId: AnkiConnectNoteAndID = { note, identifier }
            this.notes_to_edit.push(noteWithId)
            this.io_media.push({ filename: svgFilename, data: bytesToBase64(new TextEncoder().encode(svg)) })
            record.lastHash = frameHash
        }
        // Drop records for frames that no longer exist in the drawing.
        for (let recordKey of Object.keys(this.data.io_frame_records)) {
            if (recordKey.startsWith(this.path + "::")) {
                const frameId: string = recordKey.slice(this.path.length + 2)
                if (!currentFrameIds.includes(frameId)) {
                    delete this.data.io_frame_records[recordKey]
                }
            }
        }
        this.all_notes_to_add = this.notes_to_add
    }

    writeIDs() {
        let inserts: [number, string][] = []
        for (let index in this.id_indexes) {
            const i = parseInt(index)
            const identifier: number | null = this.note_ids[i]
            if (identifier) {
                inserts.push([this.id_indexes[i], "\n" + id_to_str(identifier, false, this.data.comment)])
                const recordKey: string | undefined = this.io_add_frame_keys[i]
                if (recordKey) {
                    const record = this.data.io_frame_records[recordKey]
                    if (record) {
                        record.noteId = identifier
                        record.lastHash = this.io_add_frame_hashes[i]
                    }
                }
            }
        }
        this.file = string_insert(this.file, inserts)
    }

    removeEmpties() {
        // Remove deleted frame sections, largest offset first so earlier
        // offsets stay valid.
        const spans = this.delete_spans.slice().sort((a, b) => b[0] - a[0])
        for (let [start, end] of spans) {
            this.file = this.file.slice(0, start) + this.file.slice(end)
        }
        this.delete_spans = []
    }
}
