const countPendingEl = document.getElementById("count-pending");
const countFlagsEl = document.getElementById("count-flags");
const countConflictsEl = document.getElementById("count-conflicts");
const pendingListEl = document.getElementById("list-pending");
const flagsListEl = document.getElementById("list-flags");
const conflictsListEl = document.getElementById("list-conflicts");
const splitsListEl = document.getElementById("list-splits");
const mergesListEl = document.getElementById("list-merges");
const refreshBtn = document.getElementById("refresh-admin");
const exportJsonBtn = document.getElementById("export-json");
const exportCsvBtn = document.getElementById("export-csv");
const exportSinceInput = document.getElementById("export-since");
const exportLimitInput = document.getElementById("export-limit");
const statusEl = document.getElementById("admin-status");
const adminTokenInput = document.getElementById("admin-token");
const saveAdminTokenBtn = document.getElementById("save-admin-token");
const ADMIN_TOKEN_STORAGE_KEY = "old-prague-admin-token";

function getAdminToken() {
  return String(window.sessionStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) || "");
}

function adminHeaders() {
  const token = getAdminToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

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
    renderEmpty(flagsListEl, "Žádná aktivní hlášení.");
    return;
  }
  flagsListEl.innerHTML = "";
  list.forEach((item) => {
    const text = `Skupina ${shortId(item.group_id)} · OK ${item.ok_votes}/${item.required_ok_votes} · ${formatDate(item.last_event_at || item.received_at)}`;
    flagsListEl.appendChild(createDetailItem("Hlášení", text));
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
      conflictsListEl.appendChild(createDetailItem("Konflikt sloučení", text));
      return;
    }
    const text = `Skupina ${shortId(item.group_id)} · ${formatDate(item.received_at)}`;
    conflictsListEl.appendChild(createDetailItem("Lokační konflikt", text));
  });
}

async function applyGroupSplit(sourceGroupId, xids, reason) {
  const response = await fetch("/api/admin/group-membership", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...adminHeaders(),
    },
    body: JSON.stringify({
      source_group_id: sourceGroupId,
      xids,
      reason,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.detail || `Rozdělení selhalo: ${response.status}`);
  }
  return payload;
}

function renderSplits(list) {
  if (!splitsListEl) return;
  splitsListEl.innerHTML = "";
  if (!Array.isArray(list) || !list.length) {
    renderEmpty(splitsListEl, "Žádná skupina zatím nemá dost hlasů pro rozdělení.");
    return;
  }
  list.forEach((item) => {
    const wrapper = document.createElement("div");
    wrapper.className = "detail-item split-candidate";
    const title = document.createElement("div");
    title.className = "detail-label";
    title.textContent = `Skupina ${shortId(item.group_id)} · ${item.split_votes} hlasy pro rozdělení`;
    wrapper.appendChild(title);

    const choices = document.createElement("div");
    choices.className = "split-member-list";
    (item.xids || []).forEach((xid) => {
      const label = document.createElement("label");
      label.className = "split-member";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = xid;
      label.appendChild(checkbox);
      label.append(` ${xid}`);
      choices.appendChild(label);
    });
    wrapper.appendChild(choices);

    const reason = document.createElement("input");
    reason.type = "text";
    reason.placeholder = "Důvod rozdělení";
    reason.setAttribute("aria-label", `Důvod rozdělení skupiny ${item.group_id}`);
    wrapper.appendChild(reason);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.textContent = "Přesunout vybrané do nové skupiny";
    button.addEventListener("click", async () => {
      const selected = Array.from(
        choices.querySelectorAll("input:checked"),
      ).map((input) => input.value);
      button.disabled = true;
      try {
        const result = await applyGroupSplit(
          item.group_id,
          selected,
          String(reason.value || "").trim(),
        );
        setStatus(
          `Přesunuto ${result.moved_xids.length} fotografií do skupiny ${shortId(result.target_group_id)}.`,
          "success",
        );
        await refresh();
      } catch (error) {
        setStatus(error.message || "Rozdělení selhalo", "error");
      } finally {
        button.disabled = false;
      }
    });
    wrapper.appendChild(button);
    splitsListEl.appendChild(wrapper);
  });
}

function renderMerges(list) {
  if (!mergesListEl) return;
  if (!Array.isArray(list) || !list.length) {
    renderEmpty(mergesListEl, "Zatím bez rozhodnutí o sloučení.");
    return;
  }
  mergesListEl.innerHTML = "";
  list.forEach((item) => {
    const verdict = item.verdict === "same" ? "stejný záběr" : "různé záběry";
    const conflict = item.merge_conflict ? " (konflikt)" : "";
    const text = `${shortId(item.group_id_a)} ↔ ${shortId(item.group_id_b)} · ${verdict}${conflict} · ${formatDate(item.received_at)}`;
    mergesListEl.appendChild(createDetailItem("Sloučení", text));
  });
}

async function fetchReview() {
  const response = await fetch("/api/admin/review", {
    credentials: "same-origin",
    headers: adminHeaders(),
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
      Number(payload?.counts?.mergeConflicts || 0) +
      Number(payload?.counts?.splitCandidates || 0);
    countConflictsEl.textContent = String(conflictCount);
  }
  renderPending(payload?.pendingCorrections || []);
  renderFlags(payload?.unresolvedFlags || []);
  renderConflicts(payload?.conflictCandidates || []);
  renderSplits(payload?.splitCandidates || []);
  renderMerges(payload?.recentMerges || []);
  setStatus(`Aktualizováno: ${formatDate(payload?.generatedAt)}`, "success");
}

async function downloadExport(format) {
  const response = await fetch(exportUrl(format), {
    credentials: "same-origin",
    headers: adminHeaders(),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload?.detail || `Export selhal: ${response.status}`);
  }
  const blob = await response.blob();
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `community-review-export.${format}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

if (adminTokenInput) adminTokenInput.value = getAdminToken();
if (saveAdminTokenBtn) {
  saveAdminTokenBtn.addEventListener("click", () => {
    const token = String(adminTokenInput?.value || "").trim();
    if (token) window.sessionStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token);
    else window.sessionStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
    refresh().catch((error) => setStatus(error.message, "error"));
  });
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
    downloadExport("json").catch((error) => setStatus(error.message, "error"));
  });
}

if (exportCsvBtn) {
  exportCsvBtn.addEventListener("click", () => {
    downloadExport("csv").catch((error) => setStatus(error.message, "error"));
  });
}

refresh().catch((error) => {
  setStatus(error.message || "Načtení selhalo", "error");
});
