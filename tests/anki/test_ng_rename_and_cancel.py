import re
import os
from anki.collection import Collection
from anki.collection import SearchNode

test_name = os.path.basename(__file__)[5:-3]
col_path = 'tests/test_outputs/{}/Anki2/User 1/collection.anki2'.format(test_name)
test_file_path = 'tests/test_outputs/{}/Obsidian/{}/{}.md'.format(test_name, test_name, test_name)

# After sync with mid-sync rename, the folder should be renamed
# and FOLDER_DECKS/FOLDER_TAGS should be migrated
# Expected deck: SyncFolderDeck (for renamed_sync_folder)
# Expected tag: sync-folder-tag

def test_col_exists(col):
    assert not col.is_empty()

def test_deck_default_exists(col: Collection):
    assert col.decks.id_for_name('Default') is not None
    assert col.decks.id_for_name('SyncFolderDeck') is not None

def test_cards_count(col: Collection):
    # Default: 1 root card only — the 50 queued "Cancel test card" notes are aborted
    # (the whole point of the Cancel button); they must NOT be committed to Anki.
    assert len(col.find_cards( col.build_search_string(SearchNode(deck='Default')) )) == 1
    # SyncFolderDeck: 2 cards from card.md (original + "Queued card" added in the rename cycle)
    assert len(col.find_cards( col.build_search_string(SearchNode(deck='SyncFolderDeck')) )) == 2

def test_cards_ids_from_obsidian(col: Collection):

    ID_REGEXP_STR = r'\n?(?:<!--)?(?:ID: (\d+).*)'

    # Check root file
    obs_IDs = []
    with open(test_file_path) as file:
        for line in file:            
            output = re.search(ID_REGEXP_STR, line.rstrip())
            if output is not None:
                output = output.group(1)
                obs_IDs.append(output)

    anki_IDs = col.find_notes( col.build_search_string(SearchNode(deck='Default')) )
    for aid, oid in zip(anki_IDs, obs_IDs):
        assert str(aid) == oid

    # Check sync_folder (now renamed_sync_folder) file
    test_sync_folder_path = 'tests/test_outputs/{}/Obsidian/{}/renamed_sync_folder/card.md'.format(test_name, test_name)
    obs_IDs2 = []
    if os.path.exists(test_sync_folder_path):
        with open(test_sync_folder_path) as file:
            for line in file:            
                output = re.search(ID_REGEXP_STR, line.rstrip())
                if output is not None:
                    output = output.group(1)
                    obs_IDs2.append(output)

        anki_IDs2 = col.find_notes( col.build_search_string(SearchNode(deck='SyncFolderDeck')) )
        for aid, oid in zip(anki_IDs2, obs_IDs2):
            assert str(aid) == oid

def test_cards_front_back_tag_type(col: Collection):

    # Root card
    anki_IDs = col.find_notes( col.build_search_string(SearchNode(deck='Default')) )
    note1 = col.get_note(anki_IDs[0])
    assert "Root card" in note1.fields[0]
    assert note1.fields[1] == "Root answer"
    assert note1.note_type()["name"] == "Basic"

    # Sync folder card (renamed)
    anki_IDs = col.find_notes( col.build_search_string(SearchNode(deck='SyncFolderDeck')) )
    note1 = col.get_note(anki_IDs[0])
    assert "Sync folder card" in note1.fields[0]
    assert note1.fields[1] == "Sync folder answer"
    assert "sync-folder-tag" in note1.tags
    assert note1.note_type()["name"] == "Basic"