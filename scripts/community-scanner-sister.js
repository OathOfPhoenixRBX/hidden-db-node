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

// Cache DB so we don't pull it on every single batch of 10 users!
let cachedDb = null;
let lastDbFetch = 0;
const CACHE_TTL = 10 * 60 * 1000;

async function getDatabase(dbWorkerUrl) {
    const now = Date.now();
    if (cachedDb && (now - lastDbFetch < CACHE_TTL)) {
        return cachedDb;
    }
    try {
        const res = await axios.get(dbWorkerUrl);
        cachedDb = res.data.map(u => ({ userId: u.userid, tier: u.tier, riskscore: u.riskscore }));
        lastDbFetch = now;
        return cachedDb;
    } catch (e) {
        throw new Error('Failed to fetch database.');
    }
}

async function getUserThumbnails(userIds) {
  if (userIds.length === 0) return new Map();
  try {
    const response = await axiosInstance.get(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userIds.join(',')}&size=150x150&format=Png`);
    return new Map(response.data.data.map(t => [t.targetId, t.imageUrl]));
  } catch (e) {
    return new Map();
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
      if (executing.length >= poolLimit) {
        await Promise.race(executing);
      }
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

// Main Function
async function checkCommunityScanner(payload, dbWorkerUrl, renderSecret) {
  // New architecture reads offset, limit, and isInitialCall
  const { groupId, offset = 0, limit = 10, isInitialCall = false } = payload;

  try {
    const dbUsers = await getDatabase(dbWorkerUrl);

    // Phase 1: Initial call requests the DB list size to set the UI limits
    if (isInitialCall) {
      return { status: 'initial', totalCount: dbUsers.length };
    }

    // Phase 2: Batch processing
    const chunk = dbUsers.slice(offset, offset + limit);
    const matchedUsers = [];
    let scannedCount = 0;

    // Process the batch with concurrency
    await asyncPool(10, chunk, async (user) => {
      scannedCount++;
      try {
        const isInGroup = await isUserInGroup(user.userId, groupId);
        
        if (isInGroup) {
          let username = "Unknown";
          try {
            const uRes = await axiosInstance.get(`https://users.roblox.com/v1/users/${user.userId}`);
            username = uRes.data.name;
          } catch(e){}
          
          matchedUsers.push({ ...user, username });
        }
      } catch (e) {
        if (e instanceof RateLimitError) throw e; // Bubbles up to trigger rate limit retry
      }
    });

    if (matchedUsers.length > 0) {
      const matchedIds = matchedUsers.map(u => u.userId);
      const thumbMap = await getUserThumbnails(matchedIds);
      matchedUsers.forEach(u => u.thumbnail = thumbMap.get(u.userId) || null);
    }

    return { status: 'completed', matchedUsers, scannedInBatch: scannedCount };

  } catch (error) {
    if (error instanceof RateLimitError) {
      // Hydrate whatever we managed to find before the rate limit hit
      if (matchedUsers.length > 0) {
          const matchedIds = matchedUsers.map(u => u.userId);
          const thumbMap = await getUserThumbnails(matchedIds);
          matchedUsers.forEach(u => u.thumbnail = thumbMap.get(u.userId) || null);
      }

      return {
        status: 'rate_limited',
        message: 'API rate limit reached. Automatically retrying soon.',
        matchedUsers,
        scannedInBatch: 0 // Must return 0 so offset doesn't advance and frontend retries!
      };
    }
    return { status: 'error', message: 'An unexpected error occurred.' };
  }
}

module.exports = { checkCommunityScanner };
