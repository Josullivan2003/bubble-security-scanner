// State
let state = {
  bubbleUrl: '',
  appName: '',
  pageNames: [],
  scannedUrl: '',
  editorUrl: '',
  pagePerformance: {},
  selectedPage: null,
};

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  parseUrlParams();

  document.getElementById('bubbleUrl').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      startScan();
    }
  });
});

// Parse URL parameters
function parseUrlParams() {
  const queryString = window.location.search.substring(1);
  const params = {};

  queryString.split('&').forEach(pair => {
    const eqIndex = pair.indexOf('=');
    if (eqIndex > 0) {
      const key = pair.substring(0, eqIndex);
      const value = pair.substring(eqIndex + 1);
      params[key] = decodeURIComponent(value.replace(/\+/g, '%2B'));
    }
  });

  if (params.app) {
    const urlInput = document.getElementById('bubbleUrl');
    urlInput.value = params.app;
    setTimeout(() => startScan(), 100);
  }
}

// Start scanning the Bubble app
async function startScan() {
  const urlInput = document.getElementById('bubbleUrl');
  let url = urlInput.value.trim();

  if (!url) {
    showError('step1Error', 'Please enter a Bubble app URL');
    return;
  }

  if (!url.match(/^https?:\/\//i)) {
    url = 'https://' + url;
  }

  try {
    new URL(url);
  } catch (e) {
    showError('step1Error', 'Please enter a valid URL');
    return;
  }

  state.bubbleUrl = url;
  hideError('step1Error');

  // Reset state
  state.pageNames = [];
  state.pagePerformance = {};

  // Show step 2 and loading
  document.getElementById('step2').classList.remove('hidden');
  document.getElementById('pagesLoading').classList.remove('hidden');
  document.getElementById('pagesEmpty').classList.add('hidden');
  document.getElementById('pagesList').innerHTML = '';

  showLoading('Scanning for pages...');

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

    state.pageNames = data.pageNames || [];
    state.scannedUrl = data.scannedUrl;
    state.editorUrl = data.editorUrl;

    console.log(`[Pages] Found ${state.pageNames.length} page names`);

    hideLoading();
    document.getElementById('pagesLoading').classList.add('hidden');

    if (state.pageNames.length > 0) {
      renderPagesList();
      fetchAllPagePerformance();
    } else {
      document.getElementById('pagesEmpty').innerHTML = `<p>No pages found for this application.</p>`;
      document.getElementById('pagesEmpty').classList.remove('hidden');
    }

  } catch (error) {
    console.error('Scan error:', error);
    hideLoading();
    document.getElementById('pagesLoading').classList.add('hidden');
    document.getElementById('pagesEmpty').innerHTML = `<p>Failed to scan pages: ${error.message}</p>`;
    document.getElementById('pagesEmpty').classList.remove('hidden');
  }
}

// Fetch performance metrics for all pages
async function fetchAllPagePerformance() {
  // Initialize all as loading
  for (const pageName of state.pageNames) {
    state.pagePerformance[pageName] = { loading: true };
    updatePageCard(pageName);
  }

  // Fetch performance one at a time
  // Only extract Bubble data (plugins/workflows) for the first page
  let isFirstPage = true;
  for (const pageName of state.pageNames) {
    const pageUrl = `${state.scannedUrl}/${pageName}`;
    await fetchPagePerformance(pageName, pageUrl, isFirstPage);
    isFirstPage = false;
  }

  // Show PDF export button when all pages are loaded
  document.getElementById('generatePdfBtn').classList.remove('hidden');
}

// Fetch performance for a single page
// extractBubbleData: true = extract plugins/workflows (slow), false = only timing metrics (fast)
async function fetchPagePerformance(pageName, pageUrl, extractBubbleData = false) {
  try {
    const response = await fetch('/api/page-performance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: pageUrl, extractBubbleData })
    });

    const data = await response.json();

    if (data.error) {
      console.log(`[Perf] ${pageName} error:`, data.error);
      state.pagePerformance[pageName] = { loading: false, error: data.error };
    } else {
      console.log(`[Perf] ${pageName} loadComplete:`, data?.metrics?.loadComplete, 'ms');
      state.pagePerformance[pageName] = { loading: false, metrics: data };
    }
  } catch (error) {
    state.pagePerformance[pageName] = { loading: false, error: error.message };
  }

  updatePageCard(pageName);
}

// Update a single page card with performance data
function updatePageCard(pageName) {
  const card = document.querySelector(`.page-card[data-page="${pageName}"]`);
  if (!card) return;

  const perf = state.pagePerformance[pageName];
  let perfHtml = '';

  if (perf?.loading) {
    perfHtml = '<span class="page-perf loading">Loading...</span>';
  } else if (perf?.error) {
    perfHtml = '<span class="page-perf error">Error</span>';
  } else if (perf?.metrics) {
    const loadTime = getLoadTime(perf.metrics);
    const loadClass = getLoadTimeClass(loadTime);
    perfHtml = `<span class="page-perf ${loadClass}">${formatLoadTime(loadTime)}</span>`;
  }

  let perfEl = card.querySelector('.page-perf');
  if (perfEl) {
    perfEl.outerHTML = perfHtml;
  } else {
    card.insertAdjacentHTML('beforeend', perfHtml);
  }
}

// Extract load time from metrics (prioritize content visible time)
function getLoadTime(data) {
  // API returns { url, metrics: { timeline, milestones, resources, loadComplete } }
  const metrics = data?.metrics || {};

  // Prioritize firstContentfulPaint (when content is visible to user)
  if (metrics.milestones?.firstContentfulPaint) {
    return Math.round(metrics.milestones.firstContentfulPaint);
  }
  // Fall back to other metrics
  if (metrics.milestones?.fullyLoaded) {
    return Math.round(metrics.milestones.fullyLoaded);
  }
  if (metrics.loadComplete) {
    return Math.round(metrics.loadComplete);
  }
  if (metrics.firstPaint) {
    return Math.round(metrics.firstPaint);
  }
  return null;
}

// Get CSS class based on load time
function getLoadTimeClass(loadTime) {
  if (loadTime === null) return 'unknown';
  if (loadTime < 2000) return 'fast';
  if (loadTime < 4000) return 'moderate';
  return 'slow';
}

// Format load time for display
function formatLoadTime(loadTime) {
  if (loadTime === null) return '—';
  if (loadTime < 1000) return `${loadTime}ms`;
  return `${(loadTime / 1000).toFixed(1)}s`;
}

// Render the pages list
function renderPagesList() {
  const container = document.getElementById('pagesList');
  const emptyEl = document.getElementById('pagesEmpty');

  if (state.pageNames.length === 0) {
    container.innerHTML = '';
    emptyEl.classList.remove('hidden');
    return;
  }

  emptyEl.classList.add('hidden');

  let html = `
    <div class="pages-section">
      <div class="pages-header">
        <h4>Pages (${state.pageNames.length})</h4>
      </div>
      <div class="pages-grid" id="pagesGrid">
        ${state.pageNames.map(pageName => {
          const pageUrl = `${state.scannedUrl}/${pageName}`;
          return `
            <div class="page-card public" data-page="${pageName}" onclick="openPageMetrics('${pageName}')">
              <span class="page-name">${pageName}</span>
              <a href="${pageUrl}" target="_blank" class="page-link" title="Open page" onclick="event.stopPropagation()">&#8599;</a>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;

  container.innerHTML = html;
}

// UI Helper functions
function showLoading(text) {
  const overlay = document.getElementById('loadingOverlay');
  const loadingText = document.getElementById('loadingText');
  loadingText.textContent = text;
  overlay.classList.remove('hidden');
}

function hideLoading() {
  document.getElementById('loadingOverlay').classList.add('hidden');
}

function showError(elementId, message) {
  const errorEl = document.getElementById(elementId);
  errorEl.textContent = message;
  errorEl.classList.remove('hidden');
}

function hideError(elementId) {
  document.getElementById(elementId).classList.add('hidden');
}

// Open sidebar with page metrics
function openPageMetrics(pageName) {
  state.selectedPage = pageName;
  const sidebar = document.getElementById('metricsSidebar');
  const pageNameEl = document.getElementById('sidebarPageName');
  const contentEl = document.getElementById('sidebarContent');

  pageNameEl.textContent = pageName;
  sidebar.classList.add('performance-sidebar');

  const perf = state.pagePerformance[pageName];
  const pageUrl = `${state.scannedUrl}/${pageName}`;

  if (!perf) {
    contentEl.innerHTML = '<div class="no-metrics"><div class="no-metrics-icon">📊</div><p>No performance data yet</p></div>';
  } else if (perf.loading) {
    contentEl.innerHTML = '<div class="sidebar-loading"><div class="spinner-small"></div><span>Loading metrics...</span></div>';
  } else if (perf.error) {
    contentEl.innerHTML = `<div class="no-metrics"><div class="no-metrics-icon">⚠️</div><p>Error: ${perf.error}</p></div>`;
  } else {
    const data = perf.metrics || {};
    // API returns { url, metrics: { timeline, milestones, resources, bubble } } - extract the inner metrics
    const inner = data.metrics || {};
    const timeline = inner.timeline || {};
    const milestones = inner.milestones || {};
    const resources = inner.resources || {};
    const bubble = inner.bubble || {};

    // Calculate load times - use FCP (content visible)
    const fcp = milestones.firstContentfulPaint || milestones.fullyLoaded || inner.loadComplete;
    const fullyLoaded = milestones.fullyLoaded || inner.loadComplete;
    const loadClass = getLoadTimeClass(fcp);

    contentEl.innerHTML = `
      ${renderLoadTimeHero(fcp, loadClass)}

      ${renderBubbleConfig(bubble, resources, inner, fcp, fullyLoaded)}

      <div class="sidebar-section page-link-section">
        <a href="${pageUrl}" target="_blank" class="page-link">View page ↗</a>
      </div>
    `;
  }

  sidebar.classList.add('open');
  document.body.classList.add('sidebar-open', 'performance-sidebar-open');

  // Highlight selected card
  document.querySelectorAll('.page-card').forEach(card => card.classList.remove('selected'));
  const selectedCard = document.querySelector(`.page-card[data-page="${pageName}"]`);
  if (selectedCard) selectedCard.classList.add('selected');
}

// Render the big load time hero
function renderLoadTimeHero(loadTime, loadClass) {
  if (!loadTime) {
    return '<div class="load-time-hero"><div class="load-time-value">—</div><div class="load-time-label">No timing data</div></div>';
  }

  const ratingText = loadClass === 'fast' ? 'Fast' : loadClass === 'moderate' ? 'Moderate' : 'Slow';
  const ratingIcon = loadClass === 'fast' ? '⚡' : loadClass === 'moderate' ? '🟡' : '🔴';

  return `
    <div class="load-time-hero">
      <div class="load-time-value ${loadClass}">${formatLoadTime(Math.round(loadTime))}</div>
      <div class="load-time-label">Time to content visible</div>
      <div class="load-rating ${loadClass}">${ratingIcon} ${ratingText}</div>
    </div>
  `;
}

// Render Bubble page info (elements and plugins)
function renderBubbleConfig(bubble, resources, metrics, fcp, fullyLoaded) {
  let html = '';
  const timeline = metrics?.timeline || {};

  // Benchmark: average Bubble app FCP is ~2000ms
  const BENCHMARK = 2000;

  // Benchmark comparison
  if (fcp > 0) {
    const diff = fcp - BENCHMARK;
    const percentSlower = Math.round((diff / BENCHMARK) * 100);

    if (diff > 0) {
      html += `
        <div class="sidebar-section benchmark-section">
          <div class="benchmark-comparison bad">
            <span class="benchmark-percent">${percentSlower}%</span>
            <span class="benchmark-text">slower than average Bubble app</span>
          </div>
        </div>
      `;
    } else {
      html += `
        <div class="sidebar-section benchmark-section">
          <div class="benchmark-comparison good">
            <span class="benchmark-percent">${Math.abs(percentSlower)}%</span>
            <span class="benchmark-text">faster than average Bubble app</span>
          </div>
        </div>
      `;
    }
  }

  // Waterfall chart - sequential phases
  if (fcp > 0) {
    const server = (timeline.serverResponse?.end || 0) - (timeline.serverResponse?.start || 0);
    const download = (timeline.download?.end || 0) - (timeline.download?.start || 0);
    const domProcessing = (timeline.domProcessing?.end || 0) - (timeline.domProcessing?.start || 0);
    const resourceLoading = (timeline.resourceLoading?.end || 0) - (timeline.resourceLoading?.start || 0);
    const rendering = Math.max(0, fcp - fullyLoaded);

    // Calculate sequential positions with descriptions
    const phases = [
      {
        label: 'Server',
        time: server,
        class: 'server',
        description: 'Waiting for Bubble\'s servers to respond. This is the time before any data starts arriving. If this is slow, it could mean the server is busy or far away.'
      },
      {
        label: 'Download',
        time: download,
        class: 'download',
        description: 'Downloading the basic page structure from Bubble. This is usually fast unless you have a very complex page or slow internet.'
      },
      {
        label: 'DOM',
        time: domProcessing,
        class: 'processing',
        description: 'The browser is reading and understanding your page structure. More elements on your page means more work here.'
      },
      {
        label: 'Resources',
        time: resourceLoading,
        class: 'scripts',
        description: 'Loading all the extra files your page needs - JavaScript, images, fonts, and plugin code. More plugins means more to load.'
      },
    ];

    if (rendering > 0) {
      phases.push({
        label: 'Rendering',
        time: rendering,
        class: 'rendering',
        description: 'Bubble is building your page using JavaScript. This is often the biggest chunk because Bubble apps are built dynamically. Fewer elements and simpler layouts help here.'
      });
    }

    // Build sequential waterfall
    const scale = (ms) => (ms / fcp) * 100;

    html += `
      <div class="sidebar-section waterfall-section">
        <div class="sidebar-section-title">Load Breakdown</div>
        <div class="waterfall-stacked">
    `;

    for (const phase of phases) {
      const width = scale(phase.time);
      const timeInSeconds = (phase.time / 1000).toFixed(1) + 's';
      html += `
        <div class="waterfall-segment ${phase.class}" style="width: ${Math.max(width, 0.5)}%;" onclick="showWaterfallDescription('${phase.class}')" title="${phase.label}: ${timeInSeconds}">
        </div>
      `;
    }

    html += `
        </div>
        <div class="waterfall-legend">
    `;

    for (const phase of phases) {
      const timeInSeconds = (phase.time / 1000).toFixed(1) + 's';
      html += `
        <div class="waterfall-legend-item" onclick="showWaterfallDescription('${phase.class}')">
          <span class="waterfall-legend-color ${phase.class}"></span>
          <span class="waterfall-legend-label">${phase.label}</span>
          <span class="waterfall-legend-time">${timeInSeconds}</span>
        </div>
      `;
    }

    html += `
        </div>
        <div class="waterfall-description" id="waterfallDescription">
    `;

    for (const phase of phases) {
      html += `
        <div class="waterfall-desc-content" data-phase="${phase.class}">
          <strong>${phase.label}</strong>: ${phase.description}
        </div>
      `;
    }

    html += `
        </div>
      </div>
    `;
  }

  // Plugins and Scripts tabs
  const plugins = bubble.plugins || [];
  const scripts = (resources.all || [])
    .filter(r => r.type === 'script')
    .sort((a, b) => (b.duration || 0) - (a.duration || 0));

  // Sort plugins by duration (should already be sorted, but ensure)
  const sortedPlugins = [...plugins].sort((a, b) => (b.duration || 0) - (a.duration || 0));

  html += `
    <div class="sidebar-section details-section">
      <div class="details-tabs">
        <button class="details-tab active" onclick="switchDetailsTab('plugins')">Plugins (${sortedPlugins.length})</button>
        <button class="details-tab" onclick="switchDetailsTab('scripts')">Scripts (${scripts.length})</button>
      </div>

      <div class="details-content" id="pluginsContent">
        <div class="details-list">
  `;

  if (sortedPlugins.length === 0) {
    html += `<div class="details-empty">No plugins found</div>`;
  } else {
    for (const plugin of sortedPlugins) {
      const timeInSeconds = ((plugin.duration || 0) / 1000).toFixed(1) + 's';
      html += `
        <div class="details-row">
          <span class="details-name">${plugin.name}</span>
          <span class="details-time">${timeInSeconds}</span>
        </div>
      `;
    }
  }

  html += `
        </div>
      </div>

      <div class="details-content" id="scriptsContent" style="display: none;">
        <div class="details-list">
  `;

  if (scripts.length === 0) {
    html += `<div class="details-empty">No scripts found</div>`;
  } else {
    for (const script of scripts) {
      const timeInSeconds = ((script.duration || 0) / 1000).toFixed(1) + 's';
      const displayName = script.name || script.host || 'Unknown';
      html += `
        <div class="details-row">
          <span class="details-name" title="${script.fullUrl || ''}">${displayName}</span>
          <span class="details-time">${timeInSeconds}</span>
        </div>
      `;
    }
  }

  html += `
        </div>
      </div>
    </div>
  `;

  return html;
}

// Format milliseconds to readable time
function formatTime(ms) {
  if (ms < 1000) return Math.round(ms) + 'ms';
  return (ms / 1000).toFixed(1) + 's';
}

// Format bytes to readable size
function formatSize(bytes) {
  if (!bytes || bytes === 0) return '0 KB';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// Switch between plugins and scripts tabs
function switchDetailsTab(tab) {
  // Update tab buttons
  document.querySelectorAll('.details-tab').forEach(el => {
    el.classList.remove('active');
  });
  event.target.classList.add('active');

  // Show/hide content
  document.getElementById('pluginsContent').style.display = tab === 'plugins' ? 'block' : 'none';
  document.getElementById('scriptsContent').style.display = tab === 'scripts' ? 'block' : 'none';
}

// Show waterfall phase description
function showWaterfallDescription(phase) {
  const container = document.getElementById('waterfallDescription');
  if (!container) return;

  // Hide all descriptions
  container.querySelectorAll('.waterfall-desc-content').forEach(el => {
    el.classList.remove('active');
  });

  // Show selected description
  const selected = container.querySelector(`[data-phase="${phase}"]`);
  if (selected) {
    selected.classList.add('active');
    container.classList.add('visible');
  }

  // Highlight selected segment
  document.querySelectorAll('.waterfall-segment').forEach(el => {
    el.classList.remove('selected');
  });
  document.querySelector(`.waterfall-segment.${phase}`)?.classList.add('selected');

  // Highlight selected legend item
  document.querySelectorAll('.waterfall-legend-item').forEach(el => {
    el.classList.remove('selected');
  });
  document.querySelectorAll('.waterfall-legend-item').forEach(el => {
    if (el.querySelector(`.waterfall-legend-color.${phase}`)) {
      el.classList.add('selected');
    }
  });
}

// Render the timeline as a waterfall chart
function renderTimeline(timeline, totalTime, milestones = {}) {
  if (!totalTime || totalTime === 0) {
    return '<p class="sidebar-empty">No timeline data available</p>';
  }

  const phases = [
    { key: 'redirect', icon: '↪️', name: 'Redirect', color: '#94a3b8' },
    { key: 'dnsLookup', icon: '🔍', name: 'DNS', color: '#8b5cf6' },
    { key: 'connection', icon: '🔌', name: 'Connect', color: '#06b6d4' },
    { key: 'serverResponse', icon: '⏳', name: 'Server', color: '#f59e0b' },
    { key: 'download', icon: '📥', name: 'Download', color: '#22c55e' },
    { key: 'domProcessing', icon: '🏗️', name: 'Parse HTML', color: '#3b82f6' },
    { key: 'resourceLoading', icon: '📦', name: 'Load assets', color: '#ec4899' }
  ];

  // Build bars using absolute start/end times
  const bars = [];

  for (const phase of phases) {
    const data = timeline[phase.key];
    if (data === undefined || data === null) continue;

    // Handle both formats: { start, end } object or plain number (duration)
    let start, end, duration;
    if (typeof data === 'object' && data.start !== undefined) {
      start = data.start;
      end = data.end;
      duration = end - start;
    } else {
      // Legacy format: plain number is duration, can't show accurate position
      duration = typeof data === 'number' ? data : 0;
      start = 0;
      end = duration;
    }

    if (duration <= 0) continue;

    const startPercent = (start / totalTime) * 100;
    const widthPercent = (duration / totalTime) * 100;

    bars.push({
      ...phase,
      start,
      end,
      duration,
      startPercent,
      widthPercent
    });
  }

  if (bars.length === 0) {
    return '<p class="sidebar-empty">No timeline phases recorded</p>';
  }

  // Generate time markers
  const markers = [0, 0.25, 0.5, 0.75, 1].map(pct => ({
    position: pct * 100,
    label: formatLoadTime(Math.round(totalTime * pct))
  }));

  let html = `
    <div class="waterfall-chart">
      <div class="waterfall-scale">
        ${markers.map(m => `<span class="waterfall-marker" style="left: ${m.position}%">${m.label}</span>`).join('')}
      </div>
      <div class="waterfall-bars">
  `;

  for (const bar of bars) {
    html += `
      <div class="waterfall-row">
        <div class="waterfall-label">
          <span class="waterfall-icon">${bar.icon}</span>
          <span class="waterfall-name">${bar.name}</span>
        </div>
        <div class="waterfall-track">
          <div class="waterfall-bar" style="left: ${bar.startPercent}%; width: ${Math.max(bar.widthPercent, 1)}%; background: ${bar.color};">
            <span class="waterfall-duration">${formatLoadTime(Math.round(bar.duration))}</span>
          </div>
        </div>
      </div>
    `;
  }

  html += `
      </div>
  `;

  // Add milestone markers
  const milestoneMarkers = [
    { key: 'firstPaint', label: 'First paint', color: '#f97316' },
    { key: 'firstContentfulPaint', label: 'Content visible', color: '#22c55e' }
  ];

  const visibleMarkers = milestoneMarkers.filter(m => {
    const time = milestones[m.key];
    return time && time > 0 && time <= totalTime;
  });

  if (visibleMarkers.length > 0) {
    html += `<div class="waterfall-milestones">`;
    for (const marker of visibleMarkers) {
      const time = milestones[marker.key];
      const position = (time / totalTime) * 100;
      html += `
        <div class="waterfall-milestone" style="left: ${position}%;">
          <div class="waterfall-milestone-line" style="background: ${marker.color};"></div>
          <div class="waterfall-milestone-label" style="color: ${marker.color};">${marker.label}</div>
        </div>
      `;
    }
    html += `</div>`;
  }

  html += `
      <div class="waterfall-total">
        <span class="waterfall-total-label">Total</span>
        <span class="waterfall-total-value">${formatLoadTime(Math.round(totalTime))}</span>
      </div>
    </div>
  `;

  return html;
}

// Render key milestones
function renderMilestones(milestones) {
  const items = [
    { key: 'firstPaint', icon: '👁️', name: 'First pixels', desc: 'Something appeared on screen' },
    { key: 'firstContentfulPaint', icon: '📝', name: 'Content visible', desc: 'Text and images appeared' },
    { key: 'domReady', icon: '✓', name: 'Page ready', desc: 'Page became interactive' },
    { key: 'fullyLoaded', icon: '✅', name: 'Fully loaded', desc: 'Everything finished loading' }
  ];

  let html = '';

  for (const item of items) {
    const value = milestones[item.key];
    if (!value) continue;

    html += `
      <div class="milestone-item">
        <span class="milestone-icon">${item.icon}</span>
        <div class="milestone-content">
          <div class="milestone-name">${item.name}</div>
          <div class="milestone-desc">${item.desc}</div>
        </div>
        <span class="milestone-time">@ ${formatLoadTime(Math.round(value))}</span>
      </div>
    `;
  }

  return html || '<p class="sidebar-empty">No milestone data available</p>';
}

// Render all resources ranked by size and time
function renderResources(resources, totalTime) {
  const allResources = resources.all || [];

  if (allResources.length === 0) {
    return '<p class="sidebar-empty">No resources loaded</p>';
  }

  // Sort by combined score (size + time impact)
  const maxSize = Math.max(...allResources.map(r => r.sizeKB || 0), 1);
  const maxDuration = Math.max(...allResources.map(r => r.duration || 0), 1);

  const ranked = allResources
    .map(r => ({
      ...r,
      sizeScore: (r.sizeKB || 0) / maxSize,
      timeScore: (r.duration || 0) / maxDuration,
      combinedScore: ((r.sizeKB || 0) / maxSize) * 0.5 + ((r.duration || 0) / maxDuration) * 0.5
    }))
    .sort((a, b) => b.combinedScore - a.combinedScore);

  const extIcons = {
    js: '📜', mjs: '📜',
    css: '🎨',
    png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️', ico: '🖼️',
    woff: '🔤', woff2: '🔤', ttf: '🔤', otf: '🔤', eot: '🔤',
    json: '📋', xml: '📋',
    mp4: '🎬', webm: '🎬',
    mp3: '🎵', wav: '🎵'
  };

  const typeIcons = {
    script: '📜',
    stylesheet: '🎨',
    img: '🖼️',
    font: '🔤',
    xhr: '📡',
    fetch: '📡',
    other: '📦'
  };

  let html = `
    <div class="resources-list">
      <div class="resources-header">
        <span class="resources-count">${allResources.length} resources</span>
        <span class="resources-total">${resources.totalSizeKB || 0} KB total</span>
      </div>
  `;

  for (const r of ranked) {
    const icon = extIcons[r.extension] || typeIcons[r.type] || '📦';
    const sizeBarWidth = (r.sizeKB / maxSize) * 100;
    const timeBarWidth = (r.duration / maxDuration) * 100;

    // Build display name: show meaningful path info
    let displayName = r.name || 'unknown';
    const fullUrl = r.fullUrl || r.name || '';

    // Extract path from URL for better context
    try {
      const url = new URL(fullUrl, window.location.origin);
      const pathParts = url.pathname.split('/').filter(p => p);

      if (r.host && r.host !== window.location.hostname) {
        // External resource - show host + last meaningful path part
        const lastPart = pathParts[pathParts.length - 1] || r.extension || r.type;
        // Check for plugin-like paths (e.g., /package/plugin_xxx/)
        const pluginPart = pathParts.find(p => p.startsWith('plugin_') || p.startsWith('plugin-'));
        if (pluginPart) {
          displayName = r.host + ' → ' + pluginPart.replace('plugin_', '').replace('plugin-', '').substring(0, 12);
        } else if (pathParts.length > 1) {
          // Show path context: first/last or last two parts
          displayName = r.host + ' → ' + pathParts.slice(-2).join('/');
        } else {
          displayName = r.host + ' → ' + lastPart;
        }
      } else {
        // Same domain - show path parts to differentiate
        const pluginPart = pathParts.find(p => p.startsWith('plugin_') || p.startsWith('plugin-'));
        if (pluginPart) {
          displayName = pluginPart.replace('plugin_', '').replace('plugin-', '').substring(0, 15) + '/' + (pathParts[pathParts.length - 1] || '');
        } else if (pathParts.length > 2) {
          displayName = pathParts.slice(-2).join('/');
        } else {
          displayName = pathParts.join('/') || r.name;
        }
      }
    } catch (e) {
      // Fallback to simple name truncation
      displayName = r.name && r.name.length > 25 ? r.name.substring(0, 22) + '...' : r.name;
    }

    // Truncate if still too long
    if (displayName && displayName.length > 35) {
      displayName = displayName.substring(0, 32) + '...';
    }

    html += `
      <div class="resource-row" title="${r.fullUrl || r.name}">
        <div class="resource-info">
          <span class="resource-icon">${icon}</span>
          <span class="resource-name">${displayName}</span>
        </div>
        <div class="resource-metrics">
          <div class="resource-metric">
            <span class="resource-metric-value">${r.sizeKB}KB</span>
            <div class="resource-metric-bar size-bar" style="width: ${sizeBarWidth}%"></div>
          </div>
          <div class="resource-metric">
            <span class="resource-metric-value">${formatLoadTime(r.duration)}</span>
            <div class="resource-metric-bar time-bar" style="width: ${timeBarWidth}%"></div>
          </div>
        </div>
      </div>
    `;
  }

  html += '</div>';
  return html;
}

// Truncate resource name for display
function truncateResourceName(name) {
  if (!name) return '—';
  // Get filename from URL
  const parts = name.split('/');
  let filename = parts[parts.length - 1].split('?')[0];
  if (filename.length > 25) {
    filename = filename.substring(0, 22) + '...';
  }
  return filename || name.substring(0, 25);
}

// Render recommendations
function renderRecommendations(timeline, milestones, resources, loadTime) {
  const recommendations = [];

  // Check overall load time
  if (loadTime && loadTime < 2000) {
    recommendations.push({
      type: 'good',
      icon: '✅',
      title: 'Great performance!',
      desc: 'Your page loads quickly. Users will have a smooth experience.'
    });
  }

  // Check server response time
  const serverData = timeline.serverResponse;
  const serverTime = typeof serverData === 'number' ? serverData :
    (serverData ? (serverData.end - serverData.start) : 0);
  if (serverTime > 1000) {
    recommendations.push({
      type: 'critical',
      icon: '🐢',
      title: `Slow server response (${formatLoadTime(Math.round(serverTime))})`,
      desc: 'Your server is taking a while to respond. This could be due to complex database queries or heavy server-side processing.'
    });
  } else if (serverTime > 500) {
    recommendations.push({
      type: 'warning',
      icon: '⚠️',
      title: `Server response could be faster`,
      desc: 'Your server took ' + formatLoadTime(Math.round(serverTime)) + ' to respond. Consider optimizing database queries.'
    });
  }

  // Check first paint
  const firstPaint = milestones.firstPaint;
  if (firstPaint && firstPaint > 3000) {
    recommendations.push({
      type: 'critical',
      icon: '⏱️',
      title: 'Very slow first paint',
      desc: 'It took over 3 seconds before anything appeared on screen. Users may think the page is broken.'
    });
  }

  // Check resource size
  const totalSizeKB = resources.totalSizeKB || 0;
  if (totalSizeKB > 2000) {
    recommendations.push({
      type: 'warning',
      icon: '📦',
      title: `Large page size (${Math.round(totalSizeKB / 1024)}MB)`,
      desc: 'Your page downloads a lot of data. Consider compressing images or removing unused plugins.'
    });
  } else if (totalSizeKB > 1000) {
    recommendations.push({
      type: 'warning',
      icon: '📦',
      title: `Page size is moderate (${totalSizeKB}KB)`,
      desc: 'Consider optimizing images to reduce download size for mobile users.'
    });
  }

  // Check script size (server returns sizeKB directly)
  const scriptSizeKB = resources.byType?.script?.sizeKB || 0;
  if (scriptSizeKB > 500) {
    recommendations.push({
      type: 'warning',
      icon: '📜',
      title: 'Large JavaScript bundle',
      desc: 'Your app has ' + scriptSizeKB + 'KB of JavaScript. Consider removing unused plugins.'
    });
  }

  if (recommendations.length === 0) {
    return '<p class="sidebar-empty">No specific recommendations</p>';
  }

  return recommendations.map(rec => `
    <div class="recommendation-item ${rec.type}">
      <span class="recommendation-icon">${rec.icon}</span>
      <div class="recommendation-content">
        <div class="recommendation-title">${rec.title}</div>
        <div class="recommendation-desc">${rec.desc}</div>
      </div>
    </div>
  `).join('');
}

// Close sidebar
// Generate performance recommendations based on available data
function generateRecommendations(bubble, resources, metrics) {
  const recommendations = [];
  const elements = bubble?.elements || {};
  const imageDetails = bubble?.imageDetails || [];
  const plugins = bubble?.plugins || [];
  const pageLoadWorkflows = bubble?.pageLoadWorkflows || [];

  // 1. Minimize DOM Elements
  // "the fewer elements, the better" - use conditional visibility instead of duplicates
  const totalElements = (elements.groups || 0) + (elements.text || 0) + (elements.buttons || 0) +
                        (elements.inputs || 0) + (elements.images || 0) + (elements.repeatingGroups || 0);
  if (totalElements > 100) {
    recommendations.push({
      title: 'Reduce page elements',
      severity: totalElements > 200 ? 'high' : 'medium',
      impact: `${totalElements} elements`,
      action: 'Use conditional visibility on single elements instead of creating separate desktop/mobile versions. Example: One group with condition "Current page width > 992" instead of two duplicate groups.'
    });
  }

  // Check for "Page is loaded" workflows (should use "Do when condition is true" instead)
  if (pageLoadWorkflows.length > 0) {
    recommendations.push({
      title: 'Replace "Page is loaded" triggers',
      severity: 'medium',
      impact: `${pageLoadWorkflows.length} workflow(s)`,
      action: 'Found workflows using "Page is loaded" trigger which runs on every page navigation. Replace with "Do when condition is true" using a custom state. Set state to "yes" when your data loads, reset when section hides. This gives better control and faster perceived performance.'
    });
  }

  // 2. Limit Plugin Usage
  // "Each plugin adds libraries, headers, and elements that may not be optimized"
  if (plugins.length > 8) {
    recommendations.push({
      title: 'Reduce plugins',
      severity: plugins.length > 12 ? 'high' : 'medium',
      impact: `${plugins.length} plugins`,
      action: 'Each plugin adds JavaScript libraries and overhead. Go to Plugins tab → review each plugin → remove unused ones. Choose plugins focused on specific functionality rather than broad feature sets.'
    });
  }

  // 3. Optimize Images
  // "Keep images smaller than 1MB"
  const largeImages = imageDetails.filter(img => (img.sizeKB || 0) > 1024);
  if (largeImages.length > 0) {
    recommendations.push({
      title: 'Compress large images',
      severity: 'high',
      impact: `${largeImages.length} over 1MB`,
      action: 'Images should be under 1MB. Compress using TinyPNG or Squoosh.app without losing quality. Avoid large SVG files - convert to optimized PNG/WebP if needed.'
    });
  }

  // 4. Use Variables for Data Reuse
  // "Multiple elements requesting the same data duplicate searches"
  if ((elements.repeatingGroups || 0) > 3) {
    recommendations.push({
      title: 'Consolidate data sources',
      severity: 'medium',
      impact: `${elements.repeatingGroups} repeating groups`,
      action: 'Multiple repeating groups may duplicate database searches. Create one hidden repeating group with your data source, then reference "RepeatingGroup\'s List of Things" from other elements. Data loads once instead of multiple times.'
    });
  }

  // Sort by severity
  const severityOrder = { high: 0, medium: 1, low: 2 };
  recommendations.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return recommendations;
}

// Toggle element names visibility
function toggleElementNames(rowEl) {
  const wrapper = rowEl.closest('.element-row-wrapper');
  const namesList = wrapper.querySelector('.element-names-list');
  const chevron = rowEl.querySelector('.element-chevron');

  if (namesList) {
    namesList.classList.toggle('hidden');
    if (chevron) {
      chevron.classList.toggle('expanded');
    }
  }
}

// Toggle section visibility (for images, etc.)
function toggleSection(headerEl) {
  const section = headerEl.closest('.sidebar-section');
  const content = section.querySelector('.section-content');
  const chevron = headerEl.querySelector('.section-chevron');

  if (content) {
    content.classList.toggle('hidden');
    if (chevron) {
      chevron.classList.toggle('expanded');
    }
  }
}

function closeSidebar() {
  const sidebar = document.getElementById('metricsSidebar');
  sidebar.classList.remove('open');
  sidebar.classList.remove('performance-sidebar');
  document.body.classList.remove('sidebar-open', 'performance-sidebar-open');
  document.querySelectorAll('.page-card').forEach(card => card.classList.remove('selected'));
  state.selectedPage = null;
}

// Generate PDF report
async function generatePDF() {
  const btn = document.getElementById('generatePdfBtn');
  btn.disabled = true;
  btn.textContent = 'Generating...';

  try {
    // Get app-wide plugin count from first page with performance data
    let appPluginCount = 0;
    for (const pageName of state.pageNames) {
      const perf = state.pagePerformance[pageName];
      if (perf && perf.metrics) {
        const bubble = perf.metrics.metrics?.bubble || {};
        appPluginCount = Math.max(bubble.pluginCountFromApp || 0, (bubble.plugins || []).length);
        console.log(`[PDF] App plugin count: ${appPluginCount} (from ${pageName})`);
        break; // Only need to get it once
      }
    }

    // Sum up page-load workflows from ALL scanned pages
    let totalPageLoadWorkflows = 0;
    for (const pageName of state.pageNames) {
      const perf = state.pagePerformance[pageName];
      if (perf && perf.metrics) {
        const bubble = perf.metrics.metrics?.bubble || {};
        const pageCount = bubble.pageLoadWorkflowCount || 0;
        totalPageLoadWorkflows += pageCount;
        if (pageCount > 0) {
          console.log(`[PDF] ${pageName}: ${pageCount} page-load workflows`);
        }
      }
    }
    console.log(`[PDF] Total page-load workflows: ${totalPageLoadWorkflows}`);

    // Collect page performance data
    const pages = [];
    for (const pageName of state.pageNames) {
      const perf = state.pagePerformance[pageName];
      if (perf && perf.metrics) {
        const inner = perf.metrics.metrics || {};
        const milestones = inner.milestones || {};
        const bubble = inner.bubble || {};
        const elements = bubble.elements || {};
        const redirect = inner.redirect || {};
        const totalElements = (elements.groups || 0) + (elements.repeatingGroups || 0) +
          (elements.images || 0) + (elements.text || 0) + (elements.buttons || 0) +
          (elements.inputs || 0) + (elements.other || 0);
        pages.push({
          name: pageName,
          firstPaint: Math.round(milestones.firstPaint || 0),
          fcp: Math.round(milestones.firstContentfulPaint || 0),
          fullyLoaded: Math.round(milestones.fullyLoaded || inner.loadComplete || 0),
          lcp: Math.round(milestones.largestContentfulPaint || 0),
          elements: totalElements,
          redirected: redirect.redirected || false,
          redirectTarget: redirect.finalPath || ''
        });
      }
    }

    // Call API to generate PDF
    const response = await fetch('/api/generate-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appUrl: state.bubbleUrl,
        appName: state.appName || new URL(state.bubbleUrl).hostname,
        pages: pages,
        pluginCount: appPluginCount,
        workflowCount: totalPageLoadWorkflows
      })
    });

    if (!response.ok) {
      throw new Error('Failed to generate PDF');
    }

    // Download the PDF
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `performance-report-${state.appName || 'app'}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);

  } catch (error) {
    console.error('PDF generation error:', error);
    alert('Failed to generate PDF: ' + error.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Export PDF';
  }
}
