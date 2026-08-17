import os
import re

from anki.collection import Collection
from anki.collection import SearchNode

test_name = os.path.basename(__file__)[5:-3]
col_path = 'tests/test_outputs/{}/Anki2/User 1/collection.anki2'.format(test_name)
test_file_path = 'tests/test_outputs/{}/Obsidian/{}/{}.excalidraw.md'.format(test_name, test_name, test_name)

# mask geometry -> cloze (frame1: mask1 rect, mask2 ellipse) normalized against the frame bounds
EXPECTED_OCCLUSION_FRAME1 = (
    "{{c1::image-occlusion:rect:left=0.2:top=0.3:width=0.1333:height=0.15:fill=#ff0000}}<br>"
    "{{c2::image-occlusion:ellipse:left=0.5:top=0.35:width=0.2:height=0.25:rx=0.1:ry=0.125:fill=#00ff00}}"
)
# frame3 was added mid-suite (image-less frame: freehand stroke + ellipse mask)
EXPECTED_OCCLUSION_FRAME3 = (
    "{{c1::image-occlusion:ellipse:left=0.3333:top=0.1:width=0.2667:height=0.3:rx=0.1333:ry=0.15:fill=#ff0000}}"
)


def _notes_in_default(col):
    return col.find_notes(col.build_search_string(SearchNode(deck='Default')))


def _frame_notes(col):
    """Return (frame1_note, frame3_note): frame1 carries the rect mask, frame3 is ellipse-only."""
    frame1 = frame3 = None
    for note_id in _notes_in_default(col):
        note = col.get_note(note_id)
        if 'image-occlusion:rect' in note.fields[0]:
            frame1 = note
        else:
            frame3 = note
    return frame1, frame3


def test_col_exists(col: Collection):
    assert not col.is_empty()


def test_deck_default_exists(col: Collection):
    assert col.decks.id_for_name('Default') is not None


def test_cards_count(col: Collection):
    # frame2 was deleted mid-suite; frame1 (2 cards) + frame3 (1 card) survive
    assert len(_notes_in_default(col)) == 2
    assert len(col.find_cards(col.build_search_string(SearchNode(deck='Default')))) == 3


def test_cards_ids_from_obsidian(col: Collection):
    obs_IDs = []
    with open(test_file_path) as file:
        content = file.read()
        # the surviving frame-1 + frame-3 notes still have IDs in the file
        for match in re.finditer(r'<!--ID: (\d+)-->', content):
            obs_IDs.append(match.group(1))
    assert len(obs_IDs) == 2

    anki_IDs = _notes_in_default(col)
    assert len(anki_IDs) == 2
    assert set(map(str, anki_IDs)) == set(obs_IDs)


def test_cards_front_back_tag_type(col: Collection):
    frame1, frame3 = _frame_notes(col)
    assert frame1 is not None and frame3 is not None

    assert frame1.note_type()["name"] == "Image Occlusion"
    assert frame1.fields[0] == EXPECTED_OCCLUSION_FRAME1

    # The card picture is a self-contained SVG: the non-mask objects of the
    # frame (here the "Kidney label" text) plus the embedded image as a data URI.
    image_field = frame1.fields[1]
    assert image_field.startswith('<img src="') and image_field.endswith('.svg">')
    svg_filename = image_field[len('<img src="'):-len('">')]
    svg_path = os.path.join(
        os.path.dirname(col_path), 'collection.media', svg_filename
    )
    assert os.path.isfile(svg_path)
    with open(svg_path, encoding='utf-8') as f:
        svg_content = f.read()
    assert 'Kidney label' in svg_content
    assert 'data:image/png;base64,' in svg_content
    # masks are not part of the picture: no rect/ellipse nor their fill color
    assert '<rect' not in svg_content and '<ellipse' not in svg_content
    assert '#ff0000' not in svg_content and '#00ff00' not in svg_content

    # Header is "Edited header": the sync-3 text edit applied, while the
    # later "FROZEN" + "Frozen header" edit was skipped.
    assert frame1.fields[2] == "<div>Edited header</div>"
    assert frame1.fields[3] == "<div>Original back extra</div>"
    assert frame1.fields[4] == "Original comment"

    # Tags = template + FILE TAGS + section `Tags:` + the `#kidney` Obsidian
    # tag extracted from the Header field (Add Obsidian Tags was enabled).
    assert set(frame1.tags) == {"Obsidian_to_Anki", "obsidian", "io-test", "secret", "tag", "kidney"}


def test_frame3_late_added_image_less(col: Collection):
    # The frame added to an already-synced drawing (freehand stroke + ellipse
    # mask, no embedded image) must have produced its own note — the sandbox
    # regression this suite locks in.
    _, frame3 = _frame_notes(col)
    assert frame3 is not None
    assert frame3.note_type()["name"] == "Image Occlusion"
    assert frame3.fields[0] == EXPECTED_OCCLUSION_FRAME3
    assert frame3.fields[2] == "<div>Added frame header</div>"
    assert frame3.fields[3] == "<div>Added frame back extra</div>"
    assert frame3.fields[4] == "Added frame comment"
    # note tags = template + FILE TAGS + section `Tags:` (later-tag)
    assert set(frame3.tags) == {"Obsidian_to_Anki", "obsidian", "io-test", "later-tag"}
    # The picture is the freehand stroke composited into a self-contained SVG
    # (no embedded image) — masks are not part of the picture.
    image_field = frame3.fields[1]
    assert image_field.startswith('<img src="') and image_field.endswith('.svg">')
    svg_filename = image_field[len('<img src="'):-len('">')]
    svg_path = os.path.join(
        os.path.dirname(col_path), 'collection.media', svg_filename
    )
    assert os.path.isfile(svg_path)
    with open(svg_path, encoding='utf-8') as f:
        svg_content = f.read()
    assert '<polyline points=' in svg_content
    assert '<rect' not in svg_content and '<ellipse' not in svg_content
    assert '#ff0000' not in svg_content


def test_frame2_deleted_and_section_stripped():
    with open(test_file_path) as file:
        content = file.read()
    assert "## Frame 2 Notes" not in content
    assert "## Frame 1 Notes" in content
    assert "## Frame 3 Notes" in content
    assert len(re.findall(r'<!--ID: \d+-->', content)) == 2
