import { checkLanguageText } from './language-checker.js';

const controllers = new Map();
self.onmessage = async ({ data }) => {
  if (data.cancel) { controllers.get(data.cancel)?.abort(); return; }
  const controller = new AbortController(); controllers.set(data.id, controller);
  try {
    const issues = await checkLanguageText(data.text, { ...data.options, signal: controller.signal });
    controller.signal.throwIfAborted();
    self.postMessage({ id: data.id, issues });
  } catch (error) {
    if (!controller.signal.aborted) self.postMessage({ id: data.id, error: error.message });
  } finally { controllers.delete(data.id); }
};
