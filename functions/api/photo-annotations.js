import { annotationReply, loadAnnotations } from './_annotations.js';
import { logDatabaseError } from './_db.js';
export async function onRequest({request, env}) {
  if (request.method !== 'GET') return annotationReply({detail:'Method Not Allowed'},405);
  const raw = new URL(request.url).searchParams.get('revision');
  const revision = raw === null ? null : Number(raw);
  if (raw !== null && (!/^\d+$/u.test(raw) || !Number.isSafeInteger(revision))) return annotationReply({detail:'Neplatná revize'},400);
  try { return annotationReply(await loadAnnotations(env.CORRECTIONS_DB, revision)); }
  catch(error) {
    logDatabaseError('/api/photo-annotations', 'read annotations', error);
    return annotationReply({detail:'Aktuální upřesnění nejsou dostupná'},503);
  }
}
