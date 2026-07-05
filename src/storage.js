/**
 * localStorage adapter with the same API shape as the claude.ai artifact's
 * window.storage, so UI code ports with a one-line import change.
 * Async signatures kept deliberately — swapping in IndexedDB later is a drop-in.
 */
export const storage = {
  async get(key) {
    const v = localStorage.getItem(key);
    if (v === null) throw new Error("key not found: " + key);
    return { key, value: v };
  },
  async set(key, value) {
    localStorage.setItem(key, value);
    return { key, value };
  },
  async delete(key) {
    localStorage.removeItem(key);
    return { key, deleted: true };
  }
};
