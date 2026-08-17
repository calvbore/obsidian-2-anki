import os
import re

from anki.collection import Collection
from anki.collection import SearchNode

test_name = os.path.basename(__file__)[5:-3]
col_path = 'tests/test_outputs/{}/Anki2/User 1/collection.anki2'.format(test_name)
test_file_path = 'tests/test_outputs/{}/Obsidian/{}/{}.excalidraw.md'.format(test_name, test_name, test_name)

EXPECTED_OCCLUSION = (
    "{{c1::image-occlusion:rect:left=0.2:top=0.3:width=0.1333:height=0.15:fill=#ff0000}}"
)


def test_col_exists(col: Collection):
    assert not col.is_empty()


def test_deck_default_exists(col: Collection):
    assert col.decks.id_for_name('Default') is not None


def test_cards_count(col: Collection):
    notes = col.find_notes(col.build_search_string(SearchNode(deck='Default')))
    assert len(notes) == 1
    assert len(col.find_cards(col.build_search_string(SearchNode(deck='Default')))) == 1


def test_cards_ids_from_obsidian(col: Collection):
    with open(test_file_path) as file:
        content = file.read()
    obs_IDs = re.findall(r'<!--ID: (\d+)-->', content)
    assert len(obs_IDs) == 1

    anki_IDs = col.find_notes(col.build_search_string(SearchNode(deck='Default')))
    assert len(anki_IDs) == 1
    assert str(anki_IDs[0]) == obs_IDs[0]


def test_cards_front_back_tag_type(col: Collection):
    anki_IDs = col.find_notes(col.build_search_string(SearchNode(deck='Default')))
    note = col.get_note(anki_IDs[0])

    assert note.note_type()["name"] == "Image Occlusion"
    assert note.fields[0] == EXPECTED_OCCLUSION

    image_field = note.fields[1]
    assert image_field.startswith('<img src="') and image_field.endswith('.svg">')
    svg_filename = image_field[len('<img src="'):-len('">')]
    svg_path = os.path.join(
        os.path.dirname(col_path), 'collection.media', svg_filename
    )
    assert os.path.isfile(svg_path)
    with open(svg_path, encoding='utf-8') as f:
        svg_content = f.read()
    assert 'Opted-in label' in svg_content

    assert note.fields[2] == "<div>Opted in header</div>"
    assert note.fields[3] == "<div>Opted in back extra</div>"
    assert note.fields[4] == "Opted in comment"

    # Only the template's default tag: the fixture has no FILE TAGS or Tags:
    # lines, and the copied data.json has Add Obsidian Tags off-equivalent for
    # this suite's tokens (no #tags in the fields).
    assert set(note.tags) == {"Obsidian_to_Anki"}