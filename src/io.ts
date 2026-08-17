/*Building Anki "Image Occlusion" notes from Excalidraw frames.

The built-in Anki Image Occlusion note type (23.10+) is an ordinary cloze
note. The Occlusion field holds one cloze per mask:
    {{c1::image-occlusion:rect:left=..:top=..:width=..:height=..:fill=#..}}
Each cloze's ordinal IS the card identity in Anki, so mask <-> ordinal
mapping is preserved in the plugin data file across syncs (see PLAN.md §6).*/

import { AnkiConnectNote } from './interfaces/note-interface'
import { ParsedDrawing, ExcalidrawElement, findBackOfNote, BackOfNoteInfo, escapeRegex } from './excalidraw'
import { Md5 } from 'ts-md5/dist/md5'
import { parseTagString } from './note'

// Logical field slots of the stock Image Occlusion note type, by ordinal.
export const IO_FIELD_OCCLUSION = 0
export const IO_FIELD_IMAGE = 1
export const IO_FIELD_HEADER = 2
export const IO_FIELD_BACK_EXTRA = 3
export const IO_FIELD_COMMENTS = 4
export const IO_FIELD_COUNT = 5

/**The exact frame name treated as an Image Occlusion note (not configurable,
mirrors vanilla: field keys come from the note type, not from settings).*/
export const IO_FRAME_TITLE = "Image Occlusion"

/**The note type's real (localized) field names for the text fields, derived by
ordinal from `fields_dict["Image Occlusion"]` — the section's `Key:` labels are
the model's actual field names, exactly like the vanilla parsers.*/
export interface IOFieldKeys {
    headerKey: string
    backExtraKey: string
    commentsKey: string
}

export function ioFieldKeys(fieldNames: string[]): IOFieldKeys {
    return {
        headerKey: fieldNames[IO_FIELD_HEADER],
        backExtraKey: fieldNames[IO_FIELD_BACK_EXTRA],
        commentsKey: fieldNames[IO_FIELD_COMMENTS]
    }
}

/**Settings-derived IO config: only the configurable `Hide all` directive word
 (a Syntax setting, like the `DELETE`/`FROZEN` words).*/
export interface IOConfig {
    hideAllKey: string
}

export interface IOSyncSettings extends IOConfig {
    deleteWord: string
    frozenWord: string
}

export function defaultIOConfig(): IOConfig {
    return {
        hideAllKey: "Hide all"
    }
}

export interface IOFrameRecord {
    maskOrdinals: Record<string, number>
    noteId: number | null
    lastHash: string | null
}

export interface IOMask {
    elementId: string
    type: "rectangle" | "ellipse"
    ordinal: number
    left: number
    top: number
    width: number
    height: number
    rx: number | null
    ry: number | null
    fill: string
}

export interface IOFrameBuild {
    frameId: string
    note: AnkiConnectNote | null
    identifier: number | null
    action: "add" | "edit" | "delete" | "skip"
    idIndex: number | null
    record: IOFrameRecord
    maskOrdinals: Record<string, number>
    frameHash: string
}

export interface FrameSection {
    start: number
    end: number
    idLineOffset: number
    identifier: number | null
    frozen: boolean
    delete: boolean
    hideAll: boolean
    fieldValues: Record<string, string>
}

const ID_LINE_REGEXP: RegExp = /^(?:<!--)?ID: (\d+)(?:-->)?\s*$/

/**Normalize an Excalidraw hex colour (#rrggbb or #aarrggbb) to #rrggbb.*/
export function normalizeFill(backgroundColor: string | undefined): string | null {
    if (!backgroundColor) {
        return null
    }
    let color: string = backgroundColor.trim()
    if (color.startsWith("#") && color.length === 9) {
        color = "#" + color.slice(3)
    }
    if (/^#[0-9a-fA-F]{6}$/.test(color)) {
        return color.toLowerCase()
    }
    return null
}

/**Compute a mask's geometry against an anchor (the frame) bounds. Returns null
for masks Anki would drop (<5px, transparent) or that have zero intersection.*/
export function maskGeometry(
    mask: ExcalidrawElement,
    anchor: ExcalidrawElement
): { left: number; top: number; width: number; height: number; rx: number | null; ry: number | null; fill: string } | null {
    if (mask.opacity === 0) {
        return null
    }
    if (mask.width < 5 || mask.height < 5) {
        return null
    }
    const fill: string | null = normalizeFill(mask.backgroundColor)
    if (fill === null) {
        return null
    }
    const aw: number = anchor.width
    const ah: number = anchor.height
    if (aw <= 0 || ah <= 0) {
        return null
    }
    let left: number = (mask.x - anchor.x) / aw
    let top: number = (mask.y - anchor.y) / ah
    let width: number = mask.width / aw
    let height: number = mask.height / ah
    // Zero intersection with the anchor bounds -> skip.
    if (width <= 0 || height <= 0 || left >= 1 || top >= 1 || left + width <= 0 || top + height <= 0) {
        return null
    }
    // Clamp partially-overlapping masks to the anchor bounds.
    left = Math.max(0, Math.min(1, left))
    top = Math.max(0, Math.min(1, top))
    width = Math.max(0, Math.min(1, left + width) - left)
    height = Math.max(0, Math.min(1, top + height) - top)
    if (width * aw < 5 || height * ah < 5) {
        return null
    }
    const isEllipse: boolean = mask.type === "ellipse"
    return {
        left: round4(left),
        top: round4(top),
        width: round4(width),
        height: round4(height),
        rx: isEllipse ? round4(width / 2) : null,
        ry: isEllipse ? round4(height / 2) : null,
        fill
    }
}

function round4(value: number): number {
    return Math.round(value * 10000) / 10000
}

/**Build a single mask's cloze string.*/
export function maskToCloze(mask: IOMask, hideAll: boolean): string {
    const shape: string = mask.type === "ellipse" ? "ellipse" : "rect"
    let cloze: string = "{{c" + mask.ordinal + "::image-occlusion:" + shape +
        ":left=" + mask.left +
        ":top=" + mask.top +
        ":width=" + mask.width +
        ":height=" + mask.height
    if (mask.type === "ellipse" && mask.rx !== null && mask.ry !== null) {
        cloze += ":rx=" + mask.rx + ":ry=" + mask.ry
    }
    cloze += ":fill=" + mask.fill
    if (hideAll) {
        cloze += ":oi=1"
    }
    cloze += "}}"
    return cloze
}

/**Build the Occlusion field text from masks, ordered by ordinal.*/
export function occlusionField(masks: IOMask[], hideAll: boolean): string {
    return masks
        .slice()
        .sort((a, b) => a.ordinal - b.ordinal)
        .map(mask => maskToCloze(mask, hideAll))
        .join("<br>")
}

/**Assign cloze ordinals to mask element ids, preserving existing mappings and
keeping gaps left by deleted masks (mirrors Anki's own IO editor).*/
export function assignOrdinals(
    elementIds: string[],
    record: IOFrameRecord
): Record<string, number> {
    const maskOrdinals: Record<string, number> = {}
    const used: Set<number> = new Set(Object.values(record.maskOrdinals))
    for (let elementId of elementIds) {
        if (record.maskOrdinals.hasOwnProperty(elementId)) {
            maskOrdinals[elementId] = record.maskOrdinals[elementId]
        } else {
            let ordinal: number = 1
            while (used.has(ordinal)) {
                ordinal += 1
            }
            used.add(ordinal)
            maskOrdinals[elementId] = ordinal
        }
    }
    record.maskOrdinals = maskOrdinals
    return maskOrdinals
}

export function buildOcclusionNote(
    fieldNames: string[],
    template: AnkiConnectNote,
    masks: IOMask[],
    imageFilename: string,
    header: string,
    backExtra: string,
    comments: string,
    hideAll: boolean
): AnkiConnectNote | null {
    if (fieldNames.length < IO_FIELD_COUNT) {
        return null
    }
    const note: AnkiConnectNote = JSON.parse(JSON.stringify(template))
    note["modelName"] = "Image Occlusion"
    const occlusion: string = occlusionField(masks, hideAll)
    if (!occlusion) {
        return null
    }
    note["fields"] = {}
    note["fields"][fieldNames[IO_FIELD_OCCLUSION]] = occlusion
    note["fields"][fieldNames[IO_FIELD_IMAGE]] = '<img src="' + imageFilename + '">'
    note["fields"][fieldNames[IO_FIELD_HEADER]] = header ? "<div>" + header + "</div>" : ""
    note["fields"][fieldNames[IO_FIELD_BACK_EXTRA]] = backExtra ? "<div>" + backExtra + "</div>" : ""
    note["fields"][fieldNames[IO_FIELD_COMMENTS]] = comments
    return note
}

/**Parse a frame's back-of-note section for fields + directives + ID + tags.
The section `Key:` labels are the note type's real field names (`fieldKeys`),
derived from the model — not from any setting.*/
export function parseSection(
    sectionText: string,
    fieldKeys: IOFieldKeys,
    config: IOConfig,
    deleteWord: string,
    frozenWord: string
): { identifier: number | null; frozen: boolean; deleteNote: boolean; hideAll: boolean; tags: string[]; fieldValues: Record<string, string> } {
    let identifier: number | null = null
    let frozen: boolean = false
    let deleteNote: boolean = false
    let hideAll: boolean = false
    let tags: string[] = []
    const fieldValues: Record<string, string> = {}
    const keyRegexps: Array<[string, RegExp]> = [
        [fieldKeys.headerKey, new RegExp("^" + escapeRegex(fieldKeys.headerKey) + "\\s*:\\s*(.*)$")],
        [fieldKeys.backExtraKey, new RegExp("^" + escapeRegex(fieldKeys.backExtraKey) + "\\s*:\\s*(.*)$")],
        [fieldKeys.commentsKey, new RegExp("^" + escapeRegex(fieldKeys.commentsKey) + "\\s*:\\s*(.*)$")],
        [config.hideAllKey, new RegExp("^" + escapeRegex(config.hideAllKey) + "\\s*:\\s*(.*)$")]
    ]
    for (let line of sectionText.split("\n")) {
        const trimmed: string = line.trim()
        if (trimmed === "") {
            continue
        }
        const idMatch = line.match(ID_LINE_REGEXP)
        if (idMatch) {
            identifier = parseInt(idMatch[1])
            continue
        }
        if (trimmed === deleteWord) {
            deleteNote = true
            continue
        }
        if (trimmed === frozenWord) {
            frozen = true
            continue
        }
        // Per-frame note tags: `Tags: a b` anywhere in the section, last match
        // wins. Never stored in fieldValues (mirrors vanilla note parsing).
        const tagsMatch = trimmed.match(/^Tags\s*:\s*(.*)$/)
        if (tagsMatch) {
            tags = parseTagString(tagsMatch[1])
            continue
        }
        for (let [key, regexp] of keyRegexps) {
            const valueMatch = line.match(regexp)
            if (valueMatch) {
                fieldValues[key] = valueMatch[1].trim()
                if (key === config.hideAllKey) {
                    hideAll = valueMatch[1].trim().toLowerCase() === "true"
                }
                break
            }
        }
    }
    return { identifier, frozen, deleteNote, hideAll, tags, fieldValues }
}

/**Find the back-of-note section a frame links to, returning offsets in the file.
Supports `[[#Heading]]` / `[[Heading]]` links to a heading in the same file.
Returns `null` when there is no link, the link is a block reference, or the
linked heading does not exist — callers skip the frame then.*/
export function findSection(
    content: string,
    link: string | null,
    bodyInfo: BackOfNoteInfo
): { start: number; end: number; text: string } | null {
    const headingTarget: string | null = headingFromLink(link)
    if (headingTarget) {
        for (let heading of bodyInfo.headings) {
            if (heading.heading.trim() === headingTarget) {
                return {
                    start: heading.start,
                    end: heading.end,
                    text: content.slice(heading.start, heading.end)
                }
            }
        }
    }
    return null
}

function headingFromLink(link: string | null): string | null {
    if (!link) {
        return null
    }
    const inner: string = link.slice(2, link.length - 2)
    const hashIndex: number = inner.indexOf("#")
    const target: string = hashIndex >= 0 ? inner.slice(hashIndex + 1) : inner
    if (target.startsWith("^")) {
        return null // block reference, unsupported in v1
    }
    const pathIndex: number = target.indexOf("/")
    const cleanTarget: string = pathIndex >= 0 ? target.slice(pathIndex + 1) : target
    if (!cleanTarget) {
        return null
    }
    return cleanTarget.replace(/#+$/, "").trim()
}

/**Compute a deterministic filename for image bytes (md5 + mime extension).*/
export function mediaFilename(data: string, mimeType: string): string {
    const hash: string = Md5.hashStr(data) as string
    const ext: string = extensionFromMime(mimeType)
    return hash + ext
}

function extensionFromMime(mimeType: string): string {
    switch (mimeType) {
        case "image/png":
            return ".png"
        case "image/jpeg":
            return ".jpg"
        case "image/gif":
            return ".gif"
        case "image/webp":
            return ".webp"
        case "image/svg+xml":
            return ".svg"
        default:
            return ".png"
    }
}

/**Find a drawing's Image Occlusion frames (title hardcoded, not configurable).*/
export function occlusionFrames(drawing: ParsedDrawing): ExcalidrawElement[] {
    const alive: ExcalidrawElement[] = drawing.elements.filter(element => !element.isDeleted)
    return alive.filter(element => element.type === "frame" && element.name === IO_FRAME_TITLE)
}

/**Find the mask elements (rect/ellipse) inside a frame, in array order.*/
export function frameMasks(drawing: ParsedDrawing, frame: ExcalidrawElement): ExcalidrawElement[] {
    return drawing.elements.filter(
        element =>
            !element.isDeleted &&
            element.frameId === frame.id &&
            (element.type === "rectangle" || element.type === "ellipse")
    )
}

/**Find the renderable objects inside a frame (everything that is not a mask):
images, text, arrows/lines/freedraw, diamonds, and rects/ellipses that failed
mask geometry (no-fill, tiny, opacity-0). These are composited into the card's
SVG picture.*/
export function frameRenderObjects(
    drawing: ParsedDrawing,
    frame: ExcalidrawElement,
    masks: IOMask[]
): ExcalidrawElement[] {
    const maskIds: Set<string> = new Set(masks.map(mask => mask.elementId))
    return drawing.elements.filter(
        element =>
            !element.isDeleted &&
            element.frameId === frame.id &&
            element.type !== "frame" &&
            !maskIds.has(element.id)
    )
}

/**Compute the per-frame hash that gates no-op updates. Excludes the
plugin-managed ID/freeze/delete lines (they never trigger a re-sync). `svg` is
the rendered SVG string, so any non-mask object (or image bytes) change it.*/
export function frameHash(
    masks: IOMask[],
    svg: string,
    fieldValues: Record<string, string>,
    hideAll: boolean,
    deck: string,
    tags: string
): string {
    const payload = {
        masks: masks
            .slice()
            .sort((a, b) => a.ordinal - b.ordinal)
            .map(mask => ({
                id: mask.elementId,
                type: mask.type,
                left: mask.left,
                top: mask.top,
                width: mask.width,
                height: mask.height,
                rx: mask.rx,
                ry: mask.ry,
                fill: mask.fill
            })),
        svg,
        fieldValues,
        hideAll,
        deck,
        tags
    }
    return Md5.hashStr(JSON.stringify(payload)) as string
}

/**Extract the `## Embedded Files`-style vault path for a file id, if any.*/
export function embeddedFileVaultPath(drawing: ParsedDrawing, fileId: string): string | null {
    return drawing.embeddedFiles.hasOwnProperty(fileId) ? drawing.embeddedFiles[fileId] : null
}

/**Get an element's link from the drawing's element links or its own link attr.*/
export function elementLink(drawing: ParsedDrawing, elementId: string): string | null {
    if (drawing.elementLinks.hasOwnProperty(elementId)) {
        return drawing.elementLinks[elementId]
    }
    const element = drawing.elements.find(e => e.id === elementId)
    return element && element.link ? element.link : null
}
