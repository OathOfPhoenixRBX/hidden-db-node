// CENTRAL RENDER VAULT: scripts/community-scanner-sister.js
const axios = require('axios');

class RateLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RateLimitError';
  }
}

const axiosInstance = axios.create({
  timeout: 10000,
  httpAgent: new (require('http').Agent)({ keepAlive: true }),
  httpsAgent: new (require('https').Agent)({ keepAlive: true })
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let cachedDb = null;
let lastDbFetch = 0;
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

// In-Memory cache for Delta Mode (Fast Intersection)
let groupDeltaCache = {};

// 1. Securely fetch and cache DB
async function getDatabase(dbWorkerUrl) {
  const now = Date.now();
  if (cachedDb && (now - lastDbFetch < CACHE_TTL)) return cachedDb;
  try {
    const res = await axios.post(dbWorkerUrl, { fetchFull: true });
    cachedDb = res.data.map(u => ({ userId: u.userid, tier: u.tier, riskscore: u.riskscore }));
    lastDbFetch = now;
    return cachedDb;
  } catch (e) {
    throw new Error('Failed to fetch database from Cloudflare worker.');
  }
}

// 2. Main Website Logic: Group Metadata & Members for Delta Mode
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
      await sleep(200); // Respect Roblox API limits
    } else {
      isFinished = true;
    }
  }
  return members;
}

// 3. Main Website Logic: Batch Hydration
async function getUsernamesBatch(userIds) {
  if (userIds.length === 0) return new Map();
  const nameMap = new Map();
  const chunkSize = 100;
  for (let i = 0; i < userIds.length; i += chunkSize) {
    const chunk = userIds.slice(i, i + chunkSize);
    try {
      const response = await axiosInstance.post('https://users.roblox.com/v1/users', {
        userIds: chunk, excludeBannedUsers: false
      });
      if (response.data?.data) response.data.data.forEach(u => nameMap.set(u.id, u.name));
    } catch (e) {
      if (e.response && e.response.status === 429) throw new RateLimitError('Rate limit hit fetching usernames');
    }
  }
  return nameMap;
}

async function getUserThumbnails(userIds) {
  if (userIds.length === 0) return new Map();
  const thumbMap = new Map();
  const chunkSize = 100;
  for (let i = 0; i < userIds.length; i += chunkSize) {
    const chunk = userIds.slice(i, i + chunkSize);
    try {
      const response = await axiosInstance.get(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${chunk.join(',')}&size=150x150&format=Png`);
      if (response.data?.data) response.data.data.forEach(t => thumbMap.set(t.targetId, t.imageUrl));
    } catch (e) {}
  }
  return thumbMap;
}

// 4. Main Website Logic: High-Concurrency Pool
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
    if (error.response?.status === 429 || error.response?.data?.errors?.[0]?.message?.toLowerCase().includes('too many requests')) {
      throw new RateLimitError('Rate limit hit');
    }
    return false;
  }
}

// Main Processing Function
async function checkSisterCommunityScan(payload, dbWorkerUrl) {
  const { groupId, offset = 0, limit = 10, isInitialCall = false } = payload;
  
  try {
    const dbUsers = await getDatabase(dbWorkerUrl);

    // PHASE 1: Initialization & Delta Mode Prep
    if (isInitialCall) {
      // If group is smaller than DB, cache the group members to make chunks lightning fast
      try {
        const groupInfo = await getGroupMetadata(groupId);
        if (groupInfo.accessible && groupInfo.memberCount > 0 && groupInfo.memberCount <= dbUsers.length) {
          const allMembers = await fetchAllGroupMembers(groupId);
          const memberIds = new Set(allMembers.map(m => m.user.userId));
          groupDeltaCache[groupId] = { ids: memberIds, timestamp: Date.now() };
        }
      } catch (e) {} // Fallback silently
      
      return { status: 'initial', totalCount: dbUsers.length };
    }

    // PHASE 2: Chunk Processing
    const chunk = dbUsers.slice(offset, offset + limit);
    const matchedUsers = [];
    let scannedCount = 0;

    // Check Delta Cache
    const cachedGroup = groupDeltaCache[groupId];
    const useDeltaMode = cachedGroup && (Date.now() - cachedGroup.timestamp < CACHE_TTL);

    if (useDeltaMode) {
      // EXACT MAIN SITE BEHAVIOR: O(1) Memory Intersection (Instantly finishes chunk)
      for (const user of chunk) {
        scannedCount++;
        if (cachedGroup.ids.has(user.userId)) matchedUsers.push({ ...user });
      }
    } else {
      // EXACT MAIN SITE BEHAVIOR: asyncPool(10) concurrency for massive groups
      await asyncPool(10, chunk, async (user) => {
        scannedCount++;
        try {
          const isInGroup = await isUserInGroup(user.userId, groupId);
          if (isInGroup) matchedUsers.push({ ...user });
        } catch (e) {
          if (e instanceof RateLimitError) throw e; // Bubbles to frontend
        }
      });
    }

    // EXACT MAIN SITE BEHAVIOR: Batch Hydration
    if (matchedUsers.length > 0) {
      const matchedIds = matchedUsers.map(u => u.userId);
      const [nameMap, thumbMap] = await Promise.all([
        getUsernamesBatch(matchedIds),
        getUserThumbnails(matchedIds)
      ]);
      matchedUsers.forEach(u => {
        u.username = nameMap.get(u.userId) || "Unknown";
        u.thumbnail = thumbMap.get(u.userId) || null;
      });
    }

    return { status: 'completed', matchedUsers, scannedInBatch: scannedCount };
    
  } catch (error) {
    if (error instanceof RateLimitError) {
      return { status: 'rate_limited', message: 'API rate limit reached.', matchedUsers: [], scannedInBatch: 0 };
    }
    return { status: 'error', message: error.message };
  }
}

module.exports = { checkSisterCommunityScan };
