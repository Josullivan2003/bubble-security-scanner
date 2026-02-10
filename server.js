import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import puppeteer from 'puppeteer-core';

// Dynamic import for @sparticuz/chromium-min (for serverless)
let chromium = null;
try {
  chromium = (await import('@sparticuz/chromium-min')).default;
} catch (e) {
  console.log('[@sparticuz/chromium-min not available, will try local Chrome]');
}

// URL for Chromium binary (used by chromium-min)
const CHROMIUM_URL = 'https://github.com/Sparticuz/chromium/releases/download/v122.0.0/chromium-v122.0.0-pack.tar';

import fs from 'fs';
function findLocalChrome() {
  const paths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

dotenv.config();

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
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
      return res.json({ risk: 'none', secure: true, tables: [] });
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
    summary.secure = summary.risk === 'none';
    console.log(`[Audit] Audit complete:`, JSON.stringify(summary));

    res.json(summary);
  } catch (error) {
    console.error('[Audit] Error:', error);
    res.status(500).json({ error: 'Audit failed', details: error.message });
  }
});

// AI-powered endpoint security analysis
// Get workflow definitions from meta API (no AI, just parsing)
app.post('/api/workflows', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    const baseUrl = new URL(url).origin;
    const metaUrl = `${baseUrl}/api/1.1/meta`;

    console.log(`[Workflows] Fetching meta from: ${metaUrl}`);
    const metaResponse = await fetch(metaUrl);
    const metaData = await metaResponse.json();

    if (!metaData.post || metaData.post.length === 0) {
      return res.json({ workflows: [] });
    }

    // Dangerous action keywords (from endpoint names)
    const criticalActions = ['delete', 'remove', 'export', 'payment', 'billing', 'charge', 'admin', 'password', 'reset_password'];
    const highActions = ['email', 'send', 'update', 'modify', 'edit', 'create', 'add', 'cancel', 'subscription'];
    const sensitiveData = ['user', 'customer', 'account', 'order', 'invoice', 'card', 'bank', 'ssn', 'address', 'phone'];

    // Parse workflow definitions
    const workflows = metaData.post
      .filter(wf => wf.endpoint)
      .map(wf => {
        const endpointLower = wf.endpoint.toLowerCase();

        // Check if this is a webhook (has request data parameter)
        const isWebhook = (wf.parameters || []).some(p =>
          p.key === '_wf_request_data' || p.key === 'request_data'
        );

        // Analyze endpoint name for dangerous actions
        const hasCriticalAction = criticalActions.some(a => endpointLower.includes(a));
        const hasHighAction = highActions.some(a => endpointLower.includes(a));
        const involvesSensitiveData = sensitiveData.some(d => endpointLower.includes(d));

        const parameters = (wf.parameters || [])
          .filter(p => p.key !== '_wf_request_data' && p.key !== 'request_data')
          .map(p => ({
            name: p.key,
            type: p.value || 'text',
            required: !p.optional
          }));

        // Check for custom type parameters
        const hasCustomParams = parameters.some(p =>
          p.type.startsWith('custom.') || p.type === 'user'
        );

        return {
          name: wf.endpoint,
          authRequired: !wf.auth_unecessary,
          isWebhook,
          parameters,
          // Risk factors from endpoint name analysis
          riskFactors: {
            hasCriticalAction,
            hasHighAction,
            involvesSensitiveData,
            hasCustomParams,
            noAuth: wf.auth_unecessary === true
          }
        };
      });

    console.log(`[Workflows] Found ${workflows.length} workflow APIs`);
    res.json({ workflows });
  } catch (error) {
    console.error('Workflows fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch workflows', details: error.message });
  }
});

// AI analysis of endpoint names to assess risk
app.post('/api/analyze-endpoint-risk', async (req, res) => {
  const { endpoints } = req.body;

  if (!endpoints || endpoints.length === 0) {
    return res.json({ analysis: {} });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Anthropic API key not configured' });
  }

  try {
    const endpointsList = endpoints.map(ep =>
      `- ${ep.name} (auth_required: ${ep.authRequired})`
    ).join('\n');

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: `Analyze these API endpoint names and assess the security risk based on what each endpoint likely DOES.

${endpointsList}

IMPORTANT: Risk level should be based ONLY on what the action does, NOT on whether auth is required. Auth only affects WHO can exploit it, not the damage potential.

For each endpoint, provide:
1. "risk": "critical" | "high" | "medium" | "low" based on how dangerous the ACTION is:
   - critical: Financial actions (payments, billing), mass data export, account/user deletion, role changes
   - high: Send emails, modify user data, create accounts, access sensitive records
   - medium: Update settings, create standard records, standard CRUD operations
   - low: Read-only operations, user preferences, non-sensitive actions

2. "explanation": One sentence for a non-technical business owner. Start with:
   - If auth_required=false: "Anyone on the internet can..."
   - If auth_required=true: "Any logged-in user can..."

Respond with JSON only:
{
  "endpoint_name": {
    "risk": "high",
    "explanation": "Anyone on the internet can download your complete customer database"
  }
}`
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
    console.log(`[Endpoint Risk] Analyzed ${Object.keys(analysis).length} endpoints`);

    res.json({ analysis });
  } catch (error) {
    console.error('Endpoint risk analysis error:', error);
    res.status(500).json({ error: 'Failed to analyze endpoint risk', details: error.message });
  }
});

// API Key patterns - only exploitable secret keys (not public-facing keys)
const API_KEY_PATTERNS = [
  {
    name: 'Stripe Secret Key',
    pattern: /sk_(live|test)_[a-zA-Z0-9]{24,}/g,
    risk: 'critical',
    description: 'Stripe secret key - allows full API access including charges and refunds'
  },
  {
    name: 'OpenAI API Key',
    pattern: /sk-[a-zA-Z0-9]{20,}/g,
    risk: 'critical',
    description: 'OpenAI API key - allows API usage at owner expense'
  },
  {
    name: 'AWS Secret Key',
    pattern: /(?:aws_secret|secret_key|secretAccessKey|aws_secret_access_key)[\s:="']+([A-Za-z0-9/+=]{40})/gi,
    risk: 'critical',
    description: 'AWS secret access key - allows cloud resource access'
  },
  {
    name: 'SendGrid API Key',
    pattern: /SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}/g,
    risk: 'high',
    description: 'SendGrid API key - allows email sending'
  },
  {
    name: 'Twilio Auth Token',
    pattern: /(?:twilio|auth_token|authToken)[\s:="']+([a-f0-9]{32})/gi,
    risk: 'high',
    description: 'Twilio auth token - allows SMS/voice API access'
  },
  {
    name: 'Firebase Private Key',
    pattern: /-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/g,
    risk: 'critical',
    description: 'Private key - allows service account impersonation'
  },
  {
    name: 'Mailgun API Key',
    pattern: /key-[a-zA-Z0-9]{32}/g,
    risk: 'high',
    description: 'Mailgun API key - allows email sending'
  },
  {
    name: 'Slack Token',
    pattern: /xox[baprs]-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*/g,
    risk: 'high',
    description: 'Slack token - allows workspace access'
  },
  {
    name: 'GitHub Token',
    pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/g,
    risk: 'high',
    description: 'GitHub personal access token - allows repository access'
  },
  {
    name: 'Generic Secret',
    pattern: /(?:api_key|apikey|api-key|secret_key|secretkey|auth_token|access_token|private_key|password)[\s:="']+([a-zA-Z0-9_-]{20,})/gi,
    risk: 'medium',
    description: 'Potential API key or secret detected'
  }
];

// Fallback: Extract API data from HTML without Puppeteer
async function extractApiDataFromHtml(url) {
  console.log(`[API Keys] Using HTML fallback for: ${url}`);

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  });

  const html = await response.text();

  const result = {
    clientSafe: null,
    apiConnector2: null,
    allKeys: [],
    debugInfo: { method: 'html-fallback' }
  };

  // Look for client_safe data in script tags
  // Bubble embeds this data in various ways
  const patterns = [
    /settings\s*[=:]\s*(\{[\s\S]*?"client_safe"\s*:\s*\{[\s\S]*?\}\s*\})/,
    /client_safe['"]\s*:\s*(\{[\s\S]*?\})\s*[,}]/,
    /apiconnector2['"]\s*:\s*(\{[\s\S]*?\})\s*[,}]/i,
  ];

  // Try to find and parse client_safe or apiconnector2 data
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      try {
        // Clean up the match and try to parse
        let jsonStr = match[1];
        // Balance braces
        let braceCount = 0;
        let endIdx = 0;
        for (let i = 0; i < jsonStr.length; i++) {
          if (jsonStr[i] === '{') braceCount++;
          if (jsonStr[i] === '}') braceCount--;
          if (braceCount === 0) {
            endIdx = i + 1;
            break;
          }
        }
        if (endIdx > 0) {
          jsonStr = jsonStr.substring(0, endIdx);
        }

        const parsed = JSON.parse(jsonStr);
        if (parsed.client_safe) {
          result.clientSafe = parsed.client_safe;
          if (parsed.client_safe.apiconnector2) {
            result.apiConnector2 = parsed.client_safe.apiconnector2;
          }
        } else if (parsed.apiconnector2) {
          result.apiConnector2 = parsed.apiconnector2;
        } else {
          // Might be the client_safe object directly
          result.clientSafe = parsed;
          if (parsed.apiconnector2) {
            result.apiConnector2 = parsed.apiconnector2;
          }
        }
        break;
      } catch (e) {
        console.log(`[API Keys] Failed to parse pattern match:`, e.message);
      }
    }
  }

  // Also try to find meta script with bubble data
  const metaMatch = html.match(/<script[^>]*id=["']bubble-data["'][^>]*>([\s\S]*?)<\/script>/i);
  if (metaMatch) {
    try {
      const data = JSON.parse(metaMatch[1]);
      if (data.settings?.client_safe) {
        result.clientSafe = data.settings.client_safe;
        if (data.settings.client_safe.apiconnector2) {
          result.apiConnector2 = data.settings.client_safe.apiconnector2;
        }
      }
    } catch (e) {
      console.log(`[API Keys] Failed to parse bubble-data script:`, e.message);
    }
  }

  // Extract keys from clientSafe
  if (result.clientSafe) {
    for (const [key, value] of Object.entries(result.clientSafe)) {
      if (key === 'apiconnector2') {
        result.apiConnector2 = value;
      } else if (typeof value === 'string' && value.length > 0) {
        result.allKeys.push({ name: key, value: value });
      }
    }
  }

  return result;
}

// Scan for API keys by accessing page JavaScript objects
app.post('/api/scan-api-keys', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  console.log(`[API Keys] Starting scan for: ${url}`);

  let browser = null;
  let useFallback = false;

  // Track diagnostic info for debugging
  let diagnosticInfo = {
    isVercel: !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME),
    chromiumLoaded: !!chromium,
    localChrome: null,
    launchError: null
  };

  try {
    // Try to launch Puppeteer
    // Use local Chrome for development, @sparticuz/chromium for Vercel
    let launchOptions;
    const isVercel = diagnosticInfo.isVercel;
    const localChrome = findLocalChrome();
    diagnosticInfo.localChrome = localChrome;

    if (localChrome && !isVercel) {
      // Use local Chrome for development
      console.log('[API Keys] Using local Chrome:', localChrome);
      launchOptions = {
        executablePath: localChrome,
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      };
    } else if (chromium && isVercel) {
      // Use @sparticuz/chromium-min for Vercel serverless
      console.log('[API Keys] Using @sparticuz/chromium-min with remote binary');
      launchOptions = {
        args: [...chromium.args, '--hide-scrollbars', '--disable-web-security'],
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(CHROMIUM_URL),
        headless: 'shell',
        ignoreHTTPSErrors: true,
      };
    } else {
      throw new Error('No Chrome browser found');
    }
    browser = await puppeteer.launch(launchOptions);
  } catch (launchError) {
    console.log(`[API Keys] Puppeteer launch failed, using HTML fallback:`, launchError.message);
    diagnosticInfo.launchError = launchError.message;
    useFallback = true;
  }

  try {
    // If Puppeteer failed to launch, use HTML fallback
    if (useFallback) {
      const extractedData = await extractApiDataFromHtml(url);

      const apiKeys = extractedData.allKeys.map(key => {
        let keyType = 'Unknown';
        let description = 'API key or configuration value';

        if (key.name.toLowerCase().includes('stripe')) {
          keyType = 'Stripe';
          description = key.value.startsWith('pk_') ? 'Stripe publishable key' : 'Stripe key';
        } else if (key.name.toLowerCase().includes('google')) {
          keyType = 'Google';
          description = 'Google API key';
        }

        return {
          name: key.name,
          value: key.value,
          type: keyType,
          description: description,
          risk: key.value.startsWith('sk_') ? 'critical' : 'low'
        };
      });

      console.log(`[API Keys] HTML fallback found ${apiKeys.length} keys`);

      return res.json({
        apiKeys: apiKeys,
        apiConnector2: extractedData.apiConnector2,
        clientSafe: extractedData.clientSafe,
        scannedUrl: url,
        method: 'html-fallback',
        debug: diagnosticInfo
      });
    }

    // Puppeteer path - original code

    const page = await browser.newPage();

    // Navigate to the page
    console.log(`[API Keys] Navigating to ${url}`);
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // Wait for page to fully initialize
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Extract API connector data from page context - specifically settings.client_safe
    const extractedData = await page.evaluate(() => {
      const result = {
        clientSafe: null,
        apiConnector2: null,
        allKeys: [],
        debugInfo: {}
      };

      // Helper to safely get nested property
      const safeGet = (obj, path) => {
        try {
          return path.split('.').reduce((o, k) => o && o[k], obj);
        } catch (e) {
          return null;
        }
      };

      // Search for client_safe in all window properties
      const searchForClientSafe = () => {
        // Check all window properties that might contain Bubble data
        const bubbleVars = [];
        for (const key of Object.keys(window)) {
          try {
            const val = window[key];
            if (val && typeof val === 'object') {
              // Check if this object has client_safe
              if (val.client_safe && typeof val.client_safe === 'object') {
                bubbleVars.push({ path: key + '.client_safe', value: val.client_safe });
              }
              // Check nested settings.client_safe
              if (val.settings && val.settings.client_safe) {
                bubbleVars.push({ path: key + '.settings.client_safe', value: val.settings.client_safe });
              }
            }
          } catch (e) {
            // Skip inaccessible properties
          }
        }
        return bubbleVars;
      };

      // First, try direct common paths
      const directPaths = [
        'settings.client_safe',
        'Settings.client_safe',
        'bubble_page_load_data.settings.client_safe',
        '_bubble_page_load_data.settings.client_safe',
        'appquery.settings.client_safe',
        'bubble.settings.client_safe',
        'Bubble.settings.client_safe',
        '__BUBBLE_DATA__.settings.client_safe',
        'bubbleData.settings.client_safe',
      ];

      for (const path of directPaths) {
        const value = safeGet(window, path);
        if (value && typeof value === 'object' && Object.keys(value).length > 0) {
          result.clientSafe = JSON.parse(JSON.stringify(value));
          result.debugInfo.foundAt = path;
          break;
        }
      }

      // If not found, search all window properties
      if (!result.clientSafe) {
        const found = searchForClientSafe();
        result.debugInfo.searchResults = found.map(f => f.path);
        if (found.length > 0) {
          result.clientSafe = JSON.parse(JSON.stringify(found[0].value));
          result.debugInfo.foundAt = found[0].path;
        }
      }

      // Also look in script tags for inline data
      if (!result.clientSafe) {
        const scripts = document.querySelectorAll('script:not([src])');
        for (const script of scripts) {
          const content = script.textContent;
          // Look for client_safe assignment
          const match = content.match(/client_safe\s*[=:]\s*(\{[\s\S]*?\})\s*[,;}\n]/);
          if (match) {
            try {
              result.clientSafe = JSON.parse(match[1]);
              result.debugInfo.foundAt = 'inline script';
              break;
            } catch (e) {
              // Try to find apiconnector2 directly
              const apiMatch = content.match(/apiconnector2\s*[=:]\s*(\{[\s\S]*?\})\s*[,;}\n]/);
              if (apiMatch) {
                try {
                  result.apiConnector2 = JSON.parse(apiMatch[1]);
                  result.debugInfo.foundAt = 'inline script (apiconnector2 only)';
                } catch (e2) {}
              }
            }
          }
        }
      }

      // Debug: list some global variables that might contain Bubble data
      result.debugInfo.bubbleLikeVars = Object.keys(window).filter(k =>
        k.toLowerCase().includes('bubble') ||
        k.toLowerCase().includes('setting') ||
        k.toLowerCase().includes('app') ||
        k === 'settings' ||
        k === 'Settings'
      ).slice(0, 15);

      // If we found client_safe, extract all the key-value pairs
      if (result.clientSafe) {
        for (const [key, value] of Object.entries(result.clientSafe)) {
          if (key === 'apiconnector2') {
            result.apiConnector2 = value;
          } else if (typeof value === 'string' && value.length > 0) {
            result.allKeys.push({
              name: key,
              value: value
            });
          }
        }
      }

      return result;
    });

    console.log(`[API Keys] Debug info:`, JSON.stringify(extractedData.debugInfo, null, 2));

    console.log(`[API Keys] Extracted ${extractedData.allKeys?.length || 0} keys from client_safe`);

    // Close browser
    await browser.close();
    browser = null;

    // Format the keys for display
    const apiKeys = (extractedData.allKeys || []).map(key => {
      // Try to determine the key type from the name
      let keyType = 'Unknown';
      let description = '';
      const nameLower = key.name.toLowerCase();

      if (nameLower.includes('google') || nameLower.includes('analytics')) {
        keyType = 'Google Analytics';
        description = 'Google Analytics tracking ID';
      } else if (nameLower.includes('recaptcha') || key.value.startsWith('6L')) {
        keyType = 'reCAPTCHA';
        description = 'Google reCAPTCHA site key';
      } else if (nameLower.includes('mapbox') || key.value.startsWith('pk.')) {
        keyType = 'Mapbox';
        description = 'Mapbox public access token';
      } else if (nameLower.includes('stripe') || key.value.startsWith('pk_')) {
        keyType = 'Stripe';
        description = 'Stripe publishable key';
      } else if (nameLower.includes('header') || nameLower.includes('_aal') || nameLower.includes('_abl')) {
        keyType = 'API Header';
        description = 'API authentication header value';
      } else if (key.value.length >= 20) {
        keyType = 'API Key';
        description = 'API key or token';
      }

      return {
        name: key.name,
        value: key.value,
        maskedValue: maskKey(key.value),
        type: keyType,
        description: description
      };
    });

    console.log(`[API Keys] Scan complete. Found ${apiKeys.length} API keys`);

    // Log apiConnector2 structure for debugging
    if (extractedData.apiConnector2) {
      const connectorKeys = Object.keys(extractedData.apiConnector2);
      console.log(`[API Keys] apiConnector2 has ${connectorKeys.length} connectors:`, connectorKeys);

      // Log structure of first connector to understand the format
      if (connectorKeys.length > 0) {
        const firstConnector = extractedData.apiConnector2[connectorKeys[0]];
        console.log(`[API Keys] First connector structure:`, JSON.stringify({
          keys: Object.keys(firstConnector),
          hasName: !!firstConnector.name,
          hasCalls: !!firstConnector.calls,
          callsType: firstConnector.calls ? typeof firstConnector.calls : 'N/A',
          callsKeys: firstConnector.calls ? Object.keys(firstConnector.calls).slice(0, 3) : []
        }, null, 2));
      }
    }

    res.json({
      apiKeys: apiKeys,
      apiConnector2: extractedData.apiConnector2,
      clientSafe: extractedData.clientSafe,
      scannedUrl: url
    });

  } catch (error) {
    console.error('[API Keys] Scan error:', error);

    if (browser) {
      await browser.close();
    }

    res.status(500).json({
      error: 'Failed to scan for API keys',
      details: error.message
    });
  }
});

// Analyze API exposure risk using Claude
app.post('/api/analyze-api-exposure', async (req, res) => {
  const { apiConnectors, apiKeys } = req.body;

  if (!apiConnectors && !apiKeys) {
    return res.status(400).json({ error: 'No API data to analyze' });
  }

  console.log('[API Exposure] Starting AI analysis');
  console.log('[API Exposure] Received data:', JSON.stringify({
    connectorCount: apiConnectors ? Object.keys(apiConnectors).length : 0,
    apiKeysCount: apiKeys ? apiKeys.length : 0
  }));

  try {
    // Format the API data for Claude with full details
    let analysisPrompt = `You are a security analyst reviewing API configurations extracted from a Bubble.io web application's client-side JavaScript code. This data was found in the browser and is accessible to any user.

Analyze these API configurations for security risks:
1. Are any API keys, tokens, or secrets exposed that could be exploited?
2. Are there hardcoded credentials in headers or parameters?
3. Could an attacker use these exposed values to access external services?

IMPORTANT CONTEXT:
- If a parameter/header has "private":true, the VALUE is stored server-side and NOT exposed to the client - these are SAFE
- If a parameter/header has "private":false with a hardcoded value, that value IS exposed - these may be RISKY
- Look at the actual values in %v fields to determine if they contain sensitive data

API Connectors found:
`;

    if (apiConnectors) {
      for (const [connectorId, connector] of Object.entries(apiConnectors)) {
        const connectorName = connector['%nm'] || connector.human || connector.name || connectorId;
        analysisPrompt += `\n## Connector: ${connectorName}\n`;

        // Log connector keys for debugging
        console.log(`[API Exposure] Connector ${connectorName} keys:`, Object.keys(connector));

        if (connector.calls) {
          for (const [callId, call] of Object.entries(connector.calls)) {
            const callName = call['%nm'] || call.human || call.name || callId;
            analysisPrompt += `\n### Call: ${callName}\n`;
            analysisPrompt += `URL: ${call.url || 'N/A'}\n`;
            analysisPrompt += `Method: ${call.method || 'GET'}\n`;

            // Log call keys and headers content for debugging
            console.log(`[API Exposure] Call ${callName} keys:`, Object.keys(call));
            if (call.headers) {
              console.log(`[API Exposure] Call ${callName} headers:`, JSON.stringify(call.headers));
            }

            // Check all possible header field names (can be array OR object)
            const headerFields = ['headers', 'shared_headers', 'request_headers', 'api_headers'];
            for (const field of headerFields) {
              if (call[field]) {
                if (Array.isArray(call[field]) && call[field].length > 0) {
                  analysisPrompt += `${field}:\n`;
                  call[field].forEach(h => {
                    analysisPrompt += `  ${JSON.stringify(h)}\n`;
                  });
                } else if (typeof call[field] === 'object' && Object.keys(call[field]).length > 0) {
                  // Headers stored as object with IDs as keys
                  analysisPrompt += `${field}:\n`;
                  for (const [headerId, headerData] of Object.entries(call[field])) {
                    analysisPrompt += `  ${JSON.stringify(headerData)}\n`;
                  }
                }
              }
            }

            // Check all possible parameter field names (can be array OR object)
            const paramFields = ['body_params', 'parameters', 'params', 'query_params', 'url_params', 'bodyParams'];
            for (const field of paramFields) {
              if (call[field]) {
                if (Array.isArray(call[field]) && call[field].length > 0) {
                  analysisPrompt += `${field}:\n`;
                  call[field].forEach(p => {
                    analysisPrompt += `  ${JSON.stringify(p)}\n`;
                  });
                } else if (typeof call[field] === 'object' && Object.keys(call[field]).length > 0) {
                  // Params stored as object with IDs as keys
                  analysisPrompt += `${field}:\n`;
                  for (const [paramId, paramData] of Object.entries(call[field])) {
                    analysisPrompt += `  ${JSON.stringify(paramData)}\n`;
                  }
                }
              }
            }

            // Also dump any string fields that might contain auth info
            for (const [key, value] of Object.entries(call)) {
              if (typeof value === 'string' && value.length > 0 &&
                  (key.toLowerCase().includes('auth') ||
                   key.toLowerCase().includes('token') ||
                   key.toLowerCase().includes('key') ||
                   key.toLowerCase().includes('secret') ||
                   key.toLowerCase().includes('bearer'))) {
                analysisPrompt += `${key}: "${value}"\n`;
              }
            }
          }
        }

        // Check connector-level header fields
        const connectorHeaderFields = ['shared_headers', 'headers', 'api_headers'];
        for (const field of connectorHeaderFields) {
          if (connector[field] && Array.isArray(connector[field]) && connector[field].length > 0) {
            analysisPrompt += `\nConnector ${field}:\n`;
            connector[field].forEach(h => {
              analysisPrompt += `  ${JSON.stringify(h)}\n`;
            });
          }
        }
      }
    }

    if (apiKeys && apiKeys.length > 0) {
      analysisPrompt += `\n## Other Exposed Values in Client Code:\n`;
      apiKeys.forEach(key => {
        analysisPrompt += `- ${key.type}: "${key.value}"\n`;
      });
    }

    analysisPrompt += `
Respond with a JSON object in this exact format:
{
  "summary": "Brief overall security assessment (1-2 sentences)",
  "riskLevel": "CRITICAL|HIGH|MODERATE|LOW",
  "findings": [
    {
      "connector": "connector name",
      "call": "call name (if applicable)",
      "risk": "CRITICAL|HIGH|MODERATE|LOW",
      "issue": "Specific description of the security issue and what data is exposed",
      "recommendation": "How to fix this issue"
    }
  ]
}

CRITICAL = Exploitable API keys/secrets fully exposed (can be used immediately by attacker)
HIGH = Sensitive credentials exposed that could enable attacks
MODERATE = Potentially sensitive data exposed but limited exploitability
LOW = Minor information disclosure, minimal risk

Only report actual security issues. Parameters marked "private":true are SAFE.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [
        { role: 'user', content: analysisPrompt }
      ]
    });

    const content = response.content[0].text;

    // Parse the JSON response
    let analysis;
    try {
      // Extract JSON from the response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        analysis = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      console.error('[API Exposure] Failed to parse AI response:', parseError);
      analysis = {
        summary: content,
        riskLevel: 'UNKNOWN',
        findings: []
      };
    }

    console.log(`[API Exposure] Analysis complete. Risk level: ${analysis.riskLevel}`);

    res.json(analysis);

  } catch (error) {
    console.error('[API Exposure] Analysis error:', error);
    res.status(500).json({
      error: 'Failed to analyze API exposure',
      details: error.message
    });
  }
});

// Recursively extract potential API keys from an object
function extractKeysFromObject(obj, detectedKeys, source, path = '') {
  if (!obj || typeof obj !== 'object') return;

  for (const [key, value] of Object.entries(obj)) {
    const currentPath = path ? `${path}.${key}` : key;

    if (typeof value === 'string' && value.length > 10) {
      // Check if this looks like an API key based on the property name
      const keyIndicators = ['key', 'token', 'secret', 'api', 'auth', 'password', 'credential'];
      const isKeyField = keyIndicators.some(indicator =>
        key.toLowerCase().includes(indicator)
      );

      // Check against patterns
      for (const patternDef of API_KEY_PATTERNS) {
        patternDef.pattern.lastIndex = 0;
        if (patternDef.pattern.test(value)) {
          if (!detectedKeys.some(k => k.value === value)) {
            detectedKeys.push({
              type: patternDef.name,
              value: value,
              maskedValue: maskKey(value),
              risk: patternDef.risk,
              description: patternDef.description,
              source: source,
              path: currentPath
            });
          }
        }
      }

      // If it's a key field with a long value, flag it even without pattern match
      if (isKeyField && value.length >= 20 && !detectedKeys.some(k => k.value === value)) {
        detectedKeys.push({
          type: 'Potential API Key',
          value: value,
          maskedValue: maskKey(value),
          risk: 'medium',
          description: `Found in field: ${currentPath}`,
          source: source,
          path: currentPath
        });
      }
    } else if (typeof value === 'object') {
      extractKeysFromObject(value, detectedKeys, source, currentPath);
    }
  }
}

// Mask API key for display (show first and last 4 chars)
function maskKey(key) {
  if (key.length <= 12) {
    return key.substring(0, 4) + '...' + key.substring(key.length - 4);
  }
  return key.substring(0, 6) + '...' + key.substring(key.length - 4);
}

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Bubble Security Scanner running at http://localhost:${PORT}`);
});
