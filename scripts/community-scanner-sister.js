// RENDER NODE: scripts/community-scanner-sister.js
const axios = require('axios');

class RateLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RateLimitError';
  }
}

const axiosInstance = axios.create({
  timeout: 6000, // Explicit timeout for Roblox API calls
  httpAgent: new (require('http').Agent)({ keepAlive: true }),
  httpsAgent: new (require('https').Agent)({ keepAlive: true })
});

let cachedDb = null;
let lastDbFetch = 0;
const CACHE_TTL = 10 * 60 * 1000;

async function getDatabase(dbWorkerUrl) {
    const now = Date.now();
    if (cachedDb && (now - lastDbFetch < CACHE_TTL)) return cachedDb;
    try {
        // SECURE FETCH: Added explicit 15s timeout so it never hangs indefinitely
        const res = await axios.post(dbWorkerUrl, { fetchFull: true }, { timeout: 15000 });
        
        // Maps the lowercase 'userid' from Supabase to camelCase 'userId'
        cachedDb = res.data.map(u => ({ userId: u.userid, tier: u.tier, riskscore: u.riskscore }));
        lastDbFetch = now;
        return cachedDb;
    } catch (e) {
        console.error("Worker fetch failed:", e.message);
        throw new Error('Failed to fetch database from worker.');
    }
}

async function asyncPool(poolLimit, array, iteratorFn) {
  const ret = [];
  const executing = [];
  for (const item of array) {
    const p = Promise.resolve().then(() => iteratorFn(item));
    ret.push(p);
    if (poolLimit <= array.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= poolLimit) await Promise.race(executing);
    }
  }
  return Promise.all(ret);
}

async function isUserInGroup(userId, targetGroupId) {
  try {
    const response = await axiosInstance.get(`https://groups.roblox.com/v1/users/${userId}/groups/roles`);
    return response.data.data.some(g => g.group.id === parseInt(targetGroupId));
  } catch (error) {
    const status = error.response?.status;
    if (status === 429 || error.response?.data?.errors?.[0]?.message?.toLowerCase().includes('too many requests')) {
      throw new RateLimitError('Rate limit hit');
    }
    return false;
  }
}

async function checkSisterCommunityScan(payload, dbWorkerUrl) {
  const { groupId, offset = 0, limit = 10, isInitialCall = false } = payload;
  try {
    const dbUsers = await getDatabase(dbWorkerUrl);

    // PHASE 1: Return ONLY the total count. The DB array is kept entirely hidden.
    if (isInitialCall) return { status: 'initial', totalCount: dbUsers.length };

    // PHASE 2: Process the specific 10-user chunk
    const chunk = dbUsers.slice(offset, offset + limit);
    const matchedUsers = [];
    let scannedCount = 0;

    // CONCURRENCY CAP: Lowered to 3 to dramatically reduce Roblox rate limits
    await asyncPool(3, chunk, async (user) => {
      scannedCount++;
      try {
        const isInGroup = await isUserInGroup(user.userId, groupId);
        if (isInGroup) matchedUsers.push({ ...user });
      } catch (e) {
        if (e instanceof RateLimitError) throw e;
      }
    });

    return { status: 'completed', matchedUsers, scannedInBatch: scannedCount };
  } catch (error) {
    if (error instanceof RateLimitError) {
      // Bubbles up to frontend to trigger the infinite 5-second backoff loop (No skips)
      return { status: 'rate_limited', message: 'API rate limit reached.', matchedUsers: [], scannedInBatch: 0 };
    }
    return { status: 'error', message: 'An unexpected error occurred processing chunk.' };
  }
}

module.exports = { checkSisterCommunityScan };
