// State
let state = {
  bubbleUrl: '',
  appName: '',
  tables: [],
  tablesWithColumns: [],
  tableSensitivity: {},           // Table-level sensitivity (derived from columns)
  allColumnSensitivity: {},       // Column sensitivity for all tables: { tableId: { colName: sensitivity } }
  columnSensitivity: {},          // Sensitivity for current table's columns (active view)
  manualColumnOverrides: {},      // Manual column sensitivity overrides: { tableId: { colName: sensitivity } }
  sensitivityLoading: false,      // Whether sensitivity analysis is in progress
  columnSensitivityLoading: false,// Whether column sensitivity analysis is in progress
  showSensitiveOnly: false,       // Filter to show only sensitive data
  selectedTable: '',
  results: [],
  xValue: 'p1w5CLCS+ngwPIcoMz8rpaTc/CREf7bx11VJEJtnKrc=',
  yValue: 'izOeimelvrYvr1RJO0/K2w==',
  sortColumn: null,
  sortDirection: 'asc',
  hiddenColumns: [],
  columnOrder: [],
  failedTables: [],               // Tables that failed analysis (for retry)
  // API Endpoint analysis state
  activeTab: 'tables',            // 'tables' | 'endpoints'
  endpointAnalysis: null,         // Endpoint analysis results
  endpointAnalysisLoading: false, // Loading state for endpoint analysis
  showCallableOnly: false,        // Toggle to show only callable endpoints
  summaryRiskOverride: null,      // Manual override for summary risk level
  summaryOriginalRisk: null,      // Original AI-determined risk level
  // API Keys analysis state
  apiKeysAnalysis: null,          // { keys: [], consoleCount: 0 }
  apiKeysLoading: false,          // Loading state for API keys scan
  apiExposureAnalysis: null,      // AI analysis of API exposure risk
  apiExposureLoading: false,      // Loading state for exposure analysis
  riskFilters: {                  // Multi-select risk level filters
    critical: false,
    high: false,
    medium: false
  },
  manualApiOverrides: {},         // Manual API call severity: { "connectorName|callName": { risk, issue } }
  apiKeysSearch: '',              // Search query for API keys tab
};

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  parseUrlParams();

  // Allow Enter key to trigger scan
  document.getElementById('bubbleUrl').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      startScan();
    }
  });
});

// Parse URL parameters for x and y values
function parseUrlParams() {
  // Use manual parsing to preserve + characters (URLSearchParams converts + to space)
  const queryString = window.location.search.substring(1);
  const params = {};

  queryString.split('&').forEach(pair => {
    // Split only on the first = to preserve = in values (like base64 padding)
    const eqIndex = pair.indexOf('=');
    if (eqIndex > 0) {
      const key = pair.substring(0, eqIndex);
      const value = pair.substring(eqIndex + 1);
      // Decode but preserve + by first replacing them with a placeholder
      params[key] = decodeURIComponent(value.replace(/\+/g, '%2B'));
    }
  });

  if (params.x) {
    state.xValue = params.x;
  }
  if (params.y) {
    state.yValue = params.y;
  }

  // Auto-populate and trigger scan if app URL provided
  if (params.app) {
    const urlInput = document.getElementById('bubbleUrl');
    urlInput.value = params.app;
    // Trigger scan after a short delay to ensure DOM is ready
    setTimeout(() => startScan(), 100);
  }
}

// Step 1: Start scanning the Bubble app
async function startScan() {
  const urlInput = document.getElementById('bubbleUrl');
  let url = urlInput.value.trim();

  if (!url) {
    showError('step1Error', 'Please enter a Bubble app URL');
    return;
  }

  // Add https:// if no protocol specified
  if (!url.match(/^https?:\/\//i)) {
    url = 'https://' + url;
  }

  // Validate URL format
  try {
    new URL(url);
  } catch (e) {
    showError('step1Error', 'Please enter a valid URL');
    return;
  }

  state.bubbleUrl = url;
  hideError('step1Error');

  // Reset sensitivity filter toggle
  state.showSensitiveOnly = false;
  const sensitivityCheckbox = document.getElementById('sensitivityFilter');
  if (sensitivityCheckbox) {
    sensitivityCheckbox.checked = false;
  }

  // Hide the Exposed Data section
  document.getElementById('step3').classList.add('hidden');

  // Hide and reset the AI summary section
  const summarySection = document.getElementById('textSummarySection');
  if (summarySection) {
    summarySection.classList.add('hidden');
    document.getElementById('textSummaryOutput').innerHTML = '';
  }

  showLoading('Identifying app...');

  try {
    // Step 1: Get app ID from meta API
    updateLoadingText('Fetching app info...');
    const metaResponse = await fetch(`/api/meta?url=${encodeURIComponent(url)}`);
    const metaData = await metaResponse.json();

    if (metaData.error) {
      throw new Error(metaData.error);
    }

    // Get the app ID from meta response (e.g., "99reviews-43419")
    // The app ID is in app_data.appname
    state.appName = (metaData.app_data && metaData.app_data.appname) || extractAppName(url);

    // Step 2: Get DBML schema to discover tables
    updateLoadingText('Fetching schema...');
    const schemaResponse = await fetch(`/api/schema?url=${encodeURIComponent(url)}`);
    const schemaData = await schemaResponse.json();

    if (schemaData.error) {
      throw new Error(schemaData.error);
    }

    // Step 2: Parse tables from DBML
    updateLoadingText('Discovering data tables...');

    // Store enhanced schema with columns for sensitivity analysis
    state.tablesWithColumns = schemaData.tablesWithColumns || [];

    const tables = schemaData.tables || [];
    const tableMap = new Map();

    tables.forEach(tableName => {
      // Clean up table name (remove % artifacts)
      const cleanName = tableName.replace(/%/g, '');
      tableMap.set(cleanName, {
        id: cleanName,
        display: cleanName.charAt(0).toUpperCase() + cleanName.slice(1).replace(/_/g, ' '),
        fields: [],
        explicit: true
      });
    });

    state.tables = Array.from(tableMap.values());

    if (state.tables.length === 0) {
      throw new Error('No data tables found in this app');
    }

    // Display tables initially (without counts)
    renderTableList();
    renderTabFilter();
    document.getElementById('step2').classList.remove('hidden');

    // Fetch record counts for each table in parallel
    updateLoadingText('Counting records...');
    await fetchAllTableCounts();

    hideLoading();

    // Start sensitivity analysis in background (doesn't block UI)
    analyzeSensitivity();

    // Run API keys/pages scan immediately (doesn't depend on tables having data)
    scanApiKeys();
  } catch (error) {
    hideLoading();
    showError('step1Error', `Scan failed: ${error.message}`);
  }
}

// Analyze data sensitivity using AI - column-level analysis for all tables
async function analyzeSensitivity() {
  // Get tables that have actual data (count > 1)
  const tablesWithData = state.tables.filter(table => {
    const count = table.recordCount;
    return count && count !== 0 && count !== '0' && count !== '?' && !table.metadataOnly;
  });

  if (tablesWithData.length === 0) {
    console.log('No tables with data to analyze');
    return;
  }

  console.log(`Starting column-level sensitivity analysis for ${tablesWithData.length} tables`);

  // Show loading state on table cards
  state.sensitivityLoading = true;
  state.tableSensitivity = {};
  state.allColumnSensitivity = {}; // Store column sensitivity for all tables
  state.failedTables = []; // Track failed tables for retry
  renderTableList();

  // Process tables in parallel batches of 4
  const BATCH_SIZE = 4;
  for (let i = 0; i < tablesWithData.length; i += BATCH_SIZE) {
    const batch = tablesWithData.slice(i, i + BATCH_SIZE);
    console.log(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.map(t => t.id).join(', ')}`);

    // Analyze all tables in this batch in parallel
    await Promise.all(batch.map(table => analyzeTableSensitivity(table)));

    // Update UI after each batch completes
    renderTableList();
  }

  // Retry failed tables once (in smaller batches)
  if (state.failedTables.length > 0) {
    console.log(`Retrying ${state.failedTables.length} failed tables: ${state.failedTables.map(t => t.id).join(', ')}`);
    const retryTables = [...state.failedTables];
    state.failedTables = [];

    for (let i = 0; i < retryTables.length; i += 2) {
      const batch = retryTables.slice(i, i + 2);
      await Promise.all(batch.map(table => analyzeTableSensitivity(table)));
      renderTableList();
    }
  }

  // Done analyzing all tables
  state.sensitivityLoading = false;
  renderTableList();
  renderTabFilter();
  console.log('Sensitivity analysis complete:', state.tableSensitivity);
  if (state.failedTables.length > 0) {
    console.log(`Failed to analyze ${state.failedTables.length} tables after retry`);
  }

  // Generate AI outreach summary after all analysis is done
  generateOutreachSummary();

  // Run endpoint analysis in background (now that we have exposed data)
  analyzeEndpoints();
}

// Analyze a single table's sensitivity (used for parallel processing)
async function analyzeTableSensitivity(table) {
  try {
    console.log(`Analyzing table: ${table.id}`);

    // Fetch sample data for this table
    const sampleData = await fetchTableSample(table.id);

    if (!sampleData || sampleData.length === 0) {
      console.log(`No sample data for table: ${table.id}`);
      return;
    }

    // Extract columns and sample values
    const columnsWithSamples = extractColumnsWithSamples(sampleData);

    if (columnsWithSamples.length === 0) {
      console.log(`No columns to analyze for table: ${table.id}`);
      return;
    }

    // Call column-level analysis API
    const response = await fetch('/api/analyze-columns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tableName: table.id,
        columnsWithSamples: columnsWithSamples
      })
    });

    const data = await response.json();

    if (data.error) {
      console.error(`Column analysis failed for ${table.id}:`, data.error);
      return;
    }

    // Store column sensitivity for this table
    const columnSensitivity = {};
    let highestSensitivity = 'low';
    const sensitiveFields = [];

    if (data.fields && Array.isArray(data.fields)) {
      data.fields.forEach(field => {
        columnSensitivity[field.name] = field.sensitivity;
        sensitiveFields.push(field.name);

        // Track highest sensitivity
        if (field.sensitivity === 'high') {
          highestSensitivity = 'high';
        } else if (field.sensitivity === 'moderate' && highestSensitivity !== 'high') {
          highestSensitivity = 'moderate';
        }
      });
    }

    // Store results
    state.allColumnSensitivity[table.id] = columnSensitivity;

    // Derive table sensitivity from column analysis
    if (highestSensitivity !== 'low') {
      state.tableSensitivity[table.id] = {
        sensitivity: highestSensitivity,
        reason: `Contains ${highestSensitivity === 'high' ? 'highly' : 'moderately'} sensitive fields: ${sensitiveFields.join(', ')}`
      };
    }

  } catch (error) {
    console.error(`Error analyzing table ${table.id}:`, error);
    // Track failed table for retry
    if (state.failedTables && !state.failedTables.find(t => t.id === table.id)) {
      state.failedTables.push(table);
    }
  }
}

// Fetch a small sample of data from a table for sensitivity analysis
async function fetchTableSample(tableId) {
  const payload = {
    app_version: 'live',
    appname: state.appName,
    constraints: [],
    from: 0,
    n: 5, // Just fetch 5 records for sample
    search_path: '{"constructor_name":"DataSource","args":[{"type":"json","value":"%p3.cnEQb0.%el.cnEQh0.%p.%ds"},{"type":"node","value":{"constructor_name":"Element","args":[{"type":"json","value":"%p3.cnEQb0.%el.cnEQh0"}]}},{"type":"raw","value":"Search"}]}',
    situation: 'initial search',
    sorts_list: [],
    type: getTableType(tableId),
  };

  try {
    const response = await fetch('/api/fetch-table', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        x: state.xValue,
        y: state.yValue,
        payload: payload,
        appName: state.appName,
        appUrl: state.bubbleUrl,
      }),
    });

    const data = await response.json();
    return parseResults(data);
  } catch (error) {
    console.error(`Failed to fetch sample for ${tableId}:`, error);
    return [];
  }
}

// Extract column names and sample values from data
function extractColumnsWithSamples(results) {
  const systemFields = ['_version', '_type', '_id'];
  const columns = new Set();

  results.forEach(row => {
    Object.keys(row).forEach(key => {
      if (!systemFields.includes(key)) {
        columns.add(key);
      }
    });
  });

  const columnList = Array.from(columns);

  return columnList.map(colName => {
    const samples = [];
    for (const row of results) {
      if (samples.length >= 3) break;
      const value = row[colName];
      if (value !== null && value !== undefined && value !== '') {
        let strValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
        if (strValue.length > 100) {
          strValue = strValue.substring(0, 100) + '...';
        }
        if (!samples.includes(strValue)) {
          samples.push(strValue);
        }
      }
    }
    return { name: colName, samples };
  });
}

// Toggle sensitivity filter
function toggleSensitivityFilter() {
  state.showSensitiveOnly = document.getElementById('sensitivityFilter').checked;
  renderTableList();
  // Also re-render results table if viewing one
  if (state.results.length > 0) {
    renderResultsTable();
  }
}

// Extract app name from URL as fallback
function extractAppName(url) {
  try {
    const hostname = new URL(url).hostname;
    return hostname.split('.')[0];
  } catch (e) {
    return 'unknown';
  }
}

// Fetch record counts for all tables in parallel
async function fetchAllTableCounts() {
  const countPromises = state.tables.map(async (table) => {
    try {
      const result = await fetchTableCount(table.id);
      table.recordCount = result.count;
      table.metadataOnly = result.metadataOnly;
    } catch (e) {
      table.recordCount = '?';
      table.metadataOnly = false;
    }
  });

  await Promise.all(countPromises);
  renderTableList(); // Re-render with counts
}

// Get the type string for a table (users table doesn't use custom. prefix)
function getTableType(tableId) {
  if (tableId.toLowerCase() === 'user') {
    return 'user';
  }
  return `custom.${tableId}`;
}

// Fetch record count for a single table
async function fetchTableCount(tableId) {
  const payload = {
    app_version: 'live',
    appname: state.appName,
    constraints: [],
    from: 0,
    n: 10000,
    search_path: '{"constructor_name":"DataSource","args":[{"type":"json","value":"%p3.cnEQb0.%el.cnEQh0.%p.%ds"},{"type":"node","value":{"constructor_name":"Element","args":[{"type":"json","value":"%p3.cnEQb0.%el.cnEQh0"}]}},{"type":"raw","value":"Search"}]}',
    situation: 'initial search',
    sorts_list: [],
    type: getTableType(tableId),
  };

  const response = await fetch('/api/fetch-table', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      x: state.xValue,
      y: state.yValue,
      payload: payload,
      appName: state.appName,
      appUrl: state.bubbleUrl,
    }),
  });

  const data = await response.json();

  // Check for error status
  if (data.status && data.status >= 400) {
    return { count: 0, metadataOnly: false };
  }

  // Count hits array length and check for metadata-only records
  if (data.body && data.body.hits && Array.isArray(data.body.hits.hits)) {
    const hits = data.body.hits.hits;
    const count = hits.length;

    // Check if all records only have metadata fields (_id only, no real data)
    const metadataFields = ['_id', '_type', '_version'];
    const metadataOnly = count > 0 && hits.every(hit => {
      const sourceFields = Object.keys(hit._source || {});
      // Filter out metadata fields to see if there's any real data
      const dataFields = sourceFields.filter(f => !metadataFields.includes(f));
      return dataFields.length === 0;
    });

    // If we hit the 400 limit and at_end is false, there are more records
    if (count >= 400 && data.body.at_end === false) {
      return { count: '400+', metadataOnly };
    }
    return { count, metadataOnly };
  }

  return { count: 0, metadataOnly: false };
}

// Render the table selection list
function renderTableList() {
  const container = document.getElementById('tableList');
  container.innerHTML = '';

  // Sort tables alphabetically by display name
  let sortedTables = [...state.tables].sort((a, b) =>
    a.display.toLowerCase().localeCompare(b.display.toLowerCase())
  );

  // Filter to show only sensitive tables if toggle is on
  if (state.showSensitiveOnly && !state.sensitivityLoading) {
    sortedTables = sortedTables.filter(table => {
      const sensitivityData = state.tableSensitivity[table.id];
      return sensitivityData && (sensitivityData.sensitivity === 'high' || sensitivityData.sensitivity === 'moderate');
    });
  }

  sortedTables.forEach((table) => {
    const item = document.createElement('div');
    const hasRecords = table.recordCount !== undefined && table.recordCount !== 0 && table.recordCount !== '0';
    const hasRealData = hasRecords && !table.metadataOnly;

    item.className = 'table-item' + (hasRealData ? '' : ' disabled');
    item.dataset.tableId = table.id;

    // Sensitivity indicator or loading spinner (left side)
    // Only show loading spinner for tables with data (count > 0)
    if (state.sensitivityLoading && hasRealData) {
      // Show loading spinner while analyzing
      const loadingIcon = document.createElement('span');
      loadingIcon.className = 'sensitivity-indicator sensitivity-loading-icon';
      loadingIcon.innerHTML = '<div class="spinner-tiny"></div>';
      loadingIcon.title = 'Analyzing sensitivity...';
      item.appendChild(loadingIcon);
    } else {
      const sensitivityData = state.tableSensitivity[table.id];
      if (sensitivityData && sensitivityData.sensitivity !== 'low') {
        const sensitivityIcon = document.createElement('span');
        sensitivityIcon.className = 'sensitivity-indicator';

        if (sensitivityData.sensitivity === 'high') {
          sensitivityIcon.classList.add('sensitivity-high');
          sensitivityIcon.innerHTML = '!';
          sensitivityIcon.title = `Highly Sensitive: ${sensitivityData.reason}`;
        } else if (sensitivityData.sensitivity === 'moderate') {
          sensitivityIcon.classList.add('sensitivity-moderate');
          sensitivityIcon.innerHTML = '!';
          sensitivityIcon.title = `Moderately Sensitive: ${sensitivityData.reason}`;
        }

        item.appendChild(sensitivityIcon);
      }
    }

    // Table name
    const nameSpan = document.createElement('span');
    nameSpan.className = 'table-name';
    nameSpan.textContent = table.display;
    nameSpan.title = table.display;
    item.appendChild(nameSpan);

    // Badge with count
    if (table.recordCount !== undefined) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = table.metadataOnly ? 0 : table.recordCount;
      item.appendChild(badge);
    }

    if (hasRealData) {
      item.onclick = () => selectTable(table.id, table.display);
    }

    container.appendChild(item);
  });
}

// Step 3: Select a table and fetch data
async function selectTable(tableId, displayName) {
  state.selectedTable = tableId;
  resetColumnSettings();

  // Update UI selection
  document.querySelectorAll('.table-item').forEach((item) => {
    item.classList.toggle('selected', item.dataset.tableId === tableId);
  });

  hideError('step2Error');
  document.getElementById('step3').classList.remove('hidden');
  document.getElementById('tableName').textContent = displayName;
  document.getElementById('loadingResults').classList.remove('hidden');
  document.getElementById('resultsHead').innerHTML = '';
  document.getElementById('resultsBody').innerHTML = '';

  try {
    // Build payload for encrypt API
    const payload = {
      app_version: 'live',
      appname: state.appName,
      constraints: [],
      from: 0,
      n: 10000,
      search_path: '{"constructor_name":"DataSource","args":[{"type":"json","value":"%p3.cnEQb0.%el.cnEQh0.%p.%ds"},{"type":"node","value":{"constructor_name":"Element","args":[{"type":"json","value":"%p3.cnEQb0.%el.cnEQh0"}]}},{"type":"raw","value":"Search"}]}',
      situation: 'initial search',
      sorts_list: [],
      type: getTableType(tableId),
    };

    // Call fetch-table endpoint (encrypt + worker API)
    const response = await fetch('/api/fetch-table', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        x: state.xValue,
        y: state.yValue,
        payload: payload,
        appName: state.appName,
        appUrl: state.bubbleUrl,
      }),
    });

    const data = await response.json();

    if (data.error) {
      throw new Error(data.error);
    }

    // Check for API error responses
    if (data.status && data.status >= 400) {
      throw new Error(data.body?.message || 'API request failed');
    }

    // Parse results
    state.results = parseResults(data);

    // Check if there are more records than returned (400+ case)
    const hasMore = data.body && data.body.at_end === false && state.results.length >= 400;
    document.getElementById('recordCount').textContent = hasMore ? '400+' : state.results.length;

    // Render results table
    renderResultsTable();
    document.getElementById('loadingResults').classList.add('hidden');

    // Analyze column sensitivity in background
    analyzeColumnSensitivity();
  } catch (error) {
    document.getElementById('loadingResults').classList.add('hidden');
    showError('step3Error', `Failed to fetch data: ${error.message}`);
  }
}

// Parse results from API response
function parseResults(data) {
  // Handle various response formats
  if (Array.isArray(data)) {
    return data;
  }

  // Handle elasticsearch response format from worker API
  // Structure: { body: { hits: { hits: [...] } } }
  if (data.body && data.body.hits && Array.isArray(data.body.hits.hits)) {
    return data.body.hits.hits.map(hit => {
      // Combine _source data with metadata
      const result = { ...hit._source };
      result._id = hit._id;
      result._type = hit._type;
      result._version = hit._version;
      return result;
    });
  }

  // Direct elasticsearch hits format
  if (data.hits && Array.isArray(data.hits.hits)) {
    return data.hits.hits.map(hit => {
      const result = { ...hit._source };
      result._id = hit._id;
      result._type = hit._type;
      result._version = hit._version;
      return result;
    });
  }

  if (data.response && Array.isArray(data.response.results)) {
    return data.response.results;
  }

  if (data.results && Array.isArray(data.results)) {
    return data.results;
  }

  if (data.cursor !== undefined && Array.isArray(data.results)) {
    return data.results;
  }

  // Try to find an array in the response
  for (const key of Object.keys(data)) {
    if (Array.isArray(data[key])) {
      return data[key];
    }
  }

  return [];
}

// Render the results table
function renderResultsTable() {
  const thead = document.getElementById('resultsHead');
  const tbody = document.getElementById('resultsBody');

  if (state.results.length === 0) {
    thead.innerHTML = '';
    tbody.innerHTML = '<tr><td colspan="100" class="empty-state">No data found in this table</td></tr>';
    return;
  }

  // Get all unique columns from all results (excluding hidden fields)
  const systemFields = ['_version', '_type'];
  const columns = new Set();
  state.results.forEach((row) => {
    Object.keys(row).forEach((key) => {
      if (!systemFields.includes(key)) {
        columns.add(key);
      }
    });
  });

  // Initialize column order if not set
  const allColumns = Array.from(columns);
  if (state.columnOrder.length === 0) {
    state.columnOrder = [...allColumns];
  } else {
    // Add any new columns that aren't in the order yet
    allColumns.forEach(col => {
      if (!state.columnOrder.includes(col)) {
        state.columnOrder.push(col);
      }
    });
  }

  // Filter out hidden columns and maintain order
  let columnList = state.columnOrder.filter(col =>
    allColumns.includes(col) && !state.hiddenColumns.includes(col)
  );

  // Filter to show only sensitive columns if toggle is on
  if (state.showSensitiveOnly) {
    // If still loading column sensitivity, show loading message
    if (state.columnSensitivityLoading) {
      thead.innerHTML = '';
      tbody.innerHTML = `
        <tr>
          <td colspan="100" class="empty-state">
            <div class="loading-inline">
              <div class="spinner-small"></div>
              <span>Analyzing column sensitivity...</span>
            </div>
          </td>
        </tr>`;
      return;
    }

    columnList = columnList.filter(col => {
      const sensitivity = getFieldSensitivity(col);
      return sensitivity === 'high' || sensitivity === 'moderate';
    });

    // If no sensitive columns found after analysis, show message
    if (columnList.length === 0) {
      thead.innerHTML = '';
      tbody.innerHTML = '<tr><td colspan="100" class="empty-state">No sensitive columns detected in this table</td></tr>';
      return;
    }
  }

  // Render hidden columns indicator
  const hiddenCount = state.hiddenColumns.length;
  const hiddenIndicator = hiddenCount > 0
    ? `<div class="hidden-columns-bar">
        <span>${hiddenCount} column${hiddenCount > 1 ? 's' : ''} hidden</span>
        <button onclick="showAllColumns()">Show all</button>
       </div>`
    : '';

  // Update or create hidden columns bar
  let hiddenBar = document.getElementById('hiddenColumnsBar');
  if (!hiddenBar) {
    hiddenBar = document.createElement('div');
    hiddenBar.id = 'hiddenColumnsBar';
    document.getElementById('tableWrapper').insertBefore(hiddenBar, document.getElementById('resultsTable'));
  }
  hiddenBar.innerHTML = hiddenIndicator;

  // Render header
  thead.innerHTML = `
    <tr>
      ${columnList
        .map(
          (col) => {
            const fieldSensitivity = getFieldSensitivity(col);
            const isManualOverride = hasManualOverride(col);
            // If there's a sensitivity indicator, make it clickable; otherwise show the flag button
            const sensitivityIndicator = fieldSensitivity ?
              `<span class="col-sensitivity-indicator sensitivity-${fieldSensitivity}${isManualOverride ? ' manual-override' : ''}" onclick="toggleSensitivityMenu(event, '${escapeJsString(col)}')" title="Click to change: ${fieldSensitivity === 'high' ? 'Highly' : 'Moderately'} Sensitive${isManualOverride ? ' (Manual)' : ''}">!</span>` : '';
            const flagButton = !fieldSensitivity ?
              `<button class="flag-sensitivity-btn" onclick="toggleSensitivityMenu(event, '${escapeJsString(col)}')" title="Flag sensitivity">&#9873;</button>` : '';
            return `
        <th draggable="true" data-column="${escapeHtml(col)}" class="${state.sortColumn === col ? 'sorted' : ''}">
          <div class="th-content">
            <span class="th-label" onclick="sortByColumn('${escapeJsString(col)}')">${escapeHtml(col)}<span class="sort-indicator">${getSortIndicator(col)}</span></span>
            ${sensitivityIndicator}
            ${flagButton}
            <button class="hide-column-btn" onclick="hideColumn('${escapeJsString(col)}')" title="Hide column">&times;</button>
          </div>
          <div class="resize-handle"></div>
        </th>
      `;
          }
        )
        .join('')}
    </tr>
  `;

  // Add drag and drop handlers
  setupColumnDragDrop();

  // Add resize handlers
  setupColumnResize();

  // Sort results if needed
  let sortedResults = [...state.results];
  if (state.sortColumn) {
    sortedResults.sort((a, b) => {
      const aVal = a[state.sortColumn] ?? '';
      const bVal = b[state.sortColumn] ?? '';

      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return state.sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
      }

      const aStr = String(aVal).toLowerCase();
      const bStr = String(bVal).toLowerCase();
      const comparison = aStr.localeCompare(bStr);
      return state.sortDirection === 'asc' ? comparison : -comparison;
    });
  }

  // Render body
  tbody.innerHTML = sortedResults
    .map(
      (row, index) => `
      <tr data-id="${escapeHtml(row._id || '')}">
        ${columnList.map((col) => `<td title="${escapeHtml(formatValue(row[col]))}">${formatValueWithLinks(row[col])}</td>`).join('')}
      </tr>
    `
    )
    .join('');

  // Add click handlers to rows
  tbody.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('click', () => {
      openModalById(tr.dataset.id);
    });
  });
}

// Hide a column
function hideColumn(column) {
  if (!state.hiddenColumns.includes(column)) {
    state.hiddenColumns.push(column);
    renderResultsTable();
  }
}

// Show all hidden columns
function showAllColumns() {
  state.hiddenColumns = [];
  renderResultsTable();
}

// Setup column drag and drop
function setupColumnDragDrop() {
  const headers = document.querySelectorAll('#resultsHead th[draggable="true"]');
  let draggedColumn = null;

  headers.forEach(th => {
    th.addEventListener('dragstart', (e) => {
      draggedColumn = th.dataset.column;
      th.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    th.addEventListener('dragend', () => {
      th.classList.remove('dragging');
      headers.forEach(h => h.classList.remove('drag-over'));
    });

    th.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });

    th.addEventListener('dragenter', (e) => {
      e.preventDefault();
      if (th.dataset.column !== draggedColumn) {
        th.classList.add('drag-over');
      }
    });

    th.addEventListener('dragleave', () => {
      th.classList.remove('drag-over');
    });

    th.addEventListener('drop', (e) => {
      e.preventDefault();
      const targetColumn = th.dataset.column;
      if (draggedColumn && targetColumn && draggedColumn !== targetColumn) {
        // Reorder columns
        const draggedIndex = state.columnOrder.indexOf(draggedColumn);
        const targetIndex = state.columnOrder.indexOf(targetColumn);
        if (draggedIndex > -1 && targetIndex > -1) {
          state.columnOrder.splice(draggedIndex, 1);
          state.columnOrder.splice(targetIndex, 0, draggedColumn);
          renderResultsTable();
        }
      }
      th.classList.remove('drag-over');
    });
  });
}

// Setup column resizing
function setupColumnResize() {
  const table = document.getElementById('resultsTable');
  const headers = table.querySelectorAll('th');

  headers.forEach(th => {
    const handle = th.querySelector('.resize-handle');
    if (!handle) return;

    let startX, startWidth;

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      startX = e.pageX;
      startWidth = th.offsetWidth;
      th.setAttribute('draggable', 'false');

      const onMouseMove = (e) => {
        const diff = e.pageX - startX;
        const newWidth = Math.max(50, startWidth + diff);
        th.style.width = newWidth + 'px';
        th.style.minWidth = newWidth + 'px';
      };

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        th.setAttribute('draggable', 'true');
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  });
}

// Reset column settings when selecting a new table
function resetColumnSettings() {
  state.hiddenColumns = [];
  state.columnOrder = [];
}

// Sort by column
function sortByColumn(column) {
  if (state.sortColumn === column) {
    state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
  } else {
    state.sortColumn = column;
    state.sortDirection = 'asc';
  }
  renderResultsTable();
}

// Get sort indicator
function getSortIndicator(column) {
  if (state.sortColumn !== column) return '';
  return state.sortDirection === 'asc' ? '↑' : '↓';
}

// Analyze actual column names for sensitivity (uses cached data if available)
async function analyzeColumnSensitivity() {
  console.log('analyzeColumnSensitivity called, results:', state.results.length);
  if (state.results.length === 0) return;

  // Check if we already have cached column sensitivity from initial analysis
  if (state.allColumnSensitivity[state.selectedTable]) {
    console.log('Using cached column sensitivity for:', state.selectedTable);
    state.columnSensitivity = state.allColumnSensitivity[state.selectedTable];
    state.columnSensitivityLoading = false;
    renderResultsTable();
    return;
  }

  // No cached data - need to analyze (this shouldn't happen often now)
  console.log('No cached data, analyzing columns for:', state.selectedTable);

  // Show loading state
  state.columnSensitivityLoading = true;
  if (state.showSensitiveOnly) {
    renderResultsTable(); // Re-render to show loading message
  }

  // Get all unique column names from results
  const systemFields = ['_version', '_type', '_id'];
  const columns = new Set();
  state.results.forEach(row => {
    Object.keys(row).forEach(key => {
      if (!systemFields.includes(key)) {
        columns.add(key);
      }
    });
  });

  const columnList = Array.from(columns);
  if (columnList.length === 0) return;

  // Collect sample values for each column (up to 3 non-empty values)
  const columnsWithSamples = columnList.map(colName => {
    const samples = [];
    for (const row of state.results) {
      if (samples.length >= 3) break;
      const value = row[colName];
      if (value !== null && value !== undefined && value !== '') {
        // Convert to string and truncate long values
        let strValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
        if (strValue.length > 100) {
          strValue = strValue.substring(0, 100) + '...';
        }
        // Avoid duplicate samples
        if (!samples.includes(strValue)) {
          samples.push(strValue);
        }
      }
    }
    return { name: colName, samples };
  });

  console.log('Sending columns for analysis:', columnsWithSamples.length, columnsWithSamples);

  try {
    const response = await fetch('/api/analyze-columns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tableName: state.selectedTable,
        columnsWithSamples: columnsWithSamples
      })
    });

    const data = await response.json();

    if (data.error) {
      console.error('Column analysis failed:', data.error);
      state.columnSensitivityLoading = false;
      if (state.showSensitiveOnly) {
        renderResultsTable();
      }
      return;
    }

    // Store column sensitivity with exact column names
    state.columnSensitivity = {};
    if (data.fields && Array.isArray(data.fields)) {
      data.fields.forEach(field => {
        state.columnSensitivity[field.name] = field.sensitivity;
      });
    }

    // Also cache for future use
    state.allColumnSensitivity[state.selectedTable] = { ...state.columnSensitivity };

    // Hide loading state and re-render table to show indicators
    state.columnSensitivityLoading = false;
    renderResultsTable();
  } catch (error) {
    console.error('Column analysis error:', error);
    state.columnSensitivityLoading = false;
    if (state.showSensitiveOnly) {
      renderResultsTable(); // Re-render to remove loading state
    }
  }
}

// Get field sensitivity for current table (exact match on actual column names)
// Manual overrides take priority over AI-detected sensitivity
function getFieldSensitivity(fieldName) {
  // Check manual override first
  const tableOverrides = state.manualColumnOverrides[state.selectedTable];
  if (tableOverrides && tableOverrides[fieldName] !== undefined) {
    const override = tableOverrides[fieldName];
    // If manually set to 'low', return null (not sensitive)
    if (override === 'low') {
      return null;
    }
    if (override === 'high' || override === 'moderate') {
      return override;
    }
  }

  // Fall back to AI-detected sensitivity
  const sensitivity = state.columnSensitivity[fieldName];
  if (sensitivity === 'high' || sensitivity === 'moderate') {
    return sensitivity;
  }
  return null;
}

// Check if a column has a manual override
function hasManualOverride(fieldName) {
  const tableOverrides = state.manualColumnOverrides[state.selectedTable];
  return tableOverrides && tableOverrides[fieldName] !== undefined;
}

// Set manual sensitivity override for a column
function setManualSensitivity(fieldName, sensitivity) {
  if (!state.manualColumnOverrides[state.selectedTable]) {
    state.manualColumnOverrides[state.selectedTable] = {};
  }

  // Store the override (including 'low' to override AI classification)
  state.manualColumnOverrides[state.selectedTable][fieldName] = sensitivity;

  // Recalculate table-level sensitivity
  updateTableSensitivity(state.selectedTable);

  renderResultsTable();
  renderTableList();
}

// Recalculate table-level sensitivity based on AI + manual overrides
function updateTableSensitivity(tableId) {
  const aiSensitivity = state.allColumnSensitivity[tableId] || {};
  const manualOverrides = state.manualColumnOverrides[tableId] || {};

  // Get all columns from current results
  const columns = new Set();
  state.results.forEach(row => {
    Object.keys(row).forEach(key => {
      if (!['_version', '_type'].includes(key)) {
        columns.add(key);
      }
    });
  });

  let highestSensitivity = 'low';
  const sensitiveFields = [];

  columns.forEach(col => {
    // Manual override takes priority
    const sensitivity = manualOverrides[col] || aiSensitivity[col];

    if (sensitivity === 'high') {
      highestSensitivity = 'high';
      sensitiveFields.push(col);
    } else if (sensitivity === 'moderate') {
      if (highestSensitivity !== 'high') {
        highestSensitivity = 'moderate';
      }
      sensitiveFields.push(col);
    }
  });

  // Update table sensitivity
  if (highestSensitivity !== 'low') {
    state.tableSensitivity[tableId] = {
      sensitivity: highestSensitivity,
      reason: `Contains ${highestSensitivity === 'high' ? 'highly' : 'moderately'} sensitive fields: ${sensitiveFields.join(', ')}`
    };
  } else {
    // Remove table sensitivity if no sensitive columns
    delete state.tableSensitivity[tableId];
  }
}

// Toggle sensitivity menu for a column
function toggleSensitivityMenu(event, fieldName) {
  event.stopPropagation();

  // Close any existing menu
  const existingMenu = document.querySelector('.sensitivity-menu');
  if (existingMenu) {
    existingMenu.remove();
  }

  const button = event.currentTarget;
  const rect = button.getBoundingClientRect();

  // Create menu
  const menu = document.createElement('div');
  menu.className = 'sensitivity-menu';
  menu.innerHTML = `
    <div class="sensitivity-menu-item sensitivity-menu-high" onclick="setManualSensitivity('${escapeJsString(fieldName)}', 'high')">
      <span class="menu-indicator sensitivity-high">!</span>
      Flag as Highly Sensitive
    </div>
    <div class="sensitivity-menu-item sensitivity-menu-moderate" onclick="setManualSensitivity('${escapeJsString(fieldName)}', 'moderate')">
      <span class="menu-indicator sensitivity-moderate">!</span>
      Flag as Moderately Sensitive
    </div>
    <div class="sensitivity-menu-item sensitivity-menu-clear" onclick="setManualSensitivity('${escapeJsString(fieldName)}', 'low')">
      <span class="menu-indicator">&#x2715;</span>
      Mark as Not Sensitive
    </div>
  `;

  // Position menu below button
  menu.style.position = 'fixed';
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.left = rect.left + 'px';

  document.body.appendChild(menu);

  // Close menu when clicking outside
  const closeMenu = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener('click', closeMenu);
    }
  };

  // Delay adding listener to prevent immediate close
  setTimeout(() => {
    document.addEventListener('click', closeMenu);
  }, 0);
}

// Format cell value for display
function formatValue(value) {
  if (value === null || value === undefined) {
    return '';
  }

  // Check if it's a date value
  if (isDateValue(value)) {
    return formatDate(value);
  }

  if (typeof value === 'object') {
    return JSON.stringify(value);
  }

  return String(value);
}

// Check if a value looks like a date
function isDateValue(value) {
  if (typeof value === 'number') {
    // Unix timestamp in milliseconds (between year 2000 and 2100)
    return value > 946684800000 && value < 4102444800000;
  }
  if (typeof value === 'string') {
    // ISO date string pattern (e.g., "2024-01-15T10:30:00.000Z")
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value);
  }
  return false;
}

// Format date to readable string
function formatDate(value) {
  try {
    const date = new Date(value);
    if (isNaN(date.getTime())) {
      return String(value);
    }
    return date.toLocaleString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch (e) {
    return String(value);
  }
}

// Escape HTML to prevent XSS
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Escape string for use in JavaScript string literals within HTML attributes
function escapeJsString(str) {
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/</g, '\\x3c')
    .replace(/>/g, '\\x3e');
}

// Clean column name by removing type suffixes and applying replacements
function cleanColumnName(name) {
  // Remove common Bubble type suffixes
  const suffixes = [
    '_text', '_number', '_date', '_boolean', '_file', '_image',
    '_geographic address', '_list', '_option', '_user', '_custom'
  ];

  let cleaned = name;
  for (const suffix of suffixes) {
    if (cleaned.toLowerCase().endsWith(suffix)) {
      cleaned = cleaned.slice(0, -suffix.length);
      break;
    }
  }

  // Replace specific column names
  if (cleaned.toLowerCase() === 'authentication') {
    cleaned = 'email';
  }

  return cleaned;
}

// Format value with clickable links
function formatValueWithLinks(value) {
  // First convert to string
  const strValue = formatValue(value);
  const escaped = escapeHtml(strValue);

  // Regex to find URLs: http://, https://, www., or protocol-relative (//domain.com)
  const urlPattern = /(https?:\/\/[^\s<]+|www\.[^\s<]+|\/\/[a-zA-Z0-9][^\s<]+)/gi;

  // Check if string contains any URLs
  if (!urlPattern.test(strValue)) {
    return escaped;
  }

  // Reset regex lastIndex after test
  urlPattern.lastIndex = 0;

  // Replace URLs with clickable links
  return escaped.replace(urlPattern, (match) => {
    let url = match;
    // Handle protocol-relative URLs (//domain.com/...)
    if (url.startsWith('//')) {
      url = 'https:' + url;
    }
    // Handle www. URLs
    else if (url.startsWith('www.')) {
      url = 'https://' + url;
    }
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${match}</a>`;
  });
}

// Show loading overlay
function showLoading(text) {
  document.getElementById('loadingText').textContent = text;
  document.getElementById('loadingOverlay').classList.remove('hidden');
}

// Update loading text
function updateLoadingText(text) {
  document.getElementById('loadingText').textContent = text;
}

// Hide loading overlay
function hideLoading() {
  document.getElementById('loadingOverlay').classList.add('hidden');
}

// Show error message
function showError(elementId, message) {
  const element = document.getElementById(elementId);
  element.textContent = message;
  element.classList.remove('hidden');
}

// Hide error message
function hideError(elementId) {
  document.getElementById(elementId).classList.add('hidden');
}

// Open modal with record details by ID
function openModalById(recordId) {
  const record = state.results.find(r => r._id === recordId);

  const modalBody = document.getElementById('modalBody');
  const fields = Object.keys(record || {});

  modalBody.innerHTML = fields.map(field => {
    const value = record[field];
    const displayValue = formatModalValue(value);
    const isEmpty = value === null || value === undefined || value === '';

    return `
      <div class="record-field">
        <div class="record-field-name">${escapeHtml(field)}</div>
        <div class="record-field-value${isEmpty ? ' empty' : ''}">${isEmpty ? '(empty)' : formatValueWithLinks(value)}</div>
      </div>
    `;
  }).join('');

  document.getElementById('recordModal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

// Format value for modal display
function formatModalValue(value) {
  if (value === null || value === undefined) {
    return '';
  }

  // Check if it's a date value
  if (isDateValue(value)) {
    return formatDate(value);
  }

  if (typeof value === 'object') {
    return JSON.stringify(value, null, 2);
  }

  return String(value);
}

// Close modal
function closeModal() {
  document.getElementById('recordModal').classList.add('hidden');
  document.body.style.overflow = '';
}

// Close modal on Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeModal();
  }
});

// Toggle text summary visibility
function toggleTextSummary() {
  const content = document.getElementById('textSummaryContent');
  const icon = document.querySelector('.text-summary-toggle-icon');

  if (content.classList.contains('hidden')) {
    content.classList.remove('hidden');
    icon.textContent = '▼';
  } else {
    content.classList.add('hidden');
    icon.textContent = '▶';
  }
}

// Generate AI-prioritized outreach summary (only highly sensitive data)
async function generateOutreachSummary() {
  const section = document.getElementById('textSummarySection');
  const output = document.getElementById('textSummaryOutput');

  // Only show if sensitivity analysis is complete and we have data
  if (state.sensitivityLoading || Object.keys(state.allColumnSensitivity).length === 0) {
    section.classList.add('hidden');
    return;
  }

  // Get tables that have high sensitivity columns
  const sensitiveData = [];

  state.tables.forEach(table => {
    const hasData = table.recordCount && table.recordCount !== 0 && table.recordCount !== '0' && !table.metadataOnly;
    const columnSensitivity = state.allColumnSensitivity[table.id];

    if (!hasData || !columnSensitivity) return;

    // Only include highly sensitive columns
    const highColumns = Object.keys(columnSensitivity).filter(col => {
      return columnSensitivity[col] === 'high';
    });

    if (highColumns.length > 0) {
      sensitiveData.push({
        name: table.display,
        columns: highColumns
      });
    }
  });

  if (sensitiveData.length === 0) {
    section.classList.add('hidden');
    return;
  }

  // Show section with loading state
  section.classList.remove('hidden');
  output.innerHTML = '<div class="summary-loading">Analyzing and prioritizing critical exposures...</div>';

  try {
    // Call AI to prioritize
    const response = await fetch('/api/generate-summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appName: state.appName,
        sensitiveData: sensitiveData
      })
    });

    const data = await response.json();

    if (data.error || !data.tables) {
      console.error('Summary generation failed:', data.error);
      output.innerHTML = '<div class="summary-error">Failed to generate summary. Please try again.</div>';
      return;
    }

    // Store original risk and update badge
    state.summaryOriginalRisk = data.risk || 'none';
    updateSummaryRiskBadge();

    // Build table list for output
    let html = '';
    if (data.tables && data.tables.length > 0) {
      html = '<div class="summary-list">';
      data.tables.forEach(table => {
        const columns = table.columns.map(col => escapeHtml(cleanColumnName(col))).join(', ');
        html += `<p><strong>${escapeHtml(table.name)}</strong> — ${columns}</p>`;
      });
      html += '</div>';
    }

    // Update output with HTML
    output.innerHTML = html;

  } catch (error) {
    console.error('Summary generation error:', error);
    output.innerHTML = '<div class="summary-error">Failed to generate summary. Please try again.</div>';
  }
}

// Update summary risk badge display
function updateSummaryRiskBadge() {
  const riskBadge = document.getElementById('summaryRiskBadge');
  if (!riskBadge) return;

  const riskClass = state.summaryRiskOverride || state.summaryOriginalRisk || 'none';
  const riskLabels = { high: 'High Risk', medium: 'Medium Risk', low: 'Low Risk', none: 'No Risk' };
  const isOverridden = state.summaryRiskOverride && state.summaryRiskOverride !== state.summaryOriginalRisk;

  riskBadge.className = `header-risk-badge risk-${riskClass} clickable${isOverridden ? ' overridden' : ''}`;
  riskBadge.textContent = riskLabels[riskClass];
}

// Cycle through risk levels when clicking the badge
function cycleSummaryRisk() {
  const riskLevels = ['low', 'medium', 'high'];
  const currentRisk = state.summaryRiskOverride || state.summaryOriginalRisk || 'low';
  const currentIndex = riskLevels.indexOf(currentRisk);
  const nextIndex = (currentIndex + 1) % riskLevels.length;

  state.summaryRiskOverride = riskLevels[nextIndex];
  updateSummaryRiskBadge();
}

// Switch between tabs (tables/endpoints/keys)
function switchTab(tabName) {
  state.activeTab = tabName;

  // Update tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });

  // Update panels
  document.getElementById('tablesPanel').classList.toggle('hidden', tabName !== 'tables');
  document.getElementById('endpointsPanel').classList.toggle('hidden', tabName !== 'endpoints');
  document.getElementById('keysPanel').classList.toggle('hidden', tabName !== 'keys');
  document.getElementById('pagesPanel').classList.toggle('hidden', tabName !== 'pages');

  // Render appropriate filter toggle
  renderTabFilter();

  // If switching to endpoints, show current state
  if (tabName === 'endpoints') {
    if (state.endpointAnalysis) {
      // Already have results, render them
      renderEndpointsList();
    } else if (state.endpointAnalysisLoading) {
      // Analysis in progress, show loading
      document.getElementById('endpointsLoading').classList.remove('hidden');
    } else if (state.sensitivityLoading) {
      // Waiting for data analysis to complete first
      document.getElementById('endpointsLoading').classList.remove('hidden');
      document.querySelector('#endpointsLoading span').textContent = 'Waiting for data analysis to complete...';
    }
  }

  // If switching to keys, show current state or trigger scan
  if (tabName === 'keys') {
    if (state.apiKeysAnalysis) {
      renderApiKeysList();
    } else if (state.apiKeysLoading) {
      document.getElementById('keysLoading').classList.remove('hidden');
    } else if (state.bubbleUrl && !state.apiKeysLoading) {
      // Trigger scan if we have a URL but haven't scanned yet
      scanApiKeys();
    }
  }

  // If switching to pages, show current state or trigger scan
  if (tabName === 'pages') {
    if (state.apiKeysLoading) {
      document.getElementById('pagesLoading').classList.remove('hidden');
      document.getElementById('pagesEmpty').classList.add('hidden');
    } else if (state.apiKeysAnalysis && state.apiKeysAnalysis.pageAccess && state.apiKeysAnalysis.pageAccess.length > 0) {
      renderPagesList();
    } else if (state.bubbleUrl && !state.apiKeysLoading && !state.apiKeysAnalysis) {
      // Trigger scan if we have a URL but haven't scanned yet (pages come from same scan)
      scanApiKeys();
    } else {
      // No pages found after scan completed
      document.getElementById('pagesEmpty').classList.remove('hidden');
    }
  }
}

// Render the filter toggle based on active tab
function renderTabFilter() {
  const container = document.getElementById('tabFilterContainer');
  if (!container) return;

  if (state.activeTab === 'tables') {
    // Data tables filter
    const sensitiveCount = Object.values(state.tableSensitivity).filter(s =>
      s.sensitivity === 'high' || s.sensitivity === 'moderate'
    ).length;
    container.innerHTML = `
      <label class="filter-toggle">
        <input type="checkbox" id="sensitivityFilter" ${state.showSensitiveOnly ? 'checked' : ''} onchange="toggleSensitivityFilter()">
        <span class="toggle-slider"></span>
        <span class="toggle-label">Show sensitive only (${sensitiveCount})</span>
      </label>
    `;
  } else if (state.activeTab === 'endpoints') {
    // Endpoints filter
    const callableCount = state.endpointAnalysis?.workflows?.filter(w => w.isCallable).length || 0;
    container.innerHTML = `
      <label class="filter-toggle">
        <input type="checkbox" id="callableFilter" ${state.showCallableOnly ? 'checked' : ''} onchange="toggleCallableFilter()">
        <span class="toggle-slider"></span>
        <span class="toggle-label">Show sensitive only (${callableCount})</span>
      </label>
    `;
  } else if (state.activeTab === 'keys') {
    // API Keys tab - no filter display needed
    container.innerHTML = '';
  } else if (state.activeTab === 'pages') {
    // Pages tab - no filter display needed
    container.innerHTML = '';
  }
}

// Deterministic endpoint security analysis
async function analyzeEndpoints() {
  if (!state.bubbleUrl) return;

  state.endpointAnalysisLoading = true;
  document.getElementById('endpointsLoading').classList.remove('hidden');
  document.getElementById('endpointsEmpty').classList.add('hidden');
  document.getElementById('endpointsList').innerHTML = '';

  try {
    // Step 1: Fetch workflow definitions
    const response = await fetch('/api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: state.bubbleUrl })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error);

    const { workflows } = data;
    if (!workflows || workflows.length === 0) {
      state.endpointAnalysis = { workflows: [] };
      state.endpointAnalysisLoading = false;
      document.getElementById('endpointsLoading').classList.add('hidden');
      renderEndpointsList();
      return;
    }

    // Build set of exposed table names (lowercase for matching)
    const exposedTables = new Set();
    const tablesWithData = state.tables.filter(t =>
      t.recordCount && t.recordCount !== 0 && t.recordCount !== '0' && !t.metadataOnly
    );
    tablesWithData.forEach(t => exposedTables.add(t.id.toLowerCase().replace(/\s+/g, '')));

    // Filter out webhooks and analyze parameters
    const filteredWorkflows = workflows
      .filter(w => !w.isWebhook)
      .map(workflow => {
        const parameters = workflow.parameters.map(param => {
          const analysis = {
            name: param.name,
            type: param.type,
            required: param.required,
            status: 'attacker', // default: attacker provides the value
            exposedTable: null
          };

          // Check if this contains a custom type (references a database table)
          // Handles: custom.asset, list.custom.asset, etc.
          const customMatch = param.type.match(/custom\.([^.\s]+)/i);
          if (customMatch) {
            const customTypeName = customMatch[1].toLowerCase().replace(/\s+/g, '');
            if (exposedTables.has(customTypeName)) {
              analysis.status = 'exposed';
              analysis.exposedTable = customMatch[1]; // Keep original casing for display
            } else {
              analysis.status = 'protected';
            }
          } else if (param.type === 'user' || param.type.includes('user')) {
            if (exposedTables.has('user')) {
              analysis.status = 'exposed';
              analysis.exposedTable = 'User';
            } else {
              analysis.status = 'protected';
            }
          }

          return analysis;
        });

        // Check if endpoint is callable (all required params are exposed or attacker-provided)
        const requiredParams = parameters.filter(p => p.required);
        const isCallable = requiredParams.every(p => p.status === 'exposed' || p.status === 'attacker');

        return {
          ...workflow,
          parameters,
          isCallable
        };
      })
      .sort((a, b) => {
        // Callable first, then no auth, then alphabetically
        if (a.isCallable && !b.isCallable) return -1;
        if (!a.isCallable && b.isCallable) return 1;
        if (!a.authRequired && b.authRequired) return -1;
        if (a.authRequired && !b.authRequired) return 1;
        return a.name.localeCompare(b.name);
      });

    state.endpointAnalysis = { workflows: filteredWorkflows };

    document.getElementById('endpointsLoading').classList.add('hidden');
    renderEndpointsList();
    renderTabFilter();

    state.endpointAnalysisLoading = false;
    console.log('Endpoint analysis complete:', filteredWorkflows.length, 'workflows');

  } catch (error) {
    console.error('Endpoint analysis failed:', error);
    state.endpointAnalysisLoading = false;
    document.getElementById('endpointsLoading').classList.add('hidden');
    document.getElementById('endpointsEmpty').innerHTML = `<p>Failed to analyze endpoints: ${error.message}</p>`;
    document.getElementById('endpointsEmpty').classList.remove('hidden');
  }
}

// Helper to render a parameter row
function renderParamRow(param) {
  let statusLabel;
  if (param.status === 'exposed' && param.exposedTable) {
    statusLabel = `Data exposed in ${param.exposedTable} table`;
  } else if (param.status === 'protected') {
    statusLabel = 'NOT EXPOSED';
  } else {
    statusLabel = 'EXPLOITABLE';
  }

  return `
    <div class="param-row">
      <span class="param-name">${param.name}</span>
      <span class="param-type">${param.type}</span>
      <span class="param-status ${param.status}">${statusLabel}</span>
    </div>
  `;
}

// Helper to render a section of parameters
function renderParamsSection(params, label) {
  if (!params || params.length === 0) return '';
  return `
    <div class="params-section">
      <div class="params-label">${label}</div>
      ${params.map(renderParamRow).join('')}
    </div>
  `;
}

// Render the endpoints list with toggle filter
function renderEndpointsList() {
  const container = document.getElementById('endpointsList');
  const emptyEl = document.getElementById('endpointsEmpty');

  if (!state.endpointAnalysis) {
    container.innerHTML = '';
    return;
  }

  const { workflows } = state.endpointAnalysis;

  // If no workflows found
  if (!workflows || workflows.length === 0) {
    emptyEl.innerHTML = `<p>No workflow APIs found for this application.</p>`;
    emptyEl.classList.remove('hidden');
    return;
  }

  emptyEl.classList.add('hidden');

  // Apply filter
  let filteredWorkflows = workflows;
  if (state.showCallableOnly) {
    filteredWorkflows = workflows.filter(w => w.isCallable);
  }

  let html = '';

  if (filteredWorkflows.length === 0) {
    html += `<div class="endpoints-empty"><p>No sensitive endpoints found.</p></div>`;
  } else {
    html += `<div class="endpoints-list">`;
    filteredWorkflows.forEach(workflow => {
      const workflowId = workflow.name.replace(/[^a-zA-Z0-9]/g, '_');
      const authLevel = workflow.authLevel || (workflow.authRequired ? 'user' : 'none');
      const hasParams = workflow.parameters.length > 0;

      // Get auth description based on level
      const getAuthDescription = (level, isCallable) => {
        if (level === 'none') {
          return isCallable
            ? `<span class="auth-description warning-critical">Anyone on the internet can run this.</span> <span class="auth-description">No authorisation required, and all parameters exposed.</span>`
            : `<span class="auth-description warning-critical">Anyone on the internet can run this.</span> <span class="auth-description">No authorisation required.</span>`;
        } else if (level === 'admin') {
          return isCallable
            ? `<span class="auth-description warning-admin">Admin access required.</span> <span class="auth-description">All parameters exposed.</span>`
            : `<span class="auth-description warning-admin">Admin access required.</span>`;
        } else {
          return isCallable
            ? `<span class="auth-description warning-caution">Any logged-in user can run this.</span> <span class="auth-description">Authorisation required, but all parameters exposed.</span>`
            : `<span class="auth-description warning-caution">Any logged-in user can run this.</span> <span class="auth-description">Authorisation required.</span>`;
        }
      };

      // Determine CSS class and indicator style based on auth level
      const authClass = authLevel === 'none' ? 'no-auth-endpoint' : (authLevel === 'admin' ? 'admin-auth-endpoint' : '');
      const indicatorClass = authLevel === 'none' ? 'critical' : (authLevel === 'admin' ? 'admin' : 'warning');

      // Admin endpoints get a tick, others get exclamation mark
      const getIndicator = () => {
        if (authLevel === 'admin') {
          return `<span class="secure-indicator" title="Admin access required">✓</span>`;
        }
        return workflow.isCallable ? `<span class="callable-indicator ${indicatorClass}" title="All required data is available">!</span>` : '';
      };

      html += `
        <div class="endpoint-item ${authClass} ${workflow.isCallable ? 'callable' : ''}" onclick="toggleEndpointDetails('${workflowId}')">
          <div class="endpoint-header">
            <div class="endpoint-main">
              ${getIndicator()}
              <span class="endpoint-path">/api/1.1/wf/${workflow.name}</span>
              ${hasParams ? `<span class="expand-icon">&#9660;</span>` : ''}
            </div>
            <div class="endpoint-auth">
              ${getAuthDescription(authLevel, workflow.isCallable)}
            </div>
          </div>
          ${hasParams ? `
            <div class="endpoint-details" id="endpoint-${workflowId}">
              ${renderParamsSection(workflow.parameters.filter(p => p.required), 'Required Parameters')}
              ${renderParamsSection(workflow.parameters.filter(p => !p.required), 'Optional Parameters')}
            </div>
          ` : ''}
        </div>
      `;
    });
    html += `</div>`;
  }

  container.innerHTML = html;
}

// Toggle callable filter
function toggleCallableFilter() {
  state.showCallableOnly = !state.showCallableOnly;
  renderEndpointsList();
}

// Toggle endpoint details visibility
function toggleEndpointDetails(endpointId) {
  const details = document.getElementById(`endpoint-${endpointId}`);
  if (!details) return;

  const item = details.closest('.endpoint-item');

  if (details.classList.contains('expanded')) {
    details.classList.remove('expanded');
    item.classList.remove('expanded');
  } else {
    details.classList.add('expanded');
    item.classList.add('expanded');
  }
}

// Scan for API keys in console output using Puppeteer
async function scanApiKeys() {
  if (!state.bubbleUrl) return;

  // Reset previous analysis state
  state.apiKeysAnalysis = null;
  state.apiExposureAnalysis = null;
  state.apiKeysLoading = true;
  document.getElementById('keysLoading').classList.remove('hidden');
  document.getElementById('keysEmpty').classList.add('hidden');
  document.getElementById('keysList').innerHTML = '';
  // Also reset pages panel
  document.getElementById('pagesLoading').classList.remove('hidden');
  document.getElementById('pagesEmpty').classList.add('hidden');
  document.getElementById('pagesList').innerHTML = '';

  try {
    const response = await fetch('/api/scan-api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: state.bubbleUrl })
    });

    const data = await response.json();

    if (data.error) {
      throw new Error(data.details || data.error);
    }

    state.apiKeysAnalysis = data;
    state.apiKeysLoading = false;

    document.getElementById('keysLoading').classList.add('hidden');
    document.getElementById('pagesLoading').classList.add('hidden');
    renderApiKeysList();
    renderPagesList();
    renderTabFilter();

    console.log(`[API Keys] Scan complete: ${data.totalMessages} console messages, ${data.detectedKeys?.length || 0} keys found`);
    console.log(`[Pages] Found ${data.pageAccess?.length || 0} pages`);
    console.log('[Pages] pageAccess data:', JSON.stringify(data.pageAccess?.slice(0, 2)));

    // Auto-run AI security analysis after collecting APIs
    if (state.apiKeysAnalysis && (state.apiKeysAnalysis.apiConnector2 || state.apiKeysAnalysis.apiKeys?.length > 0)) {
      analyzeApiExposure();
    }

  } catch (error) {
    console.error('API Keys scan failed:', error);
    state.apiKeysLoading = false;
    document.getElementById('keysLoading').classList.add('hidden');
    document.getElementById('keysEmpty').innerHTML = `<p>Failed to scan for API keys: ${error.message}</p>`;
    document.getElementById('keysEmpty').classList.remove('hidden');
    // Also handle pages panel error state
    document.getElementById('pagesLoading').classList.add('hidden');
    document.getElementById('pagesEmpty').innerHTML = `<p>Failed to scan pages: ${error.message}</p>`;
    document.getElementById('pagesEmpty').classList.remove('hidden');
  }
}

// Render the API keys list from extracted page data
function renderApiKeysList() {
  const container = document.getElementById('keysList');
  const emptyEl = document.getElementById('keysEmpty');

  if (!state.apiKeysAnalysis) {
    container.innerHTML = '';
    return;
  }

  const { apiKeys, apiConnector2, clientSafe } = state.apiKeysAnalysis;

  // If no data found
  if ((!apiKeys || apiKeys.length === 0) && !apiConnector2) {
    emptyEl.innerHTML = `<p>No API keys found in settings.client_safe</p>`;
    emptyEl.classList.remove('hidden');
    container.innerHTML = '';
    return;
  }

  emptyEl.classList.add('hidden');

  let html = '';

  // Show all API Calls in a compact expanded view
  if (apiConnector2) {
    const apiCalls = parseApiConnectorCalls(apiConnector2);
    if (apiCalls.length > 0) {
      // Helper to get risk level for a call
      const getCallRiskLevel = (call) => {
        const manualOrAiFinding = getSecurityFinding(call.parentName, call.name);
        const autoDetected = detectAutoSecurityIssues(call);
        const finding = manualOrAiFinding || autoDetected;
        return finding ? (finding.risk || 'medium').toLowerCase() : null;
      };

      // Count calls by risk level
      const riskCounts = { critical: 0, high: 0, medium: 0 };
      apiCalls.forEach(call => {
        const risk = getCallRiskLevel(call);
        if (risk && riskCounts.hasOwnProperty(risk)) {
          riskCounts[risk]++;
        }
      });

      const hasAnyRiskFilter = state.riskFilters.critical || state.riskFilters.high || state.riskFilters.medium;

      html += '<div class="api-calls-container compact-view">';
      html += `<div class="api-calls-header">`;
      html += `<h3 class="section-title">API Calls <span class="count-badge">${apiCalls.length}</span></h3>`;
      html += `<div class="api-header-right">`;
      html += `<div class="api-keys-search">
        <input type="text" id="apiKeysSearchInput" placeholder="Search APIs..." value="${escapeHtml(state.apiKeysSearch)}" oninput="handleApiKeysSearch(this.value)">
        ${state.apiKeysSearch ? '<button class="search-clear-btn" onclick="clearApiKeysSearch()">&times;</button>' : ''}
      </div>`;
      html += `<button class="export-csv-btn" onclick="exportApiCallsCsv()" title="Export to CSV">Export CSV</button>`;
      html += `<div class="filter-toggles risk-filters">`;

      // Add risk level filter toggles
      if (riskCounts.critical > 0) {
        html += `
          <label class="risk-filter-btn ${state.riskFilters.critical ? 'active' : ''} risk-critical" onclick="toggleRiskFilter('critical')">
            Critical (${riskCounts.critical})
          </label>
        `;
      }
      if (riskCounts.high > 0) {
        html += `
          <label class="risk-filter-btn ${state.riskFilters.high ? 'active' : ''} risk-high" onclick="toggleRiskFilter('high')">
            High (${riskCounts.high})
          </label>
        `;
      }
      if (riskCounts.medium > 0) {
        html += `
          <label class="risk-filter-btn ${state.riskFilters.medium ? 'active' : ''} risk-medium" onclick="toggleRiskFilter('medium')">
            Medium (${riskCounts.medium})
          </label>
        `;
      }

      html += '</div>'; // close filter-toggles
      html += '</div></div>'; // close api-header-right and api-calls-header

      // Filter by search query
      const searchQuery = state.apiKeysSearch.toLowerCase().trim();
      let filteredCalls = apiCalls;
      if (searchQuery) {
        filteredCalls = apiCalls.filter(call => apiCallMatchesSearch(call, searchQuery));
      }

      filteredCalls.forEach((call, index) => {
        const riskLevel = getCallRiskLevel(call);

        // Apply risk filters (if any filter is active, only show matching risks)
        if (hasAnyRiskFilter) {
          if (!riskLevel || !state.riskFilters[riskLevel]) {
            return;
          }
        }

        html += renderCompactApiCall(call, index);
      });

      // Show no results message if search filtered everything
      if (searchQuery && filteredCalls.length === 0) {
        html += `<div class="search-no-results">No API calls match "${escapeHtml(state.apiKeysSearch)}"</div>`;
      }

      html += '</div>';
    }
  }

  // Show AI analysis loading state
  if (state.apiExposureLoading) {
    html += `
      <div class="ai-analysis-section">
        <div class="analysis-loading">
          <span class="spinner-small"></span>
          <span>Running AI security analysis...</span>
        </div>
      </div>
    `;
  }

  container.innerHTML = html;
}

// Render the pages list showing public/private access
function renderPagesList() {
  const container = document.getElementById('pagesList');
  const emptyEl = document.getElementById('pagesEmpty');
  const loadingEl = document.getElementById('pagesLoading');

  loadingEl.classList.add('hidden');

  const pageAccess = state.apiKeysAnalysis?.pageAccess || [];
  const editorAccess = state.apiKeysAnalysis?.editorAccess;

  console.log('[renderPagesList] pageAccess length:', pageAccess.length);
  console.log('[renderPagesList] state.apiKeysAnalysis:', state.apiKeysAnalysis ? 'exists' : 'null');

  if (pageAccess.length === 0) {
    console.log('[renderPagesList] No pages, showing empty');
    container.innerHTML = '';
    emptyEl.classList.remove('hidden');
    return;
  }

  emptyEl.classList.add('hidden');

  let html = '';

  // Editor access section (only shows if publicly accessible)
  html += renderEditorSection(editorAccess);

  // All pages in a single grid
  html += `
    <div class="pages-section">
      <div class="pages-header" ondblclick="toggleExportButton()">
        <h4>Pages (${pageAccess.length})</h4>
        <button id="exportPagesBtn" class="export-btn hidden" onclick="exportExposedPagesCSV()">Export URLs</button>
      </div>
      <div class="pages-grid" id="pagesGrid">
        ${pageAccess.map(result => {
          if (result.error) {
            return `
              <div class="page-card error" data-page="${result.page}">
                <span class="page-icon">&#9888;</span>
                <span class="page-name">${result.page}</span>
              </div>
            `;
          } else if (result.accessible) {
            return `
              <div class="page-card public" data-page="${result.page}">
                <span class="page-name">${result.page}</span>
                <a href="${result.requestedUrl}" target="_blank" class="page-link" title="Open page">&#8599;</a>
              </div>
            `;
          } else {
            return `
              <div class="page-card protected" data-page="${result.page}">
                <span class="page-icon">&#128274;</span>
                <span class="page-name">${result.page}</span>
                <span class="page-redirect">&#8594; ${result.redirectTarget || 'login'}</span>
              </div>
            `;
          }
        }).join('')}
      </div>
    </div>
  `;

  container.innerHTML = html;
}

// Render editor section helper - only shows if editor is publicly accessible
function renderEditorSection(editorAccess) {
  if (!editorAccess || !editorAccess.accessible) return '';
  return `
    <div class="pages-section editor-section editor-exposed">
      <h4>Editor Access</h4>
      <div class="editor-status">
        <span class="editor-icon">&#9888;</span>
        <span class="editor-label">Editor is publicly accessible!</span>
        ${editorAccess.url ? `<a href="${editorAccess.url}" target="_blank" class="editor-link">Open Editor &#8599;</a>` : ''}
      </div>
    </div>
  `;
}

// Start streaming page access tests
function startPageAccessStream() {
  if (!state.bubbleUrl || !state.apiKeysAnalysis?.pageNames?.length) return;

  console.log('[Pages] Starting page access stream...');

  const eventSource = new EventSource(`/api/test-pages-stream?url=${encodeURIComponent(state.bubbleUrl)}`);

  eventSource.addEventListener('start', (e) => {
    const data = JSON.parse(e.data);
    console.log(`[Pages] Stream started: ${data.totalPages} pages`);
  });

  eventSource.addEventListener('pageResult', (e) => {
    const result = JSON.parse(e.data);
    console.log(`[Pages] Result for ${result.page}: ${result.accessible ? 'public' : 'protected'}`);

    // Update state
    if (!state.apiKeysAnalysis.pageAccess) {
      state.apiKeysAnalysis.pageAccess = [];
    }
    state.apiKeysAnalysis.pageAccess.push(result);

    // Update the specific page card in the DOM
    updatePageCard(result);

    // Update progress
    updatePagesProgress();
  });

  eventSource.addEventListener('editorResult', (e) => {
    const result = JSON.parse(e.data);
    console.log(`[Pages] Editor result: ${result.accessible ? 'accessible' : 'protected'}`);
    state.apiKeysAnalysis.editorAccess = result;

    // Update editor section
    const editorSection = document.getElementById('editorAccessSection');
    if (editorSection) {
      editorSection.outerHTML = renderEditorSection(result);
    }
  });

  eventSource.addEventListener('complete', (e) => {
    console.log('[Pages] Stream complete');
    eventSource.close();

    // Remove progress bar
    const progressEl = document.querySelector('.pages-progress');
    if (progressEl) progressEl.remove();
  });

  eventSource.addEventListener('error', (e) => {
    console.error('[Pages] Stream error');
    eventSource.close();
  });

  eventSource.onerror = () => {
    console.error('[Pages] EventSource error');
    eventSource.close();
  };
}

// Update a single page card in the DOM
function updatePageCard(result) {
  const card = document.querySelector(`.page-card[data-page="${result.page}"]`);
  if (!card) return;

  if (result.error) {
    card.className = 'page-card error';
    card.innerHTML = `
      <span class="page-icon">&#9888;</span>
      <span class="page-name">${result.page}</span>
      <span class="page-error">${result.error}</span>
    `;
  } else if (result.accessible) {
    card.className = 'page-card public';
    card.innerHTML = `
      <span class="page-name">${result.page}</span>
      <a href="${result.requestedUrl}" target="_blank" class="page-link" title="Open page">&#8599;</a>
    `;
  } else {
    card.className = 'page-card protected';
    card.innerHTML = `
      <span class="page-icon">&#128274;</span>
      <span class="page-name">${result.page}</span>
      <span class="page-redirect">&#8594; ${result.redirectTarget || 'login'}</span>
    `;
  }
}

// Update progress bar
function updatePagesProgress() {
  const progressEl = document.querySelector('.pages-progress');
  if (!progressEl) return;

  const testedCount = state.apiKeysAnalysis?.pageAccess?.length || 0;
  const totalCount = state.apiKeysAnalysis?.pageNames?.length || testedCount;

  const fill = progressEl.querySelector('.progress-fill');
  const text = progressEl.querySelector('.progress-text');

  if (fill) fill.style.width = `${(testedCount / totalCount) * 100}%`;
  if (text) text.textContent = `Testing pages: ${testedCount}/${totalCount}`;
}

// Analyze API exposure using AI
async function analyzeApiExposure() {
  if (!state.apiKeysAnalysis) return;

  state.apiExposureLoading = true;
  renderApiKeysList();

  try {
    const response = await fetch('/api/analyze-api-exposure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiConnectors: state.apiKeysAnalysis.apiConnector2,
        apiKeys: state.apiKeysAnalysis.apiKeys
      })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error);

    state.apiExposureAnalysis = data;
    state.apiExposureLoading = false;
    renderApiKeysList();

  } catch (error) {
    console.error('API exposure analysis failed:', error);
    state.apiExposureLoading = false;
    state.apiExposureAnalysis = {
      summary: 'Analysis failed: ' + error.message,
      riskLevel: 'ERROR',
      findings: []
    };
    renderApiKeysList();
  }
}

// Render API exposure analysis results
function renderApiExposureResults() {
  const container = document.getElementById('apiExposureResults');
  if (!container || !state.apiExposureAnalysis) return;

  const { summary, riskLevel, findings } = state.apiExposureAnalysis;

  const riskClass = riskLevel.toLowerCase();

  let html = `
    <div class="exposure-results">
      <div class="exposure-summary risk-${riskClass}">
        <div class="risk-badge">${escapeHtml(riskLevel)}</div>
        <p>${escapeHtml(summary)}</p>
      </div>
  `;

  if (findings && findings.length > 0) {
    html += '<div class="exposure-findings">';
    findings.forEach(finding => {
      const findingRisk = (finding.risk || 'unknown').toLowerCase();
      html += `
        <div class="finding-card risk-${findingRisk}">
          <div class="finding-header">
            <span class="finding-risk-badge">${escapeHtml(finding.risk || 'UNKNOWN')}</span>
            <span class="finding-location">${escapeHtml(finding.connector || '')}${finding.call ? ' → ' + escapeHtml(finding.call) : ''}</span>
          </div>
          <div class="finding-issue">${escapeHtml(finding.issue)}</div>
          <div class="finding-recommendation"><strong>Fix:</strong> ${escapeHtml(finding.recommendation)}</div>
        </div>
      `;
    });
    html += '</div>';
  } else if (riskLevel !== 'ERROR') {
    html += '<p class="no-findings">No critical security issues found.</p>';
  }

  html += '</div>';
  container.innerHTML = html;
}

// Parse apiconnector2 data to extract individual API calls
function parseApiConnectorCalls(apiConnector2) {
  const calls = [];

  if (!apiConnector2 || typeof apiConnector2 !== 'object') {
    return calls;
  }

  // Iterate through all API connectors (top level)
  for (const [connectorId, connectorData] of Object.entries(apiConnector2)) {
    if (!connectorData || typeof connectorData !== 'object') continue;

    // Look for human-readable name in %nm field first
    const connectorName = connectorData['%nm'] || connectorData.nm || connectorData.human || connectorData.name || connectorId;

    // Get auth type from connector level
    const authType = connectorData.auth || null;

    // Check if this connector has nested "calls" object
    if (connectorData.calls && typeof connectorData.calls === 'object') {
      // Drill into each call within this connector
      for (const [callId, callData] of Object.entries(connectorData.calls)) {
        if (!callData || typeof callData !== 'object') continue;

        const call = extractCallDetails(callData, callId, connectorName, authType);
        calls.push(call);
      }
    } else {
      // This might be a flat structure - treat connectorData as the call itself
      const call = extractCallDetails(connectorData, connectorId, null, authType);
      if (call.url || call.headers.length > 0 || call.parameters.length > 0) {
        calls.push(call);
      }
    }
  }

  return calls;
}

// Extract details from a single API call object
function extractCallDetails(callData, callId, parentName, authType) {
  // Look for human-readable name in various fields including %nm
  const humanName = callData['%nm'] || callData.nm || callData.human || callData.name || callId;

  const call = {
    id: callId,
    name: humanName,
    parentName: parentName,
    authType: authType,
    url: callData.url || callData.base_url || callData.api_url || '',
    method: callData.method || callData.http_method || callData.request_type || 'GET',
    headers: [],
    parameters: [],
    body: callData['%b3'] || callData.body || callData.request_body || null,
    rawData: callData
  };

  // Extract headers from various possible formats
  const headerSources = [
    callData.headers,
    callData.shared_headers,
    callData.request_headers
  ];

  for (const source of headerSources) {
    if (Array.isArray(source)) {
      source.forEach(h => {
        if (h && typeof h === 'object') {
          const header = {
            name: h['%k'] || h.key || h.name || h.header_name || h.k || '',
            value: h['%v'] || h.value || h.private_key || h.header_value || h.v || '',
            isPrivate: h.private === true || h.is_private === true || !!h.private_key,
            rawData: h  // Keep the raw JSON object
          };
          call.headers.push(header);
        }
      });
    } else if (source && typeof source === 'object') {
      // Handle object format where keys are IDs and values contain %k, %v, private
      Object.entries(source).forEach(([id, data]) => {
        if (data && typeof data === 'object') {
          call.headers.push({
            name: data['%k'] || data.key || data.name || id,
            value: data['%v'] || data.value || data.private_key || '',
            isPrivate: data.private === true || false,
            rawData: data
          });
        } else if (typeof data === 'string') {
          call.headers.push({
            name: id,
            value: data,
            isPrivate: false,
            rawData: { [id]: data }
          });
        }
      });
    }
  }

  // Extract parameters from various possible formats
  const paramSources = [
    callData.parameters,
    callData.params,
    callData.query_params,
    callData.url_params,
    callData.shared_parameters,
    callData.body_params,
    callData.bodyParams,
    callData.body_parameters
  ];

  for (const source of paramSources) {
    if (Array.isArray(source)) {
      source.forEach(p => {
        if (p && typeof p === 'object') {
          const param = {
            name: p['%k'] || p.key || p.name || p.param_name || p.k || '',
            value: p['%v'] || p.value || p.private_key || p.default_value || p.v || '',
            isPrivate: p.private === true || p.is_private === true || !!p.private_key,
            type: p.type || p.param_type || '',
            rawData: p  // Keep the raw JSON object
          };
          call.parameters.push(param);
        }
      });
    } else if (source && typeof source === 'object') {
      // Handle object format where keys are IDs and values contain %k, %v, private
      Object.entries(source).forEach(([id, data]) => {
        if (data && typeof data === 'object') {
          call.parameters.push({
            name: data['%k'] || data.key || data.name || id,
            value: data['%v'] || data.value || data.private_key || '',
            isPrivate: data.private === true || false,
            rawData: data
          });
        } else if (typeof data === 'string') {
          call.parameters.push({
            name: id,
            value: data,
            isPrivate: false,
            rawData: { [id]: data }
          });
        }
      });
    }
  }

  // Look for any field that might contain sensitive data at the call level
  const sensitiveKeywords = ['key', 'token', 'secret', 'auth', 'password', 'credential', 'api_key', 'apikey'];
  for (const [key, value] of Object.entries(callData)) {
    if (typeof value === 'string' && value.length > 0) {
      const keyLower = key.toLowerCase();
      if (sensitiveKeywords.some(kw => keyLower.includes(kw))) {
        const existsInHeaders = call.headers.some(h => h.value === value);
        const existsInParams = call.parameters.some(p => p.value === value);
        if (!existsInHeaders && !existsInParams) {
          call.parameters.push({ name: key, value: value, isPrivate: true });
        }
      }
    }
  }

  return call;
}

// Render a single API call card
function renderApiCall(call, index) {
  const methodClass = (call.method || 'get').toLowerCase();
  const hasHeaders = call.headers && call.headers.length > 0;
  const hasParams = call.parameters && call.parameters.length > 0;
  const hasBody = call.body && (typeof call.body === 'string' ? call.body.length > 0 : Object.keys(call.body).length > 0);

  // Use human-readable name for display
  const displayName = call.name || '(unnamed call)';

  // Check if this call has a security finding
  const finding = getSecurityFinding(call.parentName, call.name);
  const securityIndicator = finding ? renderSecurityIndicator(finding) : '';

  let html = `
    <div class="api-call-card ${finding ? 'has-security-issue risk-' + finding.risk.toLowerCase() : ''}">
      <div class="api-call-header" onclick="toggleApiCallDetails('api-call-${index}')">
        <div class="api-call-title">
          <span class="http-method method-${methodClass}">${escapeHtml((call.method || 'GET').toUpperCase())}</span>
          <span class="api-call-name">${escapeHtml(displayName)}</span>
        </div>
        <div class="api-call-header-right">
          ${securityIndicator}
          <span class="expand-icon">&#9660;</span>
        </div>
      </div>
      <div class="api-call-details" id="api-call-${index}">
  `;

  // URL
  if (call.url) {
    html += `
      <div class="api-call-section">
        <div class="section-label">URL</div>
        <div class="api-url" onclick="copyToClipboard('${escapeJsString(call.url)}')" title="Click to copy">${escapeHtml(call.url)}</div>
      </div>
    `;
  }

  // Headers - simple key: value list (only exposed ones, not private)
  const exposedHeaders = call.headers.filter(h => !h.isPrivate && h.rawData?.private !== true);
  if (exposedHeaders.length > 0) {
    html += renderCompactKeyValues('Headers', exposedHeaders);
  }

  // Parameters - simple key: value list (only exposed ones, not private)
  const exposedParams = call.parameters.filter(p => !p.isPrivate && p.rawData?.private !== true);
  if (exposedParams.length > 0) {
    html += renderCompactKeyValues('Params', exposedParams);
  }

  // Body
  if (hasBody) {
    const bodyStr = typeof call.body === 'string' ? call.body : JSON.stringify(call.body, null, 2);
    html += `
      <div class="api-call-section">
        <div class="section-label">Request Body</div>
        <pre class="request-body">${escapeHtml(bodyStr)}</pre>
      </div>
    `;
  }

  html += '</div></div>';
  return html;
}

// Generate unique key for an API call
function getApiCallKey(connectorName, callName) {
  return `${connectorName || ''}|${callName || ''}`;
}

// Auto-detect security issues from URL and headers
function detectAutoSecurityIssues(call) {
  const issues = [];

  // Check URL for API keys/tokens
  if (call.url) {
    const urlLower = call.url.toLowerCase();
    const url = call.url;

    // Common patterns for API keys in URLs
    const urlPatterns = [
      { pattern: /[?&](api[_-]?key|apikey)=([^&]+)/i, type: 'API Key in URL' },
      { pattern: /[?&](access[_-]?token|token)=([^&]+)/i, type: 'Access Token in URL' },
      { pattern: /[?&](secret|secret[_-]?key)=([^&]+)/i, type: 'Secret Key in URL' },
      { pattern: /[?&](auth|authorization)=([^&]+)/i, type: 'Auth Token in URL' },
      { pattern: /[?&](password|passwd|pwd)=([^&]+)/i, type: 'Password in URL' },
      { pattern: /[?&](client[_-]?secret)=([^&]+)/i, type: 'Client Secret in URL' },
    ];

    for (const { pattern, type } of urlPatterns) {
      const match = url.match(pattern);
      if (match && match[2] && match[2].length > 0) {
        issues.push({
          type: type,
          location: 'URL',
          value: match[2]
        });
      }
    }
  }

  // Check for exposed auth headers
  if (call.headers && call.headers.length > 0) {
    for (const header of call.headers) {
      const name = (header.name || '').toLowerCase();
      const value = header.value || header.rawData?.['%v'] || '';
      const isPrivate = header.isPrivate || header.rawData?.private === true;

      if (!isPrivate && value.length > 0) {
        if (name.includes('authorization') || name === 'auth') {
          issues.push({
            type: 'Exposed Authorization Header',
            location: 'Header',
            value: value.substring(0, 50) + (value.length > 50 ? '...' : '')
          });
        } else if (name.includes('api-key') || name.includes('apikey') || name === 'x-api-key') {
          issues.push({
            type: 'Exposed API Key Header',
            location: 'Header',
            value: value.substring(0, 50) + (value.length > 50 ? '...' : '')
          });
        } else if (name.includes('token') && !name.includes('content')) {
          issues.push({
            type: 'Exposed Token Header',
            location: 'Header',
            value: value.substring(0, 50) + (value.length > 50 ? '...' : '')
          });
        }
      }
    }
  }

  if (issues.length === 0) return null;

  // Return a finding object
  return {
    risk: 'critical',
    issue: issues.map(i => i.type).join(', '),
    recommendation: 'Move sensitive credentials to server-side. Mark these values as "Private" in Bubble.',
    isAutoDetected: true,
    details: issues
  };
}

// Get security finding for a specific API call (checks manual override first)
function getSecurityFinding(connectorName, callName) {
  const key = getApiCallKey(connectorName, callName);

  // Check manual override first
  if (state.manualApiOverrides[key]) {
    return state.manualApiOverrides[key];
  }

  if (!state.apiExposureAnalysis || !state.apiExposureAnalysis.findings) {
    return null;
  }

  // Find a finding that matches this connector/call
  return state.apiExposureAnalysis.findings.find(f => {
    const connectorMatch = !f.connector ||
      f.connector.toLowerCase() === (connectorName || '').toLowerCase() ||
      (connectorName || '').toLowerCase().includes(f.connector.toLowerCase());
    const callMatch = !f.call ||
      f.call.toLowerCase() === (callName || '').toLowerCase() ||
      (callName || '').toLowerCase().includes(f.call.toLowerCase());
    return connectorMatch && callMatch;
  });
}

// Check if an API call has a manual override
function hasManualApiOverride(connectorName, callName) {
  const key = getApiCallKey(connectorName, callName);
  return !!state.manualApiOverrides[key];
}

// Set manual severity for an API call
function setManualApiSeverity(connectorName, callName, risk) {
  const key = getApiCallKey(connectorName, callName);

  if (risk === null) {
    // Remove override
    delete state.manualApiOverrides[key];
  } else {
    state.manualApiOverrides[key] = {
      risk: risk,
      issue: 'Manually flagged',
      recommendation: 'Review this API call for security concerns',
      isManual: true
    };
  }

  renderApiKeysList();
}

// Cycle through severity levels for an API call
function cycleApiSeverity(connectorName, callName) {
  const key = getApiCallKey(connectorName, callName);
  const current = state.manualApiOverrides[key];
  const aiFinding = getAiSecurityFinding(connectorName, callName);

  // Cycle: none -> critical -> high -> medium -> none (or back to AI if exists)
  let nextRisk = null;

  if (!current) {
    nextRisk = 'critical';
  } else if (current.risk === 'critical') {
    nextRisk = 'high';
  } else if (current.risk === 'high') {
    nextRisk = 'medium';
  } else {
    nextRisk = null; // Remove override
  }

  setManualApiSeverity(connectorName, callName, nextRisk);
}

// Get AI-only security finding (ignoring manual overrides)
function getAiSecurityFinding(connectorName, callName) {
  if (!state.apiExposureAnalysis || !state.apiExposureAnalysis.findings) {
    return null;
  }

  return state.apiExposureAnalysis.findings.find(f => {
    const connectorMatch = !f.connector ||
      f.connector.toLowerCase() === (connectorName || '').toLowerCase() ||
      (connectorName || '').toLowerCase().includes(f.connector.toLowerCase());
    const callMatch = !f.call ||
      f.call.toLowerCase() === (callName || '').toLowerCase() ||
      (callName || '').toLowerCase().includes(f.call.toLowerCase());
    return connectorMatch && callMatch;
  });
}

// Render security indicator for a finding with hover tooltip
function renderSecurityIndicator(finding, connectorName, callName) {
  const risk = (finding.risk || 'unknown').toLowerCase();
  const recommendation = finding.recommendation || 'No fix available';
  const isManual = finding.isManual;
  const isAutoDetected = finding.isAutoDetected;
  const extraClass = isManual ? 'manual-override' : '';

  let sourceLabel = '';
  if (isManual) sourceLabel = ' (manual)';
  else if (isAutoDetected) sourceLabel = ' (auto)';

  return `
    <div class="security-indicator-wrapper ${extraClass}" onclick="cycleApiSeverity('${escapeHtml(connectorName || '')}', '${escapeHtml(callName || '')}'); event.stopPropagation();" title="Click to change severity">
      <span class="security-indicator risk-${risk}">!</span>
      <div class="security-tooltip">
        <div class="tooltip-header">${escapeHtml((finding.risk || 'ISSUE').toUpperCase())}${sourceLabel}</div>
        <div class="tooltip-issue">${escapeHtml(finding.issue || '')}</div>
        <div class="tooltip-fix"><strong>Fix:</strong> ${escapeHtml(recommendation)}</div>
        <div class="tooltip-hint">Click to change severity</div>
      </div>
    </div>
  `;
}

// Render add severity button for calls without findings
function renderAddSeverityButton(connectorName, callName) {
  return `
    <div class="add-severity-btn" onclick="cycleApiSeverity('${escapeHtml(connectorName || '')}', '${escapeHtml(callName || '')}'); event.stopPropagation();" title="Add security flag">
      <span class="add-severity-icon">+</span>
    </div>
  `;
}

// Render a compact API call (always expanded, no nesting)
function renderCompactApiCall(call, index) {
  const methodClass = (call.method || 'get').toLowerCase();

  // Check if this call has a security finding (manual > auto-detected > AI)
  const manualOrAiFinding = getSecurityFinding(call.parentName, call.name);
  const autoDetected = detectAutoSecurityIssues(call);
  const finding = manualOrAiFinding || autoDetected;

  const securityIndicator = finding
    ? renderSecurityIndicator(finding, call.parentName, call.name)
    : renderAddSeverityButton(call.parentName, call.name);

  // Build the display name with connector prefix
  const displayName = call.parentName ? `${call.parentName} → ${call.name}` : call.name;

  // Format auth type for display
  const authBadge = call.authType ? `<span class="auth-type-badge">${escapeHtml(call.authType)}</span>` : '';

  // Filter exposed headers and params
  const exposedHeaders = call.headers.filter(h => !h.isPrivate && h.rawData?.private !== true);
  const exposedParams = call.parameters.filter(p => !p.isPrivate && p.rawData?.private !== true);

  // Only show if there are exposed items
  if (exposedHeaders.length === 0 && exposedParams.length === 0 && !finding) {
    return ''; // Skip calls with nothing exposed
  }

  const callId = `api-call-${index}`;
  const hasDetails = exposedHeaders.length > 0 || exposedParams.length > 0;

  let html = `
    <div class="compact-api-call" id="${callId}">
      <div class="compact-call-header ${hasDetails ? 'clickable' : ''}" ${hasDetails ? `onclick="toggleApiCallDetails('${callId}')"` : ''}>
        <span class="http-method method-${methodClass}">${escapeHtml((call.method || 'GET').toUpperCase())}</span>
        ${authBadge}
        <span class="compact-call-name">${escapeHtml(displayName)}</span>
        ${hasDetails ? `<span class="expand-indicator">▶</span>` : ''}
        ${securityIndicator}
      </div>
  `;

  if (call.url) {
    html += `<div class="compact-url">${escapeHtml(call.url)}</div>`;
  }

  if (hasDetails) {
    html += `<div class="compact-call-details collapsed">`;

    if (exposedHeaders.length > 0) {
      html += renderCompactTable('Headers', exposedHeaders);
    }

    if (exposedParams.length > 0) {
      html += renderCompactTable('Parameters', exposedParams);
    }

    html += '</div>';
  }

  html += '</div>';
  return html;
}

// Toggle API call details visibility
function toggleApiCallDetails(callId) {
  const callEl = document.getElementById(callId);
  if (!callEl) return;

  const details = callEl.querySelector('.compact-call-details');
  const indicator = callEl.querySelector('.expand-indicator');

  if (details) {
    details.classList.toggle('collapsed');
    if (indicator) {
      indicator.textContent = details.classList.contains('collapsed') ? '▶' : '▼';
    }
  }
}

// Render compact key-value pairs inline
function renderCompactKeyValues(label, items) {
  let html = `<div class="compact-section"><span class="compact-label">${label}:</span>`;

  items.forEach((item, i) => {
    const key = item.rawData?.['%k'] || item.name || '';
    const value = item.rawData?.['%v'] || item.value || '';
    const separator = i < items.length - 1 ? ', ' : '';

    html += `<span class="compact-kv" onclick="copyToClipboard('${escapeJsString(value)}')" title="Click to copy">`;
    html += `<span class="compact-key">${escapeHtml(key)}</span>=<span class="compact-val">${escapeHtml(truncateValue(value, 50))}</span>`;
    html += `</span>${separator}`;
  });

  html += '</div>';
  return html;
}

// Render a compact table for headers/params
function renderCompactTable(label, items) {
  if (!items || items.length === 0) return '';

  let html = `
    <div class="compact-table-section">
      <div class="compact-table-label">${label}</div>
      <table class="compact-table">
        <thead>
          <tr>
            <th>Key</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
  `;

  items.forEach(item => {
    const key = item.rawData?.['%k'] || item.name || '';
    const value = item.rawData?.['%v'] || item.value || '';

    html += `
      <tr onclick="copyToClipboard('${escapeJsString(value)}')" title="Click to copy">
        <td class="compact-table-key">${escapeHtml(key)}</td>
        <td class="compact-table-value">${escapeHtml(value)}</td>
      </tr>
    `;
  });

  html += '</tbody></table></div>';
  return html;
}

// Truncate long values for display
function truncateValue(value, maxLen) {
  if (!value || value.length <= maxLen) return value;
  return value.substring(0, maxLen) + '...';
}

// Render a simple key: value list
function renderKeyValueList(label, items) {
  if (!items || items.length === 0) return '';

  let html = `
    <div class="api-call-section">
      <div class="section-label">${label} <span class="count-badge-small">${items.length}</span></div>
      <div class="key-value-list">
  `;

  items.forEach(item => {
    const key = item.rawData?.['%k'] || item.name || '';
    const value = item.rawData?.['%v'] || item.value || '';

    html += `
      <div class="kv-item" onclick="copyToClipboard('${escapeJsString(value)}')" title="Click to copy">
        <span class="kv-key">${escapeHtml(key)}</span>
        <span class="kv-value">${escapeHtml(value)}</span>
      </div>
    `;
  });

  html += '</div></div>';
  return html;
}

// Render a data table with dynamic columns based on rawData keys
function renderDataTable(label, items) {
  if (!items || items.length === 0) return '';

  // Collect all unique keys from rawData across all items
  const allKeys = new Set();
  items.forEach(item => {
    if (item.rawData && typeof item.rawData === 'object') {
      Object.keys(item.rawData).forEach(key => allKeys.add(key));
    }
  });

  // Convert to array and sort (put common keys first)
  const priorityKeys = ['%k', '%v', 'key', 'value', 'name', 'private', 'optional', 'type'];
  const sortedKeys = Array.from(allKeys).sort((a, b) => {
    const aIdx = priorityKeys.indexOf(a);
    const bIdx = priorityKeys.indexOf(b);
    if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
    if (aIdx !== -1) return -1;
    if (bIdx !== -1) return 1;
    return a.localeCompare(b);
  });

  let html = `
    <div class="api-call-section">
      <div class="section-label">${label} <span class="count-badge-small">${items.length}</span></div>
      <div class="table-scroll-container">
        <table class="api-table">
          <thead>
            <tr>
  `;

  // Add header columns
  sortedKeys.forEach(key => {
    html += `<th>${escapeHtml(key)}</th>`;
  });

  html += `
            </tr>
          </thead>
          <tbody>
  `;

  // Add data rows
  items.forEach(item => {
    const isSensitive = item.isPrivate || item.rawData?.private === true;
    html += `<tr class="${isSensitive ? 'sensitive' : ''}">`;

    sortedKeys.forEach(key => {
      const value = item.rawData ? item.rawData[key] : undefined;
      let displayValue = '';

      if (value === undefined || value === null) {
        displayValue = '';
      } else if (typeof value === 'boolean') {
        displayValue = value ? 'true' : 'false';
      } else if (typeof value === 'object') {
        displayValue = JSON.stringify(value);
      } else {
        displayValue = String(value);
      }

      const cellClass = (key === '%v' || key === 'value') ? 'table-value' : '';
      html += `<td class="${cellClass}" onclick="copyToClipboard('${escapeJsString(displayValue)}')" title="Click to copy">${escapeHtml(displayValue)}</td>`;
    });

    html += '</tr>';
  });

  html += '</tbody></table></div></div>';
  return html;
}

// Check if a value looks like a sensitive credential
function looksLikeSensitiveValue(value) {
  if (!value || typeof value !== 'string') return false;
  // Check for common API key patterns
  if (value.length >= 20 && /^[a-zA-Z0-9_\-]+$/.test(value)) return true;
  if (value.startsWith('sk_') || value.startsWith('pk_')) return true;
  if (value.startsWith('Bearer ')) return true;
  if (value.startsWith('Basic ')) return true;
  return false;
}

// Toggle risk level filter (multi-select)
function toggleRiskFilter(level) {
  state.riskFilters[level] = !state.riskFilters[level];
  renderApiKeysList();
}

// Handle API keys search input
function handleApiKeysSearch(query) {
  state.apiKeysSearch = query;
  renderApiKeysList();
  // Restore focus and cursor position
  const input = document.getElementById('apiKeysSearchInput');
  if (input) {
    input.focus();
    input.setSelectionRange(query.length, query.length);
  }
}

// Clear API keys search
function clearApiKeysSearch() {
  state.apiKeysSearch = '';
  renderApiKeysList();
  const input = document.getElementById('apiKeysSearchInput');
  if (input) input.focus();
}

// Export API calls to CSV
function exportApiCallsCsv() {
  if (!state.apiKeysAnalysis || !state.apiKeysAnalysis.apiConnector2) {
    alert('No API calls to export');
    return;
  }

  const apiCalls = parseApiConnectorCalls(state.apiKeysAnalysis.apiConnector2);
  if (apiCalls.length === 0) {
    alert('No API calls to export');
    return;
  }

  // CSV headers
  const headers = ['Connector', 'Call Name', 'Method', 'URL', 'Auth Type', 'Authorization/Bearer Token', 'All Headers', 'Parameters', 'Request Body'];

  // Build CSV rows
  const rows = apiCalls.map(call => {
    // Find bearer/authorization token specifically
    const authHeader = call.headers.find(h =>
      h.name.toLowerCase() === 'authorization' ||
      h.name.toLowerCase().includes('bearer') ||
      h.name.toLowerCase().includes('token') ||
      h.name.toLowerCase().includes('api-key') ||
      h.name.toLowerCase().includes('apikey')
    );
    const bearerToken = authHeader ? authHeader.value : '';

    // Format ALL headers as key:value pairs (include everything)
    const headersStr = call.headers
      .map(h => `${h.name}: ${h.value}`)
      .join('; ');

    // Format ALL parameters as key:value pairs (include everything)
    const paramsStr = call.parameters
      .map(p => `${p.name}: ${p.value}`)
      .join('; ');

    // Include request body
    const bodyStr = call.body ? (typeof call.body === 'string' ? call.body : JSON.stringify(call.body)) : '';

    return [
      call.parentName || '',
      call.name || '',
      call.method || 'GET',
      call.url || '',
      call.authType || 'None',
      bearerToken,
      headersStr,
      paramsStr,
      bodyStr
    ];
  });

  // Escape CSV values
  const escapeCsvValue = (val) => {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  };

  // Build CSV content
  const csvContent = [
    headers.map(escapeCsvValue).join(','),
    ...rows.map(row => row.map(escapeCsvValue).join(','))
  ].join('\n');

  // Download file
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const filename = `api-calls-${state.appName || 'export'}-${new Date().toISOString().slice(0,10)}.csv`;

  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

// Check if an API call matches the search query
function apiCallMatchesSearch(call, query) {
  // Search in call name
  if (call.name && call.name.toLowerCase().includes(query)) return true;
  // Search in parent/connector name
  if (call.parentName && call.parentName.toLowerCase().includes(query)) return true;
  // Search in URL
  if (call.url && call.url.toLowerCase().includes(query)) return true;
  // Search in method
  if (call.method && call.method.toLowerCase().includes(query)) return true;
  // Search in headers
  if (call.headers && call.headers.some(h =>
    (h.name && h.name.toLowerCase().includes(query)) ||
    (h.value && h.value.toLowerCase().includes(query))
  )) return true;
  // Search in parameters
  if (call.parameters && call.parameters.some(p =>
    (p.name && p.name.toLowerCase().includes(query)) ||
    (p.value && String(p.value).toLowerCase().includes(query))
  )) return true;
  // Search in body
  if (call.body) {
    const bodyStr = typeof call.body === 'string' ? call.body : JSON.stringify(call.body);
    if (bodyStr.toLowerCase().includes(query)) return true;
  }
  return false;
}

// Toggle connector group visibility
function toggleConnectorGroup(id) {
  const group = document.getElementById(id);
  if (!group) return;

  const header = group.previousElementSibling;
  if (group.classList.contains('expanded')) {
    group.classList.remove('expanded');
    header.classList.add('collapsed');
  } else {
    group.classList.add('expanded');
    header.classList.remove('collapsed');
  }
}

// Format key name for display (extract meaningful part)
function formatKeyName(name) {
  // Remove long numeric prefixes like "1504096531847x758150745130270700_"
  const match = name.match(/^\d+x\d+_(.+)$/);
  if (match) {
    return match[1];
  }
  return name;
}

// Render a collapsible data section
function renderDataSection(title, data, id) {
  const jsonStr = JSON.stringify(data, null, 2);
  const preview = jsonStr.length > 200 ? jsonStr.substring(0, 200) + '...' : jsonStr;

  return `
    <div class="data-section-item" onclick="toggleDataSection('${id}')">
      <div class="data-section-header">
        <span class="data-section-title">${escapeHtml(title)}</span>
        <span class="expand-icon">&#9660;</span>
      </div>
      <div class="data-section-content" id="${id}">
        <pre class="data-json">${escapeHtml(jsonStr)}</pre>
      </div>
    </div>
  `;
}

// Toggle data section visibility
function toggleDataSection(sectionId) {
  const content = document.getElementById(sectionId);
  if (!content) return;

  const item = content.closest('.data-section-item');

  if (content.classList.contains('expanded')) {
    content.classList.remove('expanded');
    item.classList.remove('expanded');
  } else {
    content.classList.add('expanded');
    item.classList.add('expanded');
  }
}

// Toggle console message details
function toggleConsoleDetails(msgId) {
  const details = document.getElementById(msgId);
  if (!details) return;

  const item = details.closest('.console-message-item');

  if (details.classList.contains('expanded')) {
    details.classList.remove('expanded');
    item.classList.remove('expanded');
  } else {
    details.classList.add('expanded');
    item.classList.add('expanded');
  }
}

// Copy to clipboard helper
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    console.error('Failed to copy:', err);
  }
}

// Copy raw HTML code to clipboard
async function copyTextSummary() {
  const output = document.getElementById('textSummaryOutput');

  // Generate raw HTML as bullet points
  const summaryList = output.querySelector('.summary-list');
  if (!summaryList) {
    console.error('No summary list found');
    return;
  }

  let rawHtml = '<ul>\n';

  summaryList.querySelectorAll('p').forEach(p => {
    const strongEl = p.querySelector('strong');
    if (strongEl) {
      const tableName = strongEl.textContent;
      // Get text after the strong element (the " — columns" part)
      const afterStrong = p.textContent.substring(tableName.length);
      rawHtml += `  <li><strong>${tableName}</strong>${afterStrong}</li>\n`;
    }
  });

  rawHtml += '</ul>';

  try {
    // Copy raw HTML
    await navigator.clipboard.writeText(rawHtml);

    // Show feedback
    const btn = document.querySelector('.copy-summary-btn');
    const originalText = btn.textContent;
    btn.textContent = 'Copied!';
    btn.classList.add('copied');

    setTimeout(() => {
      btn.textContent = originalText;
      btn.classList.remove('copied');
    }, 2000);
  } catch (err) {
    console.error('Failed to copy:', err);
  }
}

// Toggle export button visibility (activated by double-click on pages header)
function toggleExportButton() {
  const btn = document.getElementById('exportPagesBtn');
  if (btn) {
    btn.classList.toggle('hidden');
  }
}

// Export exposed/public page URLs to CSV
function exportExposedPagesCSV() {
  const pageAccess = state.apiKeysAnalysis?.pageAccess || [];
  const exposedPages = pageAccess.filter(p => p.accessible && !p.error);

  if (exposedPages.length === 0) {
    alert('No exposed pages to export');
    return;
  }

  // Build CSV content
  const headers = ['Page Name', 'URL'];
  const rows = exposedPages.map(p => [p.page, p.requestedUrl]);

  const csvContent = [
    headers.join(','),
    ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
  ].join('\n');

  // Create download
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `exposed-pages-${new URL(state.bubbleUrl).hostname}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
