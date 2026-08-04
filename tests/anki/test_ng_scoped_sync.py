import re
import os
from anki.collection import Collection
from anki.collection import SearchNode

test_name = os.path.basename(__file__)[5:-3]
col_path = 'tests/test_outputs/{}/Anki2/User 1/collection.anki2'.format(test_name)
root_file = 'tests/test_outputs/{}/Obsidian/{}/ng_scoped_sync.md'.format(test_name, test_name)
card1_file = 'tests/test_outputs/{}/Obsidian/{}/subdir/card1.md'.format(test_name, test_name)
card2_file = 'tests/test_outputs/{}/Obsidian/{}/subdir/card2.md'.format(test_name, test_name)

def test_col_exists(col):
    assert not col.is_empty()

def test_deck_default_exists(col: Collection):
    assert col.decks.id_for_name('Default') is not None

def test_cards_count(col: Collection):
    # 2 root + 3 card1 + 4 card2 = 9 cards, all in Default deck
    assert len(col.find_cards( col.build_search_string(SearchNode(deck='Default')) )) == 9

def test_cards_ids_from_obsidian(col: Collection):

    ID_REGEXP_STR = r'\n?(?:<!--)?(?:ID: (\d+).*)'

    obs_IDs = []
    for fp in [root_file, card1_file, card2_file]:
        with open(fp) as file:
            for line in file:
                output = re.search(ID_REGEXP_STR, line.rstrip())
                if output is not None:
                    output = output.group(1)
                    obs_IDs.append(output)

    anki_IDs = col.find_notes( col.build_search_string(SearchNode(deck='Default')) )
    assert len(obs_IDs) == len(anki_IDs)
    assert sorted(obs_IDs) == sorted([str(aid) for aid in anki_IDs])

def test_cards_front_back_tag_type(col: Collection):

    anki_IDs = col.find_notes( col.build_search_string(SearchNode(deck='Default')) )
    
    for aid in anki_IDs:
        note = col.get_note(aid)
        assert note.note_type()["name"] == "Basic"
