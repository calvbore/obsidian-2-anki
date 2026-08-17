"""Python parity for the Image Occlusion feature (mirrors `src/io.ts` and
`src/excalidraw.ts`). Pure stdlib: includes a small LZ-String base64
decompressor so compressed-json Excalidraw drawings can be read without the
`lz-string` npm package.

The built-in Anki Image Occlusion note type (23.10+) is an ordinary cloze
note. The Occlusion field holds one cloze per mask:
    {{c1::image-occlusion:rect:left=..:top=..:width=..:height=..:fill=#..}}
Each cloze's ordinal IS the card identity in Anki, so mask <-> ordinal
mapping is preserved in the plugin data file across syncs (see PLAN.md §6).
"""

import hashlib
import json
import math
import re


# --------------------------------------------------------------------------
# LZ-String (base64) decompression, ported from the reference JS implementation.
# --------------------------------------------------------------------------

_BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="
_BASE_REVERSE_DIC = {c: i for i, c in enumerate(_BASE64_ALPHABET)}


def _get_base_value(char):
    return _BASE_REVERSE_DIC.get(char, 0)


def _decompress_raw(length, reset_value, get_next_value):
    """Faithful port of lz-string's `_decompress` using an explicit state."""
    dictionary = [0, 1, 2]
    enlarge_in = 4
    dict_size = 4
    num_bits = 3
    entry = ""
    result = []
    state = {"val": get_next_value(0), "position": reset_value, "index": 1}

    def read_bits(n):
        bits = 0
        maxpower = 2 ** n
        power = 1
        while power != maxpower:
            resb = state["val"] & state["position"]
            state["position"] >>= 1
            if state["position"] == 0:
                state["position"] = reset_value
                state["val"] = get_next_value(state["index"])
                state["index"] += 1
            bits |= (1 if resb > 0 else 0) * power
            power <<= 1
        return bits

    next_val = read_bits(2)
    if next_val == 0:
        c = chr(read_bits(8))
    elif next_val == 1:
        c = chr(read_bits(16))
    elif next_val == 2:
        return ""
    else:
        return ""

    dictionary.append(c)  # dictionary[3] = c
    w = c
    result.append(c)
    while True:
        if state["index"] > length:
            return ""

        c = read_bits(num_bits)
        if c == 0:
            dictionary.append(chr(read_bits(8)))
            c = dict_size
            dict_size += 1
            enlarge_in -= 1
        elif c == 1:
            dictionary.append(chr(read_bits(16)))
            c = dict_size
            dict_size += 1
            enlarge_in -= 1
        elif c == 2:
            return "".join(result)

        if enlarge_in == 0:
            enlarge_in = 2 ** num_bits
            num_bits += 1

        if c < len(dictionary) and dictionary[c]:
            entry = dictionary[c]
        elif c == dict_size:
            entry = w + w[0]
        else:
            return None

        result.append(entry)

        dictionary.append(w + entry[0])
        dict_size += 1
        enlarge_in -= 1

        w = entry
        if enlarge_in == 0:
            enlarge_in = 2 ** num_bits
            num_bits += 1


def decompress_from_base64(encoded):
    """Decompress a base64-encoded lz-string string. Returns None on failure."""
    if encoded is None:
        return None
    if encoded == "":
        return None
    # Excalidraw writes compressed base64 in 256-char chunks separated by
    # blank lines; strip all line breaks before decoding (lz-string cannot).
    encoded = re.sub(r"[\r\n]+", "", encoded)

    def get_next_value(i):
        return _get_base_value(encoded[i])

    text = _decompress_raw(len(encoded), 32, get_next_value)
    if text is None:
        return None
    # lz-string produces a JS UTF-16 string; convert code units to a Python str.
    return text.encode("utf-16", "surrogatepass").decode("utf-16")


# --------------------------------------------------------------------------
# Excalidraw scene parsing (mirrors src/excalidraw.ts)
# --------------------------------------------------------------------------

_FENCE_REGEXP = re.compile(r"```([\w-]*)\n([\s\S]*?)```")
_DRAWING_HEADING_REGEXP = re.compile(r"^#{1,6}\s*Drawing\s*$", re.M)
_EXCALIDRAW_DATA_HEADING_REGEXP = re.compile(r"^# Excalidraw Data\s*$", re.M)
_TEXT_ELEMENTS_HEADING_REGEXP = re.compile(r"^# Text Elements\s*$", re.M)
_EMBEDDED_FILES_HEADING_REGEXP = re.compile(r"^## Embedded Files\s*$", re.M)
_ELEMENT_LINKS_HEADING_REGEXP = re.compile(r"^## Element Links\s*$", re.M)


def escape_regex(text):
    """Escape a string for use in a regular expression (JS-compatible)."""
    return re.sub(r"[-/\\^$*+?.()|[\]{}]", r"\\\g<0>", text)


def decompress_drawing(encoded):
    """Decode a compressed-json (LZ-String) Excalidraw drawing."""
    return decompress_from_base64(encoded)


def find_drawing_codeblock(content):
    """Find the Excalidraw drawing codeblock (json or compressed-json)."""
    drawing_heading_index = -1
    m = _DRAWING_HEADING_REGEXP.search(content)
    if m:
        drawing_heading_index = m.start()
    blocks = []
    for match in _FENCE_REGEXP.finditer(content):
        lang = match.group(1)
        if lang not in ("json", "compressed-json"):
            continue
        blocks.append(
            {
                "lang": lang,
                "data": match.group(2),
                "start": match.start(),
                "end": match.end(),
            }
        )
    if drawing_heading_index >= 0:
        after_drawing = [b for b in blocks if b["start"] > drawing_heading_index]
        if after_drawing:
            return after_drawing[0]
    for block in blocks:
        text = block["data"]
        if block["lang"] == "compressed-json":
            text = decompress_from_base64(text)
        if text is None:
            continue
        try:
            parsed = json.loads(text)
            if parsed and isinstance(parsed.get("elements"), list):
                return block
        except (ValueError, TypeError):
            continue
    return None


def parse_scene_json(json_text):
    """Parse a raw scene JSON text into (elements, files)."""
    try:
        scene = json.loads(json_text)
    except ValueError:
        scene = {}
    elements = scene.get("elements") if isinstance(scene, dict) else None
    if not isinstance(elements, list):
        elements = []
    files = scene.get("files")
    if not isinstance(files, dict):
        files = {}
    return elements, files


def parse_link_section(content, section_heading_regexp):
    """Parse a `key: value` link section (`## Element Links` / `## Embedded Files`)."""
    result = {}
    m = section_heading_regexp.search(content)
    if not m:
        return result
    start = m.end()
    end_match = re.compile(r"(?:^# |%%\s*$)", re.M).search(content[start:])
    end = start + end_match.start() if end_match else len(content)
    section = content[start:end]
    for line in section.split("\n"):
        colon = line.find(":")
        if colon < 0:
            continue
        key = line[:colon].strip()
        value = line[colon + 1:].strip()
        if not key or not value:
            continue
        result[key] = value
    return result


def parse_drawing(content):
    """Parse the full `.excalidraw.md` file into drawing data."""
    codeblock = find_drawing_codeblock(content)
    if not codeblock:
        return None
    text = codeblock["data"]
    if codeblock["lang"] == "compressed-json":
        text = decompress_from_base64(codeblock["data"])
        if text is None:
            return None
    elements, files = parse_scene_json(text)
    return {
        "elements": elements,
        "files": files,
        "embeddedFiles": parse_link_section(content, _EMBEDDED_FILES_HEADING_REGEXP),
        "elementLinks": parse_link_section(content, _ELEMENT_LINKS_HEADING_REGEXP),
    }


def _frontmatter_end(content):
    if not content.startswith("---"):
        return 0
    close = re.compile(r"^---[ \t]*$", re.M).search(content[3:])
    if not close:
        return 0
    return close.start() + 3


def find_back_of_note(content):
    """Find the back-of-note body region and its headings."""
    body_start = _frontmatter_end(content)
    body_end = len(content)
    for marker in (
        re.compile(r"^%%\s*$", re.M),
        _EXCALIDRAW_DATA_HEADING_REGEXP,
        _TEXT_ELEMENTS_HEADING_REGEXP,
    ):
        match = marker.search(content[body_start:])
        if match:
            candidate = body_start + match.start()
            if candidate < body_end:
                body_end = candidate
    headings = []
    for match in re.compile(r"^(#{1,6})\s+(.*?)\s*$", re.M).finditer(
        content[body_start:body_end]
    ):
        heading_offset = body_start + match.start()
        heading_text = re.sub(r"[#\s]+$", "", match.group(2))
        headings.append(
            {
                "level": len(match.group(1)),
                "heading": heading_text,
                "start": heading_offset,
                "end": heading_offset + len(match.group(0)),
            }
        )
    for i, heading in enumerate(headings):
        heading["end"] = (
            headings[i + 1]["start"] if i + 1 < len(headings) else body_end
        )
    return {"bodyStart": body_start, "bodyEnd": body_end, "headings": headings}


# --------------------------------------------------------------------------
# Image Occlusion builders (mirrors src/io.ts)
# --------------------------------------------------------------------------

IO_FIELD_OCCLUSION = 0
IO_FIELD_IMAGE = 1
IO_FIELD_HEADER = 2
IO_FIELD_BACK_EXTRA = 3
IO_FIELD_COMMENTS = 4
IO_FIELD_COUNT = 5

IO_FRAME_TITLE = "Image Occlusion"

# Settings-derived IO config: only the configurable `Hide all` directive word
# (a Syntax setting, like the DELETE/FROZEN words). The section `Key:` labels
# are the note type's real field names, derived by ordinal -- not settings.
DEFAULT_IO_CONFIG = {
    "hideAllKey": "Hide all",
}


def io_field_keys(field_names):
    """Derive the section field keys by ordinal from the note type's field names."""
    return {
        "headerKey": field_names[IO_FIELD_HEADER],
        "backExtraKey": field_names[IO_FIELD_BACK_EXTRA],
        "commentsKey": field_names[IO_FIELD_COMMENTS],
    }

_ID_LINE_REGEXP = re.compile(r"^(?:<!--)?ID: (\d+)(?:-->)?\s*$")


def normalize_fill(background_color):
    """Normalize an Excalidraw hex colour (#rrggbb or #aarrggbb) to #rrggbb."""
    if not background_color:
        return None
    color = str(background_color).strip()
    if color.startswith("#") and len(color) == 9:
        color = "#" + color[3:]
    if re.match(r"^#[0-9a-fA-F]{6}$", color):
        return color.lower()
    return None


def _round4(value):
    # Mirrors JS Math.round(value*10000)/10000 exactly (round-half toward +inf).
    return int(math.floor(value * 10000 + 0.5)) / 10000


def _fmt(value):
    """Format a coordinate like JS `String(x)` (integers lose the '.0')."""
    r = _round4(value)
    if r == 0:
        return "0"
    if r == int(r):
        return str(int(r))
    return repr(r)


def _xml_escape(text):
    """Escape text for inclusion in SVG/XML markup (JS-regex equivalence)."""
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


def _pattern_id(style, color):
    return "io-" + style + "-" + color[1:]


def _pattern_def(style, color):
    pid = _pattern_id(style, color)
    stroke = (
        '<line x1="0" y1="0" x2="8" y2="8" stroke="' + color +
        '" stroke-width="1" stroke-opacity="0.4"/>'
    )
    open_tag = (
        '<pattern id="' + pid + '" width="8" height="8" patternUnits="userSpaceOnUse">'
    )
    if style == "hachure":
        return open_tag + stroke + "</pattern>"
    if style == "cross-hatch":
        return (
            open_tag + stroke +
            '<line x1="8" y1="0" x2="0" y2="8" stroke="' + color +
            '" stroke-width="1" stroke-opacity="0.4"/></pattern>'
        )
    if style == "zigzag":
        return (
            open_tag +
            '<polyline points="0,5 2,1 4,5 6,1 8,5" fill="none" stroke="' + color +
            '" stroke-width="1" stroke-opacity="0.4"/></pattern>'
        )
    return (
        open_tag + '<circle cx="4" cy="4" r="1.4" fill="' + color +
        '" fill-opacity="0.6"/></pattern>'
    )


def _register_pattern(renderer, style, color):
    pid = _pattern_id(style, color)
    if pid not in renderer["seen"]:
        renderer["seen"].add(pid)
        renderer["patterns"].append(_pattern_def(style, color))


def _fill_style_of(element):
    return element.get("fillStyle") or "hachure"


def _normalize_hex(color):
    if not color:
        return None
    color = str(color).strip()
    if re.match(r"^#[0-9a-fA-F]{6}$", color):
        return color.lower()
    return None


def _resolve_fill(element):
    color = _normalize_hex(element.get("backgroundColor"))
    if not color:
        return "none"
    style = _fill_style_of(element)
    if style in ("hachure", "cross-hatch", "zigzag", "dots"):
        return "url(#" + _pattern_id(style, color) + ")"
    return color


def _dash_array(stroke_style):
    if stroke_style == "dashed":
        return "8,6"
    if stroke_style == "dotted":
        return "1,4"
    return None


def _roundness_radius(element):
    roundness = element.get("roundness")
    if isinstance(roundness, dict):
        value = roundness.get("value")
        if isinstance(value, (int, float)) and value > 0:
            return _round4(value * min(element.get("width", 0), element.get("height", 0)))
    return None


def _base_attributes(element, fill):
    stroke = _normalize_hex(element.get("strokeColor")) or "#1e1e1e"
    stroke_width = element.get("strokeWidth")
    if stroke_width is None:
        stroke_width = 1
    opacity = element.get("opacity")
    alpha = opacity / 100 if opacity is not None else 1
    attrs = (
        'fill="' + fill + '" stroke="' + stroke + '" stroke-width="' +
        _fmt(stroke_width) + '" opacity="' + _fmt(alpha) + '"'
    )
    dash = _dash_array(element.get("strokeStyle"))
    if dash:
        attrs += ' stroke-dasharray="' + dash + '"'
    return attrs


def _emit_polyline(renderer, element):
    points = element.get("points") or []
    if len(points) < 2:
        return
    coords = " ".join(
        _fmt(element.get("x", 0) + p[0]) + "," + _fmt(element.get("y", 0) + p[1])
        for p in points
    )
    stroke = _normalize_hex(element.get("strokeColor")) or "#1e1e1e"
    stroke_width = element.get("strokeWidth")
    if stroke_width is None:
        stroke_width = 1
    opacity = element.get("opacity")
    alpha = opacity / 100 if opacity is not None else 1
    dash = _dash_array(element.get("strokeStyle"))
    renderer["lines"].append(
        '<polyline points="' + coords + '" fill="none" stroke="' + stroke +
        '" stroke-width="' + _fmt(stroke_width) + '" opacity="' + _fmt(alpha) +
        '" stroke-linecap="round" stroke-linejoin="round"' +
        (' stroke-dasharray="' + dash + '"' if dash else "") + "/>"
    )
    if element.get("startArrowhead") and len(points) >= 2:
        p0 = points[0]
        p1 = points[1]
        _emit_arrowhead(
            renderer, element.get("x", 0) + p0[0], element.get("y", 0) + p0[1],
            p0[0] - p1[0], p0[1] - p1[1], stroke, stroke_width,
        )
    if element.get("endArrowhead") and len(points) >= 2:
        last = points[-1]
        prev = points[-2]
        _emit_arrowhead(
            renderer, element.get("x", 0) + last[0], element.get("y", 0) + last[1],
            last[0] - prev[0], last[1] - prev[1], stroke, stroke_width,
        )


def _emit_arrowhead(renderer, tip_x, tip_y, dir_x, dir_y, stroke, stroke_width):
    length = math.hypot(dir_x, dir_y)
    if length == 0:
        return
    head_length = max(8, stroke_width * 4)
    head_width = head_length * 0.4
    ux = dir_x / length
    uy = dir_y / length
    base_x = tip_x - ux * head_length
    base_y = tip_y - uy * head_length
    w1_x = base_x + -uy * head_width
    w1_y = base_y + ux * head_width
    w2_x = base_x + uy * head_width
    w2_y = base_y + -ux * head_width
    renderer["lines"].append(
        '<polygon points="' + _fmt(tip_x) + "," + _fmt(tip_y) + " " +
        _fmt(w1_x) + "," + _fmt(w1_y) + " " + _fmt(w2_x) + "," + _fmt(w2_y) +
        '" fill="' + stroke + '" stroke="none"/>'
    )


def _emit_text(renderer, element):
    font_size = element.get("fontSize") or 20
    family = "cursive" if element.get("fontFamily") == 1 else "sans-serif"
    align = element.get("textAlign") or "left"
    text_x = element.get("x", 0)
    width = element.get("width", 0) or 0
    if align == "center":
        text_x = element.get("x", 0) - width / 2
    elif align == "right":
        text_x = element.get("x", 0) - width
    text_lines = (element.get("text") or "").split("\n")
    line_height = font_size * 1.25
    content_height = line_height * len(text_lines)
    baseline = element.get("y", 0) + font_size
    vertical_align = element.get("verticalAlign") or "top"
    if vertical_align == "middle":
        baseline = element.get("y", 0) + max(0, (element.get("height", 0) or 0) - content_height) / 2 + font_size
    elif vertical_align == "bottom":
        baseline = element.get("y", 0) + max(0, (element.get("height", 0) or 0) - content_height) + font_size
    opacity = element.get("opacity")
    alpha = opacity / 100 if opacity is not None else 1
    stroke = _normalize_hex(element.get("strokeColor")) or "#1e1e1e"
    out = (
        '<text x="' + _fmt(text_x) + '" y="' + _fmt(baseline) +
        '" font-size="' + _fmt(font_size) + '" font-family="' + family +
        '" fill="' + stroke + '" opacity="' + _fmt(alpha) + '">'
    )
    for i, line in enumerate(text_lines):
        if i == 0:
            out += _xml_escape(line)
        else:
            out += '<tspan x="' + _fmt(text_x) + '" dy="' + _fmt(line_height) + '">' + _xml_escape(line) + "</tspan>"
    out += "</text>"
    renderer["lines"].append(out)


def _render_element(renderer, element, image_data):
    etype = element.get("type")
    if etype == "rectangle":
        fill = _resolve_fill(element)
        if fill.startswith("url(#"):
            _register_pattern(renderer, _fill_style_of(element), _normalize_hex(element.get("backgroundColor")))
        line = (
            '<rect x="' + _fmt(element.get("x", 0)) + '" y="' + _fmt(element.get("y", 0)) +
            '" width="' + _fmt(element.get("width", 0)) + '" height="' + _fmt(element.get("height", 0)) + '"'
        )
        rx = _roundness_radius(element)
        if rx is not None:
            line += ' rx="' + _fmt(rx) + '"'
        line += " " + _base_attributes(element, fill) + "/>"
        renderer["lines"].append(line)
    elif etype == "ellipse":
        fill = _resolve_fill(element)
        if fill.startswith("url(#"):
            _register_pattern(renderer, _fill_style_of(element), _normalize_hex(element.get("backgroundColor")))
        renderer["lines"].append(
            '<ellipse cx="' + _fmt(element.get("x", 0) + element.get("width", 0) / 2) +
            '" cy="' + _fmt(element.get("y", 0) + element.get("height", 0) / 2) +
            '" rx="' + _fmt(element.get("width", 0) / 2) +
            '" ry="' + _fmt(element.get("height", 0) / 2) + '" ' +
            _base_attributes(element, fill) + "/>"
        )
    elif etype == "diamond":
        fill = _resolve_fill(element)
        if fill.startswith("url(#"):
            _register_pattern(renderer, _fill_style_of(element), _normalize_hex(element.get("backgroundColor")))
        x = element.get("x", 0)
        y = element.get("y", 0)
        w = element.get("width", 0)
        h = element.get("height", 0)
        renderer["lines"].append(
            '<polygon points="' + _fmt(x + w / 2) + "," + _fmt(y) +
            " " + _fmt(x + w) + "," + _fmt(y + h / 2) +
            " " + _fmt(x + w / 2) + "," + _fmt(y + h) +
            " " + _fmt(x) + "," + _fmt(y + h / 2) +
            '" ' + _base_attributes(element, fill) + "/>"
        )
    elif etype in ("line", "arrow", "freedraw"):
        _emit_polyline(renderer, element)
    elif etype == "text":
        _emit_text(renderer, element)
    elif etype == "image":
        image = image_data.get(element.get("id"))
        if image:
            opacity = element.get("opacity")
            alpha = opacity / 100 if opacity is not None else 1
            renderer["lines"].append(
                '<image href="data:' + image["mimeType"] + ";base64," + image["data"] +
                '" x="' + _fmt(element.get("x", 0)) + '" y="' + _fmt(element.get("y", 0)) +
                '" width="' + _fmt(element.get("width", 0)) + '" height="' + _fmt(element.get("height", 0)) +
                '" preserveAspectRatio="xMidYMid meet" opacity="' + _fmt(alpha) + '"/>'
            )


def render_scene_svg(frame, objects, image_data):
    """Render a frame's non-mask objects into a deterministic SVG string.

    Mirrors `src/excalidraw-svg.ts::renderSceneSvg` byte-for-byte — the SVG's
    md5 is the Anki media filename, so the two implementations must agree.
    """
    renderer = {"lines": [], "patterns": [], "seen": set()}
    for element in objects:
        angle = element.get("angle") or 0
        if angle != 0:
            deg = _round4(angle * 180 / math.pi)
            cx = _round4(element.get("x", 0) + (element.get("width", 0) or 0) / 2)
            cy = _round4(element.get("y", 0) + (element.get("height", 0) or 0) / 2)
            renderer["lines"].append('<g transform="rotate(' + _fmt(deg) + " " + _fmt(cx) + " " + _fmt(cy) + ')">')
            _render_element(renderer, element, image_data)
            renderer["lines"].append("</g>")
        else:
            _render_element(renderer, element, image_data)
    output = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="' + _fmt(frame.get("width", 0)) +
        '" height="' + _fmt(frame.get("height", 0)) +
        '" viewBox="' + _fmt(frame.get("x", 0)) + " " + _fmt(frame.get("y", 0)) +
        " " + _fmt(frame.get("width", 0)) + " " + _fmt(frame.get("height", 0)) + '">'
    )
    if renderer["patterns"]:
        output += "<defs>" + "".join(renderer["patterns"]) + "</defs>"
    output += "".join(renderer["lines"])
    output += "</svg>"
    return output


def mask_geometry(mask, anchor):
    """Compute a mask's geometry against an anchor (the frame) bounds, or None to skip."""
    if mask.get("opacity") == 0:
        return None
    if mask.get("width", 0) < 5 or mask.get("height", 0) < 5:
        return None
    fill = normalize_fill(mask.get("backgroundColor"))
    if fill is None:
        return None
    aw = anchor.get("width", 0)
    ah = anchor.get("height", 0)
    if aw <= 0 or ah <= 0:
        return None
    left = (mask.get("x", 0) - anchor.get("x", 0)) / aw
    top = (mask.get("y", 0) - anchor.get("y", 0)) / ah
    width = mask.get("width", 0) / aw
    height = mask.get("height", 0) / ah
    if width <= 0 or height <= 0 or left >= 1 or top >= 1 or left + width <= 0 or top + height <= 0:
        return None
    left = max(0, min(1, left))
    top = max(0, min(1, top))
    width = max(0, min(1, left + width) - left)
    height = max(0, min(1, top + height) - top)
    if width * aw < 5 or height * ah < 5:
        return None
    is_ellipse = mask.get("type") == "ellipse"
    return {
        "left": _round4(left),
        "top": _round4(top),
        "width": _round4(width),
        "height": _round4(height),
        "rx": _round4(width / 2) if is_ellipse else None,
        "ry": _round4(height / 2) if is_ellipse else None,
        "fill": fill,
    }


def mask_to_cloze(mask, hide_all):
    """Build a single mask's cloze string."""
    shape = "ellipse" if mask["type"] == "ellipse" else "rect"
    cloze = (
        "{{c" + str(mask["ordinal"]) + "::image-occlusion:" + shape +
        ":left=" + _num(mask["left"]) +
        ":top=" + _num(mask["top"]) +
        ":width=" + _num(mask["width"]) +
        ":height=" + _num(mask["height"])
    )
    if mask["type"] == "ellipse" and mask.get("rx") is not None and mask.get("ry") is not None:
        cloze += ":rx=" + _num(mask["rx"]) + ":ry=" + _num(mask["ry"])
    cloze += ":fill=" + mask["fill"]
    if hide_all:
        cloze += ":oi=1"
    cloze += "}}"
    return cloze


def _num(value):
    # JS Number.prototype.toString for these rounded floats matches repr() of
    # the float, but avoid long reprs from float imprecision.
    return repr(float(value))


def occlusion_field(masks, hide_all):
    """Build the Occlusion field text from masks, ordered by ordinal."""
    ordered = sorted(masks, key=lambda m: m["ordinal"])
    return "<br>".join(mask_to_cloze(m, hide_all) for m in ordered)


def assign_ordinals(element_ids, record):
    """Assign cloze ordinals to mask element ids, preserving existing mappings."""
    mask_ordinals = {}
    used = set(record.get("maskOrdinals", {}).values())
    for element_id in element_ids:
        if element_id in record.get("maskOrdinals", {}):
            mask_ordinals[element_id] = record["maskOrdinals"][element_id]
        else:
            ordinal = 1
            while ordinal in used:
                ordinal += 1
            used.add(ordinal)
            mask_ordinals[element_id] = ordinal
    record["maskOrdinals"] = mask_ordinals
    return mask_ordinals


def build_occlusion_note(field_names, template, masks, image_filename, header, back_extra, comments, hide_all):
    """Build the AnkiConnect note dict, or None if it can't be built."""
    if len(field_names) < IO_FIELD_COUNT:
        return None
    note = dict(template)
    note["modelName"] = "Image Occlusion"
    occlusion = occlusion_field(masks, hide_all)
    if not occlusion:
        return None
    note["fields"] = {}
    note["fields"][field_names[IO_FIELD_OCCLUSION]] = occlusion
    note["fields"][field_names[IO_FIELD_IMAGE]] = '<img src="' + image_filename + '">'
    note["fields"][field_names[IO_FIELD_HEADER]] = "<div>" + header + "</div>" if header else ""
    note["fields"][field_names[IO_FIELD_BACK_EXTRA]] = "<div>" + back_extra + "</div>" if back_extra else ""
    note["fields"][field_names[IO_FIELD_COMMENTS]] = comments
    return note


def parse_section(section_text, field_keys, config, delete_word, frozen_word):
    """Parse a frame's back-of-note section for fields + directives + ID + tags.

    The section `Key:` labels are the note type's real field names
    (`field_keys`), derived from the model -- not from any setting."""
    identifier = None
    frozen = False
    delete_note = False
    hide_all = False
    tags = []
    field_values = {}
    key_regexps = [
        (field_keys["headerKey"], re.compile("^" + escape_regex(field_keys["headerKey"]) + r"\s*:\s*(.*)$")),
        (field_keys["backExtraKey"], re.compile("^" + escape_regex(field_keys["backExtraKey"]) + r"\s*:\s*(.*)$")),
        (field_keys["commentsKey"], re.compile("^" + escape_regex(field_keys["commentsKey"]) + r"\s*:\s*(.*)$")),
        (config["hideAllKey"], re.compile("^" + escape_regex(config["hideAllKey"]) + r"\s*:\s*(.*)$")),
    ]
    for line in section_text.split("\n"):
        trimmed = line.strip()
        if trimmed == "":
            continue
        id_match = _ID_LINE_REGEXP.match(line)
        if id_match:
            identifier = int(id_match.group(1))
            continue
        if trimmed == delete_word:
            delete_note = True
            continue
        if trimmed == frozen_word:
            frozen = True
            continue
        # Per-frame note tags: `Tags: a b` anywhere in the section, last match
        # wins. Never stored in field_values (mirrors vanilla note parsing).
        tags_match = re.match(r"^Tags\s*:\s*(.*)$", trimmed)
        if tags_match:
            tags = parse_tag_string(tags_match.group(1))
            continue
        for key, regexp in key_regexps:
            value_match = regexp.match(line)
            if value_match:
                field_values[key] = value_match.group(1).strip()
                if key == config["hideAllKey"]:
                    hide_all = value_match.group(1).strip().lower() == "true"
                break
    return {
        "identifier": identifier,
        "frozen": frozen,
        "delete": delete_note,
        "hideAll": hide_all,
        "tags": tags,
        "fieldValues": field_values,
    }


def parse_tag_string(raw):
    """Split a tag string by TAG_SEP and strip a single leading # from each tag."""
    result = []
    for t in raw.split(" "):
        if not t:
            continue
        if t.startswith("#") and len(t) > 1 and not t.startswith("##"):
            result.append(t[1:])
        else:
            result.append(t)
    return result


def heading_from_link(link):
    """Extract a heading name from an Obsidian link, or None."""
    if not link:
        return None
    inner = link[2:len(link) - 2]
    hash_index = inner.find("#")
    target = inner[hash_index + 1:] if hash_index >= 0 else inner
    if target.startswith("^"):
        return None  # block reference, unsupported in v1
    path_index = target.find("/")
    clean_target = target[path_index + 1:] if path_index >= 0 else target
    if not clean_target:
        return None
    return re.sub(r"#+$", "", clean_target).strip()


def find_section(content, link, body_info):
    """Find the back-of-note section a frame links to, with offsets.

    Returns None when there is no link, the link is a block reference, or the
    linked heading does not exist -- callers skip the frame then.
    """
    heading_target = heading_from_link(link)
    if heading_target:
        for heading in body_info["headings"]:
            if heading["heading"].strip() == heading_target:
                return {
                    "start": heading["start"],
                    "end": heading["end"],
                    "text": content[heading["start"]:heading["end"]],
                }
    return None


def media_filename(data, mime_type):
    """Compute a deterministic filename for image bytes (md5 + mime extension)."""
    hash_hex = hashlib.md5(data.encode("utf-8")).hexdigest()
    return hash_hex + _extension_from_mime(mime_type)


def _extension_from_mime(mime_type):
    ext = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/gif": ".gif",
        "image/webp": ".webp",
        "image/svg+xml": ".svg",
    }.get(mime_type, ".png")
    return ext


def occlusion_frames(drawing):
    """Find a drawing's Image Occlusion frames (title hardcoded)."""
    alive = [e for e in drawing["elements"] if not e.get("isDeleted")]
    return [e for e in alive if e.get("type") == "frame" and e.get("name") == IO_FRAME_TITLE]


def frame_masks(drawing, frame):
    """Find the mask elements (rect/ellipse) inside a frame, in array order."""
    return [
        e for e in drawing["elements"]
        if not e.get("isDeleted")
        and e.get("frameId") == frame["id"]
        and (e.get("type") == "rectangle" or e.get("type") == "ellipse")
    ]


def frame_render_objects(drawing, frame, masks):
    """Find the renderable objects inside a frame (everything that is not a mask)."""
    mask_ids = {m["elementId"] for m in masks}
    return [
        e for e in drawing["elements"]
        if not e.get("isDeleted")
        and e.get("frameId") == frame["id"]
        and e.get("type") != "frame"
        and e.get("id") not in mask_ids
    ]


def _num_repr(value):
    if value is None:
        return None
    return repr(float(value))


def frame_hash(masks, svg, field_values, hide_all, deck, tags):
    """Compute the per-frame hash that gates no-op updates. `svg` is the
    rendered SVG string, so any non-mask object (or image bytes) change it."""
    payload = {
        "masks": [
            {
                "id": m["elementId"],
                "type": m["type"],
                "left": _num_repr(m["left"]),
                "top": _num_repr(m["top"]),
                "width": _num_repr(m["width"]),
                "height": _num_repr(m["height"]),
                "rx": _num_repr(m.get("rx")),
                "ry": _num_repr(m.get("ry")),
                "fill": m["fill"],
            }
            for m in sorted(masks, key=lambda x: x["ordinal"])
        ],
        "svg": svg,
        "fieldValues": field_values,
        "hideAll": hide_all,
        "deck": deck,
        "tags": tags,
    }
    return hashlib.md5(
        json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    ).hexdigest()


def embedded_file_vault_path(drawing, file_id):
    """Extract the `## Embedded Files`-style vault path for a file id, if any."""
    return drawing["embeddedFiles"].get(file_id)


def element_link(drawing, element_id):
    """Get an element's link from the drawing's element links or its own link attr."""
    if element_id in drawing["elementLinks"]:
        return drawing["elementLinks"][element_id]
    for element in drawing["elements"]:
        if element.get("id") == element_id and element.get("link"):
            return element["link"]
    return None
