import { useEffect } from 'react';
import '../../../static/styles.css';

const scriptPromises = new Map();

function normalizeScriptUrl(src) {
  return new URL(src, window.location.href).toString();
}

function loadScript(src) {
  const normalized = normalizeScriptUrl(src);
  if (scriptPromises.has(normalized)) {
    return scriptPromises.get(normalized);
  }

  const promise = new Promise((resolve, reject) => {
    const existing = Array.from(document.querySelectorAll('script')).find(
      (script) => script.src === normalized,
    );

    if (
      existing &&
      (existing.dataset.loaded === 'true' ||
        existing.readyState === 'complete' ||
        existing.readyState === 'loaded')
    ) {
      resolve();
      return;
    }

    const script = existing || document.createElement('script');
    const cleanup = () => {
      script.removeEventListener('load', handleLoad);
      script.removeEventListener('error', handleError);
    };
    const handleLoad = () => {
      script.dataset.loaded = 'true';
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error(`Failed to load script: ${src}`));
    };

    script.addEventListener('load', handleLoad);
    script.addEventListener('error', handleError);

    if (!existing) {
      script.src = src;
      script.async = false;
      document.body.appendChild(script);
    }
  });

  scriptPromises.set(normalized, promise);
  return promise;
}

async function loadScripts(scripts) {
  for (const script of scripts) {
    await loadScript(script);
  }
}

export function useLegacyScripts(scripts) {
  useEffect(() => {
    let isDisposed = false;

    loadScripts(scripts).catch((error) => {
      if (!isDisposed) {
        console.error(error);
      }
    });

    return () => {
      isDisposed = true;
    };
  }, [scripts]);
}
