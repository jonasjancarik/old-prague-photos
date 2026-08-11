(() => {
  const picker = document.querySelector("[data-mode-picker]");
  const flowNodes = Array.from(document.querySelectorAll("[data-mode-flow]"));

  if (!picker && flowNodes.length === 0) return;

  const flowByMode = new Map();
  flowNodes.forEach((node) => {
    const mode = node.dataset.modeFlow || "";
    if (mode) flowByMode.set(mode, node);
  });

  function setMode(mode, updateUrl = true) {
    flowNodes.forEach((node) => {
      node.classList.toggle("is-hidden", node.dataset.modeFlow !== mode);
    });
    if (picker) picker.classList.toggle("is-hidden", Boolean(mode));
    document.querySelectorAll("[data-mode-back]").forEach((link) => {
      link.classList.toggle("is-hidden", !mode);
    });

    if (updateUrl) {
      const url = new URL(window.location.href);
      if (mode) url.searchParams.set("mode", mode);
      else url.searchParams.delete("mode");
      history.pushState({ mode }, "", url);
    }

    window.dispatchEvent(
      new CustomEvent("old-prague-mode", { detail: { mode } }),
    );
  }

  function modeFromUrl() {
    const mode = new URLSearchParams(window.location.search).get("mode") || "";
    return flowByMode.has(mode) ? mode : "";
  }

  setMode(modeFromUrl(), false);

  document.querySelectorAll("[data-mode-select]").forEach((button) => {
    button.addEventListener("click", (event) => {
      const mode = button.dataset.modeSelect;
      if (!mode || !flowByMode.has(mode)) return;

      const href = button.getAttribute("href");
      if (href) {
        const url = new URL(href, window.location.href);
        if (url.pathname !== window.location.pathname) return;
      }

      event.preventDefault();
      setMode(mode);
    });
  });

  document.querySelectorAll("[data-mode-back]").forEach((link) => {
    link.addEventListener("click", (event) => {
      const href = link.getAttribute("href");
      if (!href) return;
      const url = new URL(href, window.location.href);
      if (url.pathname !== window.location.pathname) return;

      event.preventDefault();
      if (modeFromUrl()) setMode("");
    });
  });

  window.addEventListener("popstate", () => {
    setMode(modeFromUrl(), false);
  });
})();
