(() => {
  const el = name => document.getElementById(`annotation-${name}`);
  let loadedXid = '';
  let revision = 0;
  let busy = false;
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
  const buttons = ['load', 'draft', 'publish', 'withdraw'];
  async function api(url, body) {
    const response = await fetch(url, {credentials: 'same-origin', ...(body ? {method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)} : {})});
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'Upřesnění se nepodařilo načíst.');
    return data;
  }
  async function run(work) {
    if (busy) return;
    busy = true;
    buttons.forEach(name => { el(name).disabled = true; });
    try { await work(); } catch(error) { el('status').textContent = error.message; }
    finally { busy = false; buttons.forEach(name => { el(name).disabled = false; }); }
  }
  async function load(xid) {
    const data = await api(`/api/admin/photo-annotations?xid=${encodeURIComponent(xid)}`);
    loadedXid = xid;
    revision = data.annotation?.revision || 0;
    el('xid').value = xid;
    el('archive').textContent = data.photo.description || 'Archivní popis není uveden.';
    el('text').value = data.annotation?.public_text || '';
    el('evidence').value = data.annotation?.evidence_note || '';
    el('mode').value = data.annotation?.place_mode || 'keep';
    fillPlaces('places', await placeOptions(), data.annotation?.place_ids || []);
    fillPlaces('disputed', data.photo.places || [], data.annotation?.disputed_place_ids || []);
    el('preview').textContent = el('text').value;
    el('content').hidden = false;
    el('history').replaceChildren();
    for (const item of data.history || []) {
      const paragraph = document.createElement('p');
      const state = {draft:'Rozpracováno',published:'Zveřejněno',withdrawn:'Staženo'}[item.state];
      paragraph.textContent = `${state} · verze ${item.revision} · ${new Date(item.updated_at).toLocaleString('cs-CZ')} · ${item.public_text}`;
      el('history').append(paragraph);
    }
    el('status').textContent = data.annotation?.published ? 'Fotografie má zveřejněné upřesnění.' : 'Fotografie nemá zveřejněné upřesnění.';
  }
  el('load')?.addEventListener('click', () => run(() => load(el('xid').value.trim())));
  el('text')?.addEventListener('input', () => { el('preview').textContent = el('text').value; });
  for (const action of ['draft','publish','withdraw']) {
    el(action)?.addEventListener('click', () => run(async () => {
      const ids = name => Array.from(el(name).selectedOptions, option => option.value);
      await api('/api/admin/photo-annotations', {xid:loadedXid,expected_revision:revision,action,public_text:el('text').value,evidence_note:el('evidence').value,place_mode:el('mode').value,place_ids:ids('places'),disputed_place_ids:ids('disputed')});
      if (window.BroadcastChannel) { const channel = new BroadcastChannel('opp-annotations'); channel.postMessage('changed'); channel.close(); }
      await load(loadedXid);
      el('status').textContent = {draft:'Rozpracované upřesnění je uložené.',publish:'Upřesnění je zveřejněné.',withdraw:'Upřesnění je stažené. Archivní údaje zůstaly zachované.'}[action];
    }));
  }
  window.OldPragueAnnotationAdmin = {open(xid) {run(async () => {await load(xid); el('editor').scrollIntoView({behavior:'smooth'});});}};
})();
