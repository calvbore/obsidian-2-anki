
import re
import os
from anki.errors import NotFoundError  # noqa
from anki.collection import Collection
from anki.collection import SearchNode

test_name = os.path.basename(__file__)[5:-3]
col_path = 'tests/test_outputs/{}/Anki2/User 1/collection.anki2'.format(test_name)

test_file_paths = [
    'tests/test_outputs/{}/Obsidian/{}/{}.md'.format(test_name, test_name, test_name),
    'tests/test_outputs/{}/Obsidian/{}/{}.file.md'.format(test_name, test_name, test_name),
    'tests/test_outputs/{}/Obsidian/{}/{}.file.inline.md'.format(test_name, test_name, test_name),
    'tests/test_outputs/{}/Obsidian/{}/{}.inline.md'.format(test_name, test_name, test_name),
    'tests/test_outputs/{}/Obsidian/{}/{}.hyphen.file.md'.format(test_name, test_name, test_name),
]

def test_col_exists(col):
    assert not col.is_empty()

def test_deck_default_exists(col: Collection):
    assert col.decks.id_for_name('Default') is not None

def test_cards_count(col: Collection):
    assert len(col.find_cards( col.build_search_string(SearchNode(deck='Default')) )) == 13

def test_cards_ids_from_obsidian(col: Collection):

    ID_REGEXP_STR = r'\n?(?:<!--)?(?:ID: (\d+).*)'

    obs_IDs = []
    for obsidian_test_md in test_file_paths:
        with open(obsidian_test_md) as file:
            for line in file:
                output = re.search(ID_REGEXP_STR, line.rstrip())
                if output is not None:
                    output = output.group(1)
                    obs_IDs.append(int(output))

    anki_IDs = col.find_notes( col.build_search_string(SearchNode(deck='Default')) )

    for aid in anki_IDs:
        assert obs_IDs.index(aid) > -1

    for oid in obs_IDs:
        assert list(anki_IDs).index(oid) > -1

    assert len(anki_IDs) == len(obs_IDs)

def find_note_with_1st_field(field, anki_IDs, col: Collection):
    for aid in anki_IDs:
        note = col.get_note(aid)
        if note.fields[0] == field:
            return note

def test_cards_front_back_tag_type(col: Collection):

    anki_IDs = col.find_notes( col.build_search_string(SearchNode(deck='Default')) )

    note1 = find_note_with_1st_field("Card with #-prefixed tags", anki_IDs, col)
    assert note1.fields[1] == "Test successful!"
    assert note1.has_tag('Tag1')
    assert note1.has_tag('Tag2')
    assert note1.has_tag('Tag3')
    assert note1.has_tag('Obsidian_to_Anki')
    assert len(note1.tags) == 4

    note2 = find_note_with_1st_field("Card with mixed # and non-# tags", anki_IDs, col)
    assert note2.fields[1] == "Test successful!"
    assert note2.has_tag('Tag1')
    assert note2.has_tag('Tag2')
    assert note2.has_tag('Tag3')
    assert note2.has_tag('Obsidian_to_Anki')
    assert len(note2.tags) == 4

    note3 = find_note_with_1st_field("Card with hyphenated tags", anki_IDs, col)
    assert note3.fields[1] == "Test successful!"
    assert note3.has_tag('my-tag')
    assert note3.has_tag('another-tag')
    assert note3.has_tag('Obsidian_to_Anki')
    assert len(note3.tags) == 3

    note4 = find_note_with_1st_field("Card with no tags line", anki_IDs, col)
    assert note4.fields[1] == "Test successful!"
    assert note4.has_tag('Obsidian_to_Anki')
    assert len(note4.tags) == 1

    note5 = find_note_with_1st_field("Card 1 with file tags", anki_IDs, col)
    assert note5.fields[1] == "Test successful!"
    assert note5.has_tag('Maths')
    assert note5.has_tag('School')
    assert note5.has_tag('Physics')
    assert note5.has_tag('Obsidian_to_Anki')
    assert len(note5.tags) == 4

    note6 = find_note_with_1st_field("Card 2 with file tags", anki_IDs, col)
    assert note6.fields[1] == "Test successful!"
    assert note6.has_tag('Maths')
    assert note6.has_tag('School')
    assert note6.has_tag('Physics')
    assert note6.has_tag('Obsidian_to_Anki')
    assert len(note6.tags) == 4

    note7 = find_note_with_1st_field("Card 1 with inline file tags", anki_IDs, col)
    assert note7.fields[1] == "Test successful!"
    assert note7.has_tag('Maths')
    assert note7.has_tag('School')
    assert note7.has_tag('Physics')
    assert note7.has_tag('Obsidian_to_Anki')
    assert len(note7.tags) == 4

    note8 = find_note_with_1st_field("Card 2 with inline file tags", anki_IDs, col)
    assert note8.fields[1] == "Test successful!"
    assert note8.has_tag('Maths')
    assert note8.has_tag('School')
    assert note8.has_tag('Physics')
    assert note8.has_tag('Obsidian_to_Anki')
    assert len(note8.tags) == 4

    note9 = find_note_with_1st_field("Inline with #-tags", anki_IDs, col)
    assert note9.fields[1] == "Test successful!"
    assert note9.has_tag('Tag1')
    assert note9.has_tag('Tag2')
    assert note9.has_tag('Obsidian_to_Anki')
    assert len(note9.tags) == 3

    note10 = find_note_with_1st_field("Card with hyphenated file tags", anki_IDs, col)
    assert note10.fields[1] == "Test successful!"
    assert note10.has_tag('my-tag')
    assert note10.has_tag('another-tag')
    assert note10.has_tag('Obsidian_to_Anki')
    assert len(note10.tags) == 3

    note11 = find_note_with_1st_field("Card 2 with hyphenated file tags", anki_IDs, col)
    assert note11.fields[1] == "Test successful!"
    assert note11.has_tag('my-tag')
    assert note11.has_tag('another-tag')
    assert note11.has_tag('Obsidian_to_Anki')
    assert len(note11.tags) == 3

    note12 = find_note_with_1st_field("Card with double-# tag", anki_IDs, col)
    assert note12.fields[1] == "Test successful!"
    assert note12.has_tag('normal')
    assert note12.has_tag('##not-a-tag')
    assert note12.has_tag('Obsidian_to_Anki')
    assert len(note12.tags) == 3

    note13 = find_note_with_1st_field("Card with edge-case tag tokens", anki_IDs, col)
    assert note13.fields[1] == "Test successful!"
    assert note13.has_tag('valid')
    assert note13.has_tag('!')
    assert note13.has_tag('?')
    assert note13.has_tag('@')
    assert note13.has_tag('###triple')
    assert note13.has_tag('#')
    assert note13.has_tag('Obsidian_to_Anki')
    assert len(note13.tags) == 7
