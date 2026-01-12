(() => {
  function escapeText(value) {
    const div = document.createElement("div");
    div.textContent = value == null ? "" : String(value);
    return div.textContent;
  }

  function getArchiveUrl(archiveBaseUrl, xid, scanIndex) {
    if (!archiveBaseUrl || !xid) return "";
    const scanParam = Number.isFinite(scanIndex) ? scanIndex + 1 : 1;
    return `${String(archiveBaseUrl).replace(/\/$/, "")}/permalink?xid=${encodeURIComponent(
      xid,
    )}&scan=${scanParam}#scan${scanParam}`;
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
    const groupItems = Array.isArray(options.groupItems) ? options.groupItems : [];
    const selectedId = String(options.selectedId || "");
    const versionClusters = Array.isArray(options.versionClusters)
      ? options.versionClusters
      : [];
    const selectedVersionId = String(options.selectedVersionId || "");
    const onSelectVersion =
      typeof options.onSelectVersion === "function"
        ? options.onSelectVersion
        : null;
    const onSelectScan =
      typeof options.onSelectScan === "function" ? options.onSelectScan : null;

    const items = [
      ["Popis", props.description],
      ["Datace", props.date_label],
      ["Autor", props.author],
      ["Signatura", props.signature],
      ["Poznámka", props.note],
      ["Geolokace", props.geolocation_type],
    ];

    const selectedScanIndex = Number.isFinite(options.selectedScanIndex)
      ? options.selectedScanIndex
      : 0;
    const scanPreviews = Array.isArray(props.scan_previews)
      ? props.scan_previews
      : [];
    const scanCount = Math.max(Number(props.scan_count) || 0, scanPreviews.length);
    const normalizedScanIndex =
      scanCount > 0
        ? Math.min(Math.max(selectedScanIndex, 0), scanCount - 1)
        : selectedScanIndex;
    const archiveUrl = getArchiveUrl(archiveBaseUrl, xid, normalizedScanIndex);

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

    if (versionClusters.length) {
      const wrapper = document.createElement("div");
      wrapper.className = "detail-item";

      const labelEl = document.createElement("div");
      labelEl.className = "detail-label";
      labelEl.textContent = `Verze (auto)`;

      const list = document.createElement("div");
      list.className = "version-list";

      versionClusters.forEach((cluster, index) => {
        const xids = Array.isArray(cluster?.xids) ? cluster.xids : [];
        if (!xids.length) return;
        const representative = cluster.representative_xid || xids[0];
        const label = `Verze ${index + 1}`;
        const suffix = xids.length > 1 ? ` · ${xids.length}` : "";
        const button = document.createElement("button");
        button.type = "button";
        button.className = "version-pill";
        if (
          (selectedVersionId && cluster.version_id === selectedVersionId) ||
          xids.includes(selectedId)
        ) {
          button.classList.add("is-active");
        }
        button.textContent = `${label}${suffix}`;
        button.title = xids.join(", ");
        if (onSelectVersion) {
          button.addEventListener("click", () => onSelectVersion(representative));
        } else {
          button.disabled = true;
        }
        list.appendChild(button);
      });

      wrapper.appendChild(labelEl);
      wrapper.appendChild(list);
      container.appendChild(wrapper);
    } else if (groupItems.length > 1) {
      const wrapper = document.createElement("div");
      wrapper.className = "detail-item";

      const labelEl = document.createElement("div");
      labelEl.className = "detail-label";
      labelEl.textContent = `Verze`;

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

    if (scanCount > 1) {
      const wrapper = document.createElement("div");
      wrapper.className = "detail-item";

      const labelEl = document.createElement("div");
      labelEl.className = "detail-label";
      labelEl.textContent = "Skeny (archiv)";

      const list = document.createElement("div");
      list.className = "scan-list";

      for (let i = 0; i < scanCount; i += 1) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "scan-pill";
        button.textContent = `${i + 1}`;
        if (i === normalizedScanIndex) button.classList.add("is-active");
        if (onSelectScan) {
          button.addEventListener("click", () => onSelectScan(i));
        } else {
          button.disabled = true;
        }
        list.appendChild(button);
      }

      wrapper.appendChild(labelEl);
      wrapper.appendChild(list);
      container.appendChild(wrapper);
    }
  }

  window.OldPragueMeta = {
    renderDetails,
  };
})();
