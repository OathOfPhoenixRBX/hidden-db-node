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
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

// Securely fetch and cache the DB from Cloudflare
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

// Hydration Functions
async function getUsernamesBatch(userIds) {
    if (userIds.length === 0) return new Map();
    const nameMap = new Map();
    try {
        const response = await axiosInstance.post('https://users.roblox.com/v1/users', { userIds, excludeBannedUsers: false });
        if (response.data?.data) response.data.data.forEach(u => nameMap.set(u.id, u.name));
    } catch (e) {}
    return nameMap;
}

async function getUserThumbnails(userIds) {
    if (userIds.length === 0) return new Map();
    const thumbMap = new Map();
    try {
        const response = await axiosInstance.get(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userIds.join(',')}&size=150x150&format=Png`);
        if (response.data?.data) response.data.data.forEach(t => thumbMap.set(t.targetId, t.imageUrl));
    } catch (e) {}
    return thumbMap;
}

// Direct Roblox API Check
async function isUserInGroup(userId, targetGroupId) {
  try {
    const response = await axiosInstance.get(`https://groups.roblox.com/v1/users/${userId}/groups/roles`);
    return response.data.data.some(g => g.group.id === parseInt(targetGroupId));
  } catch (error) {
    if (error.response?.status === 429) throw new RateLimitError('Rate limit hit');
    return false;
  }
}

// Main processing function
async function checkSisterCommunityScan(payload, dbWorkerUrl) {
  const { groupId, offset = 0, limit = 10, isInitialCall = false } = payload;
  
  try {
    const dbUsers = await getDatabase(dbWorkerUrl);

    // Phase 1: Tell frontend how many users exist (DB stays perfectly hidden)
    if (isInitialCall) return { status: 'initial', totalCount: dbUsers.length };

    // Phase 2: Process the requested 10-user chunk
    const chunk = dbUsers.slice(offset, offset + limit);
    const matchedUsers = [];
    let scannedCount = 0;

    // Sequential loop with 100ms breather guarantees stability and prevents 429 floods
    for (const user of chunk) {
      scannedCount++;
      try {
        const isInGroup = await isUserInGroup(user.userId, groupId);
        if (isInGroup) matchedUsers.push({ ...user });
        
        // Tiny breather to protect Render Node IPs from aggressive Roblox limits
        await new Promise(r => setTimeout(r, 100)); 
      } catch (e) {
        if (e instanceof RateLimitError) throw e;
      }
    }

    // Hydrate matches directly on the Render Vault before sending them back
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
