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
    document.getElementById('step2').classList.remove('hidden');

    // Fetch record counts for each table in parallel
    updateLoadingText('Counting records...');
    await fetchAllTableCounts();

    hideLoading();

    // Start sensitivity analysis in background (doesn't block UI)
    analyzeSensitivity();
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

  // Done analyzing all tables
  state.sensitivityLoading = false;
  renderTableList();
  console.log('Sensitivity analysis complete:', state.tableSensitivity);

  // Generate AI outreach summary after all analysis is done
  generateOutreachSummary();
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

    // Build formatted summary: Table — column1, column2
    let html = '<div class="summary-list">';
    data.tables.forEach(table => {
      const columns = table.columns.map(col => escapeHtml(cleanColumnName(col))).join(', ');
      html += `<p><strong>${escapeHtml(table.name)}</strong> — ${columns}</p>`;
    });
    html += '</div>';

    // Update output with HTML
    output.innerHTML = html;

  } catch (error) {
    console.error('Summary generation error:', error);
    output.innerHTML = '<div class="summary-error">Failed to generate summary. Please try again.</div>';
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
    const btn = document.querySelector('.copy-summary-btn-header');
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
