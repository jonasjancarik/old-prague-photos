import json
from src.pipeline.place_normalization import normalize_archive_metadata
from scripts.enrich_archive_metadata import enrich


def metadata(terms, **extra):
    return {"rejstříkové záznamy": [{"typ": "Místo", "obsah": term} for term in terms], **extra}


def test_cosmetic_variants_context_and_original_terms():
    a = normalize_archive_metadata(metadata(["Letenská", "Letenská ulice", "Malá Strana"]))
    streets = [p for p in a['places'] if p['kind'] == 'street']
    assert len(streets) == 1
    assert streets[0]['source_terms'] == ['Letenská', 'Letenská ulice']
    assert streets[0]['district'] == 'Malá Strana'
    b = normalize_archive_metadata(metadata(["Letenská", "Holešovice (Praha)"]))
    assert streets[0]['id'] != next(p for p in b['places'] if p['kind'] == 'street')['id']
    assert a['archive_place_terms'] == ['Letenská', 'Letenská ulice', 'Malá Strana']
    c = normalize_archive_metadata(metadata(['Praha - Josefská ulice', 'Malá Strana']))
    assert any(p['label'] == 'Josefská' and p['kind'] == 'street' for p in c['places'])


def test_ambiguity_multiple_places_and_deterministic_ids():
    terms = ['Letenská', 'Malá Strana', 'Holešovice', 'Josefská ulice', 'Letenská vodárenská věž']
    a = normalize_archive_metadata(metadata(terms))
    b = normalize_archive_metadata(metadata(list(reversed(terms))))
    assert [p['id'] for p in a['places']] == [p['id'] for p in b['places']]
    for p in a['places']:
        if p['kind'] == 'street':
            assert p['ambiguous'] and 'district' not in p
    assert any(p['kind'] == 'other' and p['label'] == terms[-1] for p in a['places'])


def test_authors_are_not_people_and_joint_names_are_preserved():
    raw = metadata([], autor='  Novák, Jan;  Svoboda, Josef ')
    raw['rejstříkové záznamy'].append({'typ': 'Osoba', 'obsah': 'Jiný člověk'})
    a = normalize_archive_metadata(raw)
    assert len(a['authors']) == 1
    assert a['authors'][0]['label'] == 'Novák, Jan; Svoboda, Josef'
    assert a['authors'][0]['source_terms'] == [raw['autor']]
    assert normalize_archive_metadata({'rejstříkové záznamy': raw['rejstříkové záznamy']})['authors'] == []
    assert normalize_archive_metadata(None)['places'] == []


def test_candidate_preserves_all_existing_fields_and_missing_records(tmp_path):
    source = tmp_path / 'source.json'
    raw_dir = tmp_path / 'raw'
    raw_dir.mkdir()
    features = [{'type':'Feature','geometry':{'type':'Point','coordinates':[14,50]},'properties':{'id':x,'group_id':'series','author':'old'}} for x in ['a','b']]
    source.write_text(json.dumps({'type':'FeatureCollection','features':features}))
    (raw_dir / 'a.json').write_text(json.dumps(metadata(['Letenská','Malá Strana'], xid='a')))
    output = tmp_path / 'candidate.json'
    report = enrich(source, raw_dir, output)
    candidate = json.loads(output.read_text())
    assert report['raw_source_gaps'] == 1
    assert report['letenska_xids'] == 1
    assert candidate['features'][1]['properties']['places'] == []
    assert candidate['features'][0]['geometry'] == features[0]['geometry']
    assert candidate['features'][0]['properties']['author'] == 'old'


def test_csv_geojson_seed_contract_and_digest(tmp_path):
    import csv
    import sqlite3
    from src.pipeline.export import export_records
    from viewer.build_geojson import build_geojson
    from scripts.build_catalog_seed import load_catalog_photos, render_chunk, digest_catalog_records
    geo_dir, raw_dir = tmp_path / 'geo', tmp_path / 'raw'
    geo_dir.mkdir(); raw_dir.mkdir()
    for xid in ['a', 'b']:
        record = {'xid':xid,'typ záznamu':'Archiválie','autor':'Old',
                  'geolocation':{'position':{'lon':14,'lat':50}}}
        (geo_dir / (xid + '.json')).write_text(json.dumps(record))
    (raw_dir / 'a.json').write_text(json.dumps(metadata(['Letenská','Malá Strana'],xid='a',autor='Novák, Jan')))
    csv_path, geo_path = tmp_path / 'export.csv', tmp_path / 'photos.json'
    export_records(geo_dir,csv_path,raw_records_dir=raw_dir)
    rows = list(csv.DictReader(csv_path.open()))
    assert json.loads(rows[0]['places'])[0]['source'] == 'archive'
    assert json.loads(rows[1]['authors']) == []
    build_geojson(csv_path,geo_path)
    records = load_catalog_photos(geo_path,set())
    props = json.loads(records[0].feature_json)
    assert props['archive_place_terms'] == ['Letenská','Malá Strana']
    assert props['authors'][0]['label'] == 'Novák, Jan'
    db = sqlite3.connect(':memory:')
    db.execute('CREATE TABLE catalog_photos(xid TEXT PRIMARY KEY,base_group_id TEXT,source_lon REAL,source_lat REAL,feature_json TEXT,search_text TEXT)')
    db.execute('CREATE TABLE community_test(xid TEXT,comment TEXT)')
    db.execute("INSERT INTO community_test VALUES ('a','keep')")
    db.executescript(render_chunk(records))
    assert json.loads(db.execute("SELECT feature_json FROM catalog_photos WHERE xid='a'").fetchone()[0]) == props
    digest = digest_catalog_records(records)
    changed = json.loads(geo_path.read_text()); changed['features'][0]['properties']['places'] = []
    geo_path.write_text(json.dumps(changed))
    updated = load_catalog_photos(geo_path,set())
    assert digest_catalog_records(updated) != digest
    db.executescript(render_chunk(updated))
    assert db.execute('SELECT comment FROM community_test').fetchone()[0] == 'keep'
