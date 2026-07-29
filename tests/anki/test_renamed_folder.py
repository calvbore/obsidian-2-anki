import re
import os
from anki.collection import Collection
from anki.collection import SearchNode

test_name = os.path.basename(__file__)[5:-3]
col_path = 'tests/test_outputs/{}/Anki2/User 1/collection.anki2'.format(test_name)

# Root vault file is ng_folder_rename.md (only parent folder was renamed by E2E test)
test_file_path = 'tests/test_outputs/{}/Obsidian/{}/ng_folder_rename.md'.format(test_name, test_name)
test_subdir_card1 = 'tests/test_outputs/{}/Obsidian/{}/subdir/card1.md'.format(test_name, test_name)
test_subdir_nested_card2 = 'tests/test_outputs/{}/Obsidian/{}/subdir/nested/card2.md'.format(test_name, test_name)

# Expected decks after rename (from ng_folder_rename to renamed_folder)
# Scan Directory is "renamed_folder/subdir" — only files under subdir/ are synced.
# FOLDER_DECKS mapping: "renamed_folder/subdir" -> "SubdirDeck"
# RootDeck and AnotherDeck do not exist (their source files are outside scan dir)

def test_col_exists(col):
    assert not col.is_empty()

def test_deck_default_exists(col: Collection):
    assert col.decks.id_for_name('Default') is not None
    assert col.decks.id_for_name('SubdirDeck') is not None

def test_cards_count(col: Collection):
    # 2 cards total — both in SubdirDeck (card1.md + nested/card2.md)
    assert len(col.find_cards( col.build_search_string(SearchNode(deck='SubdirDeck')) )) == 2

def test_cards_ids_from_obsidian(col: Collection):

    ID_REGEXP_STR = r'\n?(?:<!--)?(?:ID: (\d+).*)'

    # Check root file (ng_folder_rename.md) — 0 cards, outside scan dir
    obs_IDs = []
    if os.path.exists(test_file_path):
        with open(test_file_path) as file:
            for line in file:
                output = re.search(ID_REGEXP_STR, line.rstrip())
                if output is not None:
                    output = output.group(1)
                    obs_IDs.append(output)
    anki_IDs = col.find_notes( col.build_search_string(SearchNode(deck='Default')) )
    assert len(anki_IDs) == len(obs_IDs)

    # Collect all Obsidian IDs from SubdirDeck files and all Anki IDs
    obs_IDs = []
    for test_file in [test_subdir_card1, test_subdir_nested_card2]:
        with open(test_file) as file:
            for line in file:
                output = re.search(ID_REGEXP_STR, line.rstrip())
                if output is not None:
                    output = output.group(1)
                    obs_IDs.append(output)

    anki_IDs = col.find_notes( col.build_search_string(SearchNode(deck='SubdirDeck')) )
    assert sorted(obs_IDs) == sorted([str(aid) for aid in anki_IDs])

def test_cards_front_back_tag_type(col: Collection):

    anki_IDs = col.find_notes( col.build_search_string(SearchNode(deck='SubdirDeck')) )
    for aid in anki_IDs:
        note = col.get_note(aid)
        assert note.note_type()["name"] == "Basic"