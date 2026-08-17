/*Parsing Excalidraw scene data out of `.excalidraw.md` files.*/

import { decompressFromBase64 } from 'lz-string'

export interface ExcalidrawElement {
    id: string
    type: string
    x: number
    y: number
    width: number
    height: number
    angle: number
    backgroundColor?: string
    strokeColor?: string
    fillStyle?: string
    strokeWidth?: number
    strokeStyle?: string
    roundness?: { type?: string; value?: number }
    points?: [number, number][]
    text?: string
    fontSize?: number
    fontFamily?: number
    textAlign?: string
    verticalAlign?: string
    containerId?: string | null
    startArrowhead?: string | null
    endArrowhead?: string | null
    fileId?: string
    opacity?: number
    isDeleted?: boolean
    frameId?: string
    link?: string | null
    name?: string
}

export interface ExcalidrawFileData {
    mimeType?: string
    dataURL?: string
}

export interface ParsedDrawing {
    elements: ExcalidrawElement[]
    files: Record<string, ExcalidrawFileData>
    embeddedFiles: Record<string, string>
    elementLinks: Record<string, string>
}

export interface ExcalidrawCodeblock {
    lang: string
    data: string
    start: number
    end: number
}

const FENCE_REGEXP: RegExp = /```([\w-]*)\n([\s\S]*?)```/g
const DRAWING_HEADING_REGEXP: RegExp = /^#{1,6}\s*Drawing\s*$/m
const EXCALIDRAW_DATA_HEADING_REGEXP: RegExp = /^# Excalidraw Data\s*$/m
const TEXT_ELEMENTS_HEADING_REGEXP: RegExp = /^# Text Elements\s*$/m

export function escapeRegex(str: string): string {
    return str.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')
}

/**Decode a compressed-json (LZ-String) Excalidraw drawing into raw JSON text.*/
export function decompressDrawing(encoded: string): string | null {
    // Excalidraw writes compressed base64 in chunks separated by blank lines
    // (see its `compress` helper); lz-string cannot decode line breaks.
    return decompressFromBase64(encoded.replace(/[\r\n]+/g, ""))
}

/**Find the Excalidraw drawing codeblock (json or compressed-json) in a file.*/
export function findDrawingCodeblock(content: string): ExcalidrawCodeblock | null {
    let drawingHeadingIndex: number = -1
    const drawingHeading = content.match(DRAWING_HEADING_REGEXP)
    if (drawingHeading) {
        drawingHeadingIndex = drawingHeading.index
    }
    let blocks: ExcalidrawCodeblock[] = []
    for (let match of content.matchAll(FENCE_REGEXP)) {
        const lang: string = match[1]
        if (lang !== "json" && lang !== "compressed-json") {
            continue
        }
        blocks.push({
            lang: lang,
            data: match[2],
            start: match.index,
            end: match.index + match[0].length
        })
    }
    // Prefer a block that follows a `# Drawing` heading.
    if (drawingHeadingIndex >= 0) {
        const afterDrawing = blocks.filter(block => block.start > drawingHeadingIndex)
        if (afterDrawing.length > 0) {
            return afterDrawing[0]
        }
    }
    // Fall back to the first json/compressed-json block whose content is a valid
    // Excalidraw scene (has an "elements" key).
    for (let block of blocks) {
        let text = block.data
        if (block.lang === "compressed-json") {
            text = decompressDrawing(text)
        }
        if (text === null) {
            continue
        }
        try {
            const parsed = JSON.parse(text)
            if (parsed && Array.isArray(parsed.elements)) {
                return block
            }
        } catch (e) {
            // not JSON, keep looking
        }
    }
    return null
}

/**Parse a raw scene JSON text into drawing data.*/
export function parseSceneJSON(jsonText: string): { elements: ExcalidrawElement[]; files: Record<string, ExcalidrawFileData> } {
    const scene = JSON.parse(jsonText)
    const elements: ExcalidrawElement[] = Array.isArray(scene.elements) ? scene.elements : []
    const files: Record<string, ExcalidrawFileData> = scene.files && typeof scene.files === "object" ? scene.files : {}
    return { elements, files }
}

function parseLinkSection(content: string, sectionHeading: RegExp): Record<string, string> {
    const result: Record<string, string> = {}
    const headingMatch = content.match(sectionHeading)
    if (!headingMatch) {
        return result
    }
    const start: number = headingMatch.index + headingMatch[0].length
    // Section runs to the next `# `-level heading or the first %% fence.
    const endMatch = content.slice(start).match(/(?:^# |%%\s*$)/m)
    const end: number = endMatch ? start + endMatch.index : content.length
    const section = content.slice(start, end)
    for (let line of section.split("\n")) {
        const colon: number = line.indexOf(":")
        if (colon < 0) {
            continue
        }
        const key: string = line.slice(0, colon).trim()
        const value: string = line.slice(colon + 1).trim()
        if (!key || !value) {
            continue
        }
        result[key] = value
    }
    return result
}

/**Parse the full `.excalidraw.md` file into drawing data + section markers.*/
export function parseDrawing(content: string): ParsedDrawing | null {
    const codeblock = findDrawingCodeblock(content)
    if (!codeblock) {
        return null
    }
    let text: string = codeblock.data
    if (codeblock.lang === "compressed-json") {
        const decompressed = decompressDrawing(codeblock.data)
        if (decompressed === null) {
            return null
        }
        text = decompressed
    }
    const { elements, files } = parseSceneJSON(text)
    return {
        elements,
        files,
        embeddedFiles: parseLinkSection(content, /^## Embedded Files\s*$/m),
        elementLinks: parseLinkSection(content, /^## Element Links\s*$/m)
    }
}

export interface BackOfNoteInfo {
    bodyStart: number
    bodyEnd: number
    headings: Array<{ level: number; heading: string; start: number; end: number }>
}

/**Find the back-of-note body region and its headings (above the drawing section).*/
export function findBackOfNote(content: string): BackOfNoteInfo {
    const bodyStart: number = frontmatterEnd(content)
    let bodyEnd: number = content.length
    // The drawing section begins at the first %% fence or the Excalidraw headings.
    for (let marker of [
        /^%%\s*$/m,
        EXCALIDRAW_DATA_HEADING_REGEXP,
        TEXT_ELEMENTS_HEADING_REGEXP
    ]) {
        const match = content.slice(bodyStart).match(marker)
        if (match) {
            const candidate: number = bodyStart + match.index
            if (candidate < bodyEnd) {
                bodyEnd = candidate
            }
        }
    }
    const headings: Array<{ level: number; heading: string; start: number; end: number }> = []
    for (let match of content.slice(bodyStart, bodyEnd).matchAll(/^(#{1,6})\s+(.*?)\s*$/gm)) {
        const headingOffset: number = bodyStart + match.index
        const headingText: string = match[2].replace(/[#\s]+$/, "")
        headings.push({
            level: match[1].length,
            heading: headingText,
            start: headingOffset,
            end: headingOffset + match[0].length
        })
    }
    // Fill in each heading's end = start of the next heading (or bodyEnd).
    for (let index in headings) {
        const i: number = parseInt(index)
        headings[i].end = i + 1 < headings.length ? headings[i + 1].start : bodyEnd
    }
    return { bodyStart, bodyEnd, headings }
}

function frontmatterEnd(content: string): number {
    if (!content.startsWith("---")) {
        return 0
    }
    const close = content.slice(3).match(/^---[ \t]*$/m)
    if (!close) {
        return 0
    }
    return close.index + 3
}

/**Add/update the `anki-occlusion: true` marker in a file's frontmatter. When
the file has a closed frontmatter block, the marker line is updated in place
(or inserted right after the opening `---`); otherwise a fresh block is
prepended. Only the marker line is touched — other keys are preserved.*/
export function setIOMarker(content: string): string {
    const close = frontmatterEnd(content)
    if (content.startsWith("---") && close > 0) {
        const openingEnd: number = content.indexOf("\n")
        const body: string = content.slice(openingEnd + 1, close)
        const lines: string[] = body.split("\n")
        const markerIndex: number = lines.findIndex(line => /^\s*anki-occlusion\s*:.*$/.test(line))
        if (markerIndex === -1) {
            lines.unshift("anki-occlusion: true")
        } else {
            lines[markerIndex] = "anki-occlusion: true"
        }
        return content.slice(0, openingEnd + 1) + lines.join("\n") + content.slice(close)
    }
    return "---\nanki-occlusion: true\n---\n\n" + content
}

/**Remove the `anki-occlusion:` line(s) from a file's frontmatter. Files with
no such line (or no frontmatter) are returned unchanged.*/
export function clearIOMarker(content: string): string {
    const close = frontmatterEnd(content)
    if (content.startsWith("---") && close > 0) {
        const openingEnd: number = content.indexOf("\n")
        const body: string = content.slice(openingEnd + 1, close)
        const lines: string[] = body.split("\n")
        const kept: string[] = lines.filter(line => !/^\s*anki-occlusion\s*:.*$/.test(line))
        if (kept.length === lines.length) {
            return content
        }
        return content.slice(0, openingEnd + 1) + kept.join("\n") + content.slice(close)
    }
    return content
}
