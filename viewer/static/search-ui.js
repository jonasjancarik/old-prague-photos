(() => {
  const sections = [
    ['places', 'Místa', 'Další místa'],
    ['descriptions', 'Zmínky v popisu', 'Další fotografie'],
    ['authors', 'Autoři', 'Další autoři'],
    ['addresses', 'Adresy na mapě', ''],
  ];

  // The UI consumes semantic results from the data index; it never normalizes entities.
  function mount({ input, popup, chip, status, getResults, suggest, onSelect, onText, onClear }) {
    let generation = 0;
    let controller;
    let timer;
    let composing = false;
    let active = -1;
    let choices = [];
    let results = {};
    let limits = {};
    let addressMessage = '';
    const close = () => {
      generation += 1;
      clearTimeout(timer);
      controller?.abort();
      popup.classList.add('is-hidden');
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      active = -1;
    };
    const activate = (index) => {
      active = index;
      popup.querySelectorAll('[role=option]').forEach((el, i) => {
        el.setAttribute('aria-selected', String(i === active));
        if (i === active) {
          input.setAttribute('aria-activedescendant', el.id);
          el.scrollIntoView({ block: 'nearest' });
        }
      });
      if (active < 0) input.removeAttribute('aria-activedescendant');
    };
    const select = (item) => {
      close();
      onSelect(item);
    };
    const render = () => {
      const previousChoice = active >= 0 ? choices[active] : null;
      popup.replaceChildren();
      choices = [];
      active = -1;
      input.removeAttribute('aria-activedescendant');
      for (const [key, title, moreLabel] of sections) {
        const items = results[key] || [];
        if (!items.length && !(key === 'addresses' && addressMessage)) continue;
        const heading = document.createElement('div');
        heading.className = 'search-section-title';
        heading.id = `search-heading-${key}`;
        heading.textContent = title;
        popup.append(heading);
        const list = document.createElement('div');
        list.setAttribute('role', 'listbox');
        list.id = `search-list-${key}`;
        list.setAttribute('aria-labelledby', heading.id);
        popup.append(list);
        for (const item of items.slice(0, limits[key] || 5)) {
          const index = choices.length;
          choices.push(item);
          const option = document.createElement('div');
          option.id = `search-option-${index}`;
          option.className = 'search-item';
          option.setAttribute('role', 'option');
          option.setAttribute('aria-selected', 'false');
          option.dataset.kind = item.kind;
          const label = document.createElement('p');
          label.className = 'search-item-title';
          label.textContent = item.label;
          const detail = document.createElement('p');
          detail.className = 'search-item-meta';
          detail.textContent = item.detail;
          option.append(label, detail);
          option.addEventListener('mousedown', (event) => event.preventDefault());
          option.addEventListener('click', () => select(item));
          list.append(option);
        }
        if (moreLabel && items.length > (limits[key] || 5)) {
          // Pagination is a button outside option/group semantics, associated with the popup.
          const more = document.createElement('button');
          more.type = 'button';
          more.className = 'search-more';
          more.textContent = moreLabel;
          more.addEventListener('click', () => {
            limits[key] = Math.min(100, (limits[key] || 5) + 5);
            render();
            input.focus();
          });
          if ((limits[key] || 5) < 100) popup.append(more);
        }
        if (key === 'addresses') {
          const attribution = document.createElement('a');
          attribution.href = 'https://mapy.com/';
          attribution.textContent = '© Mapy.com';
          attribution.className = 'search-attribution';
          popup.append(attribution);
          if (addressMessage) {
            const message = document.createElement('p');
            message.className = 'search-empty';
            message.textContent = addressMessage;
            popup.append(message);
          }
        }
      }
      if (!choices.length && !addressMessage) {
        const empty = document.createElement('p');
        empty.className = 'search-empty';
        empty.textContent = 'Žádné návrhy. Enterem můžete hledat ve všech údajích fotografií.';
        popup.append(empty);
      }
      popup.classList.remove('is-hidden');
      input.setAttribute('aria-expanded', 'true');
      input.setAttribute('aria-controls', Array.from(popup.querySelectorAll('[role=listbox]')).map((list) => list.id).join(' ') || popup.id);
      if (previousChoice) activate(choices.indexOf(previousChoice));
      status.textContent = `${choices.length} návrhů. Šipkami vyberte výsledek, Enterem hledejte text.`;
    };
    const update = () => {
      close();
      if (composing) return;
      const query = input.value.trim();
      if (query.length < 2) { popup.replaceChildren(); status.textContent = ''; return; }
      const token = generation;
      limits = {};
      results = getResults(query);
      addressMessage = '';
      render();
      if (query.length < 3) return;
      timer = setTimeout(async () => {
        controller = new AbortController();
        const requestController = controller;
        const timeout = setTimeout(() => requestController.abort(), 5000);
        try {
          const addresses = await suggest(query, requestController.signal);
          if (generation !== token) return;
          results.addresses = addresses;
        } catch {
          if (generation !== token) return;
          addressMessage = 'Adresy teď nelze načíst. Místní fotografie můžete hledat dál.';
        } finally {
          clearTimeout(timeout);
        }
        if (generation === token) render();
      }, 400);
    };
    input.addEventListener('compositionstart', () => { composing = true; close(); });
    input.addEventListener('compositionend', () => { composing = false; update(); });
    input.addEventListener('input', update);
    input.addEventListener('keydown', (event) => {
      if (composing || event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (popup.classList.contains('is-hidden')) update();
        if (!choices.length) return;
        event.preventDefault();
        activate(active < 0 ? (event.key === 'ArrowDown' ? 0 : choices.length - 1)
          : (active + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const item = active >= 0 ? choices[active] : null;
        const query = input.value.trim();
        close();
        if (item) onSelect(item);
        else if (query) onText(query);
      } else if (event.key === 'Tab') {
        // Let native Tab reach pagination buttons, or leave the field normally.
        activate(-1);
      }
    });
    document.addEventListener('click', (event) => {
      if (!input.contains(event.target) && !popup.contains(event.target)) close();
    });
    return {
      close,
      refresh: () => { if (!popup.classList.contains('is-hidden')) update(); },
      setFilter(filter) {
        chip.replaceChildren();
        if (!filter) { chip.hidden = true; return; }
        const label = document.createElement('span');
        label.textContent = `${{ place: 'Místo', author: 'Autor', text: 'Text' }[filter.type]}: ${filter.label}`;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '×';
        remove.setAttribute('aria-label', 'Zrušit filtr hledání');
        remove.addEventListener('click', () => { close(); onClear(); input.focus(); });
        chip.append(label, remove);
        chip.hidden = false;
      },
    };
  }

  async function suggest(query, apiKey, signal) {
    if (!apiKey) throw new Error('Address search is not configured');
    const url = new URL('https://api.mapy.com/v1/suggest');
    url.search = new URLSearchParams({ query: query.slice(0, 150), lang: 'cs', limit: '5',
      type: 'regional.address,regional.street', locality: 'BOX(14.22,49.94,14.71,50.18)', apikey: apiKey });
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Suggest HTTP ${response.status}`);
    const payload = await response.json();
    return (payload.items || []).filter((item) => Number.isFinite(item.position?.lat) && Number.isFinite(item.position?.lon))
      .slice(0, 5).map((item) => ({ kind: 'address', label: [item.name, item.location].filter(Boolean).join(', '),
        detail: 'Přesunout mapu na toto místo', lat: item.position.lat, lon: item.position.lon }));
  }
  window.OldPragueSearchUI = { mount, suggest };
})();
