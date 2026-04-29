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
    selectionMode: false,
    scanMode: 'standard',
    freshnessDays: null,
    streamController: null
  },
  reader: {
    selectedSourceId: 'all',
    sourceSearch: '',
    headlineSearch: '',
    rangeHours: 24,
    sources: [],
    stories: []
  },
  logs: [],
  currentPackId: null,
  packDirty: false,
  savedPacks: []
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
  discoverFilter: document.getElementById('discoverFilter'),
  discoverSearch: document.getElementById('discoverSearch'),
  startBtn: document.getElementById('startBtn'),
  stopBtn: document.getElementById('stopBtn'),
  clearBtn: document.getElementById('clearBtn'),
  openReaderBtn: document.getElementById('openReaderBtn'),
  toolbarPreviewBtn: document.getElementById('toolbarPreviewBtn'),
  openLogBtn: document.getElementById('openLogBtn'),
  toolbarLogBtn: document.getElementById('toolbarLogBtn'),
  closeLogBtn: document.getElementById('closeLogBtn'),
  closeDetailsBtn: document.getElementById('closeDetailsBtn'),
  logDialog: document.getElementById('logDialog'),
  detailsDialog: document.getElementById('detailsDialog'),
  backDiscoverBtn: document.getElementById('backDiscoverBtn'),
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
  refreshArticlesBtn: document.getElementById('refreshArticlesBtn'),
  packLabel: document.getElementById('packLabel'),
  packSaveBtn: document.getElementById('packSaveBtn'),
  packSaveAsBtn: document.getElementById('packSaveAsBtn'),
  packLoadBtn: document.getElementById('packLoadBtn'),
  packsDialog: document.getElementById('packsDialog'),
  packsDialogBody: document.getElementById('packsDialogBody'),
  closePacksBtn: document.getElementById('closePacksBtn')
};

function assertRequiredEls() {
  const required = [
    'seedInput',
    'scanModeSelect',
    'discoverFilter',
    'discoverSearch',
    'startBtn',
    'stopBtn',
    'clearBtn',
    'feedList',
    'feedListCount',
    'discoverSummary',
    'statusLeft',
    'statusRight',
    'toolbarContext',
    'toolbarSecondary',
    'terminal',
    'logCount'
  ];
  const missing = required.filter((key) => !els[key]);
  if (!missing.length) return true;
  console.error('Fatal: missing required DOM elements:', missing);
  const host = document.body || document.documentElement;
  if (host) {
    const fatal = document.createElement('div');
    fatal.style.padding = '12px';
    fatal.style.background = '#3a1111';
    fatal.style.color = '#ffd8d8';
    fatal.style.fontFamily = 'monospace';
    fatal.textContent = `Fatal UI error: missing required elements: ${missing.join(', ')}`;
    host.prepend(fatal);
  }
  return false;
}

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
  if (!ts) return 'No date';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return 'No date';
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
  return [{ id: 'all', label: 'All sources', domain: 'session', feedUrl: '', active: true, stories: total }, ...rows];
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


const PACKS_STORAGE_KEY = 'rssDiscovery.packs.v1';

function updatePackUi() {
  if (!els.packLabel) return;
  const current = state.savedPacks.find((p) => p.id === state.currentPackId);
  if (!current) els.packLabel.textContent = 'Unsaved scan';
  else if (state.packDirty) els.packLabel.textContent = `${current.name} · unsaved changes`;
  else els.packLabel.textContent = `Pack: ${current.name}`;
}

function loadSavedPacks() {
  try {
    const raw = localStorage.getItem(PACKS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('invalid packs payload');
    return parsed.filter((p) => p && p.schema === 1 && p.id);
  } catch (err) {
    log('PACK', 'Saved packs were corrupt and were reset.', 'warn');
    localStorage.removeItem(PACKS_STORAGE_KEY);
    return [];
  }
}
function writeSavedPacks(packs) { localStorage.setItem(PACKS_STORAGE_KEY, JSON.stringify(packs)); state.savedPacks = packs; }
function getSavedPackById(id) { return state.savedPacks.find((p) => p.id === id) || null; }
function serializeCurrentPack(name, existingPack) {
  const now = new Date().toISOString();
  return { schema: 1, id: existingPack?.id || `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`, name: name.trim().slice(0,80), createdAt: existingPack?.createdAt || now, updatedAt: now, seeds: parseSeeds(els.seedInput.value), scanMode: els.scanModeSelect.value || state.session.scanMode || 'standard', feeds: state.session.feeds, selectedSourceId: state.reader.selectedSourceId || 'all' };
}
function restorePack(pack){
  state.session.feeds = Array.isArray(pack.feeds) ? pack.feeds.map((f)=>normalizeFeed(f)).filter(Boolean):[];
  els.seedInput.value = (pack.seeds || []).join('\n');
  els.scanModeSelect.value = pack.scanMode || 'standard';
  state.session.scanMode = els.scanModeSelect.value;
  rebuildReaderData();
  state.reader.selectedSourceId = state.reader.sources.some((s)=>s.id===pack.selectedSourceId)?pack.selectedSourceId:'all';
  renderFeedList(); renderDiscoverInspector(); updateDiscoverMetrics(); renderPackList(); renderHeadlineList(); refreshReaderStatus();
}
function markPackDirty(){ if (state.currentPackId) { state.packDirty = true; updatePackUi(); } }
function saveCurrentPack(){
  if (!state.session.feeds.length){ log('PACK','No feeds to save.','warn'); return; }
  if (!state.currentPackId) return saveCurrentPackAs();
  const existing=getSavedPackById(state.currentPackId); if(!existing) return saveCurrentPackAs();
  const next=serializeCurrentPack(existing.name, existing);
  writeSavedPacks(state.savedPacks.map((p)=>p.id===existing.id?next:p));
  state.packDirty=false; updatePackUi(); log('PACK',`Saved changes to ${next.name}`,'ok');
}
function saveCurrentPackAs(){
  if (!state.session.feeds.length){ log('PACK','No feeds to save.','warn'); return; }
  const name=(window.prompt('Pack name')||'').trim().slice(0,80); if(!name) return;
  const pack=serializeCurrentPack(name);
  writeSavedPacks([pack, ...state.savedPacks.filter((p)=>p.id!==pack.id)]);
  state.currentPackId=pack.id; state.packDirty=false; updatePackUi(); log('PACK',`Saved ${pack.name}`,'ok');
}
function deleteSavedPack(id){ const pack=getSavedPackById(id); if(!pack) return; if(!window.confirm(`Delete saved pack ${pack.name}?`)) return; writeSavedPacks(state.savedPacks.filter((p)=>p.id!==id)); if(state.currentPackId===id){ state.currentPackId=null; state.packDirty=state.session.feeds.length>0; } renderPacksDialog(); updatePackUi(); log('PACK',`Deleted ${pack.name}`,'warn'); }
function renderPacksDialog(){ if(!els.packsDialogBody) return; if(!state.savedPacks.length){ els.packsDialogBody.innerHTML='<div class="hint">No saved packs yet.</div>'; return; } els.packsDialogBody.innerHTML=''; state.savedPacks.slice().sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt)).forEach((pack)=>{ const row=document.createElement('div'); row.className='saved-pack-row'; row.innerHTML=`<div><div class="saved-pack-name">${escapeHtml(pack.name)}</div><div class="tiny mono">${(pack.feeds||[]).length} feeds · ${escapeHtml(pack.scanMode||'standard')} · ${escapeHtml(new Date(pack.updatedAt).toLocaleString())}</div></div><div class="saved-pack-actions"><button class="btn micro" data-act="load">Load</button><button class="btn micro danger-action" data-act="delete">Delete</button></div>`; row.querySelector('[data-act="load"]').addEventListener('click',()=>{ if(state.packDirty && !window.confirm('Load this pack and discard unsaved changes?')) return; restorePack(pack); state.currentPackId=pack.id; state.packDirty=false; updatePackUi(); els.packsDialog?.close?.(); log('PACK',`Loaded ${pack.name}`,'ok');}); row.querySelector('[data-act="delete"]').addEventListener('click',()=>deleteSavedPack(pack.id)); els.packsDialogBody.appendChild(row); }); }
function openPacksDialog(){ renderPacksDialog(); els.packsDialog?.showModal?.(); }

function rebuildReaderData() {
  state.reader.sources = deriveReaderSourcesFromFeeds(state.session.feeds.filter(feedPassesFreshness));
  state.reader.stories = deriveStoriesFromFeeds(state.session.feeds.filter(feedPassesFreshness));
}

function resetSessionData() {
  state.session.feeds = [];
  state.session.selectedFeedId = null;
  state.session.selectedFeedIds.clear();
  state.session.selectionMode = false;
  state.reader.selectedSourceId = 'all';
  rebuildReaderData();
  renderFeedList();
  renderDiscoverInspector();
  updateDiscoverMetrics();
  renderPackList();
  renderHeadlineList();
}

function clearSession() {
  if (state.session.streamController) {
    state.session.streamController.abort();
    state.session.streamController = null;
  }
  state.logs = [];
  markPackDirty('session-reset');
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
    const stateOk = filter === 'all' || filter === '30' || filter === '90' || filter === '365' ? true : feed.state === filter;
    state.session.freshnessDays = filter === '30' || filter === '90' || filter === '365' ? Number(filter) : null;
    const freshnessOk = feedPassesFreshness(feed);
    const hay = `${feed.title} ${feed.sourceDomain} ${feed.url} ${feed.latestTitle}`.toLowerCase();
    return stateOk && freshnessOk && (!q || hay.includes(q));
  });
}

function renderFeedList() {
  const filtered = getFilteredFeeds();
  els.feedList.innerHTML = '';
  els.feedListCount.textContent = `${filtered.length} shown`;
  if (!filtered.length) return (els.feedList.innerHTML = '<div class="hint">No feeds found. Try Standard/Deep scan or paste a direct RSS URL.</div>');
  filtered.forEach((feed) => {
    const stateLabel = feed.state === 'ignored' ? 'Ignored' : feed.state === 'problem' ? 'Problem' : 'Included';
    const row = document.createElement('div');
    row.className = `feed-row ${feed.state === 'ignored' ? 'excluded' : ''} ${feed.id === state.session.selectedFeedId ? 'focused' : ''}`;
    const latestText = feed.latestTitle || 'No items detected';
    row.innerHTML = `
      ${iconMarkup(feed.sourceDomain, feed.title, feed.sourceIcon)}
      <div class="feed-content">
        <div class="feed-primary">
          <div class="feed-identity">
            <div class="feed-title clamp-1" dir="auto" title="${escapeHtml(feed.title)}">${escapeHtml(feed.title)}</div>
            <div class="feed-url mono clamp-1" dir="ltr" title="${escapeHtml(feed.url)}">${escapeHtml(feed.url)}</div>
          </div>
          <div class="feed-actions">
            <button class="row-action" data-act="copy" title="Copy feed URL">Copy</button>
            <button class="row-action" data-act="open" title="Open feed">Open</button>
            <button class="row-action" data-act="toggle" title="${feed.state === 'ignored' ? 'Include in Preview and Export' : 'Exclude from Preview and Export'}">${feed.state === 'ignored' ? 'Restore' : 'Ignore'}</button>
            <button class="row-action danger-action" data-act="delete" title="Remove from this session">Delete</button>
            <button class="row-action" data-act="details" title="Show feed details">Details</button>
          </div>
        </div>
        <div class="feed-secondary">
          <span class="feed-domain" title="${escapeHtml(feed.sourceDomain || 'Unknown domain')}">${escapeHtml(feed.sourceDomain || 'Unknown domain')}</span>
          <span class="feed-latest clamp-1" dir="auto" title="${escapeHtml(latestText)}">Latest: ${escapeHtml(latestText)}</span>
          <span class="badge age">${escapeHtml(feed.latestAge || 'Unknown time')}</span>
          <span class="badge type">${escapeHtml(feed.format.toUpperCase())}</span>
          ${feed.state === 'included' ? '' : `<span class="badge state-${feed.state}">${stateLabel}</span>`}
        </div>
      </div>
    `;
    row.classList.toggle('selection-enabled', state.session.selectionMode);
    row.addEventListener('click', (e) => {
      if (e.target.matches('input,button')) return;
      state.session.selectedFeedId = feed.id;
      renderFeedList();
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
    row.querySelector('[data-act="delete"]').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteFeed(feed.id);
    });
    row.querySelector('[data-act="details"]').addEventListener('click', (e) => {
      e.stopPropagation();
      state.session.selectedFeedId = feed.id;
      renderDiscoverInspector();
      if (els.detailsDialog?.showModal) els.detailsDialog.showModal();
      else console.warn('Details dialog is unavailable.');
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
  markPackDirty('feed-state');
  log(nextState === 'ignored' ? 'IGNORE' : 'INCLUDE', `${feed.title} set to ${nextState}`, nextState === 'ignored' ? 'warn' : 'ok');
  rebuildReaderData();
  markPackDirty('feed-delete');
  syncReaderSelection();
  renderFeedList();
  renderDiscoverInspector();
  updateDiscoverMetrics();
  renderPackList();
  renderHeadlineList();
  refreshReaderStatus();
}

function deleteFeed(id) {
  const index = state.session.feeds.findIndex((f) => f.id === id);
  if (index < 0) return;
  const feed = state.session.feeds[index];
  if (!window.confirm('Delete this feed from the current session?')) return;
  state.session.feeds.splice(index, 1);
  state.session.selectedFeedIds.delete(id);
  if (state.session.selectedFeedId === id) state.session.selectedFeedId = null;
  if (state.reader.selectedSourceId === id) state.reader.selectedSourceId = 'all';
  if (state.reader.activeStoryId?.startsWith(`${id}-`)) state.reader.activeStoryId = null;
  rebuildReaderData();
  markPackDirty('feed-delete');
  syncReaderSelection();
  renderFeedList();
  renderDiscoverInspector();
  updateDiscoverMetrics();
  renderPackList();
  renderHeadlineList();
  refreshReaderStatus();
  if (els.detailsDialog?.open) els.detailsDialog.close();
  log('DELETE', `Removed ${feed.title} from this session`, 'warn');
}

function updateDiscoverMetrics() {
  const total = state.session.feeds.length;
  const included = state.session.feeds.filter((f) => f.state === 'included').length;
  const ignored = state.session.feeds.filter((f) => f.state === 'ignored').length;
  els.discoverSummary.textContent = `${total} found · ${included} included`;
  els.exportBtn.disabled = included === 0;
  els.exportBtn.title = included === 0 ? 'No included feeds' : 'Export included feeds';
  if (state.mode === 'discover') els.toolbarSecondary.textContent = `Seeds ${state.session.seeds || 0} · Included ${included}`;
}

function renderDiscoverInspector() {
  const feed = state.session.feeds.find((f) => f.id === state.session.selectedFeedId);
  if (!feed) {
    els.discoverInspector.innerHTML = '<div class="hint">Select a feed for details.</div>';
    return;
  }
  const lastUpdated = feed.latestAt ? new Date(feed.latestAt).toLocaleString() : 'Unknown';
  els.discoverInspector.innerHTML = `<div class="block"><div class="k">Feed title</div><div class="v">${escapeHtml(feed.title)}</div></div><div class="block"><div class="k">Domain</div><div class="s">${escapeHtml(feed.sourceDomain || 'Unknown')}</div><div class="k">Feed URL</div><div class="s mono">${escapeHtml(feed.url)}</div><div class="k">Site URL</div><div class="s mono">${escapeHtml(feed.sourceHome || feed.sourceSeed || 'Unknown')}</div></div><div class="block"><div class="k">Latest item</div><div class="v">${escapeHtml(feed.latestTitle || 'No item title')}</div><div class="s mono">${escapeHtml(feed.latestUrl || 'No article URL')}</div><div class="s">Last updated ${escapeHtml(lastUpdated)}</div></div><div class="block"><div class="k">Discovered via</div><div class="s">${escapeHtml(feed.discoveredVia || 'scan')}</div><div class="k">Format</div><div class="s">${escapeHtml(feed.format.toUpperCase())}</div></div><div class="row2"><button class="btn micro" id="insToggle">${feed.state === 'included' ? 'Ignore' : 'Include'}</button><button class="btn micro danger-action" id="insDelete">Delete</button><button class="btn micro" id="insCopy">Copy URL</button></div><div class="row2"><button class="btn micro" id="insOpenFeed">Open feed</button><button class="btn micro" id="insOpenArticle" ${feed.latestUrl ? '' : 'disabled'}>Open latest</button></div>`;
  document.getElementById('insToggle').addEventListener('click', () => setFeedState(feed.id, feed.state === 'included' ? 'ignored' : 'included'));
  document.getElementById('insDelete').addEventListener('click', () => deleteFeed(feed.id));
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

function getVisibleStoryCountForSource(sourceId) {
  const query = state.reader.headlineSearch.toLowerCase();
  const cutoff = Date.now() - state.reader.rangeHours * 3600 * 1000;
  return state.reader.stories
    .filter((st) => sourceId === 'all' || st.sourceId === sourceId)
    .filter((st) => !st.publishedAt || st.publishedAt >= cutoff)
    .filter((st) => !query || `${st.title} ${st.excerpt} ${st.url}`.toLowerCase().includes(query)).length;
}

function updateReaderScopeSummary() {
  const activeSources = state.session.feeds.filter((f) => f.state === 'included' && feedPassesFreshness(f)).length;
  const visibleStories = getFilteredHeadlines().length;
  els.readerScopeSources.textContent = `${activeSources} ${activeSources === 1 ? 'source' : 'sources'}`;
  els.readerScopeStories.textContent = `${visibleStories} visible ${visibleStories === 1 ? 'article' : 'articles'}`;
}

function renderPackList() {
  const sources = getFilteredSources();
  const included = state.session.feeds.filter((f) => f.state === 'included' && feedPassesFreshness(f)).length;
  els.packList.innerHTML = '';
  els.packCount.textContent = `${included} sources`;
  els.packSummary.textContent = included ? `${included} sources` : 'No sources yet. Find feeds first.';
  if (!sources.length) {
    updateReaderScopeSummary();
    return (els.packList.innerHTML = '<div class="hint">No source rows match search.</div>');
  }
  sources.forEach((src) => {
    const row = document.createElement('div');
    row.className = `pack-row ${state.reader.selectedSourceId === src.id ? 'selected' : ''}`;
    row.innerHTML = `${iconMarkup(src.domain, src.label, src.iconUrl)}<div class="pack-main"><div class="pack-title clamp-1">${escapeHtml(src.label)}</div><div class="sub mono">${escapeHtml(src.domain)}</div></div><span class="badge">${getVisibleStoryCountForSource(src.id)}</span>`;
    row.addEventListener('click', () => {
      state.reader.selectedSourceId = src.id;
      renderPackList();
      renderHeadlineList();
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
  const sourceLabel = state.reader.sources.find((s) => s.id === state.reader.selectedSourceId)?.label || 'All sources';
  const isSearchActive = Boolean(state.reader.headlineSearch.trim());
  const articleLabel = isSearchActive
    ? `${rows.length} matching ${rows.length === 1 ? 'article' : 'articles'}`
    : `${rows.length} ${rows.length === 1 ? 'article' : 'articles'}`;
  els.headlineSummary.textContent = `${sourceLabel} · ${articleLabel} · Last ${state.reader.rangeHours}h`;
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
    row.className = 'headline-row';
    row.tabIndex = 0;
    row.dataset.storyId = st.id;
    const storyMeta = st.publishedAt
      ? `<span class="mono quiet story-time">${escapeHtml(formatStoryTime(st.publishedAt))}</span><span class="badge age">${formatAge(st.publishedAt)}</span>`
      : '<span class="badge quiet">No date</span>';
    row.innerHTML = `<div class="headline-content"><div class="headline-topline"><div class="source-meta">${iconMarkup(st.sourceDomain, st.sourceLabel, st.sourceIcon)}<span class="headline-source">${escapeHtml(st.sourceLabel)}</span><span class="mono quiet source-domain">${escapeHtml(st.sourceDomain)}</span></div><div class="story-meta">${storyMeta}</div></div><a class="headline-title headline-link" dir="auto" href="${escapeHtml(st.url)}" target="_blank" rel="noopener" title="Open article">${escapeHtml(st.title)}</a><div class="headline-excerpt" dir="auto">${escapeHtml(st.excerpt || '')}</div></div>`;
    row.addEventListener('click', (e) => {
      if (e.target.closest('a,button')) return;
      window.open(st.url, '_blank', 'noopener');
    });
    row.querySelector('.headline-link').addEventListener('click', (e) => e.stopPropagation());
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        window.open(st.url, '_blank', 'noopener');
      }
    });
    els.headlineList.appendChild(row);
  });
  updateReaderScopeSummary();
}

function renderStoryInspector() {
  if (!els.storyInspector) return;
  els.storyInspector.innerHTML = '';
}

function batchSetSelected(nextState) {
  if (!state.session.selectedFeedIds.size) return;
  state.session.selectedFeedIds.forEach((id) => {
    const feed = state.session.feeds.find((f) => f.id === id);
    if (feed) feed.state = nextState;
  });
  markPackDirty('feed-state');
  log(nextState === 'ignored' ? 'IGNORE' : 'INCLUDE', `${state.session.selectedFeedIds.size} selected feeds set to ${nextState}`, nextState === 'ignored' ? 'warn' : 'ok');
  state.session.selectedFeedIds.clear();
  state.session.selectionMode = false;
  rebuildReaderData();
  markPackDirty('feed-delete');
  syncReaderSelection();
  renderFeedList();
  renderDiscoverInspector();
  updateDiscoverMetrics();
  renderPackList();
  renderHeadlineList();
  refreshReaderStatus();
}

function syncReaderSelection() {
  if (!state.reader.sources.some((s) => s.id === state.reader.selectedSourceId)) state.reader.selectedSourceId = 'all';
}

function refreshReaderStatus() {
  if (state.mode !== 'reader') return;
  const visible = getFilteredHeadlines().length;
  const included = getIncludedFeeds().length;
  els.toolbarContext.textContent = `${included} sources`;
  els.toolbarSecondary.textContent = `${visible} articles`;
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
  markPackDirty('feed-delete');
  syncReaderSelection();
  renderFeedList();
  renderPackList();
  renderHeadlineList();
  refreshReaderStatus();
}

async function handleRefreshArticles() {
  log('REFRESH', 'Reloading latest articles', 'ok');
  if (els.refreshArticlesBtn) els.refreshArticlesBtn.disabled = true;
  try {
    await refreshReaderItemsFromBackend();
  } catch (err) {
    log('ERROR', `Refresh failed ${String(err?.message || err)}`, 'err');
  } finally {
    if (els.refreshArticlesBtn) els.refreshArticlesBtn.disabled = false;
  }
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
  state.session.freshnessDays = null;
  setDiscoverStatus('Starting', 'Preparing scan…');
  log('RUN', 'Find feeds clicked', 'ok');
  els.toolbarContext.textContent = 'Starting';
  els.toolbarSecondary.textContent = 'Reading input…';
  els.feedList.innerHTML = '<div class="hint">Scanning… valid feeds will appear here.</div>'; 
  els.startBtn.disabled = true;
  els.stopBtn.disabled = false;

  const feedByUrl = new Map();
  let validated = 0;
  let total = 0;
  let hasFatalError = false;
  const timeoutMs = state.session.scanMode === 'deep' ? 90000 : 45000;
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(new Error('discover-timeout')), timeoutMs);

  // Frontend abort closes the stream request cleanly; backend may continue processing briefly.
  state.session.streamController = new AbortController();
  state.session.streamController.signal.addEventListener('abort', () => timeoutController.abort(new Error('discover-aborted')));

  try {
    const res = await fetch('/api/discover-stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        seeds,
        scanMode: state.session.scanMode,
        freshnessDays: state.session.freshnessDays
      }),
      signal: timeoutController.signal
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      throw new Error(`discover-stream HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`);
    }
    if (!res.body) {
      log('WARN', 'Streaming body unavailable. Falling back to /api/discover.', 'warn');
      const fallback = await apiPost('/api/discover', {
        seeds,
        scanMode: state.session.scanMode,
        freshnessDays: state.session.freshnessDays
      });
      (fallback.feeds || []).forEach((feed) => {
        const normalized = normalizeFeed(feed);
        if (normalized && !feedByUrl.has(normalized.url)) {
          feedByUrl.set(normalized.url, normalized);
          state.session.feeds.push(normalized);
        }
      });
      return;
    }

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
        try { event = JSON.parse(line); } catch {
          log('WARN', `NDJSON parse failed for line: ${line.slice(0, 180)}`, 'warn');
          return;
        }

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
            markPackDirty('new-feed');
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
            setDiscoverStatus(`Checking feeds… ${validated} found`, `${getIncludedFeeds().length} included`);
          }
        } else if (event.type === 'error') {
          hasFatalError = true;
          els.feedList.innerHTML = `<div class="hint">Scan failed: ${escapeHtml(event.error || 'discover-stream-failed')}</div>`;
          setDiscoverStatus('Failed', event.error || 'discover-stream-failed');
          log('ERROR', `Backend error: ${event.error || 'discover-stream-failed'}`, 'err');
          state.session.running = false;
          throw new Error(event.error || 'discover-stream-failed');
        }
      });
    }
  } catch (err) {
    console.error('Discovery start failed', err);
    if (timeoutController.signal.aborted && String(err?.message || '').includes('discover-timeout')) {
      hasFatalError = true;
      log('ERROR', 'Scan timed out before results arrived. Try Quick scan or check the URL.', 'err');
      setDiscoverStatus('Timed out', 'No results before timeout');
      els.feedList.innerHTML = '<div class="hint">Scan timed out before results arrived. Try Quick scan or check the URL.</div>';
    } else if (String(err?.name || '') === 'AbortError') {
      log('STOP', 'Scan stopped by user request', 'warn');
    } else {
      hasFatalError = true;
      const msg = `Scan failed: ${String(err?.message || err)}`;
      log('ERROR', msg, 'err');
      setDiscoverStatus('Failed', msg);
      els.feedList.innerHTML = `<div class="hint">${escapeHtml(msg)}</div>`;
    }
  } finally {
    clearTimeout(timeoutId);
    state.session.running = false;
    state.session.streamController = null;
    els.startBtn.disabled = false;
    els.stopBtn.disabled = true;
  }
  if (!state.session.feeds.length && !hasFatalError) {
    log('DONE', 'No valid feed records found', 'warn');
    setDiscoverStatus('Complete', 'No feeds found');
    els.feedList.innerHTML = '<div class="hint">No feeds found. Try Standard/Deep scan or paste a direct RSS URL.</div>';
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
  els.toolbarMode.textContent = isDiscover ? 'Discover' : 'Preview';
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
    try {
      const seeds = parseSeeds(els.seedInput.value);
      if (!seeds.length) {
        const msg = 'No valid URLs found. Paste one or more website or feed URLs.';
        console.error(msg);
        log('REJECT', msg, 'err');
        setDiscoverStatus('Ready', msg);
        els.feedList.innerHTML = `<div class="hint">${escapeHtml(msg)}</div>`;
        return;
      }
      await runDiscoverySession(seeds);
    } catch (err) {
      console.error('Start handler error', err);
      const msg = `Scan failed: ${String(err?.message || err)}`;
      log('ERROR', msg, 'err');
      setDiscoverStatus('Failed', msg);
      els.feedList.innerHTML = `<div class="hint">${escapeHtml(msg)}</div>`;
      state.session.running = false;
      state.session.streamController = null;
      els.startBtn.disabled = false;
      els.stopBtn.disabled = true;
    }
  });
  els.stopBtn.addEventListener('click', () => {
    state.session.running = false;
    state.session.stopped = true;
    if (state.session.streamController) state.session.streamController.abort();
    log('STOP', 'Stop requested. Stream closed for this session.', 'warn');
    setDiscoverStatus('Stopped', 'Session interrupted');
  });
  els.clearBtn.addEventListener('click', clearSession);
  els.packSaveBtn?.addEventListener('click', saveCurrentPack);
  els.packSaveAsBtn?.addEventListener('click', saveCurrentPackAs);
  els.packLoadBtn?.addEventListener('click', openPacksDialog);
  els.closePacksBtn?.addEventListener('click', () => els.packsDialog?.close?.());
  const openPreview = async () => {
    const included = getIncludedFeeds().length;
    log('RUN', included ? `Preview latest articles from ${included} included feed(s)` : 'Preview latest articles with no included feeds', included ? 'ok' : 'warn');
    setMode('reader');
    try { await refreshReaderItemsFromBackend(); } catch (err) { log('ERROR', `Reader load failed ${String(err?.message || err)}`, 'err'); }
  };
  els.openReaderBtn?.addEventListener('click', async () => {
    await openPreview();
  });
  if (els.toolbarPreviewBtn) els.toolbarPreviewBtn.addEventListener('click', openPreview);
  [els.openLogBtn, els.toolbarLogBtn].forEach((btn) => btn?.addEventListener('click', () => {
    if (els.logDialog?.showModal) els.logDialog.showModal();
  }));
  if (els.closeLogBtn) els.closeLogBtn.addEventListener('click', () => els.logDialog?.close?.());
  if (els.closeDetailsBtn) els.closeDetailsBtn.addEventListener('click', () => els.detailsDialog?.close?.());
  els.backDiscoverBtn?.addEventListener('click', () => setMode('discover'));
  [els.discoverFilter, els.discoverSearch].forEach((el) => el.addEventListener('input', () => {
    rebuildReaderData();
    renderFeedList();
    renderDiscoverInspector();
    updateDiscoverMetrics();
  }));

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
      refreshReaderStatus();
  });
  els.headlineSearch.addEventListener('input', () => {
    state.reader.headlineSearch = els.headlineSearch.value.trim();
    renderHeadlineList();
      refreshReaderStatus();
  });
  els.seedInput.addEventListener('input', () => markPackDirty('seed-input'));
  els.scanModeSelect.addEventListener('change', () => { state.session.scanMode = els.scanModeSelect.value || 'standard'; markPackDirty('scan-mode'); });
  els.rangeSelect.addEventListener('change', () => {
    state.reader.rangeHours = Number(els.rangeSelect.value);
    renderHeadlineList();
      refreshReaderStatus();
  });
  els.refreshArticlesBtn?.addEventListener('click', handleRefreshArticles);
}

function init() {
  if (!assertRequiredEls()) return;
  bindEvents();
  state.savedPacks = loadSavedPacks();
  updatePackUi();
  clearSession();
  setMode('discover');
  log('RUNTIME', 'Discovery transport: local backend /api/discover-stream', 'ok');
}

init();
