(() => {
  const view = document.getElementById("modal-photo-feedback-view");
  const form = document.getElementById("photo-feedback-form");
  const message = document.getElementById("photo-feedback-message");
  const email = document.getElementById("photo-feedback-email");
  const status = document.getElementById("photo-feedback-status");
  const submit = form?.querySelector('button[type="submit"]');
  const cancel = document.getElementById("cancel-photo-feedback");
  let xid = "";
  let submissionId = "";
  let sending = false;
  let saved = false;
  let generation = 0;
  let previousFocus = null;
  let onClose = () => {};

  function update() {
    if (submit) submit.disabled = !xid || sending || saved || message.value.trim().length < 5 || !email.checkValidity();
  }

  function close() {
    generation += 1;
    view?.classList.add("is-hidden");
    xid = "";
    submissionId = "";
    sending = false;
    saved = false;
    onClose();
    if (previousFocus?.isConnected) previousFocus.focus();
    previousFocus = null;
  }

  function open(feature, closeCallback) {
    close();
    xid = String(feature?.properties?.id || "").trim();
    if (!xid) return;
    submissionId = crypto.randomUUID();
    onClose = closeCallback || (() => {});
    previousFocus = document.activeElement;
    message.value = "";
    email.value = "";
    status.textContent = "";
    view.classList.remove("is-hidden");
    update();
    message.focus();
  }

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (sending || saved || !xid || message.value.trim().length < 5 || !email.checkValidity()) return;
    const submittedXid = xid;
    const submittedGeneration = generation;
    const payload = {
      submission_id: submissionId,
      xid: submittedXid,
      message: message.value.trim(),
      email: email.value.trim() || null,
    };
    sending = true;
    update();
    status.textContent = "Odesílám připomínku…";
    try {
      const send = () => fetch("/api/feedback", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const retry = window.OldPragueSession?.submitWithSessionRetry;
      const response = retry ? await retry(send) : await send();
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Připomínku se nepodařilo odeslat.");
      if (generation !== submittedGeneration || xid !== submittedXid) return;
      saved = true;
      email.value = "";
      status.textContent = "Děkujeme, připomínku jsme poslali správci.";
    } catch (error) {
      if (generation === submittedGeneration && xid === submittedXid) {
        status.textContent = error.message || "Připomínku se nepodařilo odeslat.";
      }
    } finally {
      if (generation === submittedGeneration) {
        sending = false;
        update();
      }
    }
  });
  message?.addEventListener("input", update);
  email?.addEventListener("input", update);
  cancel?.addEventListener("click", close);
  window.OldPraguePhotoFeedback = { open, close };
})();
