const countPendingEl = document.getElementById("count-pending");
const countFlagsEl = document.getElementById("count-flags");
const countConflictsEl = document.getElementById("count-conflicts");
const pendingListEl = document.getElementById("list-pending");
const flagsListEl = document.getElementById("list-flags");
const conflictsListEl = document.getElementById("list-conflicts");
const mergesListEl = document.getElementById("list-merges");
const refreshBtn = document.getElementById("refresh-admin");
const exportJsonBtn = document.getElementById("export-json");
const exportCsvBtn = document.getElementById("export-csv");
const exportSinceInput = document.getElementById("export-since");
const exportLimitInput = document.getElementById("export-limit");
const statusEl = document.getElementById("admin-status");

function shortId(value) {
  const text = String(value || "").trim();
  if (!text) return "—";
  if (text.length <= 16) return text;
  return `${text.slice(0, 8)}...${text.slice(-6)}`;
}

function formatDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "—";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleString("cs-CZ");
}

function setStatus(message, tone = "") {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.dataset.tone = tone;
}

function createDetailItem(label, value) {
  const wrapper = document.createElement("div");
  wrapper.className = "detail-item";
  const labelEl = document.createElement("div");
  labelEl.className = "detail-label";
  labelEl.textContent = label;
  const valueEl = document.createElement("p");
  valueEl.className = "detail-value";
  valueEl.textContent = value;
  wrapper.appendChild(labelEl);
  wrapper.appendChild(valueEl);
  return wrapper;
}

function renderEmpty(container, message) {
  if (!container) return;
  container.innerHTML = "";
  container.appendChild(createDetailItem("Stav", message));
}

function renderPending(list) {
  if (!pendingListEl) return;
  if (!Array.isArray(list) || !list.length) {
    renderEmpty(pendingListEl, "Nic nečeká na potvrzení.");
    return;
  }
  pendingListEl.innerHTML = "";
  list.forEach((item) => {
    const conflict = item.location_conflict ? " (konflikt souřadnic)" : "";
    const text = `Skupina ${shortId(item.group_id)} · OK ${item.ok_votes}/${item.required_ok_votes}${conflict} · ${formatDate(item.last_event_at || item.received_at)}`;
    pendingListEl.appendChild(createDetailItem("Čeká na potvrzení", text));
  });
}

function renderFlags(list) {
  if (!flagsListEl) return;
  if (!Array.isArray(list) || !list.length) {
    renderEmpty(flagsListEl, "Žádné aktivní flagy.");
    return;
  }
  flagsListEl.innerHTML = "";
  list.forEach((item) => {
    const text = `Skupina ${shortId(item.group_id)} · OK ${item.ok_votes}/${item.required_ok_votes} · ${formatDate(item.last_event_at || item.received_at)}`;
    flagsListEl.appendChild(createDetailItem("Flag", text));
  });
}

function renderConflicts(list) {
  if (!conflictsListEl) return;
  if (!Array.isArray(list) || !list.length) {
    renderEmpty(conflictsListEl, "Bez konfliktů.");
    return;
  }
  conflictsListEl.innerHTML = "";
  list.forEach((item) => {
    if (item.type === "merge") {
      const text = `${shortId(item.group_id_a)} ↔ ${shortId(item.group_id_b)}`;
      conflictsListEl.appendChild(createDetailItem("Merge konflikt", text));
      return;
    }
    const text = `Skupina ${shortId(item.group_id)} · ${formatDate(item.received_at)}`;
    conflictsListEl.appendChild(createDetailItem("Lokační konflikt", text));
  });
}

function renderMerges(list) {
  if (!mergesListEl) return;
  if (!Array.isArray(list) || !list.length) {
    renderEmpty(mergesListEl, "Zatím bez merge rozhodnutí.");
    return;
  }
  mergesListEl.innerHTML = "";
  list.forEach((item) => {
    const verdict = item.verdict === "same" ? "stejný záběr" : "různé záběry";
    const conflict = item.merge_conflict ? " (konflikt)" : "";
    const text = `${shortId(item.group_id_a)} ↔ ${shortId(item.group_id_b)} · ${verdict}${conflict} · ${formatDate(item.received_at)}`;
    mergesListEl.appendChild(createDetailItem("Merge", text));
  });
}

async function fetchReview() {
  const response = await fetch("/api/admin/review", {
    credentials: "same-origin",
  });
  if (!response.ok) {
    let detail = "";
    try {
      const payload = await response.json();
      detail = String(payload?.detail || "");
    } catch (error) {
      detail = "";
    }
    throw new Error(detail || `Požadavek selhal: ${response.status}`);
  }
  return response.json();
}

function exportUrl(format) {
  const url = new URL("/api/admin/export", window.location.origin);
  url.searchParams.set("format", format);
  const since = String(exportSinceInput?.value || "").trim();
  const limit = String(exportLimitInput?.value || "").trim();
  if (since) url.searchParams.set("since", since);
  if (limit) url.searchParams.set("limit", limit);
  return url.toString();
}

async function refresh() {
  setStatus("Načítám...", "");
  const payload = await fetchReview();
  if (countPendingEl) {
    countPendingEl.textContent = String(payload?.counts?.pendingCorrections || 0);
  }
  if (countFlagsEl) {
    countFlagsEl.textContent = String(payload?.counts?.unresolvedFlags || 0);
  }
  if (countConflictsEl) {
    const conflictCount =
      Number(payload?.counts?.locationConflicts || 0) +
      Number(payload?.counts?.mergeConflicts || 0);
    countConflictsEl.textContent = String(conflictCount);
  }
  renderPending(payload?.pendingCorrections || []);
  renderFlags(payload?.unresolvedFlags || []);
  renderConflicts(payload?.conflictCandidates || []);
  renderMerges(payload?.recentMerges || []);
  setStatus(`Aktualizováno: ${formatDate(payload?.generatedAt)}`, "success");
}

if (refreshBtn) {
  refreshBtn.addEventListener("click", () => {
    refresh().catch((error) => {
      setStatus(error.message || "Načtení selhalo", "error");
    });
  });
}

if (exportJsonBtn) {
  exportJsonBtn.addEventListener("click", () => {
    window.open(exportUrl("json"), "_blank", "noopener");
  });
}

if (exportCsvBtn) {
  exportCsvBtn.addEventListener("click", () => {
    window.open(exportUrl("csv"), "_blank", "noopener");
  });
}

refresh().catch((error) => {
  setStatus(error.message || "Načtení selhalo", "error");
});
