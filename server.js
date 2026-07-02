const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { checkSisterCommunityScan } = require('./scripts/community-scanner-sister.js');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

app.post('/run-community-scan', async (req, res) => {
    try {
        // The worker URL should be stored in your Render environment variables
        const dbWorkerUrl = process.env.WORKER_URL; 
        
        if (!dbWorkerUrl) {
            return res.status(500).json({ error: "Internal Configuration Error: Missing Worker URL." });
        }

        const result = await checkSisterCommunityScan(req.body, dbWorkerUrl); 
        res.json(result);
    } catch (error) {
        console.error('Community scan error:', error);
        res.status(500).json({ error: 'An unexpected server error occurred.', details: error.message });
    }
});

app.get("/", (req, res) => {
  res.send("Sister Backend Proxy is running ✔️");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
