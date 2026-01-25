import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';

dotenv.config();

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

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

    // Parse DBML to extract table names and columns
    const tablesWithColumns = parseDBML(text);

    res.json({
      raw: text,
      tables: tablesWithColumns.map(t => t.name),
      tablesWithColumns: tablesWithColumns
    });
  } catch (error) {
    console.error('Schema API error:', error);
    res.status(500).json({ error: 'Failed to fetch schema', details: error.message });
  }
});

// Parse DBML format to extract table names and columns
function parseDBML(dbml) {
  const tables = [];
  // Match entire table blocks: Table "name" { ... } or Table name { ... }
  const tableBlockRegex = /Table\s+(?:"([^"]+)"|(%?\w+))\s*\{([^}]*)\}/g;
  let match;

  while ((match = tableBlockRegex.exec(dbml)) !== null) {
    const tableName = (match[1] || match[2]).replace(/%/g, '');
    const tableBody = match[3];

    // Extract columns from table body
    // Column format: "column_name" type or column_name type
    const columns = [];
    const columnRegex = /(?:"([^"]+)"|(\w+))\s+(\w+)/g;
    let colMatch;

    while ((colMatch = columnRegex.exec(tableBody)) !== null) {
      const columnName = colMatch[1] || colMatch[2];
      const columnType = colMatch[3];
      if (columnName && !columnName.startsWith('//')) {
        columns.push({
          name: columnName,
          type: columnType
        });
      }
    }

    if (tableName) {
      tables.push({
        name: tableName,
        columns: columns
      });
    }
  }

  return tables;
}

// Endpoint for AI-powered data sensitivity analysis
app.post('/api/analyze-sensitivity', async (req, res) => {
  console.log('Sensitivity analysis endpoint called');
  const { tablesWithColumns } = req.body;

  if (!tablesWithColumns || !Array.isArray(tablesWithColumns)) {
    console.log('Error: tablesWithColumns not provided');
    return res.status(400).json({ error: 'tablesWithColumns array is required' });
  }

  console.log(`Analyzing ${tablesWithColumns.length} tables for sensitivity`);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('Error: API key not configured');
    return res.status(500).json({ error: 'Anthropic API key not configured' });
  }

  try {
    // Format schema for Claude
    const schemaText = tablesWithColumns.map(table => {
      const columnsStr = table.columns.map(c => `  - ${c.name} (${c.type})`).join('\n');
      return `Table: ${table.name}\nColumns:\n${columnsStr}`;
    }).join('\n\n');

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: `You are a data privacy and security expert. Analyze the following database schema and classify both table-level and field-level data sensitivity.

Sensitivity levels:
- HIGHLY SENSITIVE (high): Personal identifiable information (PII), financial data, health records, passwords, SSNs, credit card numbers, authentication tokens, private messages, location data, IP addresses
- MODERATELY SENSITIVE (moderate): Email addresses, phone numbers, names, dates of birth, user preferences, partial addresses, order history
- LOW SENSITIVITY (low): Product catalogs, public content, settings, non-personal metadata, IDs, timestamps

Respond ONLY with valid JSON in this exact format:
{
  "analysis": [
    {
      "table": "table_name",
      "sensitivity": "high" | "moderate" | "low",
      "reason": "brief explanation",
      "fields": [
        {
          "name": "field_name",
          "sensitivity": "high" | "moderate" | "low"
        }
      ]
    }
  ]
}

Only include fields with "high" or "moderate" sensitivity in the fields array. Omit "low" sensitivity fields.

Database Schema:
${schemaText}`
        }
      ]
    });

    // Parse Claude's response
    const responseText = message.content[0].text;

    // Extract JSON from response (handle potential markdown code blocks)
    let jsonStr = responseText;
    const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    }

    const analysis = JSON.parse(jsonStr.trim());
    console.log('Sensitivity analysis complete:', JSON.stringify(analysis, null, 2));

    res.json(analysis);
  } catch (error) {
    console.error('Sensitivity analysis error:', error);
    res.status(500).json({
      error: 'Failed to analyze sensitivity',
      details: error.message
    });
  }
});

// Endpoint for analyzing actual column names from data
app.post('/api/analyze-columns', async (req, res) => {
  console.log('Column analysis endpoint called');
  const { tableName, columnsWithSamples } = req.body;

  if (!tableName || !columnsWithSamples || !Array.isArray(columnsWithSamples)) {
    console.log('Missing required fields:', { tableName, hasColumns: !!columnsWithSamples });
    return res.status(400).json({ error: 'tableName and columnsWithSamples array are required' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Anthropic API key not configured' });
  }

  console.log(`Analyzing ${columnsWithSamples.length} columns for table: ${tableName}`);

  // Format columns with their sample values
  const columnDetails = columnsWithSamples.map(col => {
    const samples = col.samples.length > 0
      ? `Sample values: ${col.samples.map(s => `"${s}"`).join(', ')}`
      : 'No sample values';
    return `- ${col.name}\n  ${samples}`;
  }).join('\n');

  console.log('Column details being analyzed:\n', columnDetails);

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: `You are a strict data privacy expert. Only flag columns that contain CLEARLY sensitive information. When in doubt, do NOT flag.

Table: "${tableName}"

TASK: Classify columns as HIGH, MODERATE, or LOW. Be conservative - only flag obvious cases.

HIGH SENSITIVITY - Only flag if sample data CLEARLY shows:
- Actual email addresses (must see @ symbol in samples)
- Actual phone numbers (must see phone number patterns in samples)
- Full personal names stored as data (not references)
- Passwords, password hashes, auth tokens, API keys, secrets
- SSN, national ID, passport, driver's license numbers
- Credit card numbers, bank account numbers
- Private message content
- Medical records, health data
- Full home addresses (street + city + postal code)
- Dates of birth

MODERATE SENSITIVITY - Only flag if sample data CLEARLY shows:
- Business contact emails (must see @ symbol)
- Business phone numbers (must see phone patterns)
- Business street addresses
- Company financial data (actual revenue numbers, bank details)

LOW SENSITIVITY (do NOT flag) - This is the DEFAULT:
- "Created By", "Modified By" - ALWAYS LOW
- ANY column ending in _id, Id, or containing ID references
- Timestamps, dates (created_date, modified_date, etc.)
- Boolean flags, counts, numbers, statuses, types
- URLs, file paths, slugs
- Generic text fields, descriptions, notes, titles
- Settings, preferences, configuration
- Names of things (product names, category names, etc.) - NOT personal names
- References to other records
- Country, city, state without full address
- File references (unless clearly personal documents)
- Pricing, quantities, ratings
- Any column where samples look like IDs, codes, or system data

FILE COLUMNS (case-insensitive) - Flag columns containing file/document references:
- Column names containing: file, image, photo, document, pdf, attachment, upload, avatar, picture
- User files (profile pics, personal documents, user uploads) → HIGH
- Business files (company logos, business documents, marketing assets) → MODERATE
- If unclear whether user or business file → HIGH

CRITICAL RULES:
1. If sample values look like IDs or codes (alphanumeric strings, UUIDs) → LOW
2. If column name contains "id", "ref", "key" (as identifier) → LOW
3. If uncertain whether data is personal or business → LOW
4. If samples are empty or unclear → LOW
5. Only flag when you are CONFIDENT the data is sensitive
6. File columns should always be flagged (HIGH for user files, MODERATE for business files)

Columns to analyze:
${columnDetails}

Respond with valid JSON only:
{
  "fields": [
    { "name": "exact_column_name", "sensitivity": "high" },
    { "name": "exact_column_name", "sensitivity": "moderate" }
  ]
}

Only include HIGH or MODERATE columns. Omit LOW sensitivity columns entirely.`
        }
      ]
    });

    const responseText = message.content[0].text;
    let jsonStr = responseText;
    const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    }

    const analysis = JSON.parse(jsonStr.trim());
    console.log('Column analysis complete:', JSON.stringify(analysis, null, 2));

    res.json(analysis);
  } catch (error) {
    console.error('Column analysis error:', error);
    res.status(500).json({ error: 'Failed to analyze columns', details: error.message });
  }
});

// Endpoint for generating AI-prioritized summary list
app.post('/api/generate-summary', async (req, res) => {
  console.log('Generate summary endpoint called');
  const { appName, sensitiveData } = req.body;

  if (!sensitiveData || !Array.isArray(sensitiveData) || sensitiveData.length === 0) {
    return res.status(400).json({ error: 'sensitiveData array is required' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Anthropic API key not configured' });
  }

  try {
    // Format the sensitive data for Claude
    const dataDescription = sensitiveData.map(table => {
      const columns = table.columns.join(', ');
      return `- ${table.name}: ${columns}`;
    }).join('\n');

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `You are a security expert. Analyze this list of exposed sensitive data, provide an overall RISK classification, and select the TOP 3-4 most critical tables.

Exposed data found:
${dataDescription}

RISK CLASSIFICATION (choose one):
- "high": Auth data (passwords, tokens), personal IDs (SSN, passport), financial data (credit cards, bank accounts), or large volume of PII
- "medium": Contact info (emails, phones, addresses), personal files, moderate PII exposure
- "low": Limited sensitive data, mostly business info or partial PII
- "none": No truly sensitive data found (only test data, public content, or false positives)

PRIORITIZATION ORDER for tables (highest to lowest risk):
1. Authentication data (passwords, tokens, API keys, secrets)
2. Personal identifiers (SSN, passport, driver's license, national ID)
3. Financial data (credit cards, bank accounts)
4. Contact info (emails, phone numbers, addresses)
5. Personal files/documents
6. Other PII

EXCLUDE these (NOT sensitive):
- Tables named "dummy", "test", "demo", "sample", or containing test data
- Reviews, testimonials, ratings (public-facing content)
- Stripe IDs, payment IDs, subscription IDs (just references, not actual financial data)
- Blog posts, articles, public content
- Product/service information

Return ONLY a JSON object:
{
  "risk": "high" | "medium" | "low" | "none",
  "tables": [
    {
      "name": "Table Name",
      "columns": ["most_critical_column", "second_critical_column"]
    }
  ]
}

Rules:
- Maximum 4 tables
- Maximum 5 columns per table (select the most critical ones)
- Order tables by criticality (most critical first)
- Order columns by criticality within each table
- Column names must be EXACTLY as they appear in the input (no descriptions, explanations, or notes)
- SKIP tables/columns that are public content or non-sensitive references
- If risk is "none", tables should be empty array
- Return ONLY valid JSON, no other text`
        }
      ]
    });

    const responseText = message.content[0].text.trim();

    // Parse JSON from response
    let jsonStr = responseText;
    const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    }

    const result = JSON.parse(jsonStr.trim());
    console.log('Generated prioritized list:', JSON.stringify(result, null, 2));

    res.json(result);
  } catch (error) {
    console.error('Summary generation error:', error);
    res.status(500).json({ error: 'Failed to generate summary', details: error.message });
  }
});

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

// Full audit endpoint - returns AI summary of sensitive data
app.post('/api/audit', async (req, res) => {
  const { url, x, y } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  if (!x || !y) {
    return res.status(400).json({ error: 'x and y parameters are required' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Anthropic API key not configured' });
  }

  try {
    console.log(`[Audit] Starting audit for: ${url}`);

    // Step 1: Get app metadata
    const baseUrl = new URL(url).origin;
    const metaResponse = await fetch(`${baseUrl}/api/1.1/meta`);
    const metaData = await metaResponse.json();
    const appName = (metaData.app_data && metaData.app_data.appname) || new URL(url).hostname.split('.')[0];
    console.log(`[Audit] App name: ${appName}`);

    // Step 2: Get schema
    const encodedUrl = encodeURIComponent(url);
    const schemaUrl = `https://xgkxmsaivblwqfkdhtekn3nase0tudjd.lambda-url.us-east-1.on.aws/api/schema/${encodedUrl}?format=dbml`;
    const schemaResponse = await fetch(schemaUrl);
    const schemaText = await schemaResponse.text();
    const tablesWithColumns = parseDBML(schemaText);
    console.log(`[Audit] Found ${tablesWithColumns.length} tables`);

    if (tablesWithColumns.length === 0) {
      return res.json({ tables: [], message: 'No tables found' });
    }

    // Step 3: For each table, fetch sample data and analyze sensitivity
    const sensitiveData = [];
    const BATCH_SIZE = 4;

    for (let i = 0; i < tablesWithColumns.length; i += BATCH_SIZE) {
      const batch = tablesWithColumns.slice(i, i + BATCH_SIZE);

      const batchResults = await Promise.all(batch.map(async (table) => {
        try {
          // Fetch sample data
          const tableType = table.name.toLowerCase() === 'user' ? 'user' : `custom.${table.name}`;
          const payload = {
            app_version: 'live',
            appname: appName,
            constraints: [],
            from: 0,
            n: 5,
            search_path: '{"constructor_name":"DataSource","args":[{"type":"json","value":"%p3.cnEQb0.%el.cnEQh0.%p.%ds"},{"type":"node","value":{"constructor_name":"Element","args":[{"type":"json","value":"%p3.cnEQb0.%el.cnEQh0"}]}},{"type":"raw","value":"Search"}]}',
            situation: 'initial search',
            sorts_list: [],
            type: tableType,
          };

          // Encrypt
          const encryptResponse = await fetch('https://5r6gtzlbpf.execute-api.us-east-1.amazonaws.com/prod/encrypt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ x, y, payload }),
          });
          const encryptData = await encryptResponse.json();

          if (!encryptData.z) return null;

          // Fetch via worker
          const workerResponse = await fetch('https://api-worker.james-a7a.workers.dev', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              x: encryptData.x,
              y: encryptData.y,
              z: encryptData.z,
              appname: '99reviews-43419',
              url: 'https://99reviews.io/version-test/elasticsearch/search',
            }),
          });

          const workerData = await workerResponse.json();

          // Parse results
          let results = [];
          if (workerData.body?.hits?.hits) {
            results = workerData.body.hits.hits.map(hit => ({ ...hit._source, _id: hit._id }));
          }

          if (results.length === 0) return null;

          // Extract columns with samples
          const systemFields = ['_version', '_type', '_id'];
          const columns = new Set();
          results.forEach(row => Object.keys(row).forEach(k => { if (!systemFields.includes(k)) columns.add(k); }));

          const columnsWithSamples = Array.from(columns).map(colName => {
            const samples = [];
            for (const row of results) {
              if (samples.length >= 3) break;
              const value = row[colName];
              if (value != null && value !== '') {
                let strValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
                if (strValue.length > 100) strValue = strValue.substring(0, 100) + '...';
                if (!samples.includes(strValue)) samples.push(strValue);
              }
            }
            return { name: colName, samples };
          });

          // Analyze columns
          const analysisResponse = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 2048,
            messages: [{
              role: 'user',
              content: `You are a strict data privacy expert. Only flag columns that contain CLEARLY sensitive information.

Table: "${table.name}"

HIGH SENSITIVITY - Only flag if sample data CLEARLY shows:
- Actual email addresses (must see @ symbol)
- Actual phone numbers (must see phone patterns)
- Full personal names, passwords, auth tokens, API keys
- SSN, national ID, credit card numbers, bank accounts
- Private messages, medical records, full addresses, dates of birth

MODERATE SENSITIVITY - Only flag if sample data CLEARLY shows:
- Business contact emails/phones
- Business addresses, company financial data

LOW SENSITIVITY (do NOT flag):
- "Created By", "Modified By", any _id columns
- Timestamps, booleans, URLs, settings, generic text
- Product/category names, references, pricing

Columns to analyze:
${columnsWithSamples.map(col => `- ${col.name}\n  Samples: ${col.samples.map(s => `"${s}"`).join(', ') || 'none'}`).join('\n')}

Respond with valid JSON only:
{ "fields": [{ "name": "column_name", "sensitivity": "high" }] }
Only include HIGH or MODERATE columns.`
            }]
          });

          const responseText = analysisResponse.content[0].text;
          let jsonStr = responseText;
          const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
          if (jsonMatch) jsonStr = jsonMatch[1];

          const analysis = JSON.parse(jsonStr.trim());
          const highColumns = (analysis.fields || []).filter(f => f.sensitivity === 'high').map(f => f.name);

          if (highColumns.length > 0) {
            return { name: table.name, columns: highColumns };
          }
          return null;
        } catch (err) {
          console.error(`[Audit] Error analyzing table ${table.name}:`, err.message);
          return null;
        }
      }));

      batchResults.filter(Boolean).forEach(r => sensitiveData.push(r));
    }

    console.log(`[Audit] Found ${sensitiveData.length} tables with sensitive data`);

    if (sensitiveData.length === 0) {
      return res.json({ tables: [] });
    }

    // Step 4: Generate prioritized summary with risk classification
    const summaryResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `Analyze this exposed sensitive data and provide a risk classification:

${sensitiveData.map(t => `- ${t.name}: ${t.columns.join(', ')}`).join('\n')}

RISK CLASSIFICATION:
- "high": Auth data (passwords, tokens), personal IDs (SSN, passport), financial data (credit cards, bank accounts), or large volume of PII
- "medium": Contact info (emails, phones, addresses), personal files, moderate PII exposure
- "low": Limited sensitive data, mostly business info or partial PII
- "none": No truly sensitive data found (only test data, public content, or false positives)

PRIORITIZATION for tables: 1) Auth data 2) Personal IDs 3) Financial 4) Contact info 5) Files

EXCLUDE from tables: test/demo tables, reviews, Stripe IDs, public content

Return JSON only:
{
  "risk": "high" | "medium" | "low" | "none",
  "tables": [{ "name": "Table", "columns": ["critical_col1", "critical_col2"] }]
}

Max 4 tables, max 5 columns each, ordered by criticality. If risk is "none", tables should be empty array.`
      }]
    });

    const summaryText = summaryResponse.content[0].text;
    let summaryJson = summaryText;
    const summaryMatch = summaryText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (summaryMatch) summaryJson = summaryMatch[1];

    const summary = JSON.parse(summaryJson.trim());
    console.log(`[Audit] Audit complete:`, JSON.stringify(summary));

    res.json(summary);
  } catch (error) {
    console.error('[Audit] Error:', error);
    res.status(500).json({ error: 'Audit failed', details: error.message });
  }
});

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Bubble Security Scanner running at http://localhost:${PORT}`);
});
