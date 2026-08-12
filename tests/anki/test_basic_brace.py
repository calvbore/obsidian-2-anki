import os
import re
import sys
from anki.errors import NotFoundError  # noqa
from anki.collection import Collection
from anki.collection import SearchNode

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
import obsidian_to_anki  # noqa

test_name = os.path.basename(__file__)[5:-3]
col_path = 'tests/test_outputs/{}/Anki2/User 1/collection.anki2'.format(test_name)
test_file_path = 'tests/test_outputs/{}/Obsidian/{}/{}.md'.format(test_name, test_name, test_name)

def test_col_exists(col):
    assert not col.is_empty()

def test_deck_default_exists(col: Collection):
    assert col.decks.id_for_name('Default') is not None

def test_cards_count(col: Collection):
    assert len(col.find_cards( col.build_search_string(SearchNode(deck='Default')) )) == 2

def test_cards_ids_from_obsidian(col: Collection):

    ID_REGEXP_STR = r'\n?(?:<!--)?(?:ID: (\d+).*)'
    obsidian_test_md = test_file_path

    obs_IDs = []
    with open(obsidian_test_md) as file:
        for line in file:
            output = re.search(ID_REGEXP_STR, line.rstrip())
            if output is not None:
                output = output.group(1)
                obs_IDs.append(output)

    anki_IDs = col.find_notes( col.build_search_string(SearchNode(deck='Default')) )
    for aid, oid in zip(anki_IDs, obs_IDs):
        assert str(aid) == oid

def test_cards_front_back_tag_type(col: Collection):

    anki_IDs = col.find_notes( col.build_search_string(SearchNode(deck='Default')) )

    note1 = col.get_note(anki_IDs[0])
    assert note1.fields[0] == "Literal cloze text is not altered: {{c1::a^{1}}}."
    assert note1.fields[1] == "Basic answer."

    note2 = col.get_note(anki_IDs[1])
    assert note2.fields[0] == "A control note with no cloze braces."
    assert note2.fields[1] == "Control answer."

    assert note1.note_type()["name"] == "Basic"
    assert note2.note_type()["name"] == "Basic"

def test_non_cloze_text_not_altered():

    conv = obsidian_to_anki.FormatConverter
    # Non-cloze notes pass sanitize_clozes=False -> literal text untouched
    assert conv.format("{{c1::a^{1}}}", sanitize_clozes=False) == "{{c1::a^{1}}}"
    # Cloze notes pass sanitize_clozes=True -> stray "}}" split for Anki
    assert conv.format("{{c1::a^{1}}}", sanitize_clozes=True) == "{{c1::a^{1} }}"
    # No clozes at all -> identity either way
    assert conv.format("no clozes here", sanitize_clozes=True) == "no clozes here"