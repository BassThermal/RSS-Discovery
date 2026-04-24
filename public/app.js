    const state = {
      mode: 'discover',
      session: {
        runId: 0,
        running: false,
        stopped: false,
        seeds: 0,
        feeds: [],
        selectedFeedId: null,
        selectedFeedIds: new Set()
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
      seedInput: document.getElementById('seedInput'),
      discoverFilter: document.getElementById('discoverFilter'),
      discoverSearch: document.getElementById('discoverSearch'),
      startBtn: document.getElementById('startBtn'),
      stopBtn: document.getElementById('stopBtn'),
      clearBtn: document.getElementById('clearBtn'),
      keepSelectedBtn: document.getElementById('keepSelectedBtn'),
      excludeSelectedBtn: document.getElementById('excludeSelectedBtn'),
      openReaderBtn: document.getElementById('openReaderBtn'),
      backDiscoverBtn: document.getElementById('backDiscoverBtn'),
      metricDiscovered: document.getElementById('metricDiscovered'),
      metricKept: document.getElementById('metricKept'),
      metricExcluded: document.getElementById('metricExcluded'),
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
      headlineList: document.getElementById('headlineList'),
      headlineCount: document.getElementById('headlineCount'),
      headlineSummary: document.getElementById('headlineSummary'),
      storyInspector: document.getElementById('storyInspector')
    };

    const parseDateMaybe = value => {
      if (!value) return null;
      const ts = Date.parse(value);
      return Number.isFinite(ts) ? ts : null;
    };

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

    const getDomain = (input) => { try { return new URL(input).hostname.replace(/^www\./, ''); } catch { return ''; } };

    function parseSeeds(raw) {
      return [...new Set(raw.split(/[\s,\n]+/g).map(v => normalizeUrl(v)).filter(Boolean))];
    }

    function formatAge(ts) {
      if (!ts) return 'unknown';
      const delta = Date.now() - ts;
      if (delta < 0) return 'future';
      const h = Math.floor(delta / 3600000);
      if (h < 1) return `${Math.max(1, Math.floor(delta / 60000))}m ago`;
      if (h < 48) return `${h}h ago`;
      return `${Math.floor(h / 24)}d ago`;
    }

    function log(code, message, cls = '') {
      const ts = new Date().toISOString().slice(11, 19);
      state.logs.push({ ts, code, message, cls });
      renderTerminal();
    }

    function renderTerminal() {
      els.terminal.innerHTML = '';
      els.logCount.textContent = `${state.logs.length} actions`;
      if (!state.logs.length) return (els.terminal.innerHTML = '<div class="hint">Session idle. Awaiting crawl start.</div>');
      state.logs.slice(-300).forEach(row => {
        const line = document.createElement('div');
        line.className = 'log-row';
        line.innerHTML = `<div>${row.ts}</div><div class="log-code ${row.cls}">${row.code}</div><div>${row.message}</div>`;
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

    function normalizeFeed(raw) {
      const url = normalizeUrl(raw?.url || '');
      if (!url) return null;
      const items = Array.isArray(raw?.items) ? raw.items.map((it, idx) => ({
        id: it.id || `${url}#${idx}`,
        title: it.title || 'Untitled item',
        url: normalizeUrl(it.url || '', url) || url,
        excerpt: String(it.excerpt || '').slice(0, 360),
        publishedAt: typeof it.publishedAt === 'number' ? it.publishedAt : parseDateMaybe(it.publishedAt),
        author: it.author || ''
      })) : [];
      const latest = items[0] || null;
      const latestAt = latest?.publishedAt || parseDateMaybe(raw?.latestAt);
      return {
        id: raw?.id || `f-${btoa(url).replace(/=+$/g, '').slice(-12)}`,
        sourceSeed: normalizeUrl(raw?.sourceSeed || url) || url,
        sourceDomain: raw?.sourceDomain || getDomain(raw?.sourceSeed || url),
        title: raw?.title || getDomain(url),
        url,
        format: (raw?.format || 'rss').toLowerCase(),
        state: raw?.state === 'kept' || raw?.state === 'excluded' ? raw.state : 'candidate',
        latestTitle: raw?.latestTitle || latest?.title || 'No items detected',
        latestUrl: normalizeUrl(raw?.latestUrl || latest?.url || '', url) || '',
        latestAt,
        latestAge: latestAt ? formatAge(latestAt) : 'unknown',
        items
      };
    }

    function deriveReaderSourcesFromFeeds(feeds) {
      const kept = feeds.filter(f => f.state === 'kept');
      const rows = kept.map(feed => ({ id: feed.id, label: feed.title, domain: feed.sourceDomain, feedUrl: feed.url, active: true, stories: (feed.items || []).length }));
      const total = rows.reduce((n, r) => n + r.stories, 0);
      return [{ id: 'all', label: 'All kept feeds', domain: 'session', feedUrl: '', active: true, stories: total }, ...rows];
    }

    function deriveStoriesFromFeeds(feeds) {
      const stories = [];
      feeds.filter(f => f.state === 'kept').forEach(feed => {
        (feed.items || []).forEach((item, idx) => {
          stories.push({
            id: `${feed.id}-s-${idx}`,
            sourceId: feed.id,
            sourceLabel: feed.title,
            sourceDomain: feed.sourceDomain,
            feedUrl: feed.url,
            title: item.title || 'Untitled item',
            excerpt: item.excerpt || '',
            publishedAt: item.publishedAt || 0,
            url: item.url || feed.url,
            author: item.author || ''
          });
        });
      });
      stories.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
      return stories;
    }

    function rebuildReaderData() {
      state.reader.sources = deriveReaderSourcesFromFeeds(state.session.feeds);
      state.reader.stories = deriveStoriesFromFeeds(state.session.feeds);
    }

    function resetSessionData() {
      state.session.feeds = [];
      state.session.selectedFeedId = null;
      state.session.selectedFeedIds.clear();
      state.reader.selectedSourceId = 'all';
      state.reader.selectedHeadlineId = null;
      rebuildReaderData();
      renderFeedList(); renderDiscoverInspector(); updateDiscoverMetrics(); renderPackList(); renderHeadlineList(); renderStoryInspector();
    }

    function clearSession() {
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
      return state.session.feeds.filter(feed => {
        const stateOk = filter === 'all' || feed.state === filter;
        const hay = `${feed.title} ${feed.sourceDomain} ${feed.url} ${feed.latestTitle}`.toLowerCase();
        return stateOk && (!q || hay.includes(q));
      });
    }

    function renderFeedList() {
      const filtered = getFilteredFeeds();
      els.feedList.innerHTML = '';
      els.feedListCount.textContent = `${filtered.length} shown`;
      if (!filtered.length) return (els.feedList.innerHTML = '<div class="hint">No valid feed records for current filter.</div>');
      filtered.forEach(feed => {
        const row = document.createElement('div');
        row.className = `feed-row ${feed.state === 'excluded' ? 'excluded' : ''} ${feed.state === 'kept' ? 'kept' : ''} ${feed.id === state.session.selectedFeedId ? 'selected' : ''}`;
        row.innerHTML = `<input type="checkbox" data-id="${feed.id}" ${state.session.selectedFeedIds.has(feed.id) ? 'checked' : ''} /><span class="dot"></span><div class="feed-main"><div class="topline"><span class="domain">${feed.sourceDomain}</span><span class="badge type">${feed.format}</span><span class="badge state-${feed.state}">${feed.state}</span></div><div class="title">${feed.title}</div><div class="sub url">${feed.url}</div></div><button class="row-action" data-act="toggle">${feed.state === 'excluded' ? '↺' : '×'}</button><div class="preview"><div class="p-title">${feed.title}</div><div class="p-line">Source: ${feed.sourceSeed}</div><div class="p-line">Type: ${feed.format.toUpperCase()} · ${feed.state}</div><div class="p-line">Latest: ${feed.latestTitle || 'n/a'}</div><div class="p-line">Age: ${feed.latestAge || 'unknown'}</div></div>`;
        row.addEventListener('click', e => { if (e.target.matches('input,button')) return; state.session.selectedFeedId = feed.id; renderFeedList(); renderDiscoverInspector(); });
        row.querySelector('input').addEventListener('change', e => { e.target.checked ? state.session.selectedFeedIds.add(feed.id) : state.session.selectedFeedIds.delete(feed.id); });
        row.querySelector('[data-act="toggle"]').addEventListener('click', e => { e.stopPropagation(); setFeedState(feed.id, feed.state === 'excluded' ? 'candidate' : 'excluded'); });
        els.feedList.appendChild(row);
      });
    }

    function setFeedState(id, nextState) {
      const feed = state.session.feeds.find(f => f.id === id);
      if (!feed) return;
      feed.state = nextState;
      log(nextState === 'excluded' ? 'REJECT' : 'VALID', `${feed.title} set to ${nextState}`, nextState === 'excluded' ? 'warn' : 'ok');
      rebuildReaderData(); syncReaderSelection(); renderFeedList(); renderDiscoverInspector(); updateDiscoverMetrics(); renderPackList(); renderHeadlineList(); renderStoryInspector(); refreshReaderStatus();
    }

    function updateDiscoverMetrics() {
      const total = state.session.feeds.length;
      const kept = state.session.feeds.filter(f => f.state === 'kept').length;
      const excluded = state.session.feeds.filter(f => f.state === 'excluded').length;
      const candidate = total - kept - excluded;
      els.metricDiscovered.textContent = total;
      els.metricKept.textContent = kept;
      els.metricExcluded.textContent = excluded;
      els.discoverSummary.textContent = `${total} total · ${candidate} candidate · ${kept} kept · ${excluded} excluded`;
      if (state.mode === 'discover') els.toolbarSecondary.textContent = `Seeds ${state.session.seeds || 0} · Feeds ${total}`;
    }

    function renderDiscoverInspector() {
      const feed = state.session.feeds.find(f => f.id === state.session.selectedFeedId);
      if (!feed) return (els.discoverInspector.innerHTML = '<div class="hint">Select a discovered feed to inspect details.</div>');
      els.discoverInspector.innerHTML = `<div class="block"><div class="k">Source</div><div class="v">${feed.sourceDomain}</div><div class="s mono">${feed.sourceSeed}</div></div><div class="block"><div class="k">Feed</div><div class="v">${feed.title}</div><div class="s mono">${feed.url}</div><div class="s">Format ${feed.format.toUpperCase()} · State ${feed.state}</div></div><div class="block"><div class="k">Latest item</div><div class="v">${feed.latestTitle || 'No item title'}</div><div class="s mono">${feed.latestUrl || 'No article URL'}</div><div class="s">Published ${feed.latestAge || 'unknown'}</div></div><div class="row2"><button class="btn micro" id="insKeep">Keep</button><button class="btn micro danger" id="insExclude">Exclude</button></div><div class="row2"><button class="btn micro" id="insOpenFeed">Open feed</button><button class="btn micro" id="insOpenArticle" ${feed.latestUrl ? '' : 'disabled'}>Open latest</button></div>`;
      document.getElementById('insKeep').addEventListener('click', () => setFeedState(feed.id, 'kept'));
      document.getElementById('insExclude').addEventListener('click', () => setFeedState(feed.id, 'excluded'));
      document.getElementById('insOpenFeed').addEventListener('click', () => window.open(feed.url, '_blank', 'noopener'));
      document.getElementById('insOpenArticle').addEventListener('click', () => feed.latestUrl && window.open(feed.latestUrl, '_blank', 'noopener'));
    }

    const getFilteredSources = () => state.reader.sources.filter(src => src.id === 'all' || !state.reader.sourceSearch || `${src.label} ${src.domain} ${src.feedUrl}`.toLowerCase().includes(state.reader.sourceSearch.toLowerCase()));
    function getFilteredHeadlines() {
      const query = state.reader.headlineSearch.toLowerCase();
      const cutoff = Date.now() - state.reader.rangeHours * 3600 * 1000;
      return state.reader.stories.filter(st => state.reader.selectedSourceId === 'all' || st.sourceId === state.reader.selectedSourceId).filter(st => !st.publishedAt || st.publishedAt >= cutoff).filter(st => !query || `${st.title} ${st.excerpt} ${st.url}`.toLowerCase().includes(query));
    }

    function renderPackList() {
      const sources = getFilteredSources();
      const kept = state.session.feeds.filter(f => f.state === 'kept').length;
      els.packList.innerHTML = '';
      els.packCount.textContent = `${kept} active sources`;
      els.packSummary.textContent = kept ? `Kept feeds ${kept}` : 'No active Reader feeds yet. Keep feeds in Discover.';
      if (!sources.length) return (els.packList.innerHTML = '<div class="hint">No source rows match search.</div>');
      sources.forEach(src => {
        const row = document.createElement('div');
        row.className = `pack-row ${state.reader.selectedSourceId === src.id ? 'selected' : ''}`;
        row.innerHTML = `<span class="dot"></span><div class="pack-main"><div class="pack-title">${src.label}</div><div class="sub mono">${src.domain}</div></div><span class="badge">${src.stories}</span>`;
        row.addEventListener('click', () => { state.reader.selectedSourceId = src.id; state.reader.selectedHeadlineId = null; renderPackList(); renderHeadlineList(); renderStoryInspector(); refreshReaderStatus(); });
        els.packList.appendChild(row);
      });
    }

    function renderHeadlineList() {
      const rows = getFilteredHeadlines();
      els.headlineList.innerHTML = '';
      els.headlineCount.textContent = `${rows.length} shown`;
      els.headlineSummary.textContent = `Range ${state.reader.rangeHours}h · Source ${state.reader.selectedSourceId} · Loaded ${state.reader.stories.length}`;
      if (!state.session.feeds.some(f => f.state === 'kept')) return (els.headlineList.innerHTML = '<div class="hint">No active Reader feeds yet. Keep feeds in Discover.</div>');
      if (!state.reader.stories.length) return (els.headlineList.innerHTML = '<div class="hint">No readable items were loaded from active feeds.</div>');
      if (!rows.length) return (els.headlineList.innerHTML = '<div class="hint">No stories match source/search/range filters.</div>');
      rows.forEach(st => {
        const row = document.createElement('div');
        row.className = `headline-row ${state.reader.selectedHeadlineId === st.id ? 'selected' : ''}`;
        row.innerHTML = `<div class="headline-main"><div class="topline"><span class="headline-source">${st.sourceLabel}</span><span class="mono">${st.publishedAt ? new Date(st.publishedAt).toLocaleString() : 'No date'}</span></div><div class="title">${st.title}</div><div class="sub">${st.excerpt || 'No excerpt available.'}</div></div><span class="badge">${st.publishedAt ? formatAge(st.publishedAt) : 'n/a'}</span><div class="preview"><div class="p-title">${st.title}</div><div class="p-line">Source: ${st.sourceLabel} · ${st.sourceDomain}</div><div class="p-line">Published: ${st.publishedAt ? new Date(st.publishedAt).toLocaleString() : 'No date'}</div><div class="p-line">${(st.excerpt || 'No excerpt').slice(0, 120)}</div><div class="p-line mono">${st.url}</div></div>`;
        row.addEventListener('click', () => { state.reader.selectedHeadlineId = st.id; renderHeadlineList(); renderStoryInspector(); refreshReaderStatus(); });
        els.headlineList.appendChild(row);
      });
    }

    function renderStoryInspector() {
      const st = state.reader.stories.find(s => s.id === state.reader.selectedHeadlineId);
      if (!st) return (els.storyInspector.innerHTML = '<div class="hint">Select a headline row to inspect story details.</div>');
      els.storyInspector.innerHTML = `<div class="block"><div class="k">Story</div><div class="v">${st.title}</div><div class="s mono">${st.url}</div></div><div class="block"><div class="k">Source</div><div class="s">${st.sourceLabel} · ${st.sourceDomain}</div><div class="s mono">${st.feedUrl}</div><div class="s">Published ${st.publishedAt ? new Date(st.publishedAt).toLocaleString() : 'unknown'}</div></div><div class="block"><div class="k">Excerpt</div><div class="s">${st.excerpt || 'No excerpt available.'}</div></div><div class="row2"><button class="btn micro" id="openStoryBtn">Open article</button><button class="btn micro" id="openStoryFeedBtn">Open source feed</button></div>`;
      document.getElementById('openStoryBtn').addEventListener('click', () => window.open(st.url, '_blank', 'noopener'));
      document.getElementById('openStoryFeedBtn').addEventListener('click', () => window.open(st.feedUrl, '_blank', 'noopener'));
    }

    function batchSetSelected(nextState) {
      if (!state.session.selectedFeedIds.size) return;
      state.session.selectedFeedIds.forEach(id => { const feed = state.session.feeds.find(f => f.id === id); if (feed) feed.state = nextState; });
      log(nextState === 'excluded' ? 'REJECT' : 'VALID', `${state.session.selectedFeedIds.size} selected feeds set to ${nextState}`, nextState === 'excluded' ? 'warn' : 'ok');
      rebuildReaderData(); syncReaderSelection(); renderFeedList(); renderDiscoverInspector(); updateDiscoverMetrics(); renderPackList(); renderHeadlineList(); renderStoryInspector(); refreshReaderStatus();
    }

    function syncReaderSelection() {
      if (!state.reader.sources.some(s => s.id === state.reader.selectedSourceId)) state.reader.selectedSourceId = 'all';
      const visible = getFilteredHeadlines();
      if (state.reader.selectedHeadlineId && !visible.some(s => s.id === state.reader.selectedHeadlineId)) state.reader.selectedHeadlineId = visible[0]?.id || null;
    }

    function refreshReaderStatus() {
      if (state.mode !== 'reader') return;
      const visible = getFilteredHeadlines().length;
      els.toolbarContext.textContent = 'Reader active';
      els.toolbarSecondary.textContent = `${visible} visible stories`;
      els.statusLeft.textContent = 'READER · Active';
      els.statusRight.textContent = `Loaded ${state.reader.stories.length} · Range ${state.reader.rangeHours}h`;
    }

    async function refreshReaderItemsFromBackend() {
      const keptFeeds = state.session.feeds.filter(f => f.state === 'kept');
      if (!keptFeeds.length) return;
      log('READER', 'Loading reader items via local backend', 'ok');
      const payload = await apiPost('/api/reader-items', { feeds: keptFeeds.map(f => ({ id: f.id, title: f.title, sourceDomain: f.sourceDomain, url: f.url })) });
      (payload.logs || []).forEach(row => log(row.code || 'READER', row.message || '', row.level === 'warn' ? 'warn' : row.level === 'error' ? 'err' : 'ok'));
      const itemsByFeed = new Map();
      (payload.items || []).forEach(item => {
        const next = { ...item, publishedAt: typeof item.publishedAt === 'number' ? item.publishedAt : parseDateMaybe(item.publishedAt) || 0 };
        if (!itemsByFeed.has(next.sourceId)) itemsByFeed.set(next.sourceId, []);
        itemsByFeed.get(next.sourceId).push(next);
      });
      state.session.feeds.forEach(feed => {
        if (feed.state !== 'kept') return;
        const rows = itemsByFeed.get(feed.id) || [];
        feed.items = rows.map(item => ({ id: item.id, title: item.title, url: item.url, excerpt: item.excerpt, publishedAt: item.publishedAt, author: item.author }));
        const first = feed.items[0];
        if (first) {
          feed.latestTitle = first.title;
          feed.latestUrl = first.url;
          feed.latestAt = first.publishedAt;
          feed.latestAge = first.publishedAt ? formatAge(first.publishedAt) : 'unknown';
        }
      });
      rebuildReaderData();
      syncReaderSelection();
      renderPackList(); renderHeadlineList(); renderStoryInspector(); refreshReaderStatus();
    }

    async function runDiscoverySession(seeds) {
      clearSession();
      state.session.runId += 1;
      state.session.running = true;
      state.session.stopped = false;
      state.session.seeds = seeds.length;
      setDiscoverStatus('Running', `Seeds ${seeds.length}`);
      log('RUN', `Discovery session started for ${seeds.length} seed(s)`, 'ok');
      try {
        const result = await apiPost('/api/discover', { seeds });
        (result.logs || []).forEach(row => log(row.code || 'DISCOVER', row.message || '', row.level === 'warn' ? 'warn' : row.level === 'error' ? 'err' : 'ok'));
        state.session.feeds = (result.feeds || []).map(normalizeFeed).filter(Boolean);
      } catch (err) {
        log('ERROR', `Discovery failed ${String(err?.message || err)}`, 'err');
      }
      state.session.running = false;
      if (!state.session.feeds.length) {
        log('DONE', 'No valid feed records found', 'warn');
        setDiscoverStatus('Complete', '0 feeds discovered');
      } else {
        log('DONE', `${state.session.feeds.length} valid feeds discovered`, 'ok');
        setDiscoverStatus('Complete', `${state.session.feeds.length} feeds discovered`);
      }
      if (!state.session.selectedFeedId && state.session.feeds[0]) state.session.selectedFeedId = state.session.feeds[0].id;
      rebuildReaderData(); renderFeedList(); renderDiscoverInspector(); updateDiscoverMetrics(); renderPackList(); renderHeadlineList(); renderStoryInspector();
    }

    function setMode(mode) {
      state.mode = mode;
      const isDiscover = mode === 'discover';
      els.navButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.mode === mode));
      els.modePanels.forEach(panel => panel.classList.toggle('active', panel.dataset.panel === mode));
      els.discoverPane.classList.toggle('active', isDiscover);
      els.readerPane.classList.toggle('active', !isDiscover);
      els.discoverActions.classList.toggle('hidden', !isDiscover);
      els.readerActions.classList.toggle('hidden', isDiscover);
      els.toolbarMode.textContent = isDiscover ? 'Discover' : 'Reader';
      if (isDiscover) {
        els.toolbarContext.textContent = state.session.running ? 'Running' : (state.session.feeds.length ? 'Complete' : 'Idle');
        els.toolbarSecondary.textContent = `Seeds ${state.session.seeds || 0} · Feeds ${state.session.feeds.length}`;
        els.statusLeft.textContent = `DISCOVER · ${els.toolbarContext.textContent}`;
        els.statusRight.textContent = els.toolbarSecondary.textContent;
      } else {
        syncReaderSelection();
        refreshReaderStatus();
      }
    }

    function bindEvents() {
      els.navButtons.forEach(btn => btn.addEventListener('click', () => setMode(btn.dataset.mode)));
      els.startBtn.addEventListener('click', async () => {
        const seeds = parseSeeds(els.seedInput.value);
        if (!seeds.length) return log('REJECT', 'No seed URLs provided. Session not started.', 'err');
        await runDiscoverySession(seeds);
      });
      els.stopBtn.addEventListener('click', () => { state.session.running = false; state.session.stopped = true; log('STOP', 'Stop acknowledged. Current backend request cannot be aborted.', 'warn'); setDiscoverStatus('Stopped', 'Session interrupted'); });
      els.clearBtn.addEventListener('click', clearSession);
      els.keepSelectedBtn.addEventListener('click', () => batchSetSelected('kept'));
      els.excludeSelectedBtn.addEventListener('click', () => batchSetSelected('excluded'));
      els.openReaderBtn.addEventListener('click', async () => {
        const kept = state.session.feeds.filter(f => f.state === 'kept').length;
        log('RUN', kept ? `Open Reader with ${kept} kept feed(s)` : 'Open Reader with no kept feeds', kept ? 'ok' : 'warn');
        setMode('reader');
        try { await refreshReaderItemsFromBackend(); } catch (err) { log('ERROR', `Reader load failed ${String(err?.message || err)}`, 'err'); }
      });
      els.backDiscoverBtn.addEventListener('click', () => setMode('discover'));
      [els.discoverFilter, els.discoverSearch].forEach(el => el.addEventListener('input', () => { renderFeedList(); renderDiscoverInspector(); }));
      els.readerSourceSearch.addEventListener('input', () => { state.reader.sourceSearch = els.readerSourceSearch.value.trim(); renderPackList(); renderHeadlineList(); renderStoryInspector(); refreshReaderStatus(); });
      els.headlineSearch.addEventListener('input', () => { state.reader.headlineSearch = els.headlineSearch.value.trim(); renderHeadlineList(); renderStoryInspector(); refreshReaderStatus(); });
      els.rangeSelect.addEventListener('change', () => { state.reader.rangeHours = Number(els.rangeSelect.value); renderHeadlineList(); renderStoryInspector(); refreshReaderStatus(); });
    }

    function init() {
      bindEvents();
      clearSession();
      setMode('discover');
      log('RUNTIME', 'Discovery transport: local backend /api/discover', 'ok');
    }

    init();
  
