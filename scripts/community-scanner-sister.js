const axios = require('axios');

class RateLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RateLimitError';
  }
}

const axiosInstance = axios.create({
  timeout: 4000,
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
        // Securely fetch DB from Cloudflare Worker
        const res = await axios.post(dbWorkerUrl, { fetchFull: true }, { timeout: 10000 });
        cachedDb = res.data.map(u => ({ userId: u.userid, tier: u.tier, riskscore: u.riskscore }));
        lastDbFetch = now;
        return cachedDb;
    } catch (e) {
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

// FIXED: Renamed to checkSisterCommunityScan to match server.js
async function checkSisterCommunityScan(payload, dbWorkerUrl) {
  const { groupId, offset = 0, limit = 10, isInitialCall = false } = payload;
  try {
    const dbUsers = await getDatabase(dbWorkerUrl);

    // Phase 1: Return total count to the frontend so it knows how many batches to run
    if (isInitialCall) return { status: 'initial', totalCount: dbUsers.length };

    // Phase 2: Process only the specific 10-user chunk
    const chunk = dbUsers.slice(offset, offset + limit);
    const matchedUsers = [];
    let scannedCount = 0;

    await asyncPool(10, chunk, async (user) => {
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
      // Bubble up the rate limit so frontend can pause for 5 seconds
      return { status: 'rate_limited', message: 'API rate limit reached.', matchedUsers: [], scannedInBatch: 0 };
    }
    return { status: 'error', message: 'An unexpected error occurred.' };
  }
}

// FIXED: Exporting the correct name
module.exports = { checkSisterCommunityScan };
