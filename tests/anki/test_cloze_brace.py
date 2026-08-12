import re
import os
from anki.errors import NotFoundError  # noqa
from anki.collection import Collection
from anki.collection import SearchNode

test_name = os.path.basename(__file__)[5:-3]
col_path = 'tests/test_outputs/{}/Anki2/User 1/collection.anki2'.format(test_name)
test_file_path = 'tests/test_outputs/{}/Obsidian/{}/{}.md'.format(test_name, test_name, test_name)

def rendered(card):
    return card.question().split('</style>')[-1]

def render_answer(card):
    return card.answer().split('</style>')[-1]

def test_col_exists(col):
    assert not col.is_empty()

def test_deck_default_exists(col: Collection):
    assert col.decks.id_for_name('Default') is not None

def test_cards_count(col: Collection):
    assert len(col.find_cards( col.build_search_string(SearchNode(deck='Default')) )) == 3

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
    assert note1.fields[0] == "Inline math with a cloze whose content ends in braces: \\(x={{c1::a^{1} }}=y\\)."

    note2 = col.get_note(anki_IDs[1])
    assert note2.fields[0] == "Display math with a cloze containing a fraction: \\[x={{c1:: \\frac{a^{1} }{2} }}=y\\]"

    note3 = col.get_note(anki_IDs[2])
    assert note3.fields[0] == "A plain cloze with no braces inside: {{c1::abc}}."

    assert note1.note_type()["name"] == "Cloze"
    assert note2.note_type()["name"] == "Cloze"
    assert note3.note_type()["name"] == "Cloze"

def test_rendered_cards_balanced(col: Collection):

    anki_IDs = col.find_notes( col.build_search_string(SearchNode(deck='Default')) )
    
    note1 = col.get_note(anki_IDs[0])
    note2 = col.get_note(anki_IDs[1])
    note3 = col.get_note(anki_IDs[2])

    q1, a1 = rendered(note1.cards()[0]), render_answer(note1.cards()[0])
    q2, a2 = rendered(note2.cards()[0]), render_answer(note2.cards()[0])
    q3, a3 = rendered(note3.cards()[0]), render_answer(note3.cards()[0])

    # Front hides the cloze content; no stray "}" must remain
    assert "[...]" in q1
    assert "[...]" in q2
    assert "}=y" not in q1
    assert "}=y" not in q2
    assert "[...]" in q3

    # Back reveals balanced math: the trailing superscript brace and the
    # fraction braces must be intact, and no stray "}" may leak out
    assert "a^{1} =y" in a1
    assert "}=y" not in a1
    assert "\\frac{a^{1} }{2} =y" in a2
    assert "}=y" not in a2
    assert "abc" in a3