// Apply a complete public snapshot in one synchronous step. Originals and
// coordinates remain untouched; both entity filters and index read places.
export function applyAnnotationSnapshot(features, snapshot, originals) {
  const annotations = new Map((snapshot?.items || []).map(item => [item.xid, item]));
  for (const feature of features) {
    const props = feature.properties;
    if (!originals.has(props.id)) originals.set(props.id, props.places || []);
    const original = originals.get(props.id);
    const annotation = annotations.get(props.id);
    props.annotation = snapshot ? annotation || null : null;
    props.annotation_unavailable = !snapshot;
    props.metadata_revision = snapshot?.metadata_revision ?? null;
    props.places = !snapshot ? [] : !annotation ? original : annotation.place_mode === 'unknown' ? [] :
      annotation.place_mode === 'replace' ? annotation.places || [] : original.filter(place => !annotation.disputed_place_ids.includes(place.id));
  }
}
