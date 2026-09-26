"""Local curator overlay storage, independent of community votes and locations."""
import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from contextlib import contextmanager

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse


def install_annotation_routes(app, data_dir, assert_admin, assert_origin, photo_lookup, place_lookup):
    @contextmanager
    def connect():
        root = data_dir()
        root.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(root / 'photo_annotations.sqlite')
        db.row_factory = sqlite3.Row
        if not db.execute("SELECT 1 FROM sqlite_master WHERE name='photo_annotations'").fetchone():
            # Serialize first-use schema creation across threads/processes.
            db.execute('BEGIN IMMEDIATE')
            if not db.execute("SELECT 1 FROM sqlite_master WHERE name='photo_annotations'").fetchone():
                migration = next((Path(__file__).resolve().parent.parent / 'migrations').glob('*_photo_annotations.sql'))
                source = "CREATE TABLE IF NOT EXISTS catalog_photos(xid TEXT PRIMARY KEY, feature_json TEXT);\n" + migration.read_text(encoding='utf-8')
                statement = ''
                for line in source.splitlines(keepends=True):
                    statement += line
                    if sqlite3.complete_statement(statement):
                        db.execute(statement)
                        statement = ''
            db.commit()
        try:
            with db:
                yield db
        finally:
            db.close()

    def reply(value):
        return JSONResponse(value, headers={'Cache-Control': 'no-store'})

    def editor(row):
        if row is None:
            return None
        return {'xid': row['xid'], 'revision': row['revision'], 'state': row['state'],
                **json.loads(row['draft_json']), 'evidence_note': row['evidence_note'],
                'published': json.loads(row['published_json']) if row['published_json'] else None,
                'updated_at': row['updated_at'], 'actor': row['actor']}

    @app.get('/api/photo-annotations')
    def public_annotations(revision: int | None = None):
        with connect() as db:
            row = db.execute("SELECT metadata_revision, CASE WHEN metadata_revision=? THEN NULL ELSE (SELECT json_group_array(json(published_json)) FROM photo_annotations WHERE published_json IS NOT NULL) END AS items_json FROM photo_annotation_metadata WHERE singleton=1", (revision,)).fetchone()
        if revision is not None and row['metadata_revision'] == revision:
            return reply({'metadata_revision': revision, 'unchanged': True})
        return reply({'metadata_revision': row['metadata_revision'], 'items': json.loads(row['items_json'])})

    @app.get('/api/admin/photo-annotations')
    def get_annotation(request: Request, xid: str):
        assert_admin(request)
        photo = photo_lookup(xid)
        if photo is None:
            raise HTTPException(404, 'Neznámé xid')
        with connect() as db:
            current = db.execute('SELECT * FROM photo_annotations WHERE xid=?', (xid,)).fetchone()
            history = db.execute('SELECT * FROM photo_annotation_history WHERE xid=? ORDER BY revision DESC LIMIT 100', (xid,)).fetchall()
        return reply({'photo': photo, 'annotation': editor(current), 'history': [editor(row) for row in history]})

    @app.post('/api/admin/photo-annotations')
    async def save_annotation(request: Request):
        assert_admin(request)
        assert_origin(request)
        raw = await request.body()
        if len(raw) > 16384:
            raise HTTPException(413, 'Upřesnění je příliš dlouhé')
        try:
            body = json.loads(raw)
            xid, expected, action = body['xid'], body['expected_revision'], body['action']
            if not isinstance(xid, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', xid):
                raise ValueError()
            if type(expected) is not int or expected < 0 or action not in {'draft', 'publish', 'withdraw'}:
                raise ValueError()
            if action != 'withdraw':
                text, evidence = body['public_text'].strip(), body.get('evidence_note', '').strip()
                mode = body['place_mode']
                approved, disputed = body['place_ids'], body['disputed_place_ids']
                if not 1 <= len(text) <= 2000 or len(evidence) > 2000 or (action == 'publish' and not evidence):
                    raise ValueError()
                if mode not in {'keep', 'replace', 'unknown'}:
                    raise ValueError()
                for ids in (approved, disputed):
                    if not isinstance(ids, list) or len(ids) > 30 or any(not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9:_-]{1,128}', value) for value in ids):
                        raise ValueError()
                if (mode == 'replace' and not approved) or (mode != 'replace' and approved) or set(approved) & set(disputed):
                    raise ValueError()
                overlay = {'public_text': text, 'place_mode': mode, 'place_ids': sorted(set(approved)), 'disputed_place_ids': sorted(set(disputed))}
        except (ValueError, KeyError, TypeError, AttributeError):
            raise HTTPException(400, 'Neplatné upřesnění') from None
        if photo_lookup(xid) is None:
            raise HTTPException(400, 'Neznámé xid')
        if action != 'withdraw':
            entities = []
            for place_id in approved + disputed:
                entity = place_lookup(place_id)
                if entity is None:
                    raise HTTPException(400, 'Neznámé místo')
                if place_id in approved:
                    entities.append({**entity, 'source': 'curator'})
            overlay['places'] = entities
        with connect() as db:
            db.execute('BEGIN IMMEDIATE')
            previous = db.execute('SELECT * FROM photo_annotations WHERE xid=?', (xid,)).fetchone()
            if (previous['revision'] if previous else 0) != expected:
                raise HTTPException(409, 'Jiný správce mezitím změnil upřesnění. Načtěte aktuální verzi.')
            if action == 'withdraw' and (previous is None or not previous['published_json']):
                raise HTTPException(400, 'Fotografie nemá zveřejněné upřesnění')
            now = datetime.now(timezone.utc).isoformat()
            revision = expected + 1
            draft = json.dumps(overlay, ensure_ascii=False) if action != 'withdraw' else previous['draft_json']
            published = json.dumps({'xid': xid, 'revision': revision, **overlay, 'published_at': now}, ensure_ascii=False) if action == 'publish' else None if action == 'withdraw' else previous['published_json'] if previous else None
            note = evidence if action != 'withdraw' else previous['evidence_note']
            state = {'publish': 'published', 'withdraw': 'withdrawn', 'draft': 'draft'}[action]
            db.execute('INSERT INTO photo_annotations VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(xid) DO UPDATE SET revision=excluded.revision,state=excluded.state,draft_json=excluded.draft_json,evidence_note=excluded.evidence_note,published_json=excluded.published_json,updated_at=excluded.updated_at,actor=excluded.actor', (xid, revision, state, draft, note, published, now, 'authenticated-admin'))
        return reply({'ok': True, 'xid': xid, 'revision': revision})
