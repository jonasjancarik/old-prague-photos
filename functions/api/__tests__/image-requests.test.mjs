import assert from "node:assert/strict";
import test from "node:test";
import { fetchImageResource } from "../_image_requests.js";

test("image fetch deadline aborts an upstream that never sends headers", async () => {
  const originalFetch = globalThis.fetch;
  let signal;
  globalThis.fetch = async (_, options) => {
    signal = options.signal;
    return new Promise((_, reject) => signal.addEventListener("abort", () => {
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true }));
  };
  try {
    await assert.rejects(fetchImageResource("https://slow.example", {
      timeoutMs: 10, userAgent: "test", readText: true,
    }), { name: "AbortError" });
    assert.equal(signal.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("image fetch deadline stays active while reading a stalled response body", async () => {
  const originalFetch = globalThis.fetch;
  let signal;
  globalThis.fetch = async (_, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial XML"));
        signal.addEventListener("abort", () => {
          controller.error(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      },
    }));
  };
  try {
    await assert.rejects(fetchImageResource("https://slow-body.example", {
      timeoutMs: 10, userAgent: "test", readText: true,
    }), { name: "AbortError" });
    assert.equal(signal.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("image metadata byte limit applies across chunks without Content-Length", async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(8));
      controller.enqueue(new Uint8Array(8));
    },
    cancel() { cancelled = true; },
  }));
  try {
    await assert.rejects(fetchImageResource("https://large.example", {
      maxBytes: 10, userAgent: "test", readText: true,
    }), /too large/u);
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
