# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Bubble App Security Scanner - a web tool for auditing Bubble.io applications to detect exposed sensitive data. Uses Claude AI to classify data sensitivity (HIGH/MODERATE/LOW) at both table and column levels.

## Commands

```bash
# Install dependencies
npm install

# Run the server (port 3000)
npm start
```

## Required Environment Variables

```
ANTHROPIC_API_KEY=your_api_key_here
```

## Architecture

**Simple Node.js + vanilla JS stack:**
- `server.js` - Express backend with all API endpoints
- `public/app.js` - Frontend state management and UI logic
- `public/index.html` - Single page UI
- `public/styles.css` - Glassmorphism styling

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

**External APIs:**
- AWS Lambda for DBML schema extraction
- Cloudflare Worker for encrypted Bubble data access (uses x, y, z encryption params)
- Anthropic Claude API for sensitivity classification

## AI Classification Endpoints

Three Claude-powered endpoints in `server.js`:
- `POST /api/analyze-sensitivity` - Table-level analysis (schema-based)
- `POST /api/analyze-columns` - Column-level analysis with sample data
- `POST /api/generate-summary` - Prioritized summary of critical exposures

All use model `claude-sonnet-4-20250514` and return JSON responses.

## Important Notes

- This tool is for authorized security testing only
- Frontend processes tables in parallel batches of 4 for performance
- Column sensitivity is cached in `state.allColumnSensitivity` to avoid re-analysis
- Manual overrides take priority over AI classifications
