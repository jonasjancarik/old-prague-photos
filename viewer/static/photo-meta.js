(() => {
  function escapeText(value) {
    const div = document.createElement("div");
    div.textContent = value == null ? "" : String(value);
    return div.textContent;
  }

  function getArchiveUrl(archiveBaseUrl, xid) {
    if (!archiveBaseUrl || !xid) return "";
    return `${String(archiveBaseUrl).replace(/\/$/, "")}/permalink?xid=${encodeURIComponent(xid)}&scan=1#scan1`;
  }

  function renderDetails(container, feature, archiveBaseUrl) {
    if (!container) return;
    container.innerHTML = "";

    if (!feature) {
      const placeholder = document.createElement("p");
      placeholder.className = "placeholder";
      placeholder.textContent = "Zatím není vybraná fotografie.";
      container.appendChild(placeholder);
      return;
    }

    const props = feature.properties || {};
    const xid = props.id;
    const archiveUrl = getArchiveUrl(archiveBaseUrl, xid);

    const items = [
      ["Typ", props.kind],
      ["Archivní ID", props.id],
      ["Popis", props.description],
      ["Datace", props.date_label],
      ["Autor", props.author],
      ["Poznámka", props.note],
      ["Zhlédnutí", props.views],
      ["Geolokace", props.geolocation_type],
    ];

    if (archiveUrl) {
      items.unshift(["Archivní stránka", archiveUrl, "link"]);
    }

    items.forEach(([label, value, kind]) => {
      if (!value) return;
      const wrapper = document.createElement("div");
      wrapper.className = "detail-item";

      const labelEl = document.createElement("div");
      labelEl.className = "detail-label";
      labelEl.textContent = escapeText(label);

      const valueEl = document.createElement("p");
      valueEl.className = "detail-value";
      if (kind === "link") {
        const link = document.createElement("a");
        link.href = String(value);
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = "Otevřít v archivu";
        valueEl.appendChild(link);
      } else {
        valueEl.textContent = escapeText(value);
      }

      wrapper.appendChild(labelEl);
      wrapper.appendChild(valueEl);
      container.appendChild(wrapper);
    });
  }

  window.OldPragueMeta = {
    renderDetails,
  };
})();
