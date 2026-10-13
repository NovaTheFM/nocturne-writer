import { checkLanguageText } from './language-checker.js';

let worker, nextId = 0;
const requests = new Map();

export function checkLanguageTextAsync(text, options = {}) {
  options.signal?.throwIfAborted();
  if (typeof window === 'undefined' || typeof Worker === 'undefined') return checkLanguageText(text, options);
  if (!worker) {
    worker = new Worker(new URL('./language-checker-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const request = requests.get(data.id);
      if (!request) return;
      request.release();
      if (data.error) request.reject(new Error(data.error)); else request.resolve(data.issues);
    };
    worker.onerror = event => {
      for (const request of [...requests.values()]) { request.release(); request.reject(new Error(event.message || 'Не удалось загрузить локальный языковой словарь.')); }
      worker.terminate(); worker = null;
    };
  }
  const id = ++nextId, { signal, ...settings } = options;
  return new Promise((resolve, reject) => {
    const release = () => { requests.delete(id); signal?.removeEventListener('abort', abort); };
    const abort = () => { release(); worker?.postMessage({ cancel: id }); reject(signal.reason); };
    requests.set(id, { resolve, reject, release });
    signal?.addEventListener('abort', abort, { once: true });
    worker.postMessage({ id, text, options: settings });
  });
}
