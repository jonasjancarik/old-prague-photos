(() => {
  const el = name => document.getElementById(`annotation-${name}`);
  let loadedXid = '';
  let revision = 0;
  let busy = false;
  let loadedReady = false;
  const drafts = new Map();
  let catalogPlaces;
  async function placeOptions() {
    if (!catalogPlaces) {
      const response = await fetch('/data/photos.geojson');
      if (!response.ok) throw new Error('Seznam míst se nepodařilo načíst.');
      const catalog = await response.json();
      catalogPlaces = [...new Map(catalog.features.flatMap(feature => feature.properties.places || []).map(place => [place.id, place])).values()].sort((a,b) => a.label.localeCompare(b.label, 'cs'));
    }
    return catalogPlaces;
  }
  function fillPlaces(name, places, selected) {
    el(name).replaceChildren();
    for (const place of places) {
      const option = document.createElement('option');
      option.value = place.id;
      option.textContent = `${place.label}${place.district ? ` (${place.district})` : ''} · ${{street:'ulice',district:'čtvrť',other:'jiné místo'}[place.kind] || 'místo'}`;
      option.selected = selected.includes(place.id);
      el(name).append(option);
    }
  }
  async function api(url, body) {
    const response = await fetch(url, {credentials: 'same-origin', ...(body ? {method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)} : {})});
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'Upřesnění se nepodařilo načíst.');
    return data;
  }
  function updateControls() {
    el('load').disabled = busy;
    el('xid').disabled = busy;
    const ready = loadedReady && el('xid').value.trim() === loadedXid;
    for (const name of ['draft','publish','withdraw','restore']) el(name).disabled = busy || !ready;
  }
  function rememberDraft() {
    if (!loadedReady) return;
    drafts.set(loadedXid, {public_text:el('text').value,evidence_note:el('evidence').value,place_mode:el('mode').value,
      place_ids:Array.from(el('places').selectedOptions, option=>option.value),
      disputed_place_ids:Array.from(el('disputed').selectedOptions, option=>option.value)});
  }
  function invalidateEditor() {
    loadedReady = false;
    el('content').hidden = true;
    updateControls();
  }
  function fillEditor(value, places, originalPlaces) {
    el('text').value = value?.public_text || '';
    el('evidence').value = value?.evidence_note || '';
    el('mode').value = value?.place_mode || 'keep';
    fillPlaces('places', places, value?.place_ids || []);
    fillPlaces('disputed', originalPlaces, value?.disputed_place_ids || []);
    el('preview').textContent = el('text').value;
  }
  async function run(work) {
    if (busy) return;
    busy = true;
    updateControls();
    try { await work(); } catch(error) { el('status').textContent = error.message; }
    finally { busy = false; updateControls(); }
  }
  let loadedOriginalPlaces = [];
  async function load(xid, {remember = true} = {}) {
    if (remember) rememberDraft();
    invalidateEditor();
    el('xid').value = xid;
    // Commit no record identity or fields until both reads have succeeded.
    const [data, places] = await Promise.all([
      api(`/api/admin/photo-annotations?xid=${encodeURIComponent(xid)}`), placeOptions(),
    ]);
    if (el('xid').value.trim() !== xid) throw new Error('Zadané ID se změnilo. Načtěte fotografii znovu.');
    loadedXid = xid;
    revision = data.annotation?.revision || 0;
    loadedOriginalPlaces = data.photo.places || [];
    el('loaded').textContent = `Načtená fotografie: ${xid}`;
    el('archive').textContent = data.photo.description || 'Archivní popis není uveden.';
    fillEditor(data.annotation, places, loadedOriginalPlaces);
    el('restore').hidden = !drafts.has(xid);
    el('history').replaceChildren();
    for (const item of data.history || []) {
      const paragraph = document.createElement('p');
      const state = {draft:'Rozpracováno',published:'Zveřejněno',withdrawn:'Staženo'}[item.state];
      paragraph.textContent = `${state} · verze ${item.revision} · ${new Date(item.updated_at).toLocaleString('cs-CZ')} · ${item.public_text}`;
      el('history').append(paragraph);
    }
    loadedReady = true;
    el('content').hidden = false;
    el('status').textContent = data.annotation?.published ? 'Fotografie má zveřejněné upřesnění.' : 'Fotografie nemá zveřejněné upřesnění.';
  }
  el('load')?.addEventListener('click', () => run(() => load(el('xid').value.trim())));
  el('xid')?.addEventListener('input', () => {
    rememberDraft();
    invalidateEditor();
    el('status').textContent = 'Nejprve načtěte zadanou fotografii. Rozepsané údaje předchozí fotografie zůstávají v tomto okně a lze je obnovit po jejím načtení.';
  });
  el('restore')?.addEventListener('click', () => {
    if (!loadedReady || el('xid').value.trim() !== loadedXid) return;
    fillEditor(drafts.get(loadedXid), catalogPlaces, loadedOriginalPlaces);
    el('status').textContent = 'Rozepsané údaje byly obnoveny. Před zveřejněním je zkontrolujte.';
  });
  el('text')?.addEventListener('input', () => { el('preview').textContent = el('text').value; });
  for (const action of ['draft','publish','withdraw']) {
    el(action)?.addEventListener('click', () => run(async () => {
      if (!loadedReady || el('xid').value.trim() !== loadedXid) throw new Error('Nejprve načtěte zadanou fotografii.');
      const ids = name => Array.from(el(name).selectedOptions, option => option.value);
      await api('/api/admin/photo-annotations', {xid:loadedXid,expected_revision:revision,action,public_text:el('text').value,evidence_note:el('evidence').value,place_mode:el('mode').value,place_ids:ids('places'),disputed_place_ids:ids('disputed')});
      if (window.BroadcastChannel) { const channel = new BroadcastChannel('opp-annotations'); channel.postMessage('changed'); channel.close(); }
      drafts.delete(loadedXid);
      await load(loadedXid, {remember:false});
      el('status').textContent = {draft:'Rozpracované upřesnění je uložené.',publish:'Upřesnění je zveřejněné.',withdraw:'Upřesnění je stažené. Archivní údaje zůstaly zachované.'}[action];
    }));
  }
  updateControls();
  window.OldPragueAnnotationAdmin = {open(xid) {run(async () => {await load(xid); el('editor').scrollIntoView({behavior:'smooth'});});}};
})();
