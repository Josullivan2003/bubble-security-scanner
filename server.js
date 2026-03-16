import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import puppeteer from 'puppeteer-core';

// Browserless.io API key for serverless environments
const BROWSERLESS_API_KEY = process.env.BROWSERLESS_API_KEY;

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
  const { x, y, payload, appName, appUrl, cookies, userMode, version } = req.body;

  if (!payload || !appName || !appUrl) {
    return res.status(400).json({ error: 'payload, appName, and appUrl are required' });
  }

  try {
    // Step 1: Call encrypt API to get x, y, z
    const encryptUrl = 'https://5r6gtzlbpf.execute-api.us-east-1.amazonaws.com/prod/encrypt';

    console.log('\n========== FETCH-TABLE REQUEST ==========');
    console.log('[1] INCOMING REQUEST FROM FRONTEND:');
    console.log('    appName:', appName);
    console.log('    appUrl:', appUrl);
    console.log('    version:', version || 'version-live (default)');
    console.log('    cookies:', cookies || '(none)');
    console.log('    userMode:', userMode || false);
    console.log('    x:', x);
    console.log('    y:', y);
    console.log('    payload:', JSON.stringify(payload, null, 2));

    // Always include appname and app_version in encrypt request
    const versionValue = version ? version.replace('version-', '') : 'live';
    const encryptRequestBody = { x, y, payload, appname: appName, app_version: versionValue };
    console.log('\n[2] SENDING TO ENCRYPT API:', encryptUrl);
    console.log('    app_version:', versionValue);
    console.log('    Request body:', JSON.stringify(encryptRequestBody, null, 2));

    const encryptResponse = await fetch(encryptUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(encryptRequestBody),
    });

    const encryptData = await encryptResponse.json();
    console.log('\n[3] RECEIVED FROM ENCRYPT API:');
    console.log('    success:', encryptData.success);
    console.log('    x:', encryptData.x);
    console.log('    y:', encryptData.y);
    console.log('    z:', encryptData.z || '(none)');

    if (!encryptData.z) {
      throw new Error('Encryption failed - no z value returned');
    }

    // Step 2: Send x, y, z to worker API
    // Use auth-worker for user mode, api-worker for anonymous mode
    const workerUrl = userMode
      ? 'https://auth-worker.james-a7a.workers.dev/'
      : 'https://api-worker.james-a7a.workers.dev';

    // Build dynamic elasticsearch URL from app URL when in user mode
    const appUrlObj = new URL(appUrl);
    const versionPath = version || 'version-live';
    const dynamicElasticsearchUrl = `${appUrlObj.origin}/${versionPath}/elasticsearch/search`;

    const workerPayload = {
      x: encryptData.x,
      y: encryptData.y,
      z: encryptData.z,
      appname: userMode ? appName : '99reviews-43419',
      url: dynamicElasticsearchUrl,
      ...(cookies && { cookies }),
    };

    console.log('\n[4] SENDING TO WORKER API:', workerUrl);
    console.log('    appname:', workerPayload.appname);
    console.log('    url:', workerPayload.url);
    console.log('    cookies:', workerPayload.cookies || '(none)');
    console.log('    x:', workerPayload.x);
    console.log('    y:', workerPayload.y);
    console.log('    z:', workerPayload.z.substring(0, 50) + '...');

    const workerResponse = await fetch(workerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(workerPayload),
    });

    const data = await workerResponse.json();
    console.log('\n[5] RECEIVED FROM WORKER API:');
    console.log('    status:', data.status || 'N/A');
    console.log('    hits:', data.hits?.hits?.length || data.body?.hits?.hits?.length || 0, 'records');
    console.log('========== END FETCH-TABLE ==========\n');
    res.json(data);
  } catch (error) {
    console.error('Fetch table error:', error);
    res.status(500).json({ error: 'Failed to fetch table data', details: error.message });
  }
});

// Endpoint for getting accurate table counts via aggregate API (logged-out)
app.post('/api/aggregate-count', async (req, res) => {
  const { x, y, appName, tableType, version } = req.body;

  if (!x || !y || !appName || !tableType) {
    return res.status(400).json({ error: 'x, y, appName, and tableType are required' });
  }

  const versionValue = version ? version.replace('version-', '') : 'live';

  try {
    // Step 1: Call aggregate API to get encrypted params
    const aggregateUrl = 'https://5r6gtzlbpf.execute-api.us-east-1.amazonaws.com/prod/aggregate';

    const aggregateResponse = await fetch(aggregateUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        x,
        y,
        appname: '99reviews-43419',
        target_appname: appName,
        type: tableType,
        app_version: versionValue,
      }),
    });

    const aggregateData = await aggregateResponse.json();

    if (!aggregateData.z) {
      return res.json({ count: 0, error: 'Failed to get aggregate params' });
    }

    // Step 2: Call aggregate-worker to get the count
    const workerResponse = await fetch('https://aggregate-worker.james-a7a.workers.dev/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        x: aggregateData.x,
        y: aggregateData.y,
        z: aggregateData.z,
        url: 'https://99reviews.io/elasticsearch/maggregate',
      }),
    });

    const workerData = await workerResponse.json();

    // Extract count from response - can be in multiple places
    const count = workerData.count ||
                  workerData.body?.responses?.[0]?.count ||
                  workerData.body?.aggregations?.agg?.value ||
                  0;

    if (count === 0 && workerData.status !== 200) {
      console.log(`[Aggregate] ${tableType}: Worker returned status ${workerData.status}`);
    }

    res.json({ count });
  } catch (error) {
    console.error('Aggregate count error:', error);
    res.status(500).json({ error: 'Failed to get aggregate count', details: error.message });
  }
});

// Endpoint for getting accurate table counts via aggregate API (logged-in with cookies)
app.post('/api/aggregate-count-auth', async (req, res) => {
  const { x, y, appName, appUrl, tableType, cookies, version } = req.body;

  if (!x || !y || !appName || !appUrl || !tableType) {
    return res.status(400).json({ error: 'x, y, appName, appUrl, and tableType are required' });
  }

  const versionValue = version ? version.replace('version-', '') : 'live';

  try {
    // Step 1: Call aggregate API to get z (using user's x, y, appname)
    const aggregateUrl = 'https://5r6gtzlbpf.execute-api.us-east-1.amazonaws.com/prod/aggregate';

    const aggregateResponse = await fetch(aggregateUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        x,
        y,
        appname: appName,
        type: tableType,
        app_version: versionValue,
      }),
    });

    const aggregateData = await aggregateResponse.json();

    if (!aggregateData.z) {
      console.log(`[Aggregate-Auth] ${tableType}: No z returned from Step 1`);
      return res.json({ count: 0, error: 'Failed to get aggregate params' });
    }

    // Step 2: Call aggregate-worker with user's x, y, z, url, and cookies
    const appUrlObj = new URL(appUrl);
    const maggregateUrl = `${appUrlObj.origin}/elasticsearch/maggregate`;

    const workerResponse = await fetch('https://aggregate-worker.james-a7a.workers.dev/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        x,
        y,
        z: aggregateData.z,
        url: maggregateUrl,
        ...(cookies && { cookies }),
      }),
    });

    const workerData = await workerResponse.json();

    // Extract count from response
    const count = workerData.count ||
                  workerData.body?.responses?.[0]?.count ||
                  workerData.body?.aggregations?.agg?.value ||
                  0;

    if (count === 0 && workerData.status !== 200) {
      console.log(`[Aggregate-Auth] ${tableType}: Worker returned status ${workerData.status}`);
    }

    res.json({ count, authenticated: workerData.authenticated });
  } catch (error) {
    console.error('Aggregate count auth error:', error);
    res.status(500).json({ error: 'Failed to get aggregate count', details: error.message });
  }
});

// Endpoint to fetch user profile by ID via mget worker
app.post('/api/mget', async (req, res) => {
  const { x, y, appName, appUrl, ids, version, cookies } = req.body;

  if (!x || !y || !appName || !appUrl || !ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'x, y, appName, appUrl, and ids array are required' });
  }

  const versionValue = version ? version.replace('version-', '') : 'live';

  try {
    // Build mget URL from app URL
    const appUrlObj = new URL(appUrl);
    const mgetUrl = `${appUrlObj.origin}/elasticsearch/mget`;

    const requestBody = {
      x,
      y,
      appname: appName,
      ids,
      url: mgetUrl,
      app_version: versionValue,
      ...(cookies && { cookies }),
    };
    console.log(`[mget] Fetching ${ids.length} user(s) for app: ${appName}`);
    console.log(`[mget] URL: ${mgetUrl}`);

    const workerResponse = await fetch('https://mget-worker.james-a7a.workers.dev', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    const data = await workerResponse.json();
    console.log(`[mget] Response status: ${workerResponse.status}, found: ${data.body?.docs?.[0]?.found}`);

    res.json(data);
  } catch (error) {
    console.error('mget error:', error);
    res.status(500).json({ error: 'Failed to fetch user data', details: error.message });
  }
});

// Helper function to get just the app plan via Puppeteer (fast, lightweight)
async function getAppPlan(url) {
  let browser = null;
  try {
    const isVercel = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
    const localChrome = findLocalChrome();

    if (localChrome && !isVercel) {
      browser = await puppeteer.launch({
        executablePath: localChrome,
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
    } else if (BROWSERLESS_API_KEY) {
      browser = await puppeteer.connect({
        browserWSEndpoint: `wss://chrome.browserless.io?token=${BROWSERLESS_API_KEY}`,
      });
    } else {
      throw new Error('No browser available');
    }

    const page = await browser.newPage();
    // Don't wait for full network idle - just DOM content, then wait for appquery
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // Wait for Bubble's appquery object (it loads early)
    try {
      await page.waitForFunction(() => window.appquery && window.appquery.app_plan, { timeout: 15000 });
    } catch (e) {
      // Give it a bit more time then continue
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // Extract just the app plan
    const appPlan = await page.evaluate(() => {
      try {
        if (window.appquery) {
          if (typeof window.appquery.app_plan === 'function') {
            const planData = window.appquery.app_plan();
            if (planData) {
              return {
                id: planData.id || planData._id || null,
                name: planData.name || planData.display || null,
                raw: JSON.parse(JSON.stringify(planData))
              };
            }
          } else if (window.appquery.app_plan) {
            const planData = window.appquery.app_plan;
            return {
              id: planData.id || planData._id || null,
              name: planData.name || planData.display || null,
              raw: JSON.parse(JSON.stringify(planData))
            };
          }
        }
      } catch (e) {}
      return null;
    });

    await browser.close();
    return appPlan;

  } catch (error) {
    if (browser) await browser.close();
    throw error;
  }
}

// API endpoint to get just the Bubble app plan
app.post('/api/app-plan', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  console.log(`[App Plan] Fetching plan for: ${url}`);

  try {
    const appPlan = await getAppPlan(url);

    if (appPlan) {
      console.log(`[App Plan] Found: ${appPlan.id}`);
      res.json({ appPlan, url });
    } else {
      console.log(`[App Plan] Not found`);
      res.json({ appPlan: null, url, message: 'App plan not found' });
    }
  } catch (error) {
    console.error(`[App Plan] Error:`, error.message);
    res.status(500).json({ error: 'Failed to fetch app plan', details: error.message });
  }
});

// API endpoint to extract session cookies from a Bubble app
app.post('/api/extract-cookies', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  console.log(`[Extract Cookies] Navigating to: ${url}`);

  let browser = null;
  try {
    const isVercel = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
    const localChrome = findLocalChrome();

    if (localChrome && !isVercel) {
      browser = await puppeteer.launch({
        executablePath: localChrome,
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
    } else if (BROWSERLESS_API_KEY) {
      browser = await puppeteer.connect({
        browserWSEndpoint: `wss://chrome.browserless.io?token=${BROWSERLESS_API_KEY}`,
      });
    } else {
      throw new Error('No browser available');
    }

    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // Wait for Bubble's app to initialize
    try {
      await page.waitForFunction(() => window.appquery || window.app, { timeout: 10000 });
    } catch (e) {
      // Continue anyway - app may not be fully loaded
    }

    // Wait a moment for cookies and user data to be set
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Extract user info from Bubble's JavaScript context
    const userInfo = await page.evaluate(() => {
      try {
        let user = null;

        // Try different Bubble user object locations
        if (window.current_user && typeof window.current_user === 'function') {
          user = window.current_user();
        } else if (window.current_user) {
          user = window.current_user;
        } else if (window.appquery && typeof window.appquery.current_user === 'function') {
          user = window.appquery.current_user();
        } else if (window.app && window.app.current_user) {
          user = typeof window.app.current_user === 'function'
            ? window.app.current_user()
            : window.app.current_user;
        }

        if (user && user._id) {
          return {
            isLoggedIn: true,
            id: user._id || null,
            email: user.authentication?.email?.email || user.email || null,
          };
        }
      } catch (e) {}
      return { isLoggedIn: false, id: null, email: null };
    });

    // Extract all cookies for this page
    const allCookies = await page.cookies();
    await browser.close();

    // Get app name from meta API
    const baseUrl = new URL(url).origin;
    let appName = null;
    try {
      const metaResponse = await fetch(`${baseUrl}/api/1.1/meta`);
      const metaData = await metaResponse.json();
      appName = metaData.app_data?.appname;
    } catch (e) {
      // Fallback: detect app name from cookie names
      const bubbleCookie = allCookies.find(c => c.name.includes('_u1main') || c.name.includes('_u2main'));
      if (bubbleCookie) {
        appName = bubbleCookie.name.split('_')[0];
      }
    }

    // Filter cookies to only include those starting with the app name
    const appCookies = appName
      ? allCookies.filter(c => c.name.startsWith(appName))
      : allCookies;

    // Sort cookies: u1main first, then u2main, then u2main.sig
    const sortedCookies = appCookies.sort((a, b) => {
      const order = (name) => {
        if (name.includes('_u1main') || name.includes('_u1_')) return 0;
        if (name.includes('_u2main') && !name.includes('.sig')) return 1;
        if (name.includes('.sig')) return 2;
        return 3;
      };
      return order(a.name) - order(b.name);
    });

    // Format cookies as a string for the worker
    const cookieString = sortedCookies
      .map(c => `${c.name}=${c.value}`)
      .join('; ');

    // Also return structured data for debugging/display
    const sessionCookies = sortedCookies.filter(c =>
      c.name.includes('_u2main') ||
      c.name.includes('_u1main') ||
      c.name.includes('_u1_') ||
      c.name.includes('.sig')
    );

    console.log(`[Extract Cookies] App: ${appName}, Found ${allCookies.length} cookies, ${sortedCookies.length} app cookies, logged in: ${userInfo.isLoggedIn}`);

    res.json({
      cookies: cookieString,
      cookieCount: sortedCookies.length,
      sessionCookies: sessionCookies.map(c => ({ name: c.name, domain: c.domain })),
      hasSession: sessionCookies.length > 0,
      user: userInfo,
    });

  } catch (error) {
    if (browser) await browser.close();
    console.error(`[Extract Cookies] Error:`, error.message);
    res.status(500).json({ error: 'Failed to extract cookies', details: error.message });
  }
});

// Helper function to scan app info (plan and pages) via Puppeteer
async function scanAppInfo(url) {
  let browser = null;
  try {
    const isVercel = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
    const localChrome = findLocalChrome();

    if (localChrome && !isVercel) {
      browser = await puppeteer.launch({
        executablePath: localChrome,
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
    } else if (BROWSERLESS_API_KEY) {
      browser = await puppeteer.connect({
        browserWSEndpoint: `wss://chrome.browserless.io?token=${BROWSERLESS_API_KEY}`,
      });
    } else {
      throw new Error('No browser available');
    }

    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 45000 });
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Try to wait for Bubble's app object
    try {
      await page.waitForFunction(() => window.app && window.app.settings, { timeout: 10000 });
    } catch (e) {
      // Continue anyway
    }

    // Extract app plan, pages, and editor URL
    const extractedData = await page.evaluate(() => {
      const result = { appPlan: null, pages: null, editorUrl: null };

      // Extract app_plan from appquery
      try {
        if (window.appquery) {
          if (typeof window.appquery.app_plan === 'function') {
            const planData = window.appquery.app_plan();
            if (planData) {
              result.appPlan = {
                id: planData.id || planData._id || null,
                name: planData.name || planData.display || null,
                raw: JSON.parse(JSON.stringify(planData))
              };
            }
          } else if (window.appquery.app_plan) {
            const planData = window.appquery.app_plan;
            result.appPlan = {
              id: planData.id || planData._id || null,
              name: planData.name || planData.display || null,
              raw: JSON.parse(JSON.stringify(planData))
            };
          }
        }
      } catch (e) {}

      // Extract pages from app.%p3
      try {
        if (window.app && window.app['%p3']) {
          result.pages = JSON.parse(JSON.stringify(window.app['%p3']));
        }
      } catch (e) {}

      // Extract editor link
      try {
        if (window.appquery && typeof window.appquery.get_editor_link === 'function') {
          result.editorUrl = window.appquery.get_editor_link();
        }
      } catch (e) {}

      return result;
    });

    // Test page access
    let pageAccessResults = [];
    if (extractedData.pages) {
      const baseUrl = new URL(url);
      const pageNames = Object.values(extractedData.pages).map(p => p['%nm']).filter(Boolean);

      for (const pageName of pageNames) {
        const pageUrl = `${baseUrl.origin}/${pageName}`;
        try {
          let response;
          try {
            response = await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 10000 });
          } catch (navError) {
            if (navError.message.includes('timeout') || navError.message.includes('Timeout')) {
              response = await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
            } else {
              throw navError;
            }
          }

          await new Promise(resolve => setTimeout(resolve, 1500));

          const finalUrl = page.url();
          const finalPath = new URL(finalUrl).pathname.replace(/^\//, '').replace(/\/$/, '');
          const redirected = finalPath !== pageName;

          pageAccessResults.push({
            page: pageName,
            redirected: redirected,
            redirectTarget: redirected ? finalPath || 'index' : null,
            accessible: !redirected
          });
        } catch (e) {
          pageAccessResults.push({
            page: pageName,
            error: e.message,
            accessible: false
          });
        }
      }
    }

    // Test editor URL access (use test version instead of live)
    let editorAccess = null;
    if (extractedData.editorUrl) {
      // Change version=live to version=test for testing
      const testEditorUrl = extractedData.editorUrl.replace('version=live', 'version=test');
      try {
        let response;
        try {
          response = await page.goto(testEditorUrl, { waitUntil: 'networkidle2', timeout: 10000 });
        } catch (navError) {
          if (navError.message.includes('timeout') || navError.message.includes('Timeout')) {
            response = await page.goto(testEditorUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
          } else {
            throw navError;
          }
        }

        await new Promise(resolve => setTimeout(resolve, 2000));

        // Check for permission denied alert on the page
        const permissionDenied = await page.evaluate(() => {
          const bodyText = document.body ? document.body.innerText.toLowerCase() : '';
          return bodyText.includes('do not have permission') ||
                 bodyText.includes('don\'t have permission') ||
                 bodyText.includes('permission to view') ||
                 bodyText.includes('access denied') ||
                 bodyText.includes('not authorized');
        });

        const finalUrl = page.url();
        const redirectedToLogin = finalUrl.includes('login') || finalUrl.includes('signin') || finalUrl.includes('auth');

        editorAccess = {
          url: testEditorUrl,
          finalUrl: finalUrl,
          accessible: !permissionDenied && !redirectedToLogin,
          permissionDenied: permissionDenied,
          redirectedToLogin: redirectedToLogin,
          status: response ? response.status() : null
        };
      } catch (e) {
        editorAccess = {
          url: testEditorUrl,
          error: e.message,
          accessible: false
        };
      }
    }

    await browser.close();
    return { appPlan: extractedData.appPlan, pageAccess: pageAccessResults, editorAccess: editorAccess };

  } catch (error) {
    if (browser) await browser.close();
    throw error;
  }
}

// Full audit endpoint - returns AI summary of sensitive data
app.post('/api/audit', async (req, res) => {
  const { url, x, y, cookies } = req.body;

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
          const elasticsearchUrl = `${baseUrl}/version-live/elasticsearch/search`;
          const workerResponse = await fetch('https://api-worker.james-a7a.workers.dev', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              x: encryptData.x,
              y: encryptData.y,
              z: encryptData.z,
              appname: appName,
              url: elasticsearchUrl,
              ...(cookies && { cookies }),
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

    // Step 5: Get app plan, page access, and editor access via Puppeteer
    let appInfo = { appPlan: null, pageAccess: null, editorAccess: null };
    try {
      console.log(`[Audit] Scanning for app plan, pages, and editor...`);
      appInfo = await scanAppInfo(url);
      console.log(`[Audit] App plan: ${appInfo.appPlan?.id || 'not found'}, Pages: ${appInfo.pageAccess?.length || 0}, Editor: ${appInfo.editorAccess?.accessible ? 'ACCESSIBLE' : 'protected'}`);
    } catch (puppeteerError) {
      console.error(`[Audit] Puppeteer scan failed:`, puppeteerError.message);
    }

    res.json({
      ...summary,
      appPlan: appInfo.appPlan,
      pageAccess: appInfo.pageAccess,
      editorAccess: appInfo.editorAccess
    });
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

        // Parse auth level: 'none' | 'user' | 'admin'
        let authLevel = 'user'; // default: logged in user required
        if (wf.auth_unecessary === true) {
          authLevel = 'none';
        } else if (wf.auth_unecessary === 'admin_only') {
          authLevel = 'admin';
        }

        return {
          name: wf.endpoint,
          authRequired: wf.auth_unecessary !== true,
          authLevel, // 'none' | 'user' | 'admin'
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
    version: 'v4-browserless',
    isVercel: !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME),
    nodeVersion: process.version,
    method: null,
    launchError: null
  };

  try {
    const isVercel = diagnosticInfo.isVercel;
    const localChrome = findLocalChrome();

    if (localChrome && !isVercel) {
      // Use local Chrome for development
      console.log('[API Keys] Using local Chrome:', localChrome);
      diagnosticInfo.method = 'local-chrome';
      browser = await puppeteer.launch({
        executablePath: localChrome,
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
    } else if (BROWSERLESS_API_KEY) {
      // Use Browserless.io for serverless environments
      console.log('[API Keys] Using Browserless.io');
      diagnosticInfo.method = 'browserless';
      browser = await puppeteer.connect({
        browserWSEndpoint: `wss://chrome.browserless.io?token=${BROWSERLESS_API_KEY}`,
      });
    } else {
      throw new Error('No browser available (no local Chrome and no Browserless API key)');
    }
  } catch (launchError) {
    console.log(`[API Keys] Browser connection failed, using HTML fallback:`, launchError.message);
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
        appPlan: null, // Not available via HTML fallback (requires JS execution)
        pages: null, // Not available via HTML fallback (requires JS execution)
        pageAccess: null, // Not available via HTML fallback (requires JS execution)
        editorAccess: null, // Not available via HTML fallback (requires JS execution)
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
      timeout: 20000
    });

    // Wait for Bubble app to fully initialize (they load JS dynamically)
    console.log(`[API Keys] Waiting for Bubble app to initialize...`);
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Try to wait for Bubble's app object to be available
    try {
      await page.waitForFunction(() => window.app && window.app.settings, { timeout: 10000 });
      console.log(`[API Keys] Bubble app object detected`);
    } catch (e) {
      console.log(`[API Keys] Bubble app object not found after wait, continuing anyway`);
    }

    // Extract API connector data from page context - stringify inside browser to avoid CBOR limits
    let extractedData;
    try {
      const jsonString = await page.evaluate(() => {
        const result = {
          clientSafe: null,
          apiConnector2: null,
          appPlan: null,
          allKeys: [],
          pages: null,
          editorUrl: null,
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

        // Try to extract app_plan from appquery
        try {
          result.debugInfo.hasAppquery = !!window.appquery;
          if (window.appquery) {
            if (typeof window.appquery.app_plan === 'function') {
              const planData = window.appquery.app_plan();
              if (planData) {
                result.appPlan = {
                  id: planData.id || planData._id || null,
                  name: planData.name || planData.display || null
                };
              }
            } else if (window.appquery.app_plan) {
              const planData = window.appquery.app_plan;
              result.appPlan = {
                id: planData.id || planData._id || null,
                name: planData.name || planData.display || null
              };
            }
          }
        } catch (e) {
          result.debugInfo.appPlanError = e.message;
        }

        // Try to extract pages list from multiple possible locations
        try {
          let pageNames = [];

          // Method 1: window.app['%p3'] (common location)
          if (window.app && window.app['%p3']) {
            const pagesObj = window.app['%p3'];
            const pageIds = Object.keys(pagesObj).slice(0, 100);
            // Extract actual page names from each page object
            pageNames = pageIds.map(id => {
              const page = pagesObj[id];
              if (page && typeof page === 'object') {
                // Try common name properties
                return page['%nm'] || page.name || page.slug || id;
              }
              return id;
            }).filter(Boolean);
            result.debugInfo.pagesSource = 'app.%p3';
            // Debug: sample page structure
            if (pageIds.length > 0) {
              const samplePage = pagesObj[pageIds[0]];
              if (samplePage) {
                result.debugInfo.samplePageKeys = Object.keys(samplePage).slice(0, 10);
              }
            }
          }

          // Method 2: Check appquery.page_names if available
          if (pageNames.length === 0 && window.appquery) {
            if (typeof window.appquery.page_names === 'function') {
              const names = window.appquery.page_names();
              if (Array.isArray(names)) {
                pageNames = names.slice(0, 100);
                result.debugInfo.pagesSource = 'appquery.page_names()';
              }
            } else if (Array.isArray(window.appquery.page_names)) {
              pageNames = window.appquery.page_names.slice(0, 100);
              result.debugInfo.pagesSource = 'appquery.page_names';
            }
          }

          // Method 3: Check bubble_page_load_data for pages
          if (pageNames.length === 0 && window.bubble_page_load_data && window.bubble_page_load_data.pages) {
            const pages = window.bubble_page_load_data.pages;
            if (Array.isArray(pages)) {
              pageNames = pages.map(p => p.name || p['%nm'] || p.slug).filter(Boolean).slice(0, 100);
              result.debugInfo.pagesSource = 'bubble_page_load_data.pages';
            } else if (typeof pages === 'object') {
              pageNames = Object.keys(pages).slice(0, 100);
              result.debugInfo.pagesSource = 'bubble_page_load_data.pages (keys)';
            }
          }

          // Method 4: Search for pages in app.pages
          if (pageNames.length === 0 && window.app && window.app.pages) {
            const pages = window.app.pages;
            if (Array.isArray(pages)) {
              pageNames = pages.map(p => p.name || p['%nm'] || p.slug).filter(Boolean).slice(0, 100);
              result.debugInfo.pagesSource = 'app.pages';
            } else if (typeof pages === 'object') {
              pageNames = Object.keys(pages).slice(0, 100);
              result.debugInfo.pagesSource = 'app.pages (keys)';
            }
          }

          // Method 5: Look for page list in Settings
          if (pageNames.length === 0 && window.Settings && window.Settings.pages) {
            const pages = window.Settings.pages;
            if (Array.isArray(pages)) {
              pageNames = pages.map(p => p.name || p['%nm'] || p.slug).filter(Boolean).slice(0, 100);
              result.debugInfo.pagesSource = 'Settings.pages';
            }
          }

          // Method 6: Extract from URL patterns in links
          if (pageNames.length === 0) {
            const links = document.querySelectorAll('a[href]');
            const pageSet = new Set();
            const baseHost = window.location.host;
            for (const link of links) {
              try {
                const url = new URL(link.href);
                if (url.host === baseHost && url.pathname !== '/') {
                  const pageName = url.pathname.split('/')[1];
                  if (pageName && !pageName.includes('.') && pageName.length < 50) {
                    pageSet.add(pageName);
                  }
                }
              } catch (e) {}
            }
            if (pageSet.size > 0) {
              pageNames = Array.from(pageSet).slice(0, 100);
              result.debugInfo.pagesSource = 'link extraction';
            }
          }

          // Debug: Log what we found in window.app
          if (window.app) {
            result.debugInfo.appKeys = Object.keys(window.app).slice(0, 20);
          }

          if (pageNames.length > 0) {
            result.pages = pageNames.map(name => ({ name }));
          }
        } catch (e) {
          result.debugInfo.pagesError = e.message;
        }

        // Try to extract editor link
        try {
          if (window.appquery && typeof window.appquery.get_editor_link === 'function') {
            result.editorUrl = window.appquery.get_editor_link();
          }
        } catch (e) {}

        // Helper to extract keys from client_safe object
        const extractFromClientSafe = (value, foundAt) => {
          if (!value || typeof value !== 'object') return false;
          result.clientSafe = {};
          for (const [key, val] of Object.entries(value)) {
            if (typeof val === 'string' && val.length > 0) {
              result.clientSafe[key] = val;
              result.allKeys.push({ name: key, value: val });
            } else if (key === 'apiconnector2' && typeof val === 'object') {
              try {
                result.apiConnector2 = JSON.parse(JSON.stringify(val));
              } catch (e) {}
            }
          }
          result.debugInfo.foundAt = foundAt;
          return Object.keys(result.clientSafe).length > 0 || result.apiConnector2;
        };

        // Try direct common paths for client_safe
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
            if (extractFromClientSafe(value, path)) break;
          }
        }

        // If not found, search all window properties
        if (!result.clientSafe || Object.keys(result.clientSafe).length === 0) {
          const windowKeys = Object.keys(window);
          result.debugInfo.searchedKeys = windowKeys.length;

          for (const key of windowKeys) {
            try {
              const val = window[key];
              if (val && typeof val === 'object') {
                // Check if this object has client_safe
                if (val.client_safe && typeof val.client_safe === 'object') {
                  if (extractFromClientSafe(val.client_safe, key + '.client_safe')) break;
                }
                // Check nested settings.client_safe
                if (val.settings && val.settings.client_safe) {
                  if (extractFromClientSafe(val.settings.client_safe, key + '.settings.client_safe')) break;
                }
              }
            } catch (e) {
              // Skip inaccessible properties
            }
          }
        }

        // Also check inline scripts if still not found
        if (!result.clientSafe || Object.keys(result.clientSafe).length === 0) {
          try {
            const scripts = document.querySelectorAll('script:not([src])');
            for (const script of scripts) {
              const content = script.textContent;
              const match = content.match(/client_safe\s*[=:]\s*(\{[^}]+\})/);
              if (match) {
                try {
                  const parsed = JSON.parse(match[1]);
                  if (extractFromClientSafe(parsed, 'inline script')) break;
                } catch (e) {}
              }
            }
          } catch (e) {
            result.debugInfo.inlineScriptError = e.message;
          }
        }

        // Return as JSON string to avoid CBOR serialization issues
        return JSON.stringify(result);
      });

      extractedData = JSON.parse(jsonString);
    } catch (evalError) {
      console.log(`[API Keys] page.evaluate failed:`, evalError.message);
      extractedData = {
        clientSafe: null,
        apiConnector2: null,
        appPlan: null,
        allKeys: [],
        debugInfo: { error: evalError.message }
      };
    }

    console.log(`[API Keys] Debug info:`, JSON.stringify(extractedData.debugInfo, null, 2));
    console.log(`[API Keys] clientSafe found:`, !!extractedData.clientSafe);
    console.log(`[API Keys] apiConnector2 found:`, !!extractedData.apiConnector2);
    console.log(`[API Keys] Extracted ${extractedData.allKeys?.length || 0} keys from client_safe`);

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

    // Log app plan info
    // Log app plan info
    if (extractedData.appPlan) {
      console.log(`[API Keys] App plan found:`, JSON.stringify(extractedData.appPlan, null, 2));
    } else {
      console.log(`[API Keys] App plan not found`);
    }

    // Extract page names (no testing - that's done by /api/test-pages)
    let pageNames = [];
    if (extractedData.pages && Array.isArray(extractedData.pages)) {
      // Handle both formats: {name: "..."} (simplified) or {'%nm': "..."} (original)
      pageNames = extractedData.pages.map(p => p.name || p['%nm']).filter(Boolean);
      console.log(`[API Keys] Pages found: ${pageNames.length}`);
    } else {
      console.log(`[API Keys] Pages not found`);
    }

    // Close browser before sending response
    await browser.close();
    browser = null;

    // Return data without page access testing (use /api/test-pages for that)
    res.json({
      apiKeys: apiKeys,
      apiConnector2: extractedData.apiConnector2,
      clientSafe: extractedData.clientSafe,
      appPlan: extractedData.appPlan,
      pages: extractedData.pages,
      pageNames: pageNames,
      editorUrl: extractedData.editorUrl,  // Pass to frontend for /api/test-pages
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

// Separate endpoint for testing page access (supports pagination via offset)
app.post('/api/test-pages', async (req, res) => {
  const { url, pageNames, editorUrl, offset = 0 } = req.body;

  if (!url || !pageNames) {
    return res.status(400).json({ error: 'URL and pageNames are required' });
  }

  // Batch size for Vercel's 60-second timeout (~2s per page = 20 pages per batch)
  const BATCH_SIZE = 20;
  const startIndex = offset;
  const endIndex = Math.min(startIndex + BATCH_SIZE, pageNames.length);
  const pagesToTest = pageNames.slice(startIndex, endIndex);
  const hasMore = endIndex < pageNames.length;

  console.log(`[Test Pages] Testing pages ${startIndex + 1}-${endIndex} of ${pageNames.length} on ${url}`);

  let browser = null;
  let page = null;
  try {
    const baseUrl = new URL(url);

    // Launch browser
    const isProduction = process.env.NODE_ENV === 'production' || process.env.VERCEL;
    if (isProduction) {
      console.log('[Test Pages] Using Browserless.io');
      browser = await puppeteer.connect({
        browserWSEndpoint: `wss://production-sfo.browserless.io?token=${process.env.BROWSERLESS_API_KEY}`
      });
    } else {
      console.log('[Test Pages] Using local Chrome');
      browser = await puppeteer.launch({
        headless: 'new',
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
    }

    page = await browser.newPage();

    // Test pages sequentially with a single page (much faster than creating new pages)
    let pageAccessResults = [];
    for (const pageName of pagesToTest) {
      const pageUrl = `${baseUrl.origin}/${pageName}`;
      try {
        try {
          // Navigate and wait for load
          await page.goto(pageUrl, { waitUntil: 'load', timeout: 3000 });
        } catch (navError) {
          if (navError.message.includes('detached') || navError.message.includes('Detached')) {
            // Recreate page if frame detached
            try { await page.close(); } catch (e) {}
            page = await browser.newPage();
            await page.goto(pageUrl, { waitUntil: 'load', timeout: 3000 });
          } else if (!navError.message.includes('timeout') && !navError.message.includes('Timeout')) {
            throw navError;
          }
        }

        // Wait for JS redirect - Bubble apps may take a moment
        await new Promise(resolve => setTimeout(resolve, 1000));

        const finalUrl = page.url();
        const finalPath = new URL(finalUrl).pathname.replace(/^\//, '').replace(/\/$/, '');
        const redirected = finalPath !== pageName;
        const redirectTarget = redirected ? finalPath || 'index' : null;

        pageAccessResults.push({
          page: pageName,
          requestedUrl: pageUrl,
          finalUrl: finalUrl,
          redirected: redirected,
          redirectTarget: redirectTarget,
          accessible: !redirected
        });
      } catch (e) {
        pageAccessResults.push({
          page: pageName,
          requestedUrl: pageUrl,
          error: e.message,
          accessible: false
        });
        // Recreate page on error
        try { await page.close(); } catch (err) {}
        page = await browser.newPage();
      }
    }

    const accessible = pageAccessResults.filter(p => p.accessible).length;
    const protected_ = pageAccessResults.filter(p => !p.accessible && !p.error).length;
    console.log(`[Test Pages] Complete: ${accessible} accessible, ${protected_} protected`);

    if (page) {
      try { await page.close(); } catch (e) {}
    }
    await browser.close();
    browser = null;

    res.json({
      pageAccess: pageAccessResults,
      totalPages: pageNames.length,
      testedCount: pagesToTest.length,
      offset: startIndex,
      nextOffset: hasMore ? endIndex : null,
      hasMore: hasMore
    });

  } catch (error) {
    console.error('[Test Pages] Error:', error);
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
    res.status(500).json({ error: 'Failed to test pages', details: error.message });
  }
});

// SSE endpoint for streaming page access tests
app.get('/api/test-pages-stream', async (req, res) => {
  const url = req.query.url;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  console.log(`[Page Stream] Starting page access tests for: ${url}`);

  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const sendEvent = (eventType, data) => {
    res.write(`event: ${eventType}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let browser = null;

  try {
    const isVercel = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
    const localChrome = findLocalChrome();

    if (localChrome && !isVercel) {
      browser = await puppeteer.launch({
        executablePath: localChrome,
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
    } else if (BROWSERLESS_API_KEY) {
      browser = await puppeteer.connect({
        browserWSEndpoint: `wss://chrome.browserless.io?token=${BROWSERLESS_API_KEY}`,
      });
    } else {
      sendEvent('error', { message: 'No browser available' });
      res.end();
      return;
    }

    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 45000 });
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Extract page names
    const pageNames = await page.evaluate(() => {
      try {
        if (window.app && window.app['%p3']) {
          return Object.values(window.app['%p3']).map(p => p['%nm']).filter(Boolean);
        }
      } catch (e) {}
      return [];
    });

    if (pageNames.length === 0) {
      sendEvent('complete', { message: 'No pages found' });
      await browser.close();
      res.end();
      return;
    }

    sendEvent('start', { totalPages: pageNames.length, pages: pageNames });

    const baseUrl = new URL(url);

    // Test each page and stream results
    for (let i = 0; i < pageNames.length; i++) {
      const pageName = pageNames[i];
      const pageUrl = `${baseUrl.origin}/${pageName}`;

      try {
        let response;
        try {
          response = await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 10000 });
        } catch (navError) {
          if (navError.message.includes('timeout') || navError.message.includes('Timeout')) {
            response = await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
          } else {
            throw navError;
          }
        }

        await new Promise(resolve => setTimeout(resolve, 1500));

        const finalUrl = page.url();
        const finalPath = new URL(finalUrl).pathname.replace(/^\//, '').replace(/\/$/, '');
        const redirected = finalPath !== pageName;
        const redirectTarget = redirected ? finalPath || 'index' : null;

        sendEvent('pageResult', {
          index: i,
          page: pageName,
          requestedUrl: pageUrl,
          finalUrl: finalUrl,
          redirected: redirected,
          redirectTarget: redirectTarget,
          status: response ? response.status() : null,
          accessible: !redirected
        });

        console.log(`[Page Stream] ${i + 1}/${pageNames.length} - ${pageName}: ${redirected ? `redirected to ${redirectTarget}` : 'accessible'}`);

      } catch (e) {
        sendEvent('pageResult', {
          index: i,
          page: pageName,
          requestedUrl: pageUrl,
          error: e.message,
          accessible: false
        });
        console.log(`[Page Stream] ${i + 1}/${pageNames.length} - ${pageName}: error - ${e.message}`);
      }
    }

    // Test editor access
    const editorUrl = await page.evaluate(() => {
      try {
        if (window.appquery && typeof window.appquery.get_editor_link === 'function') {
          return window.appquery.get_editor_link();
        }
      } catch (e) {}
      return null;
    });

    if (editorUrl) {
      const testEditorUrl = editorUrl.replace('version=live', 'version=test');
      try {
        let response;
        try {
          response = await page.goto(testEditorUrl, { waitUntil: 'networkidle2', timeout: 10000 });
        } catch (navError) {
          if (navError.message.includes('timeout') || navError.message.includes('Timeout')) {
            response = await page.goto(testEditorUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
          } else {
            throw navError;
          }
        }

        await new Promise(resolve => setTimeout(resolve, 2000));

        const permissionDenied = await page.evaluate(() => {
          const bodyText = document.body ? document.body.innerText.toLowerCase() : '';
          return bodyText.includes('do not have permission') ||
                 bodyText.includes('don\'t have permission') ||
                 bodyText.includes('permission to view') ||
                 bodyText.includes('access denied') ||
                 bodyText.includes('not authorized');
        });

        const finalUrl = page.url();
        const redirectedToLogin = finalUrl.includes('login') || finalUrl.includes('signin') || finalUrl.includes('auth');

        sendEvent('editorResult', {
          url: testEditorUrl,
          finalUrl: finalUrl,
          accessible: !permissionDenied && !redirectedToLogin,
          permissionDenied: permissionDenied,
          redirectedToLogin: redirectedToLogin,
          status: response ? response.status() : null
        });
      } catch (e) {
        sendEvent('editorResult', {
          url: testEditorUrl,
          error: e.message,
          accessible: false
        });
      }
    }

    sendEvent('complete', { message: 'All pages tested' });

    await browser.close();
    res.end();

  } catch (error) {
    console.error('[Page Stream] Error:', error);
    sendEvent('error', { message: error.message });
    if (browser) await browser.close();
    res.end();
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

// Debug endpoint to compare data with and without cookies
app.post('/api/debug-compare', async (req, res) => {
  const { x, y, appName, appUrl, tableType, cookies } = req.body;

  if (!x || !y || !appName || !appUrl || !tableType) {
    return res.status(400).json({ error: 'x, y, appName, appUrl, and tableType are required' });
  }

  console.log('\n========== DEBUG COMPARE ==========');
  console.log('Comparing data with and without cookies for:', tableType);
  console.log('Cookies provided:', cookies ? cookies.substring(0, 100) + '...' : 'NONE');

  try {
    // Use the same payload format as fetchTableSample
    const payload = {
      app_version: 'live',
      appname: appName,
      constraints: [],
      from: 0,
      n: 10,
      search_path: '{"constructor_name":"DataSource","args":[{"type":"json","value":"%p3.cnEQb0.%el.cnEQh0.%p.%ds"},{"type":"node","value":{"constructor_name":"Element","args":[{"type":"json","value":"%p3.cnEQb0.%el.cnEQh0"}]}},{"type":"raw","value":"Search"}]}',
      situation: 'initial search',
      sorts_list: [],
      type: tableType,
    };

    // Step 1: Get encryption params (same for both requests)
    const encryptUrl = 'https://5r6gtzlbpf.execute-api.us-east-1.amazonaws.com/prod/encrypt';
    const encryptResponse = await fetch(encryptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x, y, payload, appname: appName }),
    });
    const encryptData = await encryptResponse.json();

    if (!encryptData.z) {
      console.log('Encryption failed - no z value');
      return res.json({ error: 'Encryption failed', details: encryptData });
    }

    const appUrlObj = new URL(appUrl);
    const searchUrl = `${appUrlObj.origin}/version-live/elasticsearch/search`;
    const workerUrl = 'https://auth-worker.james-a7a.workers.dev/';

    const workerPayloadBase = {
      x: encryptData.x,
      y: encryptData.y,
      z: encryptData.z,
      appname: appName,
      url: searchUrl,
    };

    // Fetch WITHOUT cookies
    console.log('\n[1] Fetching WITHOUT cookies...');
    console.log('    Worker URL:', workerUrl);
    console.log('    Search URL:', searchUrl);
    const noCookieResponse = await fetch(workerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(workerPayloadBase),
    });
    const noCookieData = await noCookieResponse.json();
    console.log('    Response status:', noCookieData.status);
    console.log('    Authenticated:', noCookieData.authenticated);

    // Fetch WITH cookies
    console.log('\n[2] Fetching WITH cookies...');
    console.log('    Cookies being sent:', cookies ? cookies.substring(0, 150) : 'EMPTY!');
    const withCookieResponse = await fetch(workerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...workerPayloadBase,
        cookies: cookies,
      }),
    });
    const withCookieData = await withCookieResponse.json();
    console.log('    Response status:', withCookieData.status);
    console.log('    Authenticated:', withCookieData.authenticated);

    // Extract hits for comparison
    const noCookieHits = noCookieData.body?.hits?.hits || noCookieData.hits?.hits || [];
    const withCookieHits = withCookieData.body?.hits?.hits || withCookieData.hits?.hits || [];

    console.log('\n[3] RESULTS SUMMARY:');
    console.log('    WITHOUT cookies: authenticated =', noCookieData.authenticated, ', hits =', noCookieHits.length);
    console.log('    WITH cookies: authenticated =', withCookieData.authenticated, ', hits =', withCookieHits.length);

    // Compare IDs
    const noCookieIds = noCookieHits.map(h => h._id);
    const withCookieIds = withCookieHits.map(h => h._id);

    // Compare field counts in first record
    const noCookieFields = noCookieHits[0] ? Object.keys(noCookieHits[0]._source || {}) : [];
    const withCookieFields = withCookieHits[0] ? Object.keys(withCookieHits[0]._source || {}) : [];

    console.log('    WITHOUT cookies fields:', noCookieFields.length, noCookieFields.slice(0, 10));
    console.log('    WITH cookies fields:', withCookieFields.length, withCookieFields.slice(0, 10));
    console.log('========== END DEBUG ==========\n');

    res.json({
      comparison: {
        noCookies: {
          authenticated: noCookieData.authenticated,
          totalHits: noCookieData.body?.hits?.total || 'unknown',
          recordCount: noCookieHits.length,
          recordIds: noCookieIds,
          fieldCount: noCookieFields.length,
          fields: noCookieFields,
          firstRecord: noCookieHits[0]?._source || null
        },
        withCookies: {
          authenticated: withCookieData.authenticated,
          totalHits: withCookieData.body?.hits?.total || 'unknown',
          recordCount: withCookieHits.length,
          recordIds: withCookieIds,
          fieldCount: withCookieFields.length,
          fields: withCookieFields,
          firstRecord: withCookieHits[0]?._source || null
        }
      },
      differences: {
        sameRecordIds: JSON.stringify(noCookieIds) === JSON.stringify(withCookieIds),
        sameFieldCount: noCookieFields.length === withCookieFields.length,
        onlyInWithCookies: withCookieFields.filter(f => !noCookieFields.includes(f)),
        onlyInNoCookies: noCookieFields.filter(f => !withCookieFields.includes(f))
      }
    });
  } catch (error) {
    console.error('Debug compare error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Bubble Security Scanner running at http://localhost:${PORT}`);
});
