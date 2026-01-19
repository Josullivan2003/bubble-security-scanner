# Bubble App Security Scanner

A web application for auditing Bubble.io applications and detecting exposed sensitive data using Claude AI for intelligent classification.

## Overview

This tool helps security researchers and developers identify data exposure vulnerabilities in Bubble.io applications by:
- Discovering database schema through Bubble APIs
- Using Claude AI to classify data sensitivity (HIGH/MODERATE/LOW)
- Visualizing exposed records with sensitive field highlighting
- Analyzing columns to identify personally identifiable information (PII)

## Technology Stack

**Backend:**
- Node.js with Express.js
- Claude AI SDK (@anthropic-ai/sdk) for sensitivity analysis
- CORS for cross-origin requests
- node-fetch for HTTP requests
- dotenv for environment configuration

**Frontend:**
- Vanilla JavaScript
- Glassmorphism design patterns
- Sortable, draggable, resizable data tables
- Multi-step workflow UI

## Project Structure

```
.
├── server.js              # Express backend server
├── public/
│   ├── index.html         # Main UI
│   ├── app.js            # Frontend logic
│   └── styles.css        # Styling
├── package.json          # Dependencies
└── .env                  # Environment variables (not tracked)
```

## Key Features

### 1. URL Input & Discovery
- Users input a Bubble.io application URL
- System fetches app metadata and database schema
- Schema retrieved in DBML format from AWS Lambda

### 2. Table Selection
- Displays all discovered tables with record counts
- AI-powered sensitivity classification at table level
- Visual indicators: RED (HIGH), YELLOW (MODERATE), GREEN (LOW)
- Toggle to filter and show only sensitive tables

### 3. Data Exposure Visualization
- Interactive data table with:
  - Sortable columns
  - Draggable column headers
  - Resizable columns
  - Column hide/show toggles
- Sensitive field highlighting with visual indicators
- Record detail modal for viewing complete data
- Pagination for large datasets

### 4. Sensitivity Analysis
Uses Claude AI to classify data based on:

**HIGH Risk:**
- Names, emails, phone numbers
- Social Security Numbers (SSN)
- Credit card information
- Passwords/Authentication tokens
- Health/Medical data
- Exact GPS coordinates

**MODERATE Risk:**
- Business contact information
- Business addresses
- Financial account details
- Order history

**LOW Risk:**
- Product catalogs
- Timestamps/Dates
- Generic IDs
- Settings/Preferences
- Public metadata

## API Endpoints

### Backend Routes

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/meta` | Fetch Bubble app metadata |
| GET | `/api/schema` | Retrieve DBML database schema |
| POST | `/api/analyze-sensitivity` | AI-powered table-level sensitivity analysis |
| POST | `/api/analyze-columns` | AI-powered column analysis with sample data |
| GET | `/api/data` | Proxy to Bubble Data API |
| POST | `/api/fetch-table` | Fetch table data via encrypted worker API |

## Security Architecture

### Encryption Layer
- Uses AWS Lambda for schema extraction
- Implements Cloudflare Workers for encrypted API access
- Manages encryption parameters: x, y (hardcoded), z (generated)

### Data Handling
- Sensitive data is classified but not permanently stored
- Analysis done via Claude API (data sent for AI processing)
- Frontend-driven workflow minimizes backend data exposure

## Setup & Usage

### Prerequisites
- Node.js and npm
- ANTHROPIC_API_KEY environment variable

### Installation
```bash
npm install
```

### Environment Variables
```
ANTHROPIC_API_KEY=your_api_key_here
PORT=3000
```

### Running the Server
```bash
npm start
```

Server runs on `http://localhost:3000`

## Workflow

1. **Input Stage**: User enters Bubble app URL
2. **Discovery Stage**: System fetches schema and metadata
3. **Classification Stage**: Claude AI analyzes tables for sensitivity
4. **Selection Stage**: User selects which tables to examine
5. **Exposure Stage**: System displays data with highlighting
6. **Analysis Stage**: Column-level sensitivity analysis with sample data

## Important Notes

- This tool is designed for authorized security testing and vulnerability research
- Ensure you have permission before scanning any Bubble.io application
- The application integrates with Bubble's public APIs and encryption infrastructure
- Sensitivity classification is performed by Claude AI and may require fine-tuning based on specific data contexts

## Recent Changes

- Multi-step UI workflow implemented
- AI-powered sensitivity classification at both table and column levels
- Advanced data table with sorting, dragging, and resizing
- Sensitive field visual indicators
- Record detail modal functionality

## Development Notes

- Frontend state management handles multi-step workflow
- Claude AI model integration for intelligent data classification
- Uses sample data for column-level analysis to avoid processing entire tables
- Encryption worker API for secure Bubble API communication
