import { authorizeAdmin } from '../_admin_auth.js';
import { findCatalogPhoto } from '../_catalog.js';
import { assertSameOrigin, toHttpError } from '../_security.js';
import { logDatabaseError } from '../_db.js';
import { annotationReply as reply, validateAnnotation, editorAnnotation } from '../_annotations.js';
export async function onRequest({request, env}) {
  const denied = await authorizeAdmin(request,env);
  if (denied) return denied;
  const db = env.CORRECTIONS_DB;
  if (!db) return reply({detail:'Chybí CORRECTIONS_DB'},500);
  if (request.method === 'GET') {
    const xid = new URL(request.url).searchParams.get('xid');
    if (!xid || !/^[A-Za-z0-9_-]{1,128}$/u.test(xid)) return reply({detail:'Neplatné xid'},400);
    try {
      const photo = await findCatalogPhoto(env,xid);
      if (!photo) return reply({detail:'Neznámé xid'},404);
      const current = await db.prepare('SELECT * FROM photo_annotations WHERE xid = ?').bind(xid).first();
      const history = await db.prepare('SELECT * FROM photo_annotation_history WHERE xid = ? ORDER BY revision DESC LIMIT 100').bind(xid).all();
      return reply({photo:JSON.parse(photo.feature_json), annotation:editorAnnotation(current), history:(history.results || []).map(editorAnnotation)});
    } catch(error) { logDatabaseError('/api/admin/photo-annotations','read',error); return reply({detail:'Upřesnění nejsou dostupná'},503); }
  }
  if (request.method !== 'POST') return reply({detail:'Method Not Allowed'},405);
  try { assertSameOrigin(request,env); } catch(error) { const failure=toHttpError(error,403,'Neplatný původ požadavku'); return reply({detail:failure.detail},failure.status); }
  let input;
  try {
    const raw=await request.text();
    if(new TextEncoder().encode(raw).length > 16384) return reply({detail:'Upřesnění je příliš dlouhé'},413);
    input=validateAnnotation(JSON.parse(raw));
  } catch(error) { return reply({detail:error.message},400); }
  try {
    if (!(await findCatalogPhoto(env,input.xid))) return reply({detail:'Neznámé xid'},400);
    if (input.overlay) {
      const approved = [];
      for (const id of [...input.overlay.place_ids, ...input.overlay.disputed_place_ids]) {
        const row = await db.prepare('SELECT entity_json FROM catalog_place_members WHERE place_id = ? LIMIT 1').bind(id).first();
        if (!row) return reply({detail:'Neznámé místo'},400);
        if (input.overlay.place_ids.includes(id)) approved.push({...JSON.parse(row.entity_json), source:'curator'});
      }
      input.overlay.places = approved;
    }
    const previous=await db.prepare('SELECT * FROM photo_annotations WHERE xid = ?').bind(input.xid).first();
    if(Number(previous?.revision || 0)!==input.expected_revision) return reply({detail:'Jiný správce mezitím změnil upřesnění. Načtěte aktuální verzi.'},409);
    if(input.action==='withdraw' && !previous?.published_json) return reply({detail:'Fotografie nemá zveřejněné upřesnění'},400);
    const revision=input.expected_revision+1;
    const now=new Date().toISOString();
    const draft=input.overlay ? JSON.stringify(input.overlay) : previous.draft_json;
    const published=input.action==='publish' ? JSON.stringify({xid:input.xid, revision,...input.overlay,published_at:now}) : input.action==='withdraw' ? null : previous?.published_json || null;
    const result=await db.prepare(`INSERT INTO photo_annotations(xid,revision,state,draft_json,evidence_note,published_json,updated_at,actor)
      SELECT ?,?,?,?,?,?,?,? WHERE ? = 0
      ON CONFLICT(xid) DO UPDATE SET revision=excluded.revision,state=excluded.state,draft_json=excluded.draft_json,
      evidence_note=excluded.evidence_note,published_json=excluded.published_json,updated_at=excluded.updated_at,actor=excluded.actor
      WHERE photo_annotations.revision = ?`).bind(input.xid,revision,input.action==='publish'?'published':input.action==='withdraw'?'withdrawn':'draft',draft,input.evidence_note ?? previous?.evidence_note ?? '',published,now,'authenticated-admin',previous ? 0 : input.expected_revision,input.expected_revision).run();
    if(!result.meta.changes) return reply({detail:'Jiný správce mezitím změnil upřesnění. Načtěte aktuální verzi.'},409);
    return reply({ok:true,xid:input.xid,revision});
  } catch(error) { logDatabaseError('/api/admin/photo-annotations','write',error); return reply({detail:'Upřesnění se nepodařilo uložit'},503); }
}
