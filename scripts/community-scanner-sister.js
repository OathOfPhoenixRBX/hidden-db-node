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

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Securely cached DB on your Render node
let cachedDb = null;
let lastDbFetch = 0;
const CACHE_TTL = 10 * 60 * 1000; // Cache the DB for 10 minutes to save requests

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
  
  try {
    // The Render node securely pulls the DB from your Cloudflare worker
    const res = await axios.get(dbWorkerUrl);
    cachedDb = res.data.map(u => ({ userId: u.userid, tier: u.tier, riskscore: u.riskscore }));
    lastDbFetch = now;
    return cachedDb;
  } catch (e) {
    console.error("Failed to fetch DB from worker:", e.message);
    throw new Error('Database fetch failed');
  }
}

async function getGroupMetadata(groupId) {
  try {
    const res = await axiosInstance.get(`https://groups.roblox.com/v1/groups/${groupId}`);
    return { memberCount: res.data.memberCount, accessible: true };
  } catch (e) {
    return { memberCount: 0, accessible: false };
  }
}

async function fetchAllGroupMembers(groupId) {
  const members = [];
  let cursor = "";
  let isFinished = false;

  while (!isFinished) {
    const url = `https://groups.roblox.com/v1/groups/${groupId}/users?limit=100${cursor ? `&cursor=${cursor}` : ""}`;
    const res = await axiosInstance.get(url);
    members.push(...res.data.data);
    if (res.data.nextPageCursor) {
      cursor = res.data.nextPageCursor;
      await sleep(150); // Respect limits
    } else {
      isFinished = true;
    }
  }
  return members;
}

async function isUserInGroup(userId, targetGroupId) {
  try {
    const response = await axiosInstance.get(`https://groups.roblox.com/v1/users/${userId}/groups/roles`);
    return response.data.data.some(g => g.group.id === parseInt(targetGroupId));
  } catch (error) {
    if (error.response?.status === 429) throw new RateLimitError('Rate limit hit');
    return false; 
  }
}

async function getUserThumbnails(userIds) {
  if (userIds.length === 0) return new Map();
  const thumbMap = new Map();
  const chunkSize = 100;
  for (let i = 0; i < userIds.length; i += chunkSize) {
    const chunk = userIds.slice(i, i + chunkSize);
    try {
      const response = await axiosInstance.get(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${chunk.join(',')}&size=150x150&format=Png`);
      if (response.data?.data) {
        response.data.data.forEach(t => thumbMap.set(t.targetId, t.imageUrl));
      }
    } catch (e) {}
  }
  return thumbMap;
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

// MAIN FUNCTION
async function checkSisterCommunityScan(payload, dbWorkerUrl) {
  const { groupId } = payload;
  if (!groupId) return { status: 'error', message: 'Missing groupId' };

  try {
    const [dbUsers, groupInfo] = await Promise.all([
      getFullDatabase(dbWorkerUrl),
      getGroupMetadata(groupId)
    ]);

    if (!groupInfo.accessible || groupInfo.memberCount === 0) {
      return { status: 'error', message: 'Group is invalid or empty.' };
    }

    let matchedUsers = [];
    let methodUsed = '';
    let scannedCount = 0;

    // PATH A: Small Group (Delta Mode - Fetch Group Members)
    // If the group is smaller than our database, it's faster to fetch the group.
    if (groupInfo.memberCount <= dbUsers.length) {
      methodUsed = 'fast_memory_intersect';
      const allGroupMembers = await fetchAllGroupMembers(groupId);
      scannedCount = allGroupMembers.length;
      const groupMemberMap = new Map(allGroupMembers.map(m => [m.user.userId, m.user.username]));
      
      matchedUsers = dbUsers
        .filter(u => groupMemberMap.has(u.userId))
        .map(u => ({ ...u, username: groupMemberMap.get(u.userId) }));

    // PATH B: Massive Group (Standard Batching - Check DB Users)
    // If the group has 1M+ members, we check our DB users against the group.
    } else {
      methodUsed = 'database_concurrent_check';
      scannedCount = dbUsers.length;
      
      await asyncPool(10, dbUsers, async (user) => {
        try {
          const isInGroup = await isUserInGroup(user.userId, groupId);
          if (isInGroup) {
            let username = "Unknown";
            try {
              const uRes = await axiosInstance.get(`https://users.roblox.com/v1/users/${user.userId}`);
              username = uRes.data.name;
            } catch(e) {}
            matchedUsers.push({ ...user, username });
          }
        } catch (e) {
          if (e instanceof RateLimitError) console.warn("Rate limit hit, skipping user:", user.userId);
        }
      });
    }

    // Hydrate thumbnails for matches regardless of the path taken
    if (matchedUsers.length > 0) {
      const matchedIds = matchedUsers.map(u => u.userId);
      const thumbMap = await getUserThumbnails(matchedIds);
      matchedUsers.forEach(u => u.thumbnail = thumbMap.get(u.userId) || null);
    }

    return { 
      status: 'completed', 
      matchedUsers, 
      scannedCount,
      method: methodUsed
    };

  } catch (error) {
    console.error("Scanner Error:", error);
    return { status: 'error', message: 'An unexpected error occurred during scanning.' };
  }
}

module.exports = { checkSisterCommunityScan };
