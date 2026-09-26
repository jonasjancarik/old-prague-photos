const countPendingEl = document.getElementById("count-pending");
const countFlagsEl = document.getElementById("count-flags");
const countConflictsEl = document.getElementById("count-conflicts");
const pendingListEl = document.getElementById("list-pending");
const flagsListEl = document.getElementById("list-flags");
const conflictsListEl = document.getElementById("list-conflicts");
const splitsListEl = document.getElementById("list-splits");
const membershipHistoryListEl = document.getElementById("list-membership-history");
const mergesListEl = document.getElementById("list-merges");
const refreshBtn = document.getElementById("refresh-admin");
const exportJsonBtn = document.getElementById("export-json");
const exportCsvBtn = document.getElementById("export-csv");
const exportSinceInput = document.getElementById("export-since");
const exportLimitInput = document.getElementById("export-limit");
const statusEl = document.getElementById("admin-status");
const adminTokenInput = document.getElementById("admin-token");
const saveAdminTokenBtn = document.getElementById("save-admin-token");
const logoutAdminBtn = document.getElementById("logout-admin");
const operationsListEl = document.getElementById("admin-operations");
const feedbackListEl = document.getElementById("feedback-admin-list");
const feedbackStatusEl = document.getElementById("feedback-admin-status");
const feedbackMoreBtn = document.getElementById("feedback-more");
const feedbackNewBtn = document.getElementById("feedback-new");
const feedbackResolvedBtn = document.getElementById("feedback-resolved");
let feedbackStatus = "new";
let feedbackBeforeId = null;
let feedbackLoading = false;

async function loadFeedback({ append = false } = {}) {
  if (feedbackLoading || !feedbackListEl) return;
  feedbackLoading = true;
  feedbackStatusEl.textContent = "Načítám připomínky…";
  try {
    const params = new URLSearchParams({ status: feedbackStatus, limit: "30" });
    if (append && feedbackBeforeId) params.set("before_id", feedbackBeforeId);
    const response = await fetch(`/api/admin/feedback?${params}`, { credentials: "same-origin" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || "Připomínky se nepodařilo načíst.");
    if (!append) feedbackListEl.replaceChildren();
    for (const item of data.items || []) {
      const card = document.createElement("article");
      card.className = "feedback-admin-item";
      const link = document.createElement("a");
      link.href = `./index.html?xid=${encodeURIComponent(item.xid)}`;
      link.textContent = `Fotografie ${item.xid}`;
      const date = document.createElement("p");
      date.className = "helper";
      date.textContent = formatDate(item.created_at);
      const message = document.createElement("p");
      message.className = "feedback-admin-message";
      message.textContent = item.message;
      card.append(link, date, message);
      if (item.email) card.append(createDetailItem("E-mail pro upřesnění", item.email));
      const action = document.createElement("button");
      action.type = "button";
      action.className = "secondary";
      action.textContent = feedbackStatus === "new" ? "Označit jako vyřízené" : "Vrátit mezi nové";
      action.addEventListener("click", async () => {
        action.disabled = true;
        try {
          const nextStatus = feedbackStatus === "new" ? "resolved" : "new";
          const updated = await fetch("/api/admin/feedback", {
            method: "POST", credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: String(item.id), status: nextStatus }),
          });
          const payload = await updated.json().catch(() => ({}));
          if (!updated.ok) throw new Error(payload.detail || "Stav se nepodařilo změnit.");
          card.remove();
          feedbackStatusEl.textContent = nextStatus === "resolved" ? "Připomínka je vyřízená." : "Připomínka je opět mezi novými.";
        } catch (error) {
          feedbackStatusEl.textContent = error.message;
          action.disabled = false;
        }
      });
      const annotationButton = document.createElement("button");
      annotationButton.type = "button";
      annotationButton.className = "secondary";
      annotationButton.textContent = "Připravit ověřené upřesnění";
      annotationButton.addEventListener("click", () => window.OldPragueAnnotationAdmin.open(item.xid));
      card.append(action, annotationButton);
      feedbackListEl.append(card);
    }
    feedbackBeforeId = data.next_before_id == null ? null : String(data.next_before_id);
    feedbackMoreBtn.hidden = !feedbackBeforeId;
    feedbackStatusEl.textContent = feedbackListEl.childElementCount ? "" : "Žádné připomínky v tomto stavu.";
  } catch (error) {
    feedbackStatusEl.textContent = error.message || "Připomínky se nepodařilo načíst.";
  } finally {
    feedbackLoading = false;
  }
}

function switchFeedback(status) {
  feedbackStatus = status;
  feedbackBeforeId = null;
  feedbackNewBtn.setAttribute("aria-pressed", String(status === "new"));
  feedbackResolvedBtn.setAttribute("aria-pressed", String(status === "resolved"));
  loadFeedback();
}
feedbackNewBtn?.addEventListener("click", () => switchFeedback("new"));
feedbackResolvedBtn?.addEventListener("click", () => switchFeedback("resolved"));
feedbackMoreBtn?.addEventListener("click", () => loadFeedback({ append: true }));

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

function renderOperations(operations) {
  if (!operationsListEl) return;
  operationsListEl.innerHTML = "";
  if (!operations) {
    renderEmpty(operationsListEl, "Provozní údaje nejsou k dispozici.");
    return;
  }

  const projection = operations.projection || {};
  const publicState = projection.current
    ? `Aktuální · poslední přepočet ${formatDate(projection.updatedAt)}`
    : projection.expectedDataVersion !== projection.projectedDataVersion
      ? "Nasazená data se liší od posledního přepočtu. Obnovte některý pracovní seznam a pak stav zkontrolujte znovu."
      : projection.hasPayload
        ? `Čeká na přepočet ${Number(projection.pendingRevisions || 0)} změn.`
        : "Veřejný stav ještě nebyl vytvořen. Obnovte některý pracovní seznam a pak stav zkontrolujte znovu.";
  operationsListEl.appendChild(
    createDetailItem("Změny na veřejném webu", publicState),
  );

  const submissions = operations.submissions || {};
  operationsListEl.appendChild(
    createDetailItem(
      "Příspěvky za 24 hodin",
      `Přijato ${Number(submissions.accepted24h || 0)} · odmítnuto ${Number(submissions.rejected24h || 0)}`,
    ),
  );

  const queues = operations.queues || {};
  const oldest = queues.oldestPendingAt
    ? ` · nejstarší položka ${formatDate(queues.oldestPendingAt)}`
    : "";
  operationsListEl.appendChild(
    createDetailItem(
      "Položky čekající na kontrolu",
      `Opravy ${Number(queues.pendingCorrections || 0)} · hlášení ${Number(queues.unresolvedFlags || 0)} · rozdělení ${Number(queues.splitCandidates || 0)} · konflikty ${Number(queues.conflicts || 0)}${oldest}`,
    ),
  );

  const candidateRequests = operations.candidateRequests || {};
  operationsListEl.appendChild(
    createDetailItem(
      "Načítání pracovních seznamů za 24 hodin",
      `Stránky ${Number(candidateRequests.pages24h || 0)} · zastaralé seznamy ${Number(candidateRequests.staleCursors24h || 0)} · selhání ${Number(candidateRequests.failures24h || 0)}`,
    ),
  );

  const contributors = operations.contributors || {};
  operationsListEl.appendChild(
    createDetailItem(
      "Přispěvatelé za 30 dní",
      `Aktivní ${Number(contributors.active30d || 0)} · vracející se ${Number(contributors.returning30d || 0)} · s více příspěvky ${Number(contributors.repeat30d || 0)}`,
    ),
  );
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

async function applyGroupMembership(sourceGroupId, xids, reason, targetGroupId = "") {
  const response = await fetch("/api/admin/group-membership", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      source_group_id: sourceGroupId,
      target_group_id: targetGroupId || undefined,
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

async function resolveMemberPreview(xid, image, emptyState) {
  try {
    const response = await fetch(`/api/preview-url?xid=${encodeURIComponent(xid)}`);
    const payload = await response.json();
    const url = String(payload?.url || "").trim();
    if (!response.ok || !url) throw new Error("missing preview");
    image.src = url;
    image.hidden = false;
    emptyState.hidden = true;
  } catch (error) {
    image.hidden = true;
    emptyState.hidden = false;
  }
}

function createMemberChoice(member) {
  const label = document.createElement("label");
  label.className = "split-member-card";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.value = member.xid;
  checkbox.setAttribute("aria-label", `Vybrat fotografii ${member.xid}`);

  const preview = document.createElement("span");
  preview.className = "split-member-preview";
  const image = document.createElement("img");
  image.alt = "";
  image.loading = "lazy";
  image.hidden = true;
  const empty = document.createElement("span");
  empty.className = "split-member-preview-empty";
  empty.textContent = "Náhled není k dispozici";
  preview.append(image, empty);

  const text = document.createElement("span");
  text.className = "split-member-copy";
  const title = document.createElement("strong");
  title.textContent = member.description || `Fotografie ${member.xid}`;
  const meta = document.createElement("span");
  meta.textContent = [member.date_label, member.author, member.signature]
    .filter(Boolean)
    .join(" · ") || member.xid;
  const id = document.createElement("span");
  id.className = "split-member-id";
  id.textContent = member.xid;
  text.append(title, meta, id);
  label.append(checkbox, preview, text);
  resolveMemberPreview(member.xid, image, empty);
  return label;
}

function attachGroupSearch(input, datalist) {
  let timer = 0;
  let currentResults = new Set();
  input.addEventListener("input", () => {
    window.clearTimeout(timer);
    const query = String(input.value || "").trim();
    if (query.length < 2) {
      datalist.innerHTML = "";
      currentResults = new Set();
      input.setCustomValidity("");
      return;
    }
    timer = window.setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/admin/groups?query=${encodeURIComponent(query)}`,
          { credentials: "same-origin" },
        );
        if (!response.ok) throw new Error(`Hledání selhalo: ${response.status}`);
        const payload = await response.json();
        const items = Array.isArray(payload?.items) ? payload.items : [];
        currentResults = new Set(items.map((item) => item.group_id));
        datalist.innerHTML = "";
        items.forEach((item) => {
          const option = document.createElement("option");
          option.value = item.group_id;
          option.label = `${item.member_count} fotografií · ${item.description || "Bez popisu"}`;
          datalist.appendChild(option);
        });
        input.setCustomValidity(
          input.value && !currentResults.has(input.value)
            ? "Vyberte existující skupinu ze seznamu, nebo pole vymažte."
            : "",
        );
      } catch (error) {
        setStatus(error.message || "Hledání skupin selhalo", "error");
      }
    }, 250);
  });
  input.addEventListener("change", () => {
    input.setCustomValidity(
      input.value && !currentResults.has(input.value)
        ? "Vyberte existující skupinu ze seznamu, nebo pole vymažte."
        : "",
    );
  });
}

function renderSplits(list) {
  if (!splitsListEl) return;
  splitsListEl.innerHTML = "";
  if (!Array.isArray(list) || !list.length) {
    renderEmpty(splitsListEl, "Žádná skupina zatím nemá dost hlasů pro rozdělení.");
    return;
  }
  list.forEach((item, candidateIndex) => {
    const wrapper = document.createElement("div");
    wrapper.className = "detail-item split-candidate";
    const title = document.createElement("div");
    title.className = "detail-label";
    title.textContent = `Skupina ${shortId(item.group_id)} · ${item.split_votes} hlasy pro rozdělení`;
    wrapper.appendChild(title);

    const voteHistory = document.createElement("p");
    voteHistory.className = "helper split-vote-history";
    voteHistory.textContent = (item.vote_history || [])
      .filter((vote) => vote.verdict === "split")
      .map((vote) => `Návrh na rozdělení: ${formatDate(vote.created_at)}`)
      .join(" · ");
    wrapper.appendChild(voteHistory);

    const choices = document.createElement("div");
    choices.className = "split-member-list";
    const members = Array.isArray(item.members) && item.members.length
      ? item.members
      : (item.xids || []).map((xid) => ({ xid }));
    members.forEach((member) => {
      choices.appendChild(createMemberChoice(member));
    });
    wrapper.appendChild(choices);

    const targetLabel = document.createElement("label");
    targetLabel.className = "field";
    const targetTitle = document.createElement("span");
    targetTitle.textContent = "Cílová skupina";
    const target = document.createElement("input");
    target.type = "text";
    target.placeholder = "Začněte psát ID, popis nebo signaturu";
    const datalist = document.createElement("datalist");
    datalist.id = `split-target-groups-${candidateIndex}`;
    target.setAttribute("list", datalist.id);
    target.setAttribute(
      "aria-describedby",
      `split-target-help-${candidateIndex}`,
    );
    const targetHelp = document.createElement("span");
    targetHelp.className = "helper";
    targetHelp.id = `split-target-help-${candidateIndex}`;
    targetHelp.textContent = "Vyberte existující skupinu, nebo nechte pole prázdné pro novou.";
    targetLabel.append(targetTitle, target, datalist, targetHelp);
    attachGroupSearch(target, datalist);
    wrapper.appendChild(targetLabel);

    const reason = document.createElement("input");
    reason.type = "text";
    reason.placeholder = "Důvod rozdělení";
    reason.setAttribute("aria-label", `Důvod rozdělení skupiny ${item.group_id}`);
    wrapper.appendChild(reason);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.textContent = "Přesunout vybrané fotografie";
    button.addEventListener("click", async () => {
      const selected = Array.from(
        choices.querySelectorAll("input:checked"),
      ).map((input) => input.value);
      if (!target.reportValidity()) return;
      button.disabled = true;
      try {
        const result = await applyGroupMembership(
          item.group_id,
          selected,
          String(reason.value || "").trim(),
          String(target.value || "").trim(),
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

function renderMembershipHistory(list) {
  if (!membershipHistoryListEl) return;
  membershipHistoryListEl.innerHTML = "";
  if (!Array.isArray(list) || !list.length) {
    renderEmpty(membershipHistoryListEl, "Zatím nebyla přesunuta žádná fotografie.");
    return;
  }
  list.forEach((item) => {
    const wrapper = document.createElement("div");
    wrapper.className = "detail-item membership-history-item";
    const label = document.createElement("div");
    label.className = "detail-label";
    label.textContent = `${shortId(item.source_group_id)} → ${shortId(item.target_group_id)} · ${formatDate(item.created_at)}`;
    const summary = document.createElement("p");
    summary.className = "detail-value";
    summary.textContent = `${item.xids.length} fotografií: ${item.xids.join(", ")}`;
    wrapper.append(label, summary);
    if (item.reason) {
      const reason = document.createElement("p");
      reason.className = "helper";
      reason.textContent = `Důvod: ${item.reason}`;
      wrapper.appendChild(reason);
    }
    const reverse = document.createElement("button");
    reverse.type = "button";
    reverse.className = "secondary";
    reverse.textContent = "Vrátit tento přesun";
    reverse.disabled = !item.xids.length;

    const confirmation = document.createElement("div");
    confirmation.className = "membership-reversal-confirmation is-hidden";
    const confirmationText = document.createElement("p");
    confirmationText.textContent = `Vrátit ${item.xids.length} fotografií do původní skupiny?`;
    const confirmationActions = document.createElement("div");
    confirmationActions.className = "membership-reversal-actions";
    const confirmReverse = document.createElement("button");
    confirmReverse.type = "button";
    confirmReverse.className = "secondary";
    confirmReverse.textContent = "Ano, vrátit přesun";
    const cancelReverse = document.createElement("button");
    cancelReverse.type = "button";
    cancelReverse.className = "secondary";
    cancelReverse.textContent = "Ponechat beze změny";
    confirmationActions.append(confirmReverse, cancelReverse);
    confirmation.append(confirmationText, confirmationActions);

    reverse.addEventListener("click", () => {
      reverse.classList.add("is-hidden");
      confirmation.classList.remove("is-hidden");
      confirmReverse.focus();
    });
    cancelReverse.addEventListener("click", () => {
      confirmation.classList.add("is-hidden");
      reverse.classList.remove("is-hidden");
      reverse.focus();
    });
    confirmReverse.addEventListener("click", async () => {
      confirmReverse.disabled = true;
      cancelReverse.disabled = true;
      try {
        await applyGroupMembership(
          item.target_group_id,
          item.xids,
          `Vrácení přesunu ${item.id}`,
          item.source_group_id,
        );
        setStatus("Přesun byl vrácen a změna je uložená v historii.", "success");
        await refresh();
      } catch (error) {
        setStatus(error.message || "Přesun se nepodařilo vrátit", "error");
      } finally {
        confirmReverse.disabled = false;
        cancelReverse.disabled = false;
      }
    });
    wrapper.append(reverse, confirmation);
    membershipHistoryListEl.appendChild(wrapper);
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
  renderMembershipHistory(payload?.membershipHistory || []);
  renderMerges(payload?.recentMerges || []);
  renderOperations(payload?.operations);
  setStatus(`Aktualizováno: ${formatDate(payload?.generatedAt)}`, "success");
}

async function downloadExport(format) {
  const response = await fetch(exportUrl(format), {
    credentials: "same-origin",
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

async function createAdminSession(token) {
  const response = await fetch("/api/admin/session", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.detail || `Přihlášení selhalo: ${response.status}`);
  }
}

async function deleteAdminSession() {
  const response = await fetch("/api/admin/session", {
    method: "DELETE",
    credentials: "same-origin",
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload?.detail || `Odhlášení selhalo: ${response.status}`);
  }
}

if (saveAdminTokenBtn) {
  saveAdminTokenBtn.addEventListener("click", async () => {
    const token = String(adminTokenInput?.value || "").trim();
    if (!token) {
      setStatus("Vložte přístupový token.", "error");
      return;
    }
    saveAdminTokenBtn.disabled = true;
    setStatus("Přihlašuji...", "");
    try {
      await createAdminSession(token);
      if (adminTokenInput) adminTokenInput.value = "";
      await refresh();
    } catch (error) {
      setStatus(error.message || "Přihlášení selhalo", "error");
    } finally {
      saveAdminTokenBtn.disabled = false;
    }
  });
}

if (logoutAdminBtn) {
  logoutAdminBtn.addEventListener("click", async () => {
    logoutAdminBtn.disabled = true;
    try {
      await deleteAdminSession();
      window.location.reload();
    } catch (error) {
      setStatus(error.message || "Odhlášení selhalo", "error");
    } finally {
      logoutAdminBtn.disabled = false;
    }
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
loadFeedback();
