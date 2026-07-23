import pytest
from anki.collection import Collection


@pytest.fixture()
def col(request):
    col = Collection(request.module.col_path)
    yield col
    col.close()
