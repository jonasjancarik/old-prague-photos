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

  function renderDetails(container, feature, archiveBaseUrl, options = {}) {
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
    const groupItems = Array.isArray(options.groupItems) ? options.groupItems : [];
    const selectedId = String(options.selectedId || "");
    const onSelectVersion =
      typeof options.onSelectVersion === "function"
        ? options.onSelectVersion
        : null;

    const items = [
      ["Popis", props.description],
      ["Datace", props.date_label],
      ["Autor", props.author],
      ["Signatura", props.signature],
      ["Poznámka", props.note],
      ["Geolokace", props.geolocation_type],
    ];

    if (archiveUrl) {
      items.push(["Archivní stránka", archiveUrl, "link"]);
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

    if (groupItems.length > 1) {
      const wrapper = document.createElement("div");
      wrapper.className = "detail-item";

      const labelEl = document.createElement("div");
      labelEl.className = "detail-label";
      labelEl.textContent = `Verze (${groupItems.length})`;

      const list = document.createElement("div");
      list.className = "version-list";

      groupItems.forEach((item) => {
        const itemProps = item?.properties || {};
        const itemId = String(itemProps.id || "");
        if (!itemId) return;
        const signature = String(itemProps.signature || "").trim();
        const label = signature || itemId.slice(-6) || itemId;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "version-pill";
        if (itemId === selectedId) button.classList.add("is-active");
        button.textContent = escapeText(label);
        button.title = itemId;
        if (onSelectVersion) {
          button.addEventListener("click", () => onSelectVersion(itemId));
        } else {
          button.disabled = true;
        }
        list.appendChild(button);
      });

      wrapper.appendChild(labelEl);
      wrapper.appendChild(list);
      container.appendChild(wrapper);
    }
  }

  window.OldPragueMeta = {
    renderDetails,
  };
})();
