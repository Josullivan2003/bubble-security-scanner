// State
let state = {
  bubbleUrl: '',
  appName: '',
  tables: [],
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
  } catch (error) {
    hideLoading();
    showError('step1Error', `Scan failed: ${error.message}`);
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
  const sortedTables = [...state.tables].sort((a, b) =>
    a.display.toLowerCase().localeCompare(b.display.toLowerCase())
  );

  sortedTables.forEach((table) => {
    const item = document.createElement('div');
    const hasRecords = table.recordCount !== undefined && table.recordCount !== 0 && table.recordCount !== '0';
    const hasRealData = hasRecords && !table.metadataOnly;

    item.className = 'table-item' + (hasRealData ? '' : ' disabled');
    item.dataset.tableId = table.id;

    // Database icon
    const icon = document.createElement('span');
    icon.className = 'table-icon';
    icon.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path></svg>';
    item.appendChild(icon);

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
  const columnList = state.columnOrder.filter(col =>
    allColumns.includes(col) && !state.hiddenColumns.includes(col)
  );

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
          (col) => `
        <th draggable="true" data-column="${escapeHtml(col)}" class="${state.sortColumn === col ? 'sorted' : ''}">
          <div class="th-content">
            <span class="th-label" onclick="sortByColumn('${escapeHtml(col)}')">${escapeHtml(col)}<span class="sort-indicator">${getSortIndicator(col)}</span></span>
            <button class="hide-column-btn" onclick="hideColumn('${escapeHtml(col)}')" title="Hide column">&times;</button>
          </div>
          <div class="resize-handle"></div>
        </th>
      `
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
