const scriptPromises = new Map();
let modalFocusTrapInstalled = false;

function isVisibleElement(element) {
  if (!(element instanceof HTMLElement)) return false;
  const style = window.getComputedStyle(element);
  return (
    element.getClientRects().length > 0 &&
    style.display !== "none" &&
    style.visibility !== "hidden"
  );
}

function installModalFocusTrap() {
  if (modalFocusTrapInstalled) return;
  modalFocusTrapInstalled = true;
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const openModals = Array.from(document.querySelectorAll(".modal.is-open"))
      .filter((element) => (
        element.getAttribute("aria-hidden") !== "true" &&
        isVisibleElement(element)
      ));
    const modal = openModals.at(-1);
    if (!modal) return;
    const focusable = Array.from(
      modal.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), iframe, [contenteditable="true"], [tabindex]:not([tabindex="-1"])',
      ),
    ).filter(isVisibleElement);
    if (!focusable.length) {
      event.preventDefault();
      modal.querySelector('[role="dialog"]')?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (!modal.contains(active)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

function normalizeScriptUrl(src) {
  return new URL(src, window.location.href).toString();
}

function loadScript(src) {
  const normalized = normalizeScriptUrl(src);
  if (scriptPromises.has(normalized)) return scriptPromises.get(normalized);

  const promise = new Promise((resolve, reject) => {
    const existing = Array.from(document.querySelectorAll("script")).find(
      (script) => script.src === normalized,
    );
    const script = existing || document.createElement("script");
    const handleLoad = () => {
      script.dataset.loaded = "true";
      resolve();
    };
    const handleError = () => reject(new Error(`Failed to load script: ${src}`));

    if (existing?.dataset.loaded === "true") {
      resolve();
    } else {
      script.addEventListener("load", handleLoad, { once: true });
      script.addEventListener("error", handleError, { once: true });
      if (!existing) {
        script.src = src;
        script.async = false;
        document.body.appendChild(script);
      }
    }
  });
  scriptPromises.set(normalized, promise);
  return promise;
}

export async function mountPage(template, scripts) {
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing page root");
  root.innerHTML = template;
  installModalFocusTrap();
  for (const script of scripts) {
    try {
      await loadScript(script);
    } catch (error) {
      if (!/^https:\/\//u.test(script)) throw error;
      console.warn(`Optional browser library unavailable: ${script}`, error);
    }
  }
}
