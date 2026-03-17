# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Bubble App Security Scanner - a web tool for auditing Bubble.io applications to detect exposed sensitive data. Uses Claude AI to classify data sensitivity (HIGH/MODERATE/LOW) at both table and column levels.

## Commands

```bash
npm install       # Install dependencies
npm start         # Run server on port 3000
```

Requires Node.js 20.x (see .nvmrc/.node-version).

## Required Environment Variables

Create a `.env` file with:
```
ANTHROPIC_API_KEY=your_api_key_here
BROWSERLESS_API_KEY=your_key_here  # Optional: for serverless/Vercel deployment
```

## Architecture

**Simple Node.js + vanilla JS stack (ES modules):**
- `server.js` - Express backend with all API endpoints
- `public/app.js` - Frontend state management and UI logic
- `public/index.html` - Single page UI with 4 tabs (Data, Endpoints, API Keys, Pages)
- `public/styles.css` - Glassmorphism styling

**Scan Modes:**
- **Normal mode** - Fetches data via Cloudflare Worker proxy with encryption params
- **Enterprise mode** (`?enterprise=yes`) - Requires user credentials (x, y values) before scanning; runs both logged-out and logged-in scans; cookies are optional

**Data Flow:**
1. User enters Bubble.io app URL
2. Backend fetches schema via AWS Lambda (`/api/schema`)
3. Backend fetches metadata via Bubble API (`/api/meta`)
4. For each table with data, frontend requests sample data via encrypted worker API (`/api/fetch-table`)
5. Claude AI analyzes columns for sensitivity (`/api/analyze-columns`)
6. Table sensitivity is derived from column-level analysis
7. AI generates prioritized summary of critical exposures (`/api/generate-summary`)

**Key State Variables (public/app.js):**
- `state.tableSensitivity` - Table-level sensitivity (derived from columns)
- `state.allColumnSensitivity` - Column sensitivity for all tables
- `state.manualColumnOverrides` - User manual sensitivity overrides
- `state.activeTab` - Current UI tab ('tables' | 'endpoints' | 'keys' | 'pages')
- `state.enterpriseMode` - If true, requires credentials before scanning
- `state.currentView` - 'logged-out' | 'logged-in' for comparing data exposure

**External APIs:**
- AWS Lambda for DBML schema extraction
- Cloudflare Worker for encrypted Bubble data access (uses x, y, z encryption params)
- Anthropic Claude API for sensitivity classification (model: `claude-sonnet-4-20250514`)
- Browserless.io for headless Chrome in serverless environments

## API Endpoints

**AI-Powered (Claude):**
- `POST /api/analyze-sensitivity` - Table-level analysis (schema-based)
- `POST /api/analyze-columns` - Column-level analysis with sample data
- `POST /api/generate-summary` - Prioritized summary of critical exposures
- `POST /api/analyze-endpoint-risk` - Workflow API endpoint risk assessment
- `POST /api/analyze-api-exposure` - API key exposure analysis

**Data Fetching:**
- `GET /api/schema` - Fetch DBML schema via AWS Lambda
- `GET /api/meta` - Fetch Bubble app metadata
- `POST /api/fetch-table` - Fetch table data via encrypted worker
- `POST /api/workflows` - Parse workflow API definitions

**Page/Editor Scanning (Puppeteer):**
- `POST /api/scan-api-keys` - Scan client-side JS for exposed keys
- `POST /api/test-pages` - Test page access with pagination
- `GET /api/test-pages-stream` - SSE streaming for page tests
- `POST /api/app-plan` - Get Bubble app plan info

All AI endpoints return JSON responses.

## Deployment

**Vercel:** Configured via `vercel.json` with 60s function timeout and 1024MB memory. All routes rewrite to server.js.

## Version Parameter & Proxy Pattern (CRITICAL)

The fetch-table API uses 99reviews as a proxy to scan other Bubble apps. **Do not change this pattern.**

### Encrypt API Request Patterns

| Mode | appname | target_appname | app_version |
|------|---------|----------------|-------------|
| Non-userMode + live | *(omit)* | *(omit)* | *(omit)* |
| Non-userMode + test | `99reviews-43419` | `{targetApp}` | `test` |
| userMode (any version) | `{targetApp}` | *(omit)* | `live` or `test` |

### Worker API Request Patterns

| Mode | appname | url |
|------|---------|-----|
| Non-userMode | `99reviews-43419` | `https://99reviews.io/version-{live\|test}/elasticsearch/search` |
| userMode | `{targetApp}` | `https://{targetAppUrl}/version-{live\|test}/elasticsearch/search` |

### Key Rules

1. **Non-userMode uses 99reviews as proxy** - The `z` value (encrypted payload) contains the target app's info, but the worker call goes to 99reviews
2. **Use `target_appname` for non-userMode + test** - Must match the aggregate API pattern
3. **Never put appname/app_version in encrypt request for non-userMode + live** - Keep it simple: `{ x, y, payload }`
4. **URL version path matters** - Must include `/version-live/` or `/version-test/` in the elasticsearch URL

## Important Notes

- This tool is for authorized security testing only
- Frontend processes tables in parallel batches of 4 for performance
- Column sensitivity is cached in `state.allColumnSensitivity` to avoid re-analysis
- Manual overrides take priority over AI classifications
- Puppeteer uses local Chrome for development, Browserless.io for production/Vercel
- Page testing supports pagination (20 pages per batch) for Vercel's 60s timeout
