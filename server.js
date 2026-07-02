// CENTRAL RENDER VAULT: server.js
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { checkSisterCommunityScan } = require('./scripts/community-scanner-sister.js');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

app.post('/run-community-scan', async (req, res) => {
    try {
        const dbWorkerUrl = process.env.WORKER_URL; 
        
        if (!dbWorkerUrl) {
            console.error("[VAULT CRITICAL] Missing WORKER_URL environment variable!");
            // MUST return { status: 'error' } to prevent infinite loops on the frontend
            return res.status(500).json({ status: 'error', message: "Internal Configuration Error: Missing Worker URL." });
        }

        const result = await checkSisterCommunityScan(req.body, dbWorkerUrl); 
        res.json(result);
    } catch (error) {
        console.error('[VAULT CRITICAL] Top-level routing error:', error);
        res.status(500).json({ status: 'error', message: 'An unexpected server error occurred.', details: error.message });
    }
});

app.get("/", (req, res) => {
  res.send("Vault Backend is running ✔️");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Vault Server running on port ${PORT}`);
});
