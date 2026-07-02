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

let cachedDb = null;
let lastDbFetch = 0;
const CACHE_TTL = 15 * 60 * 1000;

async function getDatabase(dbWorkerUrl) {
    const now = Date.now();
    if (cachedDb && (now - lastDbFetch < CACHE_TTL)) {
        console.log(`[VAULT] Using cached database. Size: ${cachedDb.length}`);
        return cachedDb;
    }
    
    console.log(`[VAULT] Fetching full database from Cloudflare...`);
    try {
        const res = await axios.post(dbWorkerUrl, { fetchFull: true });
        cachedDb = res.data.map(u => ({ userId: u.userid, tier: u.tier, riskscore: u.riskscore }));
        lastDbFetch = now;
        console.log(`[VAULT] Successfully loaded ${cachedDb.length} users into vault memory.`);
        return cachedDb;
    } catch (e) {
        console.error(`[VAULT ERROR] Failed to fetch database from worker:`, e.message);
        throw new Error('Failed to fetch database from Cloudflare worker.');
    }
}

async function getUsernamesBatch(userIds) {
    if (userIds.length === 0) return new Map();
    const nameMap = new Map();
    try {
        const response = await axiosInstance.post('https://users.roblox.com/v1/users', { userIds, excludeBannedUsers: false });
        if (response.data?.data) response.data.data.forEach(u => nameMap.set(u.id, u.name));
    } catch (e) { console.error(`[VAULT WARNING] Username fetch failed:`, e.message); }
    return nameMap;
}

async function getUserThumbnails(userIds) {
    if (userIds.length === 0) return new Map();
    const thumbMap = new Map();
    try {
        const response = await axiosInstance.get(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userIds.join(',')}&size=150x150&format=Png`);
        if (response.data?.data) response.data.data.forEach(t => thumbMap.set(t.targetId, t.imageUrl));
    } catch (e) { console.error(`[VAULT WARNING] Thumbnail fetch failed:`, e.message); }
    return thumbMap;
}

async function isUserInGroup(userId, targetGroupId) {
  try {
    // USING ROPROXY to heavily prevent IP bans
    const response = await axiosInstance.get(`https://groups.roproxy.com/v1/users/${userId}/groups/roles`);
    return response.data.data.some(g => g.group.id === parseInt(targetGroupId));
  } catch (error) {
    if (error.response?.status === 429) {
        console.warn(`[VAULT WARNING] Rate limit hit checking user ${userId}!`);
        throw new RateLimitError('Rate limit hit');
    }
    return false;
  }
}

async function checkSisterCommunityScan(payload, dbWorkerUrl) {
  const { groupId, offset = 0, limit = 10, isInitialCall = false } = payload;
  console.log(`[VAULT] Request received: Group=${groupId}, Offset=${offset}, Limit=${limit}, Initial=${isInitialCall}`);
  
  try {
    const dbUsers = await getDatabase(dbWorkerUrl);

    if (isInitialCall) {
        console.log(`[VAULT] Initial call processed. Sending totalCount: ${dbUsers.length}`);
        return { status: 'initial', totalCount: dbUsers.length };
    }

    const chunk = dbUsers.slice(offset, offset + limit);
    const matchedUsers = [];
    let scannedCount = 0;

    console.log(`[VAULT] Processing chunk ${offset} to ${offset + limit}...`);
    
    for (const user of chunk) {
      scannedCount++;
      try {
        const isInGroup = await isUserInGroup(user.userId, groupId);
        if (isInGroup) matchedUsers.push({ ...user });
        await new Promise(r => setTimeout(r, 100)); // 100ms breather
      } catch (e) {
        if (e instanceof RateLimitError) throw e;
      }
    }

    if (matchedUsers.length > 0) {
      console.log(`[VAULT] Found ${matchedUsers.length} matches in chunk! Hydrating data...`);
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

    console.log(`[VAULT] Chunk complete. Returning ${matchedUsers.length} matched users.`);
    return { status: 'completed', matchedUsers, scannedInBatch: scannedCount };
    
  } catch (error) {
    if (error instanceof RateLimitError) {
      console.log(`[VAULT] Bubbling rate limit error back to proxy...`);
      return { status: 'rate_limited', message: 'API rate limit reached.', matchedUsers: [], scannedInBatch: 0 };
    }
    console.error(`[VAULT ERROR] System failure in chunk processing:`, error.message);
    return { status: 'error', message: error.message };
  }
}

module.exports = { checkSisterCommunityScan };
