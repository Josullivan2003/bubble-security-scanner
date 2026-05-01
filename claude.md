# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Bubble App Security Scanner - a web tool for auditing Bubble.io applications to detect exposed sensitive data. Uses Claude AI to classify data sensitivity (HIGH/MODERATE/LOW) at both table and column levels.

## Commands

```bash
npm install       # Install dependencies
npm start         # Run server on port 3000
npm run dev       # Same as npm start (for development)
```

Requires Node.js 20.x (see .nvmrc/.node-version). Uses ES modules (`"type": "module"`).

## Required Environment Variables

Create a `.env` file with:
```
ANTHROPIC_API_KEY=your_api_key_here
BROWSERLESS_API_KEY=your_key_here  # Optional: for serverless/Vercel deployment
CLOUDFLARE_ACCOUNT_ID=your_id_here  # Optional: for /api/extract-contact
CLOUDFLARE_API_TOKEN=your_token_here  # Optional: for /api/extract-contact
```

## File Structure

```
server.js           # Express backend (~3500 lines)
public/
  app.js            # Frontend logic (~5400 lines)
  index.html        # Single page UI
  styles.css        # Glassmorphism CSS (~5400 lines)
vercel.json         # Vercel deployment config
```

No test suite exists in this project.

## Architecture

**Simple Node.js + vanilla JS stack (ES modules):**
- `server.js` - Express backend with all API endpoints
- `public/app.js` - Frontend state management and UI logic
- `public/index.html` - Single page UI with 4 tabs (Data, Endpoints, API Keys, Pages)
- `public/styles.css` - Glassmorphism styling

**Scan Modes:**
- **Normal mode** - Fetches data via Cloudflare Worker proxy with encryption params
- **User mode** (`?user=yes`) - Shows auth scan section for comparing logged-out vs logged-in data
- **Enterprise mode** (`?enterprise=yes`) - Requires user credentials (x, y values) before scanning; runs both logged-out and logged-in scans; cookies are optional

**Data Flow:**
1. User enters Bubble.io app URL
2. Backend fetches app info via Puppeteer (`/api/app-info`)
3. Backend fetches schema via AWS Lambda (`/api/schema`)
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
- `state.loggedOutData` / `state.loggedInData` - Separate storage for comparison views

**External APIs:**
- AWS Lambda for DBML schema extraction and encryption (`/prod/encrypt`, `/prod/aggregate`)
- Cloudflare Worker (`auth-worker.james-a7a.workers.dev`) for encrypted Bubble data access
- Anthropic Claude API for sensitivity classification (model: `claude-sonnet-4-20250514`)
- Browserless.io for headless Chrome in serverless environments

## API Endpoints

**AI-Powered (Claude):**
- `POST /api/analyze-sensitivity` - Table-level analysis (schema-based)
- `POST /api/analyze-columns` - Column-level analysis with sample data
- `POST /api/generate-summary` - Prioritized summary of critical exposures
- `POST /api/generate-table-descriptions` - AI descriptions for tables
- `POST /api/analyze-endpoint-risk` - Workflow API endpoint risk assessment
- `POST /api/analyze-api-exposure` - API key exposure analysis

**Data Fetching:**
- `GET /api/schema` - Fetch DBML schema via AWS Lambda
- `POST /api/fetch-table` - Fetch table data via encrypted worker (main data endpoint)
- `POST /api/mget` - Multi-get records by ID (used for user profile lookup)
- `POST /api/aggregate-count` - Get record counts for tables
- `POST /api/aggregate-count-auth` - Record counts with auth cookies
- `POST /api/aggregate-count-constrained` - Constrained record counts
- `POST /api/aggregate-column-distinct` - Get distinct column values
- `POST /api/workflows` - Parse workflow API definitions

**Authentication & Audit:**
- `POST /api/extract-cookies` - Extract auth cookies from Puppeteer session
- `POST /api/audit` - Access audit comparing logged-out vs logged-in visibility
- `POST /api/debug-compare` - Debug endpoint for data comparison

**Page/Editor Scanning (Puppeteer):**
- `POST /api/scan-api-keys` - Scan client-side JS for exposed API keys
- `POST /api/test-pages` - Test page access with pagination (20 pages/batch)
- `GET /api/test-pages-stream` - SSE streaming for real-time page test results
- `POST /api/app-plan` - Get Bubble app plan info
- `POST /api/admin-email` - Get Bubble app admin email from appquery.custom_domain_admin_email()
- `POST /api/app-info` - Get Bubble app ID and favicon from appquery.id() and appquery.favicon()
- `POST /api/extract-contact` - Extract contact email and LinkedIn using Cloudflare Browser Rendering AI

All AI endpoints return JSON responses. SSE endpoints use `text/event-stream` content type.

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

## URL Parameters

The frontend accepts these query parameters for testing and automation:

| Parameter | Example | Description |
|-----------|---------|-------------|
| `app` | `?app=https://myapp.bubbleapps.io` | Auto-populates URL and triggers scan |
| `x` | `?x=base64value` | Override default x encryption value |
| `y` | `?y=base64value` | Override default y encryption value |
| `user` | `?user=yes` | Enable user mode (shows auth scan section) |
| `enterprise` | `?enterprise=yes` | Enable enterprise mode (requires credentials) |
| `version` | `?version=test` | Query test version instead of live (`version-test` or `test`) |

## Implementation Notes

**Performance:**
- Frontend processes tables in parallel batches of 4
- Column sensitivity is cached in `state.allColumnSensitivity` to avoid re-analysis
- Page testing uses pagination (20 pages/batch) for Vercel's 60s timeout
- SSE streaming (`/api/test-pages-stream`) provides real-time feedback during scans

**Data Handling:**
- Manual overrides in `state.manualColumnOverrides` take priority over AI classifications
- Logged-out and logged-in data stored separately for comparison views
- Cookies passed to `mget` when available (all cookies except debug)

**Puppeteer/Browser:**
- Local Chrome for development (auto-detected from common paths)
- Browserless.io for production/Vercel (requires `BROWSERLESS_API_KEY`)
