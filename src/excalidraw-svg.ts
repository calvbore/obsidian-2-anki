/*Deterministic SVG compositing of a frame's non-mask objects into the card's
picture (Phase 1-B). The output must be **byte-identical** to the pure-stdlib
mirror `obsidian_io.py::render_scene_svg` — the SVG's md5 is the media
filename, so any drift would make the TS plugin and Python CLI reference
different files for the same drawing. Keep both implementations in sync.

All numeric output goes through `fmt()` (round4 then JS `String`); all
attributes use a fixed order; elements render in scene-array order.*/

import { ExcalidrawElement } from './excalidraw'

export interface ImageData {
    mimeType: string
    /**Base64 payload, without the `data:<mime>;base64,` prefix.*/
    data: string
}

const XML_ESCAPES: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;"
}

export function xmlEscape(text: string): string {
    return text.replace(/[&<>"']/g, ch => XML_ESCAPES[ch])
}

function round4(value: number): number {
    return Math.round(value * 10000) / 10000
}

/**Format a coordinate like JS `String(x)` (integers lose the ".0").*/
function fmt(value: number): string {
    const r = round4(value)
    if (r === 0) {
        return "0"
    }
    if (Number.isInteger(r)) {
        return String(r)
    }
    return String(r)
}

function normalizeColor(color: string | undefined): string | null {
    if (!color) {
        return null
    }
    const c = color.trim()
    return /^#[0-9a-fA-F]{6}$/.test(c) ? c.toLowerCase() : null
}

function fillStyleOf(element: ExcalidrawElement): string {
    return element.fillStyle || "hachure"
}

function patternId(style: string, color: string): string {
    return "io-" + style + "-" + color.slice(1)
}

/**Resolve an element's SVG `fill` attribute (pattern-ref for sketchy styles).*/
function resolveFill(element: ExcalidrawElement): string {
    const color: string | null = normalizeColor(element.backgroundColor)
    if (!color) {
        return "none"
    }
    const style: string = fillStyleOf(element)
    if (style === "hachure" || style === "cross-hatch" || style === "zigzag" || style === "dots") {
        return "url(#" + patternId(style, color) + ")"
    }
    return color
}

function dashArray(strokeStyle: string | undefined): string | null {
    if (strokeStyle === "dashed") {
        return "8,6"
    }
    if (strokeStyle === "dotted") {
        return "1,4"
    }
    return null
}

function roundnessRadius(element: ExcalidrawElement): number | null {
    const roundness = element.roundness
    if (roundness && typeof roundness.value === "number" && roundness.value > 0) {
        const radius = roundness.value * Math.min(element.width || 0, element.height || 0)
        return round4(radius)
    }
    return null
}

function patternDef(style: string, color: string): string {
    const id: string = patternId(style, color)
    const stroke: string = '<line x1="0" y1="0" x2="8" y2="8" stroke="' + color + '" stroke-width="1" stroke-opacity="0.4"/>'
    const open: string = '<pattern id="' + id + '" width="8" height="8" patternUnits="userSpaceOnUse">'
    if (style === "hachure") {
        return open + stroke + "</pattern>"
    }
    if (style === "cross-hatch") {
        return open + stroke + '<line x1="8" y1="0" x2="0" y2="8" stroke="' + color + '" stroke-width="1" stroke-opacity="0.4"/></pattern>'
    }
    if (style === "zigzag") {
        return open + '<polyline points="0,5 2,1 4,5 6,1 8,5" fill="none" stroke="' + color + '" stroke-width="1" stroke-opacity="0.4"/></pattern>'
    }
    return open + '<circle cx="4" cy="4" r="1.4" fill="' + color + '" fill-opacity="0.6"/></pattern>'
}

interface ElemRenderer {
    lines: string[]
    patterns: string[]
    seen: Set<string>
    imageData: Record<string, ImageData>
}

function registerPattern(renderer: ElemRenderer, style: string, color: string): void {
    const id: string = patternId(style, color)
    if (!renderer.seen.has(id)) {
        renderer.seen.add(id)
        renderer.patterns.push(patternDef(style, color))
    }
}

function baseAttributes(element: ExcalidrawElement, fill: string): string {
    const stroke: string = normalizeColor(element.strokeColor) || "#1e1e1e"
    const strokeWidth: number = element.strokeWidth != null ? element.strokeWidth : 1
    const alpha: number = element.opacity != null ? element.opacity / 100 : 1
    let attrs: string = 'fill="' + fill + '" stroke="' + stroke + '" stroke-width="' + fmt(strokeWidth) + '" opacity="' + fmt(alpha) + '"'
    const dash: string | null = dashArray(element.strokeStyle)
    if (dash) {
        attrs += ' stroke-dasharray="' + dash + '"'
    }
    return attrs
}

function emitArrowhead(renderer: ElemRenderer, tipX: number, tipY: number, dirX: number, dirY: number, stroke: string, strokeWidth: number): void {
    const length: number = Math.hypot(dirX, dirY)
    if (length === 0) {
        return
    }
    const headLength: number = Math.max(8, strokeWidth * 4)
    const headWidth: number = headLength * 0.4
    const ux: number = dirX / length
    const uy: number = dirY / length
    const baseX: number = tipX - ux * headLength
    const baseY: number = tipY - uy * headLength
    const w1X: number = baseX + -uy * headWidth
    const w1Y: number = baseY + ux * headWidth
    const w2X: number = baseX + uy * headWidth
    const w2Y: number = baseY + -ux * headWidth
    renderer.lines.push(
        '<polygon points="' + fmt(tipX) + ',' + fmt(tipY) + " " + fmt(w1X) + ',' + fmt(w1Y) + " " + fmt(w2X) + ',' + fmt(w2Y) +
        '" fill="' + stroke + '" stroke="none"/>'
    )
}

function emitPolyline(renderer: ElemRenderer, element: ExcalidrawElement): void {
    const points: [number, number][] = element.points || []
    if (points.length < 2) {
        return
    }
    const coords: string = points
        .map(p => fmt(element.x + p[0]) + "," + fmt(element.y + p[1]))
        .join(" ")
    const stroke: string = normalizeColor(element.strokeColor) || "#1e1e1e"
    const strokeWidth: number = element.strokeWidth != null ? element.strokeWidth : 1
    const alpha: number = element.opacity != null ? element.opacity / 100 : 1
    renderer.lines.push(
        '<polyline points="' + coords + '" fill="none" stroke="' + stroke + '" stroke-width="' + fmt(strokeWidth) + '" opacity="' + fmt(alpha) +
        '" stroke-linecap="round" stroke-linejoin="round"' +
        (dashArray(element.strokeStyle) ? ' stroke-dasharray="' + dashArray(element.strokeStyle) + '"' : "") +
        "/>"
    )
    if (element.startArrowhead && points.length >= 2) {
        const p0 = points[0]
        const p1 = points[1]
        emitArrowhead(renderer, element.x + p0[0], element.y + p0[1], p0[0] - p1[0], p0[1] - p1[1], stroke, strokeWidth)
    }
    if (element.endArrowhead && points.length >= 2) {
        const last = points[points.length - 1]
        const prev = points[points.length - 2]
        emitArrowhead(renderer, element.x + last[0], element.y + last[1], last[0] - prev[0], last[1] - prev[1], stroke, strokeWidth)
    }
}

function emitText(renderer: ElemRenderer, element: ExcalidrawElement): void {
    const fontSize: number = element.fontSize || 20
    const family: string = element.fontFamily === 1 ? "cursive" : "sans-serif"
    const align: string = element.textAlign || "left"
    let textX: number = element.x
    if (align === "center") {
        textX = element.x - (element.width || 0) / 2
    } else if (align === "right") {
        textX = element.x - (element.width || 0)
    }
    const lines: string[] = (element.text || "").split("\n")
    const lineHeight: number = fontSize * 1.25
    const contentHeight: number = lineHeight * lines.length
    let baseline: number = element.y + fontSize
    const verticalAlign: string = element.verticalAlign || "top"
    if (verticalAlign === "middle") {
        baseline = element.y + Math.max(0, (element.height || 0) - contentHeight) / 2 + fontSize
    } else if (verticalAlign === "bottom") {
        baseline = element.y + Math.max(0, (element.height || 0) - contentHeight) + fontSize
    }
    const alpha: number = element.opacity != null ? element.opacity / 100 : 1
    const stroke: string = normalizeColor(element.strokeColor) || "#1e1e1e"
    let out: string =
        '<text x="' + fmt(textX) + '" y="' + fmt(baseline) + '" font-size="' + fmt(fontSize) +
        '" font-family="' + family + '" fill="' + stroke + '" opacity="' + fmt(alpha) + '">'
    for (let i = 0; i < lines.length; i++) {
        if (i === 0) {
            out += xmlEscape(lines[i])
        } else {
            out += '<tspan x="' + fmt(textX) + '" dy="' + fmt(lineHeight) + '">' + xmlEscape(lines[i]) + "</tspan>"
        }
    }
    out += "</text>"
    renderer.lines.push(out)
}

function renderElement(renderer: ElemRenderer, element: ExcalidrawElement): void {
    const inner: ElemRenderer = { lines: [], patterns: renderer.patterns, seen: renderer.seen, imageData: renderer.imageData }
    if (element.type === "rectangle") {
        let fill: string = resolveFill(element)
        if (fill.indexOf("url(#") === 0) {
            const color: string | null = normalizeColor(element.backgroundColor) as string
            registerPattern(renderer, fillStyleOf(element), color)
        }
        let line: string = '<rect x="' + fmt(element.x) + '" y="' + fmt(element.y) +
            '" width="' + fmt(element.width) + '" height="' + fmt(element.height) + '"'
        const rx: number | null = roundnessRadius(element)
        if (rx !== null) {
            line += ' rx="' + fmt(rx) + '"'
        }
        line += " " + baseAttributes(element, fill) + "/>"
        renderer.lines.push(line)
    } else if (element.type === "ellipse") {
        let fill: string = resolveFill(element)
        if (fill.indexOf("url(#") === 0) {
            registerPattern(renderer, fillStyleOf(element), normalizeColor(element.backgroundColor) as string)
        }
        renderer.lines.push(
            '<ellipse cx="' + fmt(element.x + element.width / 2) + '" cy="' + fmt(element.y + element.height / 2) +
            '" rx="' + fmt(element.width / 2) + '" ry="' + fmt(element.height / 2) + '" ' +
            baseAttributes(element, fill) + "/>"
        )
    } else if (element.type === "diamond") {
        let fill: string = resolveFill(element)
        if (fill.indexOf("url(#") === 0) {
            registerPattern(renderer, fillStyleOf(element), normalizeColor(element.backgroundColor) as string)
        }
        renderer.lines.push(
            '<polygon points="' + fmt(element.x + element.width / 2) + "," + fmt(element.y) +
            " " + fmt(element.x + element.width) + "," + fmt(element.y + element.height / 2) +
            " " + fmt(element.x + element.width / 2) + "," + fmt(element.y + element.height) +
            " " + fmt(element.x) + "," + fmt(element.y + element.height / 2) +
            '" ' + baseAttributes(element, fill) + "/>"
        )
    } else if (element.type === "line" || element.type === "arrow" || element.type === "freedraw") {
        emitPolyline(renderer, element)
    } else if (element.type === "text") {
        emitText(renderer, element)
    } else if (element.type === "image") {
        const image: ImageData | undefined = renderer.imageData[element.id]
        if (image) {
            const alpha: number = element.opacity != null ? element.opacity / 100 : 1
            renderer.lines.push(
                '<image href="data:' + image.mimeType + ";base64," + image.data +
                '" x="' + fmt(element.x) + '" y="' + fmt(element.y) +
                '" width="' + fmt(element.width) + '" height="' + fmt(element.height) +
                '" preserveAspectRatio="xMidYMid meet" opacity="' + fmt(alpha) + '"/>'
            )
        }
    }
}

/**Render a frame's non-mask objects into a deterministic SVG string.*/
export function renderSceneSvg(
    frame: ExcalidrawElement,
    objects: ExcalidrawElement[],
    imageData: Record<string, ImageData>
): string {
    const renderer: ElemRenderer = {
        lines: [],
        patterns: [],
        seen: new Set<string>(),
        imageData
    }
    for (const element of objects) {
        const angle: number = element.angle || 0
        if (angle !== 0) {
            const deg: number = round4((angle * 180) / Math.PI)
            const cx: number = round4(element.x + (element.width || 0) / 2)
            const cy: number = round4(element.y + (element.height || 0) / 2)
            renderer.lines.push('<g transform="rotate(' + fmt(deg) + " " + fmt(cx) + " " + fmt(cy) + ')">')
            renderElement(renderer, element)
            renderer.lines.push("</g>")
        } else {
            renderElement(renderer, element)
        }
    }
    let output: string = '<svg xmlns="http://www.w3.org/2000/svg" width="' + fmt(frame.width) +
        '" height="' + fmt(frame.height) + '" viewBox="' + fmt(frame.x) + " " + fmt(frame.y) + " " + fmt(frame.width) + " " + fmt(frame.height) + '">'
    if (renderer.patterns.length > 0) {
        output += "<defs>" + renderer.patterns.join("") + "</defs>"
    }
    output += renderer.lines.join("")
    output += "</svg>"
    return output
}