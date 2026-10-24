from app.providers import build_overview, normalize_models


def test_removed_products_are_absent_from_all_provider_sources():
    ids = ('nous', 'opencode-zen', 'opencode-go')
    env = {f'KEY_{i}': {'provider': i, 'is_set': True} for i in ids}
    oauth = {'providers': [{'id': i} for i in ids]}
    analytics = {'models': [{'provider': i, 'sessions': 1} for i in ids]}
    assert [p['id'] for p in build_overview(env, oauth, analytics, 30)['providers']] == ['opencode-go']
    options = {'providers': [{'slug': i, 'models': ['model']} for i in ids]}
    assert [p['slug'] for p in normalize_models(options)] == ['opencode-go']
