// Pure catalogue index. Reuse it as review membership and visible filters change.
export function normalizeSearchText(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('cs').replace(/\s+/g, ' ').trim();
}
const searchable = (entity) => normalizeSearchText([entity.label, entity.district, ...(entity.aliases || []), ...(entity.source_terms || [])].join(' '));
const matches = (text, query) => query.split(' ').every((token) => text.includes(token));

export function buildSearchIndex(features) {
  const photos = new Map();
  const places = new Map();
  const authors = new Map();
  for (const feature of features || []) {
    const props = feature?.properties || {};
    const xid = String(props.id || '').trim();
    if (!xid || photos.has(xid)) continue;
    photos.set(xid, { xid, feature, descriptionText: normalizeSearchText([props.description, props.annotation?.public_text].filter(Boolean).join(' ')), text: normalizeSearchText([props.description, props.annotation?.public_text, props.author, props.date_label, props.signature, props.note, props.kind].join(' ')) });
    for (const [field, index] of [['places', places], ['authors', authors]]) {
      for (const entity of props[field] || []) {
        if (!entity?.id) continue;
        if (!index.has(entity.id)) index.set(entity.id, { ...entity, xids: new Set(), texts: new Set(), labels: new Set(), aliasTexts: new Set() });
        const entry = index.get(entity.id);
        entry.xids.add(xid);
        entry.texts.add(searchable(entity));
        entry.labels.add(normalizeSearchText(entity.label));
        entry.labels.add(normalizeSearchText([entity.label, entity.district].filter(Boolean).join(' ')));
        for (const alias of entity.aliases || []) entry.aliasTexts.add(normalizeSearchText(alias));
      }
    }
  }
  return { photos, places, authors };
}

// groupByXid is the current grouping result, not immutable base membership.
export function updateSearchMembership(index, groupByXid = new Map(), visibleXids = null) {
  const membership = new Map();
  for (const [xid, photo] of index.photos) {
    if (visibleXids && !visibleXids.has(xid)) continue;
    const current = groupByXid.get(xid);
    membership.set(xid, typeof current === 'string' ? current : current?.id || photo.feature.properties.group_id || xid);
  }
  return { index, membership };
}

export function searchIndex(state, query, { limit = 14, field = 'all' } = {}) {
  const text = normalizeSearchText(query);
  if (!text) return { places: [], authors: [], photos: [] };
  const { index, membership } = state;
  const entities = (entries) => Array.from(entries.values()).filter((entity) => Array.from(entity.texts).some((value) => matches(value, text))).map((entity) => {
    const xids = Array.from(entity.xids).filter((xid) => membership.has(xid)).sort();
    const groupIds = Array.from(new Set(xids.map((xid) => membership.get(xid)))).sort();
    const { texts, labels, aliasTexts, ...data } = entity;
    const rank = labels.has(text) ? 0 : aliasTexts.has(text) ? 1 : Array.from(labels).some((label) => label.startsWith(text)) ? 2 : 3;
    return { ...data, rank, xids, groupIds, photoCount: xids.length, groupCount: groupIds.length, matchedXid: xids[0] };
  }).filter((entity) => entity.photoCount).sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label, 'cs') || a.id.localeCompare(b.id)).slice(0, limit);
  const groups = new Map();
  for (const photo of index.photos.values()) {
    if (!membership.has(photo.xid) || !matches(field === 'description' ? photo.descriptionText : photo.text, text)) continue;
    const groupId = membership.get(photo.xid);
    if (!groups.has(groupId)) groups.set(groupId, { groupId, matchedXid: photo.xid, xids: [] });
    groups.get(groupId).xids.push(photo.xid);
  }
  return { places: entities(index.places), authors: entities(index.authors), photos: Array.from(groups.values()).slice(0, limit) };
}

export function searchDescriptions(state, query, options = {}) {
  return searchIndex(state, query, { ...options, field: 'description' }).photos;
}
