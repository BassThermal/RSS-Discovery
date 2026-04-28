const state = {
  mode: 'discover',
  session: {
    runId: 0,
    running: false,
    stopped: false,
    seeds: 0,
    feeds: [],
    selectedFeedId: null,
    selectedFeedIds: new Set(),
    scanMode: 'standard',
    freshnessDays: null,
    streamController: null
  },
  reader: {
    selectedSourceId: 'all',
    selectedHeadlineId: null,
    sourceSearch: '',
    headlineSearch: '',
    rangeHours: 24,
    sources: [],
    stories: []
  },
  logs: []
};

const els = {
  navButtons: document.querySelectorAll('.nav-btn'),
  modePanels: document.querySelectorAll('.mode-panel'),
  discoverPane: document.getElementById('discoverPane'),
  readerPane: document.getElementById('readerPane'),
  toolbarMode: document.getElementById('toolbarMode'),
  toolbarContext: document.getElementById('toolbarContext'),
  toolbarSecondary: document.getElementById('toolbarSecondary'),
  statusLeft: document.getElementById('statusLeft'),
  statusRight: document.getElementById('statusRight'),
  discoverActions: document.getElementById('discoverActions'),
  readerActions: document.getElementById('readerActions'),
  exportBtn: document.getElementById('exportBtn'),
  exportMenu: document.getElementById('exportMenu'),
  exportOpmlBtn: document.getElementById('exportOpmlBtn'),
  copyUrlsBtn: document.getElementById('copyUrlsBtn'),
  exportCsvBtn: document.getElementById('exportCsvBtn'),
  exportJsonBtn: document.getElementById('exportJsonBtn'),
  seedInput: document.getElementById('seedInput'),
  scanModeSelect: document.getElementById('scanModeSelect'),
  freshnessSelect: document.getElementById('freshnessSelect'),
  discoverFilter: document.getElementById('discoverFilter'),
  discoverSearch: document.getElementById('discoverSearch'),
  startBtn: document.getElementById('startBtn'),
  stopBtn: document.getElementById('stopBtn'),
  clearBtn: document.getElementById('clearBtn'),
  includeSelectedBtn: document.getElementById('includeSelectedBtn'),
  ignoreSelectedBtn: document.getElementById('ignoreSelectedBtn'),
  selectVisibleBtn: document.getElementById('selectVisibleBtn'),
  clearVisibleBtn: document.getElementById('clearVisibleBtn'),
  openReaderBtn: document.getElementById('openReaderBtn'),
  backDiscoverBtn: document.getElementById('backDiscoverBtn'),
  bulkActionBar: document.getElementById('bulkActionBar'),
  metricDiscovered: document.getElementById('metricDiscovered'),
  metricIncluded: document.getElementById('metricIncluded'),
  metricIgnored: document.getElementById('metricIgnored'),
  logCount: document.getElementById('logCount'),
  terminal: document.getElementById('terminal'),
  feedList: document.getElementById('feedList'),
  feedListCount: document.getElementById('feedListCount'),
  discoverSummary: document.getElementById('discoverSummary'),
  discoverInspector: document.getElementById('discoverInspector'),
  packList: document.getElementById('packList'),
  packCount: document.getElementById('packCount'),
  packSummary: document.getElementById('packSummary'),
  readerSourceSearch: document.getElementById('readerSourceSearch'),
  headlineSearch: document.getElementById('headlineSearch'),
  rangeSelect: document.getElementById('rangeSelect'),
  readerScopeSources: document.getElementById('readerScopeSources'),
  readerScopeStories: document.getElementById('readerScopeStories'),
  headlineList: document.getElementById('headlineList'),
  headlineCount: document.getElementById('headlineCount'),
  headlineSummary: document.getElementById('headlineSummary'),
  storyInspector: document.getElementById('storyInspector')
};

const parseDateMaybe = (value) => {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
};

const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

function normalizePublishedAt(value) {
  const parsed = typeof value === 'number' ? value : parseDateMaybe(value);
  if (!Number.isFinite(parsed)) return null;
  const now = Date.now();
  if (parsed > now + FUTURE_TOLERANCE_MS) return null;
  return Math.min(parsed, now);
}

function normalizeUrl(input, base) {
  if (!input) return null;
  const v = String(input).trim();
  if (!v || /^mailto:|^tel:|^javascript:/i.test(v) || v.startsWith('#')) return null;
  try {
    const url = base ? new URL(v, base) : new URL(/^(https?:)?\/\//i.test(v) ? v : `https://${v}`);
    if (!/^https?:$/i.test(url.protocol)) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

const getDomain = (input) => {
  try {
    return new URL(input).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

const escapeHtml = (value) => String(value || '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

const decodeHtmlEntities = (() => {
  const textarea = document.createElement('textarea');
  return (value) => {
    if (value === null || value === undefined) return '';
    const raw = String(value);
    if (!/[&][#a-zA-Z0-9]+;/.test(raw)) return raw;
    textarea.innerHTML = raw;
    return textarea.value;
  };
})();

const toFaviconUrl = (domain) => `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`;

function parseSeeds(raw) {
  return [...new Set(raw.split(/[\s,\n]+/g).map((v) => normalizeUrl(v)).filter(Boolean))];
}

function formatAge(ts) {
  if (!ts) return 'Unknown time';
  const delta = Date.now() - ts;
  if (delta <= 0) return 'Just now';
  const h = Math.floor(delta / 3600000);
  if (h < 1) return `${Math.max(1, Math.floor(delta / 60000))}m ago`;
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatStoryTime(ts) {
  if (!ts) return 'Unknown time';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return 'Unknown time';
  }
}

function iconMarkup(domain, label, iconUrl = '') {
  const safeDomain = escapeHtml(domain || '');
  const safeLabel = escapeHtml((label || domain || '?').trim().slice(0, 1).toUpperCase() || '?');
  const src = iconUrl || (safeDomain ? toFaviconUrl(safeDomain) : '');
  if (!src) return `<span class="source-icon fallback">${safeLabel}</span>`;
  return `<span class="source-icon-wrap"><img class="source-icon" loading="lazy" src="${src}" alt="" onerror="this.remove(); this.parentNode.classList.add('fallback'); this.parentNode.textContent='${safeLabel}';" /></span>`;
}

function log(code, message, cls = '') {
  const ts = new Date().toISOString().slice(11, 19);
  state.logs.push({ ts, code, message, cls });
  renderTerminal();
}

function renderTerminal() {
  els.terminal.innerHTML = '';
  els.logCount.textContent = `${state.logs.length} actions`;
  if (!state.logs.length) return (els.terminal.innerHTML = '<div class="hint">Session idle. Awaiting scan.</div>');
  state.logs.slice(-300).forEach((row) => {
    const line = document.createElement('div');
    line.className = 'log-row';
    line.innerHTML = `<div>${row.ts}</div><div class="log-code ${row.cls}">${row.code}</div><div>${escapeHtml(row.message)}</div>`;
    els.terminal.appendChild(line);
  });
  els.terminal.scrollTop = els.terminal.scrollHeight;
}

function setDiscoverStatus(context, right) {
  els.toolbarContext.textContent = context;
  els.toolbarSecondary.textContent = right;
  if (state.mode === 'discover') els.statusLeft.textContent = `DISCOVER · ${context}`;
  els.statusRight.textContent = right;
}

async function apiPost(path, payload) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload || {})
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toUiState(rawState) {
  if (rawState === 'ignored' || rawState === 'excluded') return 'ignored';
  if (rawState === 'problem') return 'problem';
  return 'included';
}

function normalizeFeed(raw) {
  const url = normalizeUrl(raw?.url || '');
  if (!url) return null;
  const sourceDomain = raw?.sourceDomain || getDomain(raw?.sourceHome || url);
  const items = Array.isArray(raw?.items)
    ? raw.items.map((it, idx) => ({
      id: it.id || `${url}#${idx}`,
      title: decodeHtmlEntities(it.title || 'Untitled item'),
      url: normalizeUrl(it.url || '', url) || url,
      excerpt: decodeHtmlEntities(String(it.excerpt || '').slice(0, 260)),
      publishedAt: normalizePublishedAt(it.publishedAt),
      author: it.author || ''
    }))
    : [];
  const latest = items[0] || null;
  const latestAt = latest?.publishedAt || normalizePublishedAt(raw?.latestAt);

  return {
    id: raw?.id || `f-${btoa(url).replace(/=+$/g, '').slice(-12)}`,
    sourceSeed: normalizeUrl(raw?.sourceSeed || url) || url,
    sourceDomain,
    sourceHome: normalizeUrl(raw?.sourceHome || '', url) || '',
    sourceIcon: raw?.sourceIcon || toFaviconUrl(sourceDomain),
    title: decodeHtmlEntities(raw?.title || sourceDomain || getDomain(url)),
    url,
    wrappedUrl: normalizeUrl(raw?.wrappedUrl || '', url) || '',
    discoveredVia: raw?.discoveredVia || 'scan',
    format: (raw?.format || 'rss').toLowerCase(),
    state: toUiState(raw?.state),
    latestTitle: decodeHtmlEntities(raw?.latestTitle || latest?.title || 'No items detected'),
    latestUrl: normalizeUrl(raw?.latestUrl || latest?.url || '', url) || '',
    latestAt,
    latestAge: latestAt ? formatAge(latestAt) : 'Unknown time',
    items
  };
}

function getIncludedFeeds() {
  return state.session.feeds.filter((f) => f.state === 'included');
}

function getFreshnessCutoff() {
  return state.session.freshnessDays ? Date.now() - state.session.freshnessDays * 86400000 : null;
}

function feedPassesFreshness(feed) {
  const cutoff = getFreshnessCutoff();
  if (!cutoff) return true;
  return !!feed.latestAt && feed.latestAt >= cutoff;
}

function deriveReaderSourcesFromFeeds(feeds) {
  const included = feeds.filter((f) => f.state === 'included');
  const rows = included.map((feed) => ({
    id: feed.id,
    label: feed.title,
    domain: feed.sourceDomain,
    feedUrl: feed.url,
    active: true,
    stories: (feed.items || []).length,
    iconUrl: feed.sourceIcon || toFaviconUrl(feed.sourceDomain)
  }));
  const total = rows.reduce((n, r) => n + r.stories, 0);
  return [{ id: 'all', label: 'All included feeds', domain: 'session', feedUrl: '', active: true, stories: total }, ...rows];
}

function deriveStoriesFromFeeds(feeds) {
  const stories = [];
  feeds.filter((f) => f.state === 'included').forEach((feed) => {
    (feed.items || []).forEach((item, idx) => {
      stories.push({
        id: `${feed.id}-s-${idx}`,
        sourceId: feed.id,
        sourceLabel: feed.title,
        sourceDomain: feed.sourceDomain || getDomain(feed.url),
        sourceIcon: feed.sourceIcon || toFaviconUrl(feed.sourceDomain || getDomain(feed.url)),
        feedUrl: feed.url,
        title: decodeHtmlEntities(item.title || 'Untitled item'),
        excerpt: decodeHtmlEntities(item.excerpt || ''),
        publishedAt: normalizePublishedAt(item.publishedAt),
        url: item.url || feed.url,
        author: item.author || ''
      });
    });
  });
  stories.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
  return stories;
}

function rebuildReaderData() {
  state.reader.sources = deriveReaderSourcesFromFeeds(state.session.feeds.filter(feedPassesFreshness));
  state.reader.stories = deriveStoriesFromFeeds(state.session.feeds.filter(feedPassesFreshness));
}

function resetSessionData() {
  state.session.feeds = [];
  state.session.selectedFeedId = null;
  state.session.selectedFeedIds.clear();
  state.reader.selectedSourceId = 'all';
  state.reader.selectedHeadlineId = null;
  rebuildReaderData();
  renderFeedList();
  renderDiscoverInspector();
  updateDiscoverMetrics();
  renderPackList();
  renderHeadlineList();
  renderStoryInspector();
}

function clearSession() {
  if (state.session.streamController) {
    state.session.streamController.abort();
    state.session.streamController = null;
  }
  state.logs = [];
  state.session.running = false;
  state.session.stopped = false;
  resetSessionData();
  renderTerminal();
  setDiscoverStatus('Idle', 'Session ready');
}

function getFilteredFeeds() {
  const filter = els.discoverFilter.value;
  const q = els.discoverSearch.value.trim().toLowerCase();
  return state.session.feeds.filter((feed) => {
    const stateOk = filter === 'all' || feed.state === filter;
    const freshnessOk = feedPassesFreshness(feed);
    const hay = `${feed.title} ${feed.sourceDomain} ${feed.url} ${feed.latestTitle}`.toLowerCase();
    return stateOk && freshnessOk && (!q || hay.includes(q));
  });
}

function renderFeedList() {
  const filtered = getFilteredFeeds();
  els.feedList.innerHTML = '';
  els.feedListCount.textContent = `${filtered.length} shown`;
  if (!filtered.length) return (els.feedList.innerHTML = '<div class="hint">No feed records for this filter.</div>');
  filtered.forEach((feed) => {
    const row = document.createElement('div');
    row.className = `feed-row ${feed.state === 'ignored' ? 'excluded' : ''} ${feed.id === state.session.selectedFeedId ? 'focused' : ''}`;
    const latestText = feed.latestTitle || 'No items detected';
    row.innerHTML = `
      <input class="feed-select" aria-label="Select ${escapeHtml(feed.title)}" type="checkbox" data-id="${feed.id}" ${state.session.selectedFeedIds.has(feed.id) ? 'checked' : ''} />
      ${iconMarkup(feed.sourceDomain, feed.title, feed.sourceIcon)}
      <div class="feed-main">
        <div class="title clamp-1">${escapeHtml(feed.title)}</div>
        <div class="feed-meta-line">
          <span class="domain">${escapeHtml(feed.sourceDomain || 'Unknown domain')}</span>
          <span class="sub url">${escapeHtml(feed.url)}</span>
        </div>
        <div class="feed-tertiary">
          <span class="clamp-1">${escapeHtml(latestText)}</span>
          <span class="badge age">${escapeHtml(feed.latestAge || 'Unknown time')}</span>
          <span class="badge state-${feed.state}">${feed.state === 'ignored' ? 'Ignored' : 'Included'}</span>
          <span class="badge type">${escapeHtml(feed.format.toUpperCase())}</span>
        </div>
      </div>
      <div class="row-actions">
        <button class="row-action" data-act="copy" title="Copy feed URL">Copy URL</button>
        <button class="row-action" data-act="open" title="Open feed in new tab">Open feed</button>
        <button class="row-action" data-act="toggle" title="${feed.state === 'ignored' ? 'Restore feed' : 'Ignore feed'}">${feed.state === 'ignored' ? 'Restore' : 'Ignore'}</button>
      </div>
    `;
    row.addEventListener('click', (e) => {
      if (e.target.matches('input,button')) return;
      state.session.selectedFeedId = feed.id;
      renderFeedList();
      renderDiscoverInspector();
    });
    row.querySelector('input').addEventListener('change', (e) => {
      if (e.target.checked) state.session.selectedFeedIds.add(feed.id);
      else state.session.selectedFeedIds.delete(feed.id);
      updateDiscoverMetrics();
    });
    row.querySelector('[data-act="toggle"]').addEventListener('click', (e) => {
      e.stopPropagation();
      setFeedState(feed.id, feed.state === 'ignored' ? 'included' : 'ignored');
    });
    row.querySelector('[data-act="copy"]').addEventListener('click', async (e) => {
      e.stopPropagation();
      await copyText(feed.url, 'Copied 1 feed URL');
    });
    row.querySelector('[data-act="open"]').addEventListener('click', (e) => {
      e.stopPropagation();
      window.open(feed.url, '_blank', 'noopener');
    });
    els.feedList.appendChild(row);
  });
}

function setVisibleSelection(checked) {
  const visible = getFilteredFeeds();
  visible.forEach((feed) => {
    if (checked) state.session.selectedFeedIds.add(feed.id);
    else state.session.selectedFeedIds.delete(feed.id);
  });
  renderFeedList();
  updateDiscoverMetrics();
}

function setFeedState(id, nextState) {
  const feed = state.session.feeds.find((f) => f.id === id);
  if (!feed) return;
  feed.state = nextState;
  log(nextState === 'ignored' ? 'IGNORE' : 'INCLUDE', `${feed.title} set to ${nextState}`, nextState === 'ignored' ? 'warn' : 'ok');
  rebuildReaderData();
  syncReaderSelection();
  renderFeedList();
  renderDiscoverInspector();
  updateDiscoverMetrics();
  renderPackList();
  renderHeadlineList();
  renderStoryInspector();
  refreshReaderStatus();
}

function updateDiscoverMetrics() {
  const total = state.session.feeds.length;
  const included = state.session.feeds.filter((f) => f.state === 'included').length;
  const ignored = state.session.feeds.filter((f) => f.state === 'ignored').length;
  const selected = state.session.selectedFeedIds.size;
  els.metricDiscovered.textContent = total;
  els.metricIncluded.textContent = included;
  els.metricIgnored.textContent = ignored;
  els.discoverSummary.textContent = `${included} included · ${ignored} ignored${selected ? ` · ${selected} selected` : ''}`;
  els.bulkActionBar.classList.toggle('hidden', selected === 0);
  els.exportBtn.disabled = included === 0;
  els.exportBtn.title = included === 0 ? 'No included feeds' : 'Export included feeds';
  if (state.mode === 'discover') els.toolbarSecondary.textContent = `Seeds ${state.session.seeds || 0} · Included ${included}`;
}

function updateDiscoverLayout() {
  const hasSelection = !!state.session.selectedFeedId;
  const hasWideSpace = window.innerWidth >= 1500;
  els.discoverPane.classList.toggle('has-inspector', hasSelection && hasWideSpace);
}

function renderDiscoverInspector() {
  const feed = state.session.feeds.find((f) => f.id === state.session.selectedFeedId);
  if (!feed) {
    els.discoverInspector.innerHTML = '<div class="hint">Select a feed for details.</div>';
    els.discoverInspector.closest('.discover-inspector-pane')?.classList.remove('has-content');
    updateDiscoverLayout();
    return;
  }
  const lastUpdated = feed.latestAt ? new Date(feed.latestAt).toLocaleString() : 'Unknown';
  els.discoverInspector.innerHTML = `<div class="block"><div class="k">Feed title</div><div class="v">${escapeHtml(feed.title)}</div></div><div class="block"><div class="k">Domain</div><div class="s">${escapeHtml(feed.sourceDomain || 'Unknown')}</div><div class="k">Feed URL</div><div class="s mono">${escapeHtml(feed.url)}</div><div class="k">Site URL</div><div class="s mono">${escapeHtml(feed.sourceHome || feed.sourceSeed || 'Unknown')}</div></div><div class="block"><div class="k">Latest item</div><div class="v">${escapeHtml(feed.latestTitle || 'No item title')}</div><div class="s mono">${escapeHtml(feed.latestUrl || 'No article URL')}</div><div class="s">Last updated ${escapeHtml(lastUpdated)}</div></div><div class="block"><div class="k">Discovered via</div><div class="s">${escapeHtml(feed.discoveredVia || 'scan')}</div><div class="k">Format</div><div class="s">${escapeHtml(feed.format.toUpperCase())}</div></div><div class="row2"><button class="btn micro" id="insToggle">${feed.state === 'included' ? 'Ignore' : 'Include'}</button><button class="btn micro" id="insCopy">Copy URL</button></div><div class="row2"><button class="btn micro" id="insOpenFeed">Open feed</button><button class="btn micro" id="insOpenArticle" ${feed.latestUrl ? '' : 'disabled'}>Open latest</button></div>`;
  els.discoverInspector.closest('.discover-inspector-pane')?.classList.add('has-content');
  updateDiscoverLayout();
  document.getElementById('insToggle').addEventListener('click', () => setFeedState(feed.id, feed.state === 'included' ? 'ignored' : 'included'));
  document.getElementById('insCopy').addEventListener('click', () => copyText(feed.url, 'Copied 1 feed URL'));
  document.getElementById('insOpenFeed').addEventListener('click', () => window.open(feed.url, '_blank', 'noopener'));
  document.getElementById('insOpenArticle').addEventListener('click', () => feed.latestUrl && window.open(feed.latestUrl, '_blank', 'noopener'));
}

const getFilteredSources = () => state.reader.sources.filter((src) => src.id === 'all' || !state.reader.sourceSearch || `${src.label} ${src.domain} ${src.feedUrl}`.toLowerCase().includes(state.reader.sourceSearch.toLowerCase()));

function getFilteredHeadlines() {
  const query = state.reader.headlineSearch.toLowerCase();
  const cutoff = Date.now() - state.reader.rangeHours * 3600 * 1000;
  return state.reader.stories
    .filter((st) => state.reader.selectedSourceId === 'all' || st.sourceId === state.reader.selectedSourceId)
    .filter((st) => !st.publishedAt || st.publishedAt >= cutoff)
    .filter((st) => !query || `${st.title} ${st.excerpt} ${st.url}`.toLowerCase().includes(query));
}

function updateReaderScopeSummary() {
  const activeSources = state.session.feeds.filter((f) => f.state === 'included' && feedPassesFreshness(f)).length;
  const visibleStories = getFilteredHeadlines().length;
  els.readerScopeSources.textContent = `${activeSources} included ${activeSources === 1 ? 'feed' : 'feeds'}`;
  els.readerScopeStories.textContent = `${visibleStories} visible ${visibleStories === 1 ? 'article' : 'articles'}`;
}

function renderPackList() {
  const sources = getFilteredSources();
  const included = state.session.feeds.filter((f) => f.state === 'included' && feedPassesFreshness(f)).length;
  els.packList.innerHTML = '';
  els.packCount.textContent = `${included} included feeds`;
  els.packSummary.textContent = included ? `Included feeds ${included}` : 'No included feeds yet. Find feeds first.';
  if (!sources.length) {
    updateReaderScopeSummary();
    return (els.packList.innerHTML = '<div class="hint">No source rows match search.</div>');
  }
  sources.forEach((src) => {
    const row = document.createElement('div');
    row.className = `pack-row ${state.reader.selectedSourceId === src.id ? 'selected' : ''}`;
    row.innerHTML = `${iconMarkup(src.domain, src.label, src.iconUrl)}<div class="pack-main"><div class="pack-title clamp-1">${escapeHtml(src.label)}</div><div class="sub mono">${escapeHtml(src.domain)}</div></div><span class="badge">${src.stories}</span>`;
    row.addEventListener('click', () => {
      state.reader.selectedSourceId = src.id;
      state.reader.selectedHeadlineId = null;
      renderPackList();
      renderHeadlineList();
      renderStoryInspector();
      refreshReaderStatus();
    });
    els.packList.appendChild(row);
  });
  updateReaderScopeSummary();
}

function renderHeadlineList() {
  const rows = getFilteredHeadlines();
  els.headlineList.innerHTML = '';
  els.headlineCount.textContent = `${rows.length} shown`;
  els.headlineSummary.textContent = `Range ${state.reader.rangeHours}h · Source ${state.reader.selectedSourceId} · Loaded ${state.reader.stories.length}`;
  if (!state.session.feeds.some((f) => f.state === 'included')) {
    updateReaderScopeSummary();
    return (els.headlineList.innerHTML = '<div class="hint">No included feeds yet. Include feeds in Discover.</div>');
  }
  if (!state.reader.stories.length) {
    updateReaderScopeSummary();
    return (els.headlineList.innerHTML = '<div class="hint">No readable items were loaded from included feeds.</div>');
  }
  if (!rows.length) {
    updateReaderScopeSummary();
    return (els.headlineList.innerHTML = '<div class="hint">No articles match source/search/range filters.</div>');
  }
  rows.forEach((st) => {
    const row = document.createElement('div');
    row.className = `headline-row ${state.reader.selectedHeadlineId === st.id ? 'selected' : ''}`;
    row.tabIndex = 0;
    row.innerHTML = `<div class="headline-main"><div class="headline-meta"><div class="source-meta">${iconMarkup(st.sourceDomain, st.sourceLabel, st.sourceIcon)}<span class="headline-source">${escapeHtml(st.sourceLabel)}</span><span class="mono quiet source-domain">${escapeHtml(st.sourceDomain)}</span></div><span class="mono quiet story-time">${escapeHtml(formatStoryTime(st.publishedAt))}</span></div><a class="title clamp-2 headline-link" dir="auto" href="${escapeHtml(st.url)}" target="_blank" rel="noopener" title="Open article">${escapeHtml(st.title)}</a><div class="sub clamp-1" dir="auto">${escapeHtml(st.excerpt || '')}</div></div><span class="badge age">${formatAge(st.publishedAt)}</span>`;
    row.addEventListener('click', () => {
      state.reader.selectedHeadlineId = st.id;
      renderHeadlineList();
      renderStoryInspector();
      refreshReaderStatus();
    });
    row.querySelector('.headline-link').addEventListener('click', (e) => e.stopPropagation());
    els.headlineList.appendChild(row);
  });
  updateReaderScopeSummary();
}

function renderStoryInspector() {
  const st = state.reader.stories.find((s) => s.id === state.reader.selectedHeadlineId);
  if (!st) return (els.storyInspector.innerHTML = '<div class="hint">Select an article to inspect details.</div>');
  els.storyInspector.innerHTML = `<div class="block"><div class="k">Story</div><div class="v">${escapeHtml(st.title)}</div><div class="s mono">${escapeHtml(st.url)}</div></div><div class="block"><div class="k">Source</div><div class="s">${escapeHtml(st.sourceLabel)} · ${escapeHtml(st.sourceDomain)}</div><div class="s mono">${escapeHtml(st.feedUrl)}</div><div class="s">Published ${escapeHtml(formatStoryTime(st.publishedAt))}</div></div><div class="block"><div class="k">Excerpt</div><div class="s">${escapeHtml(st.excerpt || 'No excerpt available.')}</div></div><div class="row2"><button class="btn micro" id="openStoryBtn">Open article</button><button class="btn micro" id="openStoryFeedBtn">Open source feed</button></div>`;
  document.getElementById('openStoryBtn').addEventListener('click', () => window.open(st.url, '_blank', 'noopener'));
  document.getElementById('openStoryFeedBtn').addEventListener('click', () => window.open(st.feedUrl, '_blank', 'noopener'));
}

function batchSetSelected(nextState) {
  if (!state.session.selectedFeedIds.size) return;
  state.session.selectedFeedIds.forEach((id) => {
    const feed = state.session.feeds.find((f) => f.id === id);
    if (feed) feed.state = nextState;
  });
  log(nextState === 'ignored' ? 'IGNORE' : 'INCLUDE', `${state.session.selectedFeedIds.size} selected feeds set to ${nextState}`, nextState === 'ignored' ? 'warn' : 'ok');
  rebuildReaderData();
  syncReaderSelection();
  renderFeedList();
  renderDiscoverInspector();
  updateDiscoverMetrics();
  renderPackList();
  renderHeadlineList();
  renderStoryInspector();
  refreshReaderStatus();
}

function syncReaderSelection() {
  if (!state.reader.sources.some((s) => s.id === state.reader.selectedSourceId)) state.reader.selectedSourceId = 'all';
  const visible = getFilteredHeadlines();
  if (state.reader.selectedHeadlineId && !visible.some((s) => s.id === state.reader.selectedHeadlineId)) state.reader.selectedHeadlineId = visible[0]?.id || null;
}

function refreshReaderStatus() {
  if (state.mode !== 'reader') return;
  const visible = getFilteredHeadlines().length;
  const included = getIncludedFeeds().length;
  els.toolbarContext.textContent = `Previewing ${included} included feeds`;
  els.toolbarSecondary.textContent = `${visible} visible articles`;
  els.statusLeft.textContent = 'PREVIEW · Active';
  els.statusRight.textContent = `Loaded ${state.reader.stories.length} · Range ${state.reader.rangeHours}h`;
  updateReaderScopeSummary();
}

async function refreshReaderItemsFromBackend() {
  const includedFeeds = getIncludedFeeds().filter(feedPassesFreshness);
  if (!includedFeeds.length) return;
  log('READER', 'Loading latest articles via local backend', 'ok');
  const payload = await apiPost('/api/reader-items', {
    feeds: includedFeeds.map((f) => ({ id: f.id, title: f.title, sourceDomain: f.sourceDomain, sourceSeed: f.sourceSeed, url: f.url }))
  });
  (payload.logs || []).forEach((row) => log(row.code || 'READER', row.message || '', row.level === 'warn' ? 'warn' : row.level === 'error' ? 'err' : 'ok'));
  const itemsByFeed = new Map();
  (payload.items || []).forEach((item) => {
    const next = {
      ...item,
      title: decodeHtmlEntities(item.title || 'Untitled item'),
      excerpt: decodeHtmlEntities(item.excerpt || ''),
      sourceIcon: item.sourceIcon || toFaviconUrl(item.sourceDomain),
      publishedAt: normalizePublishedAt(item.publishedAt)
    };
    if (!itemsByFeed.has(next.sourceId)) itemsByFeed.set(next.sourceId, []);
    itemsByFeed.get(next.sourceId).push(next);
  });
  state.session.feeds.forEach((feed) => {
    if (feed.state !== 'included') return;
    const rows = itemsByFeed.get(feed.id) || [];
    feed.items = rows.map((item) => ({ id: item.id, title: item.title, url: item.url, excerpt: item.excerpt, publishedAt: item.publishedAt, author: item.author }));
    const first = feed.items[0];
    if (first) {
      feed.latestTitle = first.title;
      feed.latestUrl = first.url;
      feed.latestAt = first.publishedAt;
      feed.latestAge = first.publishedAt ? formatAge(first.publishedAt) : 'Unknown time';
    }
  });
  rebuildReaderData();
  syncReaderSelection();
  renderFeedList();
  renderPackList();
  renderHeadlineList();
  renderStoryInspector();
  refreshReaderStatus();
}

function xmlEscape(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function buildOpml(feeds) {
  const outlines = feeds.map((feed) => `    <outline text="${xmlEscape(feed.title)}" title="${xmlEscape(feed.title)}" type="rss" xmlUrl="${xmlEscape(feed.url)}" htmlUrl="${xmlEscape(feed.sourceHome || feed.sourceSeed || '')}" />`).join('\n');
  const now = new Date().toUTCString();
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="1.0">\n  <head>\n    <title>RSS Discovery Included Feeds</title>\n    <dateCreated>${xmlEscape(now)}</dateCreated>\n    <ownerName>RSS Discovery</ownerName>\n  </head>\n  <body>\n${outlines}\n  </body>\n</opml>\n`;
}

function csvCell(value) {
  const raw = String(value ?? '');
  return `"${raw.replaceAll('"', '""')}"`;
}

function buildCsv(feeds) {
  const header = 'title,feedUrl,siteUrl,domain,format,latestTitle,latestAt,discoveredVia';
  const rows = feeds.map((feed) => [
    feed.title,
    feed.url,
    feed.sourceHome || feed.sourceSeed || '',
    feed.sourceDomain,
    feed.format,
    feed.latestTitle,
    feed.latestAt ? new Date(feed.latestAt).toISOString() : '',
    feed.discoveredVia || 'scan'
  ].map(csvCell).join(','));
  return `${header}\n${rows.join('\n')}\n`;
}

function buildJson(feeds) {
  return JSON.stringify(feeds.map((feed) => ({
    title: feed.title,
    feedUrl: feed.url,
    siteUrl: feed.sourceHome || feed.sourceSeed || '',
    domain: feed.sourceDomain,
    format: feed.format,
    latestTitle: feed.latestTitle,
    latestAt: feed.latestAt ? new Date(feed.latestAt).toISOString() : null,
    discoveredVia: feed.discoveredVia || 'scan',
    sourceSeed: feed.sourceSeed || ''
  })), null, 2);
}

function downloadText(filename, mime, text) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function copyText(text, successMessage) {
  try {
    await navigator.clipboard.writeText(text);
    log('COPY', successMessage, 'ok');
    setDiscoverStatus('Ready', successMessage);
  } catch {
    log('ERROR', 'Clipboard copy failed in this browser context', 'err');
  }
}

async function copyIncludedUrls() {
  const feeds = getIncludedFeeds().filter(feedPassesFreshness);
  if (!feeds.length) {
    log('EXPORT', 'No included feeds to export.', 'warn');
    setDiscoverStatus('Ready', 'No included feeds to export.');
    return;
  }
  const text = feeds.map((f) => f.url).join('\n');
  await copyText(text, `Copied ${feeds.length} feed URLs`);
}

function exportIncluded(kind) {
  const feeds = getIncludedFeeds().filter(feedPassesFreshness);
  if (!feeds.length) {
    log('EXPORT', 'No included feeds to export.', 'warn');
    setDiscoverStatus('Ready', 'No included feeds to export.');
    return;
  }

  if (kind === 'opml') {
    downloadText('rss-discovery-feeds.opml', 'text/x-opml;charset=utf-8', buildOpml(feeds));
  } else if (kind === 'csv') {
    downloadText('rss-discovery-feeds.csv', 'text/csv;charset=utf-8', buildCsv(feeds));
  } else if (kind === 'json') {
    downloadText('rss-discovery-feeds.json', 'application/json;charset=utf-8', buildJson(feeds));
  }
  log('EXPORT', `Exported ${feeds.length} included feeds as ${kind.toUpperCase()}`, 'ok');
}

async function runDiscoverySession(seeds) {
  clearSession();
  state.session.runId += 1;
  state.session.running = true;
  state.session.stopped = false;
  state.session.seeds = seeds.length;
  state.session.scanMode = els.scanModeSelect.value || 'standard';
  state.session.freshnessDays = els.freshnessSelect.value ? Number(els.freshnessSelect.value) : null;
  setDiscoverStatus('Finding feeds', `Seeds ${seeds.length} · Included 0`);
  log('RUN', `Discovery session started for ${seeds.length} website(s)`, 'ok');

  const feedByUrl = new Map();
  let validated = 0;
  let total = 0;

  // Frontend abort closes the stream request cleanly; backend may continue processing briefly.
  state.session.streamController = new AbortController();

  try {
    const res = await fetch('/api/discover-stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        seeds,
        scanMode: state.session.scanMode,
        freshnessDays: state.session.freshnessDays
      }),
      signal: state.session.streamController.signal
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (state.session.running) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      lines.forEach((line) => {
        if (!line.trim()) return;
        let event;
        try { event = JSON.parse(line); } catch { return; }

        if (event.type === 'log') {
          log(event.code || 'RUN', event.message || '', event.level === 'warn' ? 'warn' : event.level === 'error' ? 'err' : 'ok');
        } else if (event.type === 'feed' && event.feed) {
          const normalized = normalizeFeed(event.feed);
          if (!normalized) return;
          if (!feedByUrl.has(normalized.url)) {
            feedByUrl.set(normalized.url, normalized);
            state.session.feeds.push(normalized);
            if (!state.session.selectedFeedId) state.session.selectedFeedId = normalized.id;
            rebuildReaderData();
            renderFeedList();
            renderDiscoverInspector();
            updateDiscoverMetrics();
          }
        } else if (event.type === 'progress') {
          if (event.stage === 'scanning-seed') {
            setDiscoverStatus(`Scanning ${state.session.scanMode}`, `${event.seed || ''}`);
          } else if (event.stage === 'candidates-recovered') {
            setDiscoverStatus('Checking discovered links', `Included ${getIncludedFeeds().length}`);
          } else if (event.stage === 'validating') {
            validated = Number(event.validated || validated);
            total = Number(event.total || total || validated);
            setDiscoverStatus(`Validating ${validated}/${Math.max(total, validated)}`, `${getIncludedFeeds().length} included`);
          }
        } else if (event.type === 'error') {
          throw new Error(event.error || 'discover-stream-failed');
        }
      });
    }
  } catch (err) {
    if (String(err?.name || '') === 'AbortError') {
      log('STOP', 'Scan stopped by user request', 'warn');
    } else {
      log('ERROR', `Discovery failed ${String(err?.message || err)}`, 'err');
    }
  }

  state.session.running = false;
  state.session.streamController = null;
  if (!state.session.feeds.length) {
    log('DONE', 'No valid feed records found', 'warn');
    setDiscoverStatus('Complete', '0 feeds discovered');
  } else {
    state.session.feeds.sort((a, b) => (b.latestAt || 0) - (a.latestAt || 0) || a.title.localeCompare(b.title));
    log('DONE', `${state.session.feeds.length} valid feeds discovered`, 'ok');
    setDiscoverStatus('Complete', `${getIncludedFeeds().length} included feeds ready`);
  }
  rebuildReaderData();
  renderFeedList();
  renderDiscoverInspector();
  updateDiscoverMetrics();
  renderPackList();
  renderHeadlineList();
  renderStoryInspector();
}

function setMode(mode) {
  state.mode = mode;
  const isDiscover = mode === 'discover';
  document.body.classList.toggle('reader-active', !isDiscover);
  els.navButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.mode === mode));
  els.modePanels.forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === mode));
  els.discoverPane.classList.toggle('active', isDiscover);
  els.readerPane.classList.toggle('active', !isDiscover);
  els.discoverActions.classList.toggle('hidden', !isDiscover);
  els.readerActions.classList.toggle('hidden', isDiscover);
  els.toolbarMode.textContent = isDiscover ? 'Discover' : 'Preview latest articles';
  if (isDiscover) {
    els.toolbarContext.textContent = state.session.running ? 'Running' : (state.session.feeds.length ? 'Complete' : 'Idle');
    els.toolbarSecondary.textContent = `Seeds ${state.session.seeds || 0} · Included ${getIncludedFeeds().length}`;
    els.statusLeft.textContent = `DISCOVER · ${els.toolbarContext.textContent}`;
    els.statusRight.textContent = els.toolbarSecondary.textContent;
  } else {
    syncReaderSelection();
    refreshReaderStatus();
  }
}

function bindEvents() {
  els.navButtons.forEach((btn) => btn.addEventListener('click', () => setMode(btn.dataset.mode)));
  els.startBtn.addEventListener('click', async () => {
    const seeds = parseSeeds(els.seedInput.value);
    if (!seeds.length) return log('REJECT', 'No websites provided. Scan not started.', 'err');
    await runDiscoverySession(seeds);
  });
  els.stopBtn.addEventListener('click', () => {
    state.session.running = false;
    state.session.stopped = true;
    if (state.session.streamController) state.session.streamController.abort();
    log('STOP', 'Stop requested. Stream closed for this session.', 'warn');
    setDiscoverStatus('Stopped', 'Session interrupted');
  });
  els.clearBtn.addEventListener('click', clearSession);
  els.includeSelectedBtn.addEventListener('click', () => batchSetSelected('included'));
  els.ignoreSelectedBtn.addEventListener('click', () => batchSetSelected('ignored'));
  els.openReaderBtn.addEventListener('click', async () => {
    const included = getIncludedFeeds().length;
    log('RUN', included ? `Preview latest articles from ${included} included feed(s)` : 'Preview latest articles with no included feeds', included ? 'ok' : 'warn');
    setMode('reader');
    try {
      await refreshReaderItemsFromBackend();
    } catch (err) {
      log('ERROR', `Reader load failed ${String(err?.message || err)}`, 'err');
    }
  });
  els.backDiscoverBtn.addEventListener('click', () => setMode('discover'));
  [els.discoverFilter, els.discoverSearch, els.freshnessSelect].forEach((el) => el.addEventListener('input', () => {
    state.session.freshnessDays = els.freshnessSelect.value ? Number(els.freshnessSelect.value) : null;
    rebuildReaderData();
    renderFeedList();
    renderDiscoverInspector();
    updateDiscoverMetrics();
  }));
  els.selectVisibleBtn.addEventListener('click', () => setVisibleSelection(true));
  els.clearVisibleBtn.addEventListener('click', () => setVisibleSelection(false));

  els.exportBtn.addEventListener('click', () => {
    if (els.exportBtn.disabled) return;
    els.exportMenu.classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.export-group')) els.exportMenu.classList.remove('open');
  });
  els.exportOpmlBtn.addEventListener('click', () => exportIncluded('opml'));
  els.copyUrlsBtn.addEventListener('click', () => copyIncludedUrls());
  els.exportCsvBtn.addEventListener('click', () => exportIncluded('csv'));
  els.exportJsonBtn.addEventListener('click', () => exportIncluded('json'));

  els.readerSourceSearch.addEventListener('input', () => {
    state.reader.sourceSearch = els.readerSourceSearch.value.trim();
    renderPackList();
    renderHeadlineList();
    renderStoryInspector();
    refreshReaderStatus();
  });
  els.headlineSearch.addEventListener('input', () => {
    state.reader.headlineSearch = els.headlineSearch.value.trim();
    renderHeadlineList();
    renderStoryInspector();
    refreshReaderStatus();
  });
  els.rangeSelect.addEventListener('change', () => {
    state.reader.rangeHours = Number(els.rangeSelect.value);
    renderHeadlineList();
    renderStoryInspector();
    refreshReaderStatus();
  });
  window.addEventListener('resize', updateDiscoverLayout);
}

function init() {
  bindEvents();
  clearSession();
  setMode('discover');
  log('RUNTIME', 'Discovery transport: local backend /api/discover-stream', 'ok');
}

init();
