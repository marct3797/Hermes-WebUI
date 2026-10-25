import gzip
import os

import pytest
from fastapi import HTTPException

from app.fileexchange import NOT_ARCHIVE, NOT_SHARED, TOO_BIG, read_archive


def _w(tmp_path, data: bytes, name="a.tar.gz"):
    p = tmp_path / name
    p.write_bytes(data)
    return str(p)


def test_valid_gzip_and_zip_are_returned_unchanged(tmp_path):
    g = gzip.compress(b"hallo")
    assert read_archive(_w(tmp_path, g), 1000) == g
    z = b"PK\x03\x04rest"
    assert read_archive(_w(tmp_path, z, "b.zip"), 1000) == z


def test_missing_file_is_reported_as_not_shared(tmp_path):
    with pytest.raises(HTTPException) as e:
        read_archive(str(tmp_path / "gibt-es-nicht"), 1000)
    assert e.value.status_code == 502 and e.value.detail == NOT_SHARED


def test_empty_file_is_reported_as_not_shared(tmp_path):
    with pytest.raises(HTTPException) as e:
        read_archive(_w(tmp_path, b""), 1000)
    assert e.value.status_code == 502 and e.value.detail == NOT_SHARED


def test_symlink_and_directory_are_refused(tmp_path):
    target = _w(tmp_path, gzip.compress(b"x"))
    link = tmp_path / "l.tar.gz"
    os.symlink(target, link)
    for p in (str(link), str(tmp_path)):
        with pytest.raises(HTTPException) as e:
            read_archive(p, 1000)
        assert e.value.detail == NOT_SHARED


def test_too_big_and_not_an_archive(tmp_path):
    with pytest.raises(HTTPException) as e:
        read_archive(_w(tmp_path, gzip.compress(b"x" * 500)), 5)
    assert e.value.detail == TOO_BIG
    with pytest.raises(HTTPException) as e:
        read_archive(_w(tmp_path, b"kein archiv"), 1000)
    assert e.value.detail == NOT_ARCHIVE
