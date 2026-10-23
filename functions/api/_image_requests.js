export function isValidImageId(value) {
  return /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

export function parseScanIndex(value) {
  if (value === null) return 0;
  if (!/^\d+$/u.test(value)) return null;
  const index = Number(value);
  return Number.isSafeInteger(index) ? index : null;
}

export function catalogScanCount(props) {
  const declared = Number(props?.scan_count);
  return Math.max(
    1,
    Number.isSafeInteger(declared) && declared > 0 ? declared : 0,
    Array.isArray(props?.scan_previews) ? props.scan_previews.length : 0,
    Array.isArray(props?.scan_zoomify_paths) ? props.scan_zoomify_paths.length : 0,
  );
}

// Keep the deadline active through body consumption, not only response headers.
export async function fetchImageResource(url, {
  method = "GET",
  userAgent,
  readText = false,
  maxBytes = 128 * 1024,
  timeoutMs = 5000,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: { "User-Agent": userAgent },
      signal: controller.signal,
    });
    if (!readText || !response.ok) {
      await response.body?.cancel();
      return { ok: response.ok, status: response.status, text: "" };
    }
    const reader = response.body?.getReader();
    if (!reader) return { ok: response.ok, status: response.status, text: "" };
    const decoder = new TextDecoder();
    let size = 0;
    let text = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new Error("Image metadata response too large");
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      try {
        await reader.cancel();
      } finally {
        reader.releaseLock();
      }
    }
    return { ok: response.ok, status: response.status, text };
  } finally {
    clearTimeout(timer);
  }
}
