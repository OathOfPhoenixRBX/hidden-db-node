// RENDER NODE: scripts/community-scanner-sister.js
const axios = require('axios');

const axiosInstance = axios.create({
  timeout: 10000,
  httpAgent: new (require('http').Agent)({ keepAlive: true }),
  httpsAgent: new (require('https').Agent)({ keepAlive: true })
});

let cachedDb = null;
let lastDbFetch = 0;
const CACHE_TTL = 10 * 60 * 1000;

async function getFullDatabase(dbWorkerUrl) {
  const now = Date.now();
  if (cachedDb && (now - lastDbFetch < CACHE_TTL)) {
    return cachedDb;
  }
  try {
    const res = await axios.post(dbWorkerUrl, { fetchFull: true });
    cachedDb = res.data.map(u => ({ userId: u.userid, tier: u.tier, riskscore: u.riskscore }));
    lastDbFetch = now;
    return cachedDb;
  } catch (e) {
    throw new Error('Database fetch failed');
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

// MAIN CHUNK PROCESSOR
async function checkSisterCommunityScan(payload, dbWorkerUrl) {
  const { groupId, offset = 0, limit = 50 } = payload;
  
  if (!groupId) return { status: 'error', message: 'Missing groupId' };

  try {
    const dbUsers = await getFullDatabase(dbWorkerUrl);
    const totalCount = dbUsers.length;
    
    // Slice only the requested chunk
    const chunk = dbUsers.slice(offset, offset + limit);
    const matchedUsers = [];
    let scannedCount = 0;

    // Use a pool limit of 5 to be safe, and ROPROXY to bypass rate limits!
    await asyncPool(5, chunk, async (user) => {
      scannedCount++;
      try {
        // MAGIC FIX: roproxy.com prevents the 429 IP bans shown in your screenshot
        const url = `https://groups.roproxy.com/v1/users/${user.userId}/groups/roles`;
        const res = await axiosInstance.get(url);
        
        const isInGroup = res.data.data.some(g => g.group.id === parseInt(groupId));
        if (isInGroup) {
          matchedUsers.push({ ...user }); // Push raw data, Sister backend will hydrate
        }
      } catch (e) {
        // Silently skip failed users to keep the stream moving
      }
    });

    return { 
      status: 'completed', 
      matchedUsers, 
      scannedInBatch: scannedCount,
      totalCount 
    };

  } catch (error) {
    console.error("Scanner Error:", error);
    return { status: 'error', message: 'Render node failed to process chunk.' };
  }
}

module.exports = { checkSisterCommunityScan };
