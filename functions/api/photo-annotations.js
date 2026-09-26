import { annotationReply, loadAnnotations } from './_annotations.js';
import { logDatabaseError } from './_db.js';
export async function onRequest({request, env}) {
  if (request.method !== 'GET') return annotationReply({detail:'Method Not Allowed'},405);
  try { return annotationReply(await loadAnnotations(env.CORRECTIONS_DB)); }
  catch(error) {
    logDatabaseError('/api/photo-annotations', 'read annotations', error);
    return annotationReply({detail:'Aktuální upřesnění nejsou dostupná'},503);
  }
}
