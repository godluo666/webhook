import { createHash } from 'node:crypto';

// Only overlapping reads share a snapshot; a later check always reads again.
export function createSharedSourceReader(read, { maxEntries = 64, maxConsumers = 32 } = {}) {
  const pending = new Map();
  const keyOf = (url, options) => JSON.stringify([
    options.userId, String(url), options.mode || 'auto', Boolean(options.expectsJson),
    Boolean(options.direct), createHash('sha256').update(options.proxyUrl || '').digest('hex'),
    options.proxyIdentity || ''
  ]);
  const forget = entry => { if (pending.get(entry.key) === entry) pending.delete(entry.key); };
  function readShared(url, options = {}) {
    const { signal } = options;
    signal?.throwIfAborted();
    if (!options.userId) return read(url, options);
    const key = keyOf(url, options);
    let entry = pending.get(key);
    if (entry?.consumers.size >= maxConsumers || (!entry && pending.size >= maxEntries)) return read(url, options);
    if (!entry) {
      entry = { key, controller: new AbortController(), consumers: new Set() };
      pending.set(key, entry);
      entry.promise = Promise.resolve().then(() => {
        entry.controller.signal.throwIfAborted();
        return read(url, { ...options, signal: entry.controller.signal });
      }).finally(() => forget(entry));
    }
    return new Promise((resolve, reject) => {
      const consumer = {};
      entry.consumers.add(consumer);
      const detach = () => {
        signal?.removeEventListener('abort', abort);
        return entry.consumers.delete(consumer);
      };
      const abort = () => {
        if (!detach()) return;
        reject(signal.reason);
        if (!entry.consumers.size) { forget(entry); entry.controller.abort(); }
      };
      signal?.addEventListener('abort', abort, { once: true });
      entry.promise.then(result => {
        if (detach()) {
          try {
            // The potentially large HTML string is immutable; isolate the mutable details.
            const { body, ...details } = result;
            resolve({ ...structuredClone(details), body });
          } catch (error) { reject(error); }
        }
      }, error => {
        if (detach()) {
          // Rule tests attach their own report, so each caller gets its own error.
          try {
            const copy = new Error(error.message, { cause: error.cause });
            Object.assign(copy, error);
            copy.name = error.name || 'Error';
            copy.stack = error.stack;
            if (error.fetchDetails) copy.fetchDetails = structuredClone(error.fetchDetails);
            reject(copy);
          } catch (copyError) { reject(copyError); }
        }
      });
      if (signal?.aborted) abort();
    });
  }
  Object.defineProperty(readShared, 'active', { get: () => pending.size });
  return readShared;
}
