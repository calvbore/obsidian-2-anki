import base64
import hashlib
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
import obsidian_io as IO  # noqa
import obsidian_to_anki as ota  # noqa
from obsidian_to_anki import IOFile, App, MEDIA, NOTE_DICT_TEMPLATE  # noqa

FIELD_NAMES = ["Occlusion", "Image", "Header", "Back Extra", "Comments"]

# The section `Key:` labels are derived from the note type's field names (§16),
# so the parser config is built from the fixture FIELD_NAMES, not a setting.
IO_FIELD_KEYS = IO.io_field_keys(FIELD_NAMES)


def parse_section_with_field_names(text, delete_word="DELETE", frozen_word="FROZEN"):
    return IO.parse_section(text, IO_FIELD_KEYS, IO.DEFAULT_IO_CONFIG, delete_word, frozen_word)

BASE_SCENE = {
    "type": "excalidraw",
    "version": 2,
    "elements": [
        {"id": "frame1", "type": "frame", "name": "Image Occlusion", "x": 0, "y": 0, "width": 300, "height": 200, "angle": 0},
        {"id": "img1", "type": "image", "fileId": "file1", "x": 50, "y": 50, "width": 200, "height": 100, "angle": 0, "frameId": "frame1"},
        {"id": "mask1", "type": "rectangle", "x": 60, "y": 60, "width": 40, "height": 30, "angle": 0, "frameId": "frame1", "backgroundColor": "#ff0000"},
        {"id": "mask2", "type": "ellipse", "x": 150, "y": 70, "width": 60, "height": 50, "angle": 0, "frameId": "frame1", "backgroundColor": "#00ff00"},
        {"id": "gone", "type": "rectangle", "x": 0, "y": 0, "width": 10, "height": 10, "angle": 0, "frameId": "frame1", "backgroundColor": "#000000", "opacity": 0},
        {"id": "tiny", "type": "rectangle", "x": 80, "y": 80, "width": 3, "height": 3, "angle": 0, "frameId": "frame1", "backgroundColor": "#000000"},
        {"id": "text1", "type": "text", "x": 10, "y": 10, "width": 50, "height": 20, "angle": 0, "frameId": "frame1", "text": "hi"},
    ],
    "files": {},
}

# Known lz-string base64 of a small scene (generated with the lz-string npm
# package; kept here so the pure-stdlib decompressor is tested against a
# genuine lz-string encoding).
KNOWN_COMPRESSED = (
    "N4IgLgngDgpiBcIYA8DGBDANgSwCYCd0B3EAGhADcZ8BnbAewDsEAmcmTGA"
    "WxkbBoQBtUHgQh0ARjLhocRADNCPaY3TLEASS7oA5jAAEAeVSpMAVzpNpyB"
    "AAZyEO+SJ4wAC1a37INzGw63MAQJAFZbAF8AXXJ5bE4BeGBw8KA==="
)


def make_drawing_content(scene=None, extra_body="", element_links=None):
    scene = scene if scene is not None else BASE_SCENE
    json_text = json.dumps(scene, separators=(",", ":"))
    element_links = element_links if element_links is not None else "frame1: [[#Frame 1 Notes]]"
    return (
        "---\n"
        "anki-occlusion: true\n"
        "deck: My Deck\n"
        "---\n"
        "\n"
        "# Drawing\n"
        "\n"
        "```json\n"
        + json_text +
        "\n```\n"
        "\n"
        "FILE TAGS: obsidian io-test\n"
        "\n"
        "## Element Links\n"
        "\n"
        + element_links +
        "\n"
        "\n"
        "## Embedded Files\n"
        "\n"
        "file1: test-images/cat.png\n"
        "\n"
        "## Frame 1 Notes\n"
        "\n"
        "Header: Some header\n"
        "Back Extra: Some back extra\n"
        "Comments: My comment\n"
        + extra_body
    )


def build_masks(frame=None, image=None):
    drawing = IO.parse_drawing(make_drawing_content())
    frame = frame or IO.occlusion_frames(drawing)[0]
    masks = []
    for m in IO.frame_masks(drawing, frame):
        g = IO.mask_geometry(m, frame)
        if g:
            masks.append({
                "elementId": m["id"],
                "type": "ellipse" if m["type"] == "ellipse" else "rectangle",
                "ordinal": 0,
                **g,
            })
    record = {"maskOrdinals": {}, "noteId": None, "lastHash": None}
    ordinals = IO.assign_ordinals([m["elementId"] for m in masks], record)
    for m in masks:
        m["ordinal"] = ordinals[m["elementId"]]
    return masks


def test_decompress_known_lzstring():
    scene = json.loads(IO.decompress_from_base64(KNOWN_COMPRESSED))
    assert scene["elements"][0]["id"] == "a1"
    assert scene["elements"][0]["type"] == "frame"


def test_decompress_unicode():
    # é + CJK + emoji round-trip through the UTF-16 bridge
    out = IO.decompress_from_base64(
        "N4IgLgngDgpiBcIYA8DGBDANgSwCYCd0B3EAGhADcZ8BnbAewDsEAmcmTGA"
        "WxkbBoQBtUHgQgARgEYy4aHERgUYGYuTLEACwCXmTPQAEgA3lAvpr7AvBu"
        "AAPZABfALrkAZtk4D4wa9aA"
    )
    parsed = json.loads(out)
    assert parsed["elements"][0]["text"] == "héllo 你好 😀"


def test_parse_drawing_plain_json():
    drawing = IO.parse_drawing(make_drawing_content())
    assert drawing is not None
    assert len(drawing["elements"]) == 7
    assert drawing["embeddedFiles"]["file1"] == "test-images/cat.png"
    assert drawing["elementLinks"]["frame1"] == "[[#Frame 1 Notes]]"


def test_parse_drawing_compressed_json():
    compressed = IO.decompress_from_base64(KNOWN_COMPRESSED)
    content = (
        "---\nanki-occlusion: true\n---\n\n# Drawing\n\n```compressed-json\n"
        + KNOWN_COMPRESSED +
        "\n```\n"
    )
    drawing = IO.parse_drawing(content)
    assert drawing is not None
    assert compressed is not None and json.loads(compressed)["elements"]
    assert len(drawing["elements"]) == 1


def test_parse_drawing_no_drawing_returns_none():
    assert IO.parse_drawing("# Just a normal note\n\nNo drawing here.\n") is None


def test_decompress_from_base64_chunked():
    # Excalidraw 2.12.x `compress` helper writes compressed base64 in 256-char
    # chunks separated by blank lines; lz-string cannot decode raw line breaks.
    chunked = "\n\n".join(
        KNOWN_COMPRESSED[i:i + 256]
        for i in range(0, len(KNOWN_COMPRESSED), 256)
    )
    out = IO.decompress_from_base64(chunked)
    assert out is not None
    assert json.loads(out)["elements"]


def test_parse_drawing_v2_layout_compressed_chunked():
    # Obsidian Excalidraw 2.12.x saves drawings under a `# Excalidraw Data` /
    # `## Drawing` heading pair (level-2, not level-1) with chunked base64.
    payload = "\n\n".join(
        KNOWN_COMPRESSED[i:i + 256]
        for i in range(0, len(KNOWN_COMPRESSED), 256)
    )
    content = (
        "---\nanki-occlusion: true\n---\n\n# Excalidraw Data\n\n"
        "## Text Elements\n"
        "## Element Links\nframe1: [[#Drawing]]\n\n"
        "%%\n## Drawing\n```compressed-json\n" + payload +
        "\n```\n%%\n"
    )
    drawing = IO.parse_drawing(content)
    assert drawing is not None
    assert len(drawing["elements"]) == 1
    assert drawing["elementLinks"]["frame1"] == "[[#Drawing]]"


def test_mask_geometry_skips():
    drawing = IO.parse_drawing(make_drawing_content())
    frame = IO.occlusion_frames(drawing)[0]
    masks = IO.frame_masks(drawing, frame)
    geometries = [IO.mask_geometry(m, frame) for m in masks]
    viable = [g for g in geometries if g is not None]
    # opacity-0, <5px, and text elements are dropped
    assert len(viable) == 2
    assert geometries[0]["fill"] == "#ff0000"
    assert geometries[0]["rx"] is None
    assert geometries[1]["rx"] == 0.1 and geometries[1]["ry"] == 0.125
    assert geometries[0]["left"] == 0.2
    assert geometries[0]["top"] == 0.3
    assert geometries[0]["width"] == 0.1333
    assert geometries[0]["height"] == 0.15


def test_mask_geometry_image_free_frame():
    # No image element in the frame: geometry anchors to the frame bounds.
    frame_only_scene = {
        "type": "excalidraw",
        "version": 2,
        "elements": [
            {"id": "frame1", "type": "frame", "name": "Image Occlusion", "x": 0, "y": 0, "width": 300, "height": 200, "angle": 0},
            {"id": "mask1", "type": "rectangle", "x": 60, "y": 60, "width": 40, "height": 30, "angle": 0, "frameId": "frame1", "backgroundColor": "#ff0000"},
            {"id": "mask2", "type": "ellipse", "x": 150, "y": 70, "width": 60, "height": 50, "angle": 0, "frameId": "frame1", "backgroundColor": "#00ff00"},
        ],
        "files": {},
    }
    content = make_drawing_content(frame_only_scene)
    drawing = IO.parse_drawing(content)
    frame = IO.occlusion_frames(drawing)[0]
    geo = set(IO.mask_geometry(m, frame)["left"] for m in IO.frame_masks(drawing, frame))
    assert geo == {0.2, 0.5}


def test_frame_render_objects():
    drawing = IO.parse_drawing(make_drawing_content())
    frame = IO.occlusion_frames(drawing)[0]
    masks = build_masks(frame)
    objects = IO.frame_render_objects(drawing, frame, masks)
    ids = [o["id"] for o in objects]
    # masks excluded, image included; no-fill `gone` (opacity 0) and tiny
    # rects become render objects rather than masks
    assert "img1" in ids
    assert "text1" in ids
    assert "gone" in ids
    assert "tiny" in ids
    assert "mask1" not in ids
    assert "mask2" not in ids


def test_mask_to_cloze_and_hide_all():
    masks = build_masks()
    occlusion = IO.occlusion_field(masks, False)
    assert "{{c1::image-occlusion:rect:left=0.2:top=0.3:width=0.1333:height=0.15:fill=#ff0000}}" in occlusion
    assert "{{c2::image-occlusion:ellipse:left=0.5:top=0.35:width=0.2:height=0.25:rx=0.1:ry=0.125:fill=#00ff00}}" in occlusion
    assert "<br>" in occlusion
    occlusion_hide = IO.occlusion_field(masks, True)
    assert occlusion_hide.count(":oi=1}}") == 2


def test_assign_ordinals_gap_preserving():
    record = {"maskOrdinals": {"mask1": 1, "mask2": 2}, "noteId": None, "lastHash": None}
    # mask2 deleted; mask3 should get the next free ordinal (3), not 2
    new_ord = IO.assign_ordinals(["mask1", "mask3"], record)
    assert new_ord["mask1"] == 1
    assert new_ord["mask3"] == 3
    # and record is updated
    assert record["maskOrdinals"]["mask3"] == 3


def test_build_occlusion_note():
    masks = build_masks()
    template = dict(NOTE_DICT_TEMPLATE)
    note = IO.build_occlusion_note(
        FIELD_NAMES, template, masks, "abcd1234.svg",
        "Some header", "Some back extra", "My comment", False,
    )
    assert note["modelName"] == "Image Occlusion"
    assert note["fields"]["Image"] == '<img src="abcd1234.svg">'
    assert note["fields"]["Header"] == "<div>Some header</div>"
    assert note["fields"]["Back Extra"] == "<div>Some back extra</div>"
    assert note["fields"]["Comments"] == "My comment"
    assert note["fields"]["Occlusion"].startswith("{{c1::image-occlusion:")
    # Missing field names -> cannot build
    assert IO.build_occlusion_note(["Occlusion"], template, masks, "x.svg", "", "", "", False) is None


def test_parse_section_directives():
    content = make_drawing_content()
    body_info = IO.find_back_of_note(content)
    drawing = IO.parse_drawing(content)
    link = IO.element_link(drawing, "frame1")
    section = IO.find_section(content, link, body_info)
    parsed = parse_section_with_field_names(section["text"])
    assert parsed["identifier"] is None
    assert parsed["delete"] is False
    assert parsed["frozen"] is False
    assert parsed["hideAll"] is False
    assert parsed["fieldValues"]["Header"] == "Some header"

    # ID line
    with_id = content.replace("Comments: My comment", "Comments: My comment\n\n<!--ID: 1234-->")
    body2 = IO.find_back_of_note(with_id)
    section2 = IO.find_section(with_id, link, body2)
    parsed2 = parse_section_with_field_names(section2["text"])
    assert parsed2["identifier"] == 1234

    # DELETE + FROZEN + Hide all
    directive = content.replace(
        "Comments: My comment",
        "Comments: My comment\n\nHide all: true\n\nDELETE",
    )
    body3 = IO.find_back_of_note(directive)
    section3 = IO.find_section(directive, link, body3)
    parsed3 = parse_section_with_field_names(section3["text"])
    assert parsed3["delete"] is True
    assert parsed3["hideAll"] is True
    assert parsed3["fieldValues"]["Hide all"] == "true"

    frozen = content.replace("Comments: My comment", "Comments: My comment\n\nFROZEN")
    body4 = IO.find_back_of_note(frozen)
    section4 = IO.find_section(frozen, link, body4)
    parsed4 = parse_section_with_field_names(section4["text"])
    assert parsed4["frozen"] is True


def _parse_frame1_section(content):
    body_info = IO.find_back_of_note(content)
    drawing = IO.parse_drawing(content)
    link = IO.element_link(drawing, "frame1")
    section = IO.find_section(content, link, body_info)
    return parse_section_with_field_names(section["text"])


def test_parse_section_tags_line():
    # Default content has no `Tags:` line.
    parsed = _parse_frame1_section(make_drawing_content())
    assert parsed["tags"] == []

    # A `Tags:` line anywhere in the section yields note tags (leading `#`
    # stripped, blank entries dropped).
    tagged = make_drawing_content(extra_body="\nTags: #secret tag\n")
    parsed = _parse_frame1_section(tagged)
    assert parsed["tags"] == ["secret", "tag"]

    # Last match wins (mirrors the section-scoped line parser).
    two_lines = "\nTags: one\nTags: final two\n"
    parsed = _parse_frame1_section(make_drawing_content(extra_body=two_lines))
    assert parsed["tags"] == ["final", "two"]

    # Never leaks into fieldValues (even if a field listed it, `Tags:` is
    # reserved before the key-regexpass loop).
    parsed = _parse_frame1_section(make_drawing_content(extra_body="\nTags: one\n"))
    assert "Tags" not in parsed["fieldValues"]
    assert parsed["fieldValues"]["Header"] == "Some header"


def test_file_tags_override_frontmatter_tags(monkeypatch, tmp_path):
    # Decision 1: IO inherits vanilla FILE TAGS parsing; a frontmatter `tags:`
    # block is entirely unused for note tags.
    plain = make_drawing_content()
    # Reintroduce a frontmatter tags: block on top; global tags must come from
    # the FILE TAGS body line only, never the frontmatter.
    content = (
        plain.split("# Drawing")[0]
        + "tags:\n  - ignored\n  - list\n"
        + "# Drawing"
        + plain.split("# Drawing")[1]
    )
    _configure_io()
    fixture = tmp_path / "io_test.md"
    fixture.write_text(content, encoding="utf-8")
    io_file = IOFile(str(fixture))
    io_file.setup_global_tags()
    assert io_file.global_tags == "obsidian io-test"


def test_scan_file_add_merges_section_tags():
    _configure_io()
    import tempfile
    content = make_drawing_content(extra_body="\nTags: secret tag\n")
    with tempfile.TemporaryDirectory() as tmp:
        fixture_path = os.path.join(tmp, "io_test.md")
        with open(fixture_path, "w", encoding="utf-8") as f:
            f.write(content)
        img_dir = os.path.join(tmp, "test-images")
        os.makedirs(img_dir)
        with open(os.path.join(img_dir, "cat.png"), "wb") as f:
            f.write(b"\x89PNG\r\n\x1a\nfake-png-bytes")
        io_file = IOFile(fixture_path)
        io_file.scan_file()
        assert io_file.global_tags == "obsidian io-test"
        assert len(io_file.notes_to_add) == 1
        note = io_file.notes_to_add[0]
        # template + noteTags + global_tags, concatenated (no dedup)
        assert note["tags"] == ["Obsidian_to_Anki", "secret", "tag", "obsidian", "io-test"]


def test_frame_hash_sensitive_to_effective_tags():
    masks = build_masks()
    svg = IO.render_scene_svg(
        {"id": "frame1", "type": "frame", "name": "Image Occlusion", "x": 0, "y": 0, "width": 300, "height": 200, "angle": 0},
        [{"id": "text1", "type": "text", "x": 10, "y": 10, "width": 50, "height": 20, "angle": 0, "text": "hi"}],
        {},
    )
    fv = {"Header": "Some header", "Back Extra": "Some back extra", "Comments": "My comment", "Hide all": "false"}
    h1 = IO.frame_hash(masks, svg, fv, False, "My Deck", "obsidian io-test")
    # A `Tags:`/`#tag` change alone (effective-tag string) must re-sync.
    h2 = IO.frame_hash(masks, svg, fv, False, "My Deck", "obsidian io-test secret")
    assert h1 != h2
    # Same effective string -> identical hash (no-op dedup preserved).
    assert IO.frame_hash(masks, svg, fv, False, "My Deck", "obsidian io-test") == h1


def test_frame_hash_deterministic_and_sensitive():
    masks = build_masks()
    svg = IO.render_scene_svg(
        {"id": "frame1", "type": "frame", "name": "Image Occlusion", "x": 0, "y": 0, "width": 300, "height": 200, "angle": 0},
        [{"id": "text1", "type": "text", "x": 10, "y": 10, "width": 50, "height": 20, "angle": 0, "text": "hi"}],
        {},
    )
    fv = {"Header": "Some header", "Back Extra": "Some back extra", "Comments": "My comment", "Hide all": "false"}
    h1 = IO.frame_hash(masks, svg, fv, False, "My Deck", "obsidian io-test")
    h2 = IO.frame_hash(masks, svg, fv, False, "My Deck", "obsidian io-test")
    assert h1 == h2 and len(h1) == 32
    h3 = IO.frame_hash(masks, svg, fv, False, "Other Deck", "obsidian io-test")
    assert h1 != h3
    fv2 = dict(fv)
    fv2["Header"] = "Changed"
    h4 = IO.frame_hash(masks, svg, fv2, False, "My Deck", "obsidian io-test")
    assert h1 != h4
    # A non-mask object edit (different SVG) must re-sync too.
    svg2 = svg.replace(">hi<", ">hi there<")
    h5 = IO.frame_hash(masks, svg2, fv, False, "My Deck", "obsidian io-test")
    assert h1 != h5


def test_render_scene_svg_golden_and_content():
    frame = {"id": "frame1", "type": "frame", "name": "Image Occlusion", "x": 0, "y": 0, "width": 100, "height": 50, "angle": 0}
    objects = [
        {"id": "o1", "type": "rectangle", "x": 10, "y": 10, "width": 40, "height": 20, "angle": 0, "backgroundColor": "#ff0000", "fillStyle": "solid", "strokeColor": "#000000", "strokeWidth": 1, "opacity": 100},
        {"id": "o2", "type": "text", "x": 60, "y": 10, "width": 40, "height": 15, "angle": 0, "text": "Kidney label", "fontSize": 16, "fontFamily": 2, "textAlign": "left"},
        {"id": "o3", "type": "ellipse", "x": 10, "y": 30, "width": 20, "height": 14, "angle": 0, "backgroundColor": "#1971c2", "fillStyle": "hachure", "strokeColor": "#000000", "strokeWidth": 1},
        {"id": "o4", "type": "image", "x": 70, "y": 30, "width": 25, "height": 15, "angle": 0, "fileId": "f1"},
    ]
    image_data = {"o4": {"mimeType": "image/png", "data": "QUJDRA=="}}
    expected = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" viewBox="0 0 100 50">'
        '<defs><pattern id="io-hachure-1971c2" width="8" height="8" patternUnits="userSpaceOnUse">'
        '<line x1="0" y1="0" x2="8" y2="8" stroke="#1971c2" stroke-width="1" stroke-opacity="0.4"/></pattern></defs>'
        '<rect x="10" y="10" width="40" height="20" fill="#ff0000" stroke="#000000" stroke-width="1" opacity="1"/>'
        '<text x="60" y="26" font-size="16" font-family="sans-serif" fill="#1e1e1e" opacity="1">Kidney label</text>'
        '<ellipse cx="20" cy="37" rx="10" ry="7" fill="url(#io-hachure-1971c2)" stroke="#000000" stroke-width="1" opacity="1"/>'
        '<image href="data:image/png;base64,QUJDRA==" x="70" y="30" width="25" height="15" preserveAspectRatio="xMidYMid meet" opacity="1"/>'
        "</svg>"
    )
    svg = IO.render_scene_svg(frame, objects, image_data)
    assert svg == expected
    # Deterministic
    assert IO.render_scene_svg(frame, objects, image_data) == svg
    # Without a resolvable image, the element is simply omitted (frame works).
    svg_no_image = IO.render_scene_svg(frame, objects[:3], {})
    assert "data:image/png" not in svg_no_image
    assert "<text" in svg_no_image and "Kidney label" in svg_no_image


def test_render_scene_svg_rotation_and_arrowhead():
    frame = {"id": "frame1", "type": "frame", "name": "Image Occlusion", "x": 0, "y": 0, "width": 200, "height": 100, "angle": 0}
    objects = [
        {"id": "r1", "type": "rectangle", "x": 10, "y": 10, "width": 40, "height": 20, "angle": 0.5, "backgroundColor": "#ffffff", "fillStyle": "solid", "strokeColor": "#333333", "strokeWidth": 2, "strokeStyle": "dotted", "opacity": 50},
        {"id": "a1", "type": "arrow", "x": 60, "y": 60, "width": 90, "height": 40, "angle": 0, "points": [[0, 0], [60, 40], [90, 40]], "endArrowhead": "arrow", "strokeColor": "#1971c2", "strokeWidth": 2},
    ]
    svg = IO.render_scene_svg(frame, objects, {})
    assert 'stroke-dasharray="1,4"' in svg
    assert 'opacity="0.5"' in svg
    assert 'transform="rotate(28.6479 30 20)"' in svg
    assert "<polygon" in svg  # end arrowhead triangle
    assert svg.count("</g>") == 1


def test_media_filename_deterministic():
    a = IO.media_filename("iVBORw0KGgoAAAANSUhEUgAAAA==", "image/png")
    b = IO.media_filename("iVBORw0KGgoAAAANSUhEUgAAAA==", "image/png")
    assert a == b and a.endswith(".png")
    assert len(a) == 36  # 32-hex md5 + ".png"
    assert IO.media_filename("abc", "image/jpeg").endswith(".jpg")


def test_iofile_scan_file_adds_note(monkeypatch, tmp_path):
    # Synthetic Anki environment (no real collection)
    App.FIELDS_DICT = {"Image Occlusion": FIELD_NAMES}
    App.EXISTING_IDS = set()
    App.IO_FRAME_RECORDS = {}
    App.ADDED_MEDIA = []
    App.FILE_HASHES = {}
    MEDIA.clear()
    NOTE_DICT_TEMPLATE["tags"] = ["Obsidian_to_Anki"]
    NOTE_DICT_TEMPLATE["deckName"] = "Default"
    ota.CONFIG_DATA["Vault"] = ""
    ota.CONFIG_DATA["Add file link"] = False
    ota.CONFIG_DATA["IO_HIDE_ALL_WORD"] = "Hide all"
    ota.CONFIG_DATA["IO_DELETE_WORD"] = "DELETE"
    ota.CONFIG_DATA["IO_FROZEN_WORD"] = "FROZEN"
    ota.CONFIG_DATA["Comment"] = True
    _set_app_regexps()

    fixture = tmp_path / "io_test.md"
    fixture.write_text(make_drawing_content(), encoding="utf-8")
    img_dir = tmp_path / "test-images"
    img_dir.mkdir()
    (img_dir / "cat.png").write_bytes(b"\x89PNG\r\n\x1a\nfake-png-bytes")

    io_file = IOFile(str(fixture))

    io_file.scan_file()
    assert io_file.target_deck == "My Deck"
    assert io_file.global_tags == "obsidian io-test"
    assert len(io_file.notes_to_add) == 1
    note = io_file.notes_to_add[0]
    assert note["modelName"] == "Image Occlusion"
    assert note["deckName"] == "My Deck"
    assert note["tags"] == ["Obsidian_to_Anki", "obsidian", "io-test"]
    assert len(io_file.id_indexes) == 1
    # media registered: a single self-contained SVG (image embedded as data URI)
    assert len(MEDIA) == 1
    filename = list(MEDIA.keys())[0]
    assert filename.endswith(".svg")
    assert note["fields"]["Image"] == '<img src="' + filename + '">'
    svg_content = base64.b64decode(MEDIA[filename]).decode("utf-8")
    assert "<image" in svg_content and "data:image/png;base64" in svg_content
    # media md5 (of the raw SVG bytes) matches the filename it is stored under
    assert hashlib.md5(svg_content.encode("utf-8")).hexdigest() + ".svg" == filename

    # Simulated response: note was added with id 424242
    io_file.note_ids = [424242]
    record_key = str(fixture) + "::frame1"
    io_file.write_ids()
    assert "<!--ID: 424242-->" in io_file.file
    assert App.IO_FRAME_RECORDS[record_key]["noteId"] == 424242
    # hash recorded on next scan prevents duplicate
    io_file.notes_to_edit = []
    io_file.scan_file()
    assert len(io_file.notes_to_edit) == 0
    assert len(io_file.notes_to_add) == 0


def _configure_io():
    App.FIELDS_DICT = {"Image Occlusion": FIELD_NAMES}
    App.EXISTING_IDS = set()
    App.IO_FRAME_RECORDS = {}
    App.ADDED_MEDIA = []
    App.FILE_HASHES = {}
    MEDIA.clear()
    NOTE_DICT_TEMPLATE["tags"] = ["Obsidian_to_Anki"]
    NOTE_DICT_TEMPLATE["deckName"] = "Default"
    ota.CONFIG_DATA["Vault"] = ""
    ota.CONFIG_DATA["Add file link"] = False
    ota.CONFIG_DATA["IO_HIDE_ALL_WORD"] = "Hide all"
    ota.CONFIG_DATA["IO_DELETE_WORD"] = "DELETE"
    ota.CONFIG_DATA["IO_FROZEN_WORD"] = "FROZEN"
    ota.CONFIG_DATA["Comment"] = True
    _set_app_regexps()


def _set_app_regexps():
    # IOFile inherits vanilla setup_global_tags (FILE TAGS line) which reads
    # App.TAG_REGEXP -- normally built by App.gen_regexp at startup.
    ota.CONFIG_DATA["TAG_LINE"] = re.escape("FILE TAGS")
    App.TAG_REGEXP = re.compile(
        "^" + ota.CONFIG_DATA["TAG_LINE"] + r"(?:\n|: )(.*)",
        flags=re.MULTILINE,
    )


TWO_FRAME_SCENE = {
    "type": "excalidraw",
    "version": 2,
    "elements": [
        {"id": "frame1", "type": "frame", "name": "Image Occlusion", "x": 0, "y": 0, "width": 300, "height": 200, "angle": 0},
        {"id": "img1", "type": "image", "fileId": "file1", "x": 50, "y": 50, "width": 200, "height": 100, "angle": 0, "frameId": "frame1"},
        {"id": "mask1", "type": "rectangle", "x": 60, "y": 60, "width": 40, "height": 30, "angle": 0, "frameId": "frame1", "backgroundColor": "#ff0000"},
        {"id": "frame2", "type": "frame", "name": "Image Occlusion", "x": 0, "y": 300, "width": 300, "height": 200, "angle": 0},
        {"id": "mask2", "type": "rectangle", "x": 40, "y": 320, "width": 30, "height": 20, "angle": 0, "frameId": "frame2", "backgroundColor": "#1971c2"},
        {"id": "text2", "type": "text", "x": 90, "y": 330, "width": 60, "height": 15, "angle": 0, "text": "no image here"},
    ],
    "files": {},
}


def test_iofile_multiple_frames_two_notes(monkeypatch, tmp_path, capsys):
    # Two Image Occlusion frames in one file: frame1 is linked to a back-of-note
    # section, frame2 has NO element link. The unlinked frame is skipped (no
    # note, no record, no ID) and must never inherit frame1's fields.
    content = make_drawing_content(TWO_FRAME_SCENE)  # only frame1 gets a link
    content += "\n"

    _configure_io()
    fixture = tmp_path / "io_two.md"
    fixture.write_text(content, encoding="utf-8")
    img_dir = tmp_path / "test-images"
    img_dir.mkdir()
    (img_dir / "cat.png").write_bytes(b"\x89PNG\r\n\x1a\nfake-png-bytes")

    io_file = IOFile(str(fixture))
    io_file.scan_file()
    assert len(io_file.notes_to_add) == 1
    assert len(io_file.id_indexes) == 1
    assert len(io_file.io_add_frame_keys) == 1
    assert (str(fixture) + "::frame1") in App.IO_FRAME_RECORDS
    assert (str(fixture) + "::frame2") not in App.IO_FRAME_RECORDS
    note = io_file.notes_to_add[0]
    assert note["fields"]["Header"] == "<div>Some header</div>"
    assert note["fields"]["Image"].endswith(".svg\">")
    # frame2 warned about the missing section link
    assert "frame2" in capsys.readouterr().out

    io_file.note_ids = [1]
    io_file.write_ids()
    assert "<!--ID: 1-->" in io_file.file
    assert "<!--ID: 2-->" not in io_file.file


def test_iofile_linked_partial_section_does_not_leak(monkeypatch, tmp_path):
    # Both frames ARE linked. frame2's section only fills Header, so its note
    # must have blank Back Extra / Comments -- never inheriting frame1's values.
    content = make_drawing_content(
        TWO_FRAME_SCENE,
        element_links="frame1: [[#Frame 1 Notes]]\nframe2: [[#Frame 2 Notes]]",
        extra_body="\n## Frame 2 Notes\n\nHeader: H2\n",
    )

    _configure_io()
    fixture = tmp_path / "io_two.md"
    fixture.write_text(content, encoding="utf-8")
    img_dir = tmp_path / "test-images"
    img_dir.mkdir()
    (img_dir / "cat.png").write_bytes(b"\x89PNG\r\n\x1a\nfake-png-bytes")

    io_file = IOFile(str(fixture))
    io_file.scan_file()
    assert len(io_file.notes_to_add) == 2
    frame1_note, frame2_note = io_file.notes_to_add
    assert frame1_note["fields"]["Header"] == "<div>Some header</div>"
    assert frame1_note["fields"]["Back Extra"] == "<div>Some back extra</div>"
    assert frame2_note["fields"]["Header"] == "<div>H2</div>"
    assert frame2_note["fields"]["Back Extra"] == ""
    assert frame2_note["fields"]["Comments"] == ""
    # frame2 still gets its own masks/occlusion and its own (image-less) SVG
    assert frame2_note["fields"]["Occlusion"].startswith("{{c1::image-occlusion:")
    assert frame2_note["fields"]["Image"].endswith(".svg\">")


LOCALIZED_FIELD_NAMES = ["Occlusion", "Bild", "Prompts", "Extra Info", "Notizen"]


def test_parse_section_keys_are_the_note_type_field_names():
    # §16: the section `Key:` labels come from the model's (localized) field
    # names by ordinal, never from a setting. Feeding different field names
    # changes which lines are parsed -- a `Prompts:` line fills the THIRD
    # field slot, and the old "Header:"-style line is ignored.
    content = make_drawing_content(
        extra_body="\nPrompts: Localized prompt\nHeader: Not a key here\n",
    )
    body_info = IO.find_back_of_note(content)
    drawing = IO.parse_drawing(content)
    link = IO.element_link(drawing, "frame1")
    section = IO.find_section(content, link, body_info)

    localized_keys = IO.io_field_keys(LOCALIZED_FIELD_NAMES)
    parsed = IO.parse_section(section["text"], localized_keys, IO.DEFAULT_IO_CONFIG, "DELETE", "FROZEN")
    assert parsed["fieldValues"]["Prompts"] == "Localized prompt"
    assert parsed["fieldValues"].get("Extra Info", "") == ""
    # The English-mirrored line does not match a derived key.
    assert "Header" not in parsed["fieldValues"]
    assert parsed["tags"] == []


def test_iofile_scan_derives_keys_from_the_model(monkeypatch, tmp_path, capsys):
    # IOFile.scan_file derives the section field keys from an altered
    # FIELDS_DICT (localized model), so the note fields use those names.
    content = make_drawing_content(
        extra_body="\nPrompts: Localized prompt\nExtra Info: Localized extra\nNotizen: Localized comment\n",
    )

    _configure_io()
    App.FIELDS_DICT = {"Image Occlusion": LOCALIZED_FIELD_NAMES}
    fixture = tmp_path / "io_localized.md"
    fixture.write_text(content, encoding="utf-8")
    img_dir = tmp_path / "test-images"
    img_dir.mkdir()
    (img_dir / "cat.png").write_bytes(b"\x89PNG\r\n\x1a\nfake-png-bytes")

    io_file = IOFile(str(fixture))
    io_file.scan_file()
    assert len(io_file.notes_to_add) == 1
    note = io_file.notes_to_add[0]
    assert note["fields"]["Prompts"] == "<div>Localized prompt</div>"
    assert note["fields"]["Extra Info"] == "<div>Localized extra</div>"
    assert note["fields"]["Notizen"] == "Localized comment"
    assert note["fields"]["Occlusion"].startswith("{{c1::image-occlusion:")
    assert "Header" not in note["fields"]


def test_iofile_skips_when_io_model_missing(monkeypatch, tmp_path, capsys):
    # Without a complete "Image Occlusion" model there is nothing to derive the
    # section field keys from -- the file is skipped with a warning, no crash.
    content = make_drawing_content()

    _configure_io()
    App.FIELDS_DICT = {"Image Occlusion": ["Occlusion"]}
    fixture = tmp_path / "io_missing_model.md"
    fixture.write_text(content, encoding="utf-8")

    io_file = IOFile(str(fixture))
    io_file.scan_file()
    assert io_file.notes_to_add == []
    assert "skipped" in capsys.readouterr().out
