export function annotationReply(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

export function validateAnnotation(body) {
  if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error('Neplatný JSON');
  const { xid, expected_revision, action } = body;
  if (typeof xid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(xid)) throw new Error('Neplatné xid');
  if (!Number.isSafeInteger(expected_revision) || expected_revision < 0) throw new Error('Neplatná revize');
  if (!['draft', 'publish', 'withdraw'].includes(action)) throw new Error('Neplatná akce');
  if (action === 'withdraw') return { xid, expected_revision, action };
  const public_text = typeof body.public_text === 'string' ? body.public_text.trim() : '';
  const evidence_note = typeof body.evidence_note === 'string' ? body.evidence_note.trim() : '';
  if (!public_text || public_text.length > 2000) throw new Error('Upřesnění musí mít 1 až 2000 znaků');
  if (evidence_note.length > 2000 || (action === 'publish' && !evidence_note)) throw new Error('Před zveřejněním doplňte doklad ověření');
  const place_mode = body.place_mode;
  if (!['keep', 'replace', 'unknown'].includes(place_mode)) throw new Error('Vyberte způsob přiřazení míst');
  function ids(value) {
    if (!Array.isArray(value) || value.length > 30 || value.some(id => typeof id !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/u.test(id))) throw new Error('Neplatná místa');
    return [...new Set(value)].sort();
  }
  const place_ids = ids(body.place_ids);
  const disputed_place_ids = ids(body.disputed_place_ids);
  if ((place_mode === 'replace' && !place_ids.length) || (place_mode !== 'replace' && place_ids.length) || place_ids.some(id => disputed_place_ids.includes(id))) throw new Error('Seznam míst neodpovídá vybranému způsobu');
  return { xid, expected_revision, action, evidence_note, overlay: { public_text, place_mode, place_ids, disputed_place_ids } };
}

// One SQL statement reads the revision and its matching public snapshot.
export async function loadAnnotations(db) {
  const row = await db.prepare(`SELECT metadata_revision,
    (SELECT json_group_array(json(published_json)) FROM photo_annotations WHERE published_json IS NOT NULL) AS items_json
    FROM photo_annotation_metadata WHERE singleton = 1`).first();
  if (!row) throw new Error('Annotation migration is missing');
  return { metadata_revision: Number(row.metadata_revision), items: JSON.parse(row.items_json || '[]') };
}

export function editorAnnotation(row) {
  if (!row) return null;
  return { xid: row.xid, revision: row.revision, state: row.state,
    ...JSON.parse(row.draft_json), evidence_note: row.evidence_note,
    published: row.published_json ? JSON.parse(row.published_json) : null,
    updated_at: row.updated_at, actor: row.actor };
}
