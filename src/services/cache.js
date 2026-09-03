const cache = new Map();

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

function get(key) {
  const item = cache.get(key);

  if (!item) {
    return null;
  }

  if (Date.now() > item.expiresAt) {
    cache.delete(key);
    return null;
  }

  return item.value;
}

function set(key, value, ttlMs = DEFAULT_TTL_MS) {
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs
  });

  return value;
}

function remove(key) {
  cache.delete(key);
}

function clear() {
  cache.clear();
}

function stats() {
  return {
    entries: cache.size
  };
}

module.exports = {
  get,
  set,
  remove,
  clear,
  stats
};
