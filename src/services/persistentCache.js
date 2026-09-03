const supabase = require('../config/supabase');

const DEFAULT_TTL_MS = 5 * 60 * 1000;

async function get(styleId) {
  const { data, error } = await supabase
    .from('market_cache')
    .select('data, expires_at')
    .eq('style_id', styleId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return null;
  }

  if (new Date(data.expires_at).getTime() <= Date.now()) {
    return null;
  }

  return data.data;
}

async function set(styleId, value, ttlMs = DEFAULT_TTL_MS) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  const storedValue = {
    ...value
  };

  delete storedValue.cache;

  const { error } = await supabase
    .from('market_cache')
    .upsert({
      style_id: styleId,
      data: storedValue,
      fetched_at: storedValue.fetchedAt || now.toISOString(),
      expires_at: expiresAt.toISOString(),
      updated_at: now.toISOString()
    });

  if (error) {
    throw error;
  }

  return storedValue;
}

module.exports = {
  get,
  set
};
