import json

from hostd.discover import discover, merge


def home(tmp_path):
    (tmp_path / 'profiles' / 'gamma').mkdir(parents=True)
    (tmp_path / 'profiles' / 'bad name').mkdir()
    (tmp_path / 'profiles' / 'file').write_text('x')
    return tmp_path


def test_discover_default_and_profiles(tmp_path):
    found = discover(home(tmp_path))
    assert set(found) == {'default', 'gamma'}
    assert found['gamma']['path'].endswith('profiles/gamma')
    assert discover(tmp_path / 'fehlt') == {}


def test_merge_adds_only_missing(tmp_path):
    cfg = tmp_path / 'c.json'
    cfg.write_text(json.dumps({'profiles': {'default': {'path': '/eigen', 'allow_management': True}}}))
    added, kept = merge(cfg, home(tmp_path))
    data = json.loads(cfg.read_text())['profiles']
    assert added == ['gamma'] and kept == ['default']
    assert data['default'] == {'path': '/eigen', 'allow_management': True}
    assert merge(cfg, tmp_path) == ([], ['default', 'gamma'])
