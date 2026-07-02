// RENDER NODE: scripts/community-scanner-sister.js
const axios = require('axios');

const axiosInstance = axios.create({
  timeout: 10000,
  httpAgent: new (require('http').Agent)({ keepAlive: true }),
  httpsAgent: new (require('https').Agent)({ keepAlive: true })
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

// MAIN CHUNK PROCESSOR WITH ACCURATE RETRY LOOPS
async function checkSisterCommunityScan(payload, dbWorkerUrl) {
  const { groupId, offset = 0, limit = 50 } = payload;
  
  if (!groupId) return { status: 'error', message: 'Missing groupId' };

  try {
    const dbUsers = await getFullDatabase(dbWorkerUrl);
    const totalCount = dbUsers.length;
    
    // Slice out the exact targeted batch chunk
    const chunk = dbUsers.slice(offset, offset + limit);
    const matchedUsers = [];
    let scannedCount = 0;

    // Concurrency limit of 5 to balance speed and stability over proxy networks
    await asyncPool(5, chunk, async (user) => {
      let checking = true;
      let attempt = 0;

      while (checking) {
        try {
          // Utilizes roproxy to help mitigate IP blocks
          const url = `https://groups.roproxy.com/v1/users/${user.userId}/groups/roles`;
          const res = await axiosInstance.get(url);
          
          const isInGroup = res.data.data.some(g => g.group.id === parseInt(groupId));
          if (isInGroup) {
            matchedUsers.push({ ...user }); // Added to match list; sister site backend handles hydration
          }
          
          scannedCount++;
          checking = false; // Successfully analyzed, break the loop
        } catch (e) {
          attempt++;
          const status = e.response?.status;
          const errMsg = e.response?.data?.errors?.[0]?.message?.toLowerCase() || "";

          // Explicit verification for rate limits
          if (status === 429 || errMsg.includes("too many requests")) {
            console.warn(`[Rate Limit] Hit on user ${user.userId} (Attempt ${attempt}). Pausing for 5 seconds...`);
            await sleep(5000); 
          } else {
            // General network glitch or temporary 5xx infrastructure failure
            console.warn(`[Network Error] Status ${status || 'Unknown'} on user ${user.userId}. Retrying in 2 seconds...`);
            await sleep(2000);
          }
          
          // Fallback safeguard: if it loops infinitely (> 15 times) on a dead account or hard error, skip to prevent stalling
          if (attempt >= 15) {
            console.error(`[Fatal Drop] User ${user.userId} failed completely after 15 consecutive retries.`);
            scannedCount++;
            checking = false;
          }
        }
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
    return { status: 'error', message: 'Render node failed to process chunk securely.' };
  }
}

module.exports = { checkSisterCommunityScan };
