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

    if (updateUrl) {
      const url = new URL(window.location.href);
      if (mode) url.searchParams.set("mode", mode);
      else url.searchParams.delete("mode");
      history.replaceState({}, "", url);
    }

    window.dispatchEvent(
      new CustomEvent("old-prague-mode", { detail: { mode } }),
    );
  }

  const params = new URLSearchParams(window.location.search);
  const initialMode = params.get("mode");
  if (initialMode && flowByMode.has(initialMode)) {
    setMode(initialMode, false);
  } else {
    flowNodes.forEach((node) => node.classList.add("is-hidden"));
  }

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
})();
