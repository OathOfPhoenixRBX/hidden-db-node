// Replace the existing getFullDatabase function with this:
async function getFullDatabase(dbWorkerUrl) {
  const now = Date.now();
  if (cachedDb && (now - lastDbFetch < CACHE_TTL)) {
    return cachedDb;
  }
  
  try {
    // FIX: Send a POST request with fetchFull to bypass the Worker's ID check
    const res = await axios.post(dbWorkerUrl, { fetchFull: true });
    cachedDb = res.data.map(u => ({ userId: u.userid, tier: u.tier, riskscore: u.riskscore }));
    lastDbFetch = now;
    return cachedDb;
  } catch (e) {
    console.error("Failed to fetch DB from worker:", e.message);
    throw new Error('Database fetch failed');
  }
}
