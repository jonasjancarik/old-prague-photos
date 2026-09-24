(() => {
  const key = "old-prague-own-proposals-v1";
  let memory = {};
  try {
    const stored = JSON.parse(sessionStorage.getItem(key) || "{}");
    if (stored && typeof stored === "object" && !Array.isArray(stored)) memory = stored;
  } catch { /* A blocked sessionStorage still permits this page to remember its submit. */ }

  window.OldPragueOwnProposals = {
    remember(xid, correctionId) {
      const photo = String(xid || "").trim();
      const id = String(correctionId || "").trim();
      if (!photo || !id) return;
      memory[photo] = id;
      try { sessionStorage.setItem(key, JSON.stringify(memory)); } catch { /* memory remains */ }
    },
    isCurrent(xid, proposedId) {
      const photo = String(xid || "").trim();
      const id = String(proposedId || "").trim();
      return Boolean(photo && id && memory[photo] === id);
    },
    isCurrentInGroup(features, proposedId) {
      return Array.isArray(features) && features.some((feature) =>
        this.isCurrent(feature?.properties?.id, proposedId));
    },
  };
})();
