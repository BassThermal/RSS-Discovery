const express = require('express');
const path = require('path');
const cheerio = require('cheerio');
const Parser = require('rss-parser');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const parser = new Parser({ timeout: 12000 });

const FEED_GUESSES = ['/feed', '/feed.xml', '/rss', '/rss.xml', '/atom.xml', '/index.xml', '/feed.json'];
const FEED_TYPE_PATTERN = /(application\/(rss|atom)\+xml|application\/xml|text\/xml|application\/feed\+json|application\/json)/i;
const FEED_HINT_PATTERN = /(rss|feed|atom|xml|jsonfeed|subscribe|syndication)/i;
const HARD_FEED_PATH_PATTERN = /\/(feed|rss|atom)(\b|[\/_-])/i;
const BINARY_EXT = /\.(png|jpe?g|gif|webp|svg|ico|pdf|zip|gz|mp4|mp3|avi|mov|woff2?|ttf)(\?|$)/i;
const SOCIAL_DOMAINS = new Set(['twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'pinterest.com', 'youtube.com', 'linkedin.com', 't.me']);
const TOOL_PATH_PATTERN = /(privacy|terms|about|contact|career|careers|adverti|login|signup|account|support|help|docs?|documentation|publisher|widget|widgets|builder|combiner|scheduler|embed|oembed|wp-json|api|jobs?|faq|cookies?|policy)/i;
const FEEDSPOT_JUNK_PATH = /(rss-feed|top-rss|blog|directory|news\/|news$|magazines?|podcasts?|websites?|infiniterss\.php)/i;
const JUNK_HOST_PATTERNS = [/^feedspot\.com$/i, /(?:^|\.)feedspot\.com$/i, /(?:^|\.)facebook\.com$/i, /(?:^|\.)twitter\.com$/i, /(?:^|\.)x\.com$/i];

const VALIDATION_CONCURRENCY = 6;
const SEED_CONCURRENCY = 2;
const READER_CONCURRENCY = 6;

const CACHE_TTL = {
  seedFetch: 10 * 60 * 1000,
  feedFetch: 5 * 60 * 1000,
  validation: 10 * 60 * 1000,
  parsedFeed: 5 * 60 * 1000,
  readerItems: 3 * 60 * 1000,
  icon: 24 * 60 * 60 * 1000
};

const cache = {
  seedFetch: new Map(),
  feedFetch: new Map(),
  validation: new Map(),
  parsedFeed: new Map(),
  readerItems: new Map(),
  icon: new Map()
};

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function getCache(map, key) {
  const hit = map.get(key);
  if (!hit) return null;
  if (hit.expires <= Date.now()) {
    map.delete(key);
    return null;
  }
  return hit.value;
}

function setCache(map, key, value, ttlMs) {
  map.set(key, { value, expires: Date.now() + ttlMs });
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

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function rootDomain(hostname) {
  const parts = hostname.replace(/^www\./, '').split('.').filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join('.') : parts.join('.');
}

function parseDateMaybe(value) {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

function normalizePublishedAt(value) {
  const parsed = typeof value === 'number' ? value : parseDateMaybe(value);
  if (!Number.isFinite(parsed)) return null;
  const now = Date.now();
  if (parsed > now + FUTURE_TOLERANCE_MS) return null;
  return Math.min(parsed, now);
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

function stripHtml(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function fetchText(url, options = {}) {
  const { cacheBucket = 'feedFetch' } = options;
  const targetMap = cache[cacheBucket] || cache.feedFetch;
  const ttl = CACHE_TTL[cacheBucket] || CACHE_TTL.feedFetch;
  const cached = getCache(targetMap, url);
  if (cached) return { ...cached, fromCache: true };

  const res = await fetch(url, {
    headers: {
      'user-agent': 'RSS-Discovery/1.0 (+local-proxy)',
      accept: 'text/html,application/xml,text/xml,application/rss+xml,application/atom+xml,application/feed+json,application/json,*/*'
    }
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = { text: await res.text(), contentType: res.headers.get('content-type') || '' };
  setCache(targetMap, url, payload, ttl);
  return { ...payload, fromCache: false };
}

function extractUrlCandidate(raw) {
  if (!raw) return null;
  let decoded = String(raw).trim();
  for (let i = 0; i < 3; i += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }

  if (/^site:/i.test(decoded)) decoded = decoded.replace(/^site:/i, '').trim();
  const match = decoded.match(/https?:\/\/[^\s"'<>]+/i);
  return normalizeUrl(match ? match[0] : decoded);
}

function unwrapKnownWrapper(candidateUrl) {
  try {
    const url = new URL(candidateUrl);
    const host = url.hostname.replace(/^www\./, '');
    const pathname = url.pathname.toLowerCase();

    const rawTargets = [];
    ['url', 'u', 'target', 'dest', 'destination', 'feed', 'q', 'redirect', 'to'].forEach((key) => {
      const v = url.searchParams.get(key);
      if (v) rawTargets.push(v);
    });

    for (const raw of rawTargets) {
      const candidate = extractUrlCandidate(raw);
      if (!candidate || candidate === candidateUrl) continue;
      return { canonical: candidate, wrapped: candidateUrl, kind: 'wrapped-target' };
    }

    if (host.endsWith('feedspot.com') && pathname.includes('infiniterss.php')) {
      return { canonical: null, wrapped: candidateUrl, kind: 'feedspot-wrapper' };
    }

    return { canonical: candidateUrl, wrapped: null, kind: '' };
  } catch {
    return { canonical: candidateUrl, wrapped: null, kind: '' };
  }
}

function rejectCandidate(rawUrl, context = {}) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    const pathname = url.pathname.toLowerCase();
    const query = url.search.toLowerCase();

    if (BINARY_EXT.test(rawUrl)) return 'binary-ext';
    if ([...SOCIAL_DOMAINS].some((d) => host === d || host.endsWith(`.${d}`))) return 'social-domain';
    if (JUNK_HOST_PATTERNS.some((pattern) => pattern.test(host)) && !FEED_HINT_PATTERN.test(pathname + query)) return 'known-junk-host';

    if (host.endsWith('feedspot.com') && pathname.includes('infiniterss.php')) return 'wrapper-not-feed';
    if (/\bq=site:\b/i.test(query) && !url.searchParams.get('q')?.replace(/site:/i, '').trim()) return 'empty-site-wrapper';
    if (/\/wp-json\//i.test(pathname) || /\/oembed\b/i.test(pathname) || /[?&](rest_route|oembed)=/i.test(query)) return 'embed-endpoint';
    if (TOOL_PATH_PATTERN.test(pathname) && !HARD_FEED_PATH_PATTERN.test(pathname)) return 'nav-or-tool-page';
    if (host.endsWith('feedspot.com') && FEEDSPOT_JUNK_PATH.test(pathname) && !host.startsWith('rss.')) return 'feedspot-directory-page';

    const fromAnchor = `${(context.anchorText || '').toLowerCase()} ${(context.rel || '').toLowerCase()}`;
    if (/(privacy|terms|about|careers?|docs?|contact|support|widgets?|home|tools?)/.test(fromAnchor) && !HARD_FEED_PATH_PATTERN.test(pathname)) return 'nav-link';

    const isLikelyFeed = HARD_FEED_PATH_PATTERN.test(pathname) || FEED_HINT_PATTERN.test(pathname) || FEED_HINT_PATTERN.test(query);
    if (!isLikelyFeed && (host.endsWith('feedspot.com') || context.kind === 'guess')) return 'unlikely-feed';

    return null;
  } catch {
    return 'invalid-url';
  }
}

function extractCandidates(html, seedUrl) {
  const $ = cheerio.load(html);
  const found = [];
  const seen = new Set();
  const stats = { skipped: 0, recovered: 0, detected: 0 };

  function pushRow(row) {
    found.push(row);
    if (row.rejectedBy) stats.skipped += 1;
    else if (row.wrapperAction === 'unwrapped') {
      stats.recovered += 1;
      stats.detected += 1;
    } else stats.detected += 1;
  }

  function addCandidate(href, context = {}) {
    const normalized = normalizeUrl(href, seedUrl);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);

    const unwrapped = unwrapKnownWrapper(normalized);
    if (unwrapped.wrapped && unwrapped.canonical) {
      const canonical = unwrapped.canonical;
      if (!seen.has(canonical)) seen.add(canonical);
      const canonicalRejectedBy = rejectCandidate(canonical, context);
      if (!canonicalRejectedBy) {
        pushRow({ url: canonical, wrappedUrl: unwrapped.wrapped, kind: context.kind || unwrapped.kind || 'anchor', wrapperAction: 'unwrapped' });
      } else {
        pushRow({ url: canonical, wrappedUrl: unwrapped.wrapped, kind: context.kind || unwrapped.kind || 'anchor', rejectedBy: canonicalRejectedBy, wrapperAction: 'unwrapped-rejected' });
      }
      return;
    }

    if (unwrapped.wrapped && !unwrapped.canonical) {
      pushRow({ url: normalized, wrappedUrl: normalized, kind: context.kind || unwrapped.kind || 'anchor', rejectedBy: 'wrapper-no-target', wrapperAction: 'unwrapped-empty' });
      return;
    }

    const rejectedBy = rejectCandidate(normalized, context);
    if (rejectedBy) {
      pushRow({ url: normalized, wrappedUrl: '', kind: context.kind || 'anchor', rejectedBy });
      return;
    }

    pushRow({ url: normalized, wrappedUrl: unwrapped.wrapped, kind: context.kind || unwrapped.kind || 'anchor' });
  }

  $('link[rel]').each((_, el) => {
    const rel = ($(el).attr('rel') || '').toLowerCase();
    if (!rel.includes('alternate')) return;

    const href = $(el).attr('href') || '';
    const type = ($(el).attr('type') || '').toLowerCase();
    if (!href || (!FEED_TYPE_PATTERN.test(type) && !FEED_HINT_PATTERN.test(href))) return;
    addCandidate(href, { kind: 'link-rel', rel });
  });

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const label = ($(el).text() || '').trim();
    const rel = ($(el).attr('rel') || '').toLowerCase();
    addCandidate(href, { kind: 'anchor', anchorText: label, rel });
  });

  FEED_GUESSES.forEach((guess) => addCandidate(guess, { kind: 'guess' }));
  return { found, stats };
}

function normalizeParsedItem(item, feedUrl, idx) {
  const url = normalizeUrl(item.link || item.guid || item.id || '', feedUrl) || feedUrl;
  const publishedAt = normalizePublishedAt(item.isoDate || item.pubDate || item.published || item.updated);

  return {
    id: item.guid || item.id || `${feedUrl}#${idx}`,
    title: String(item.title || 'Untitled item').trim(),
    url,
    excerpt: stripHtml(item.contentSnippet || item.summary || item.content || '').slice(0, 280),
    publishedAt,
    author: item.creator || item.author || ''
  };
}

function inferSourceDomain(seedUrl, feedUrl, parsed) {
  const feedDomain = getDomain(feedUrl);
  const homeUrl = normalizeUrl(parsed?.link || parsed?.feedUrl || '', feedUrl);
  const homeDomain = getDomain(homeUrl);
  if (!feedDomain) return homeDomain || getDomain(seedUrl);

  const feedRoot = rootDomain(feedDomain);
  const seedDomain = getDomain(seedUrl);
  const seedRoot = rootDomain(seedDomain);
  const homeRoot = rootDomain(homeDomain);

  if (homeDomain && homeRoot && homeRoot !== 'feedspot.com') return homeDomain;
  if (feedRoot && feedRoot !== 'feedspot.com') return feedDomain;
  if (seedRoot && seedRoot !== 'feedspot.com') return seedDomain;
  return homeDomain || feedDomain || seedDomain;
}

function iconForDomain(domain) {
  if (!domain) return '';
  const cached = getCache(cache.icon, domain);
  if (cached) return cached;
  const url = `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`;
  setCache(cache.icon, domain, url, CACHE_TTL.icon);
  return url;
}

function toFeedRecord(seedUrl, feedUrl, parsed, meta = {}) {
  const items = (parsed.items || []).slice(0, 80).map((item, idx) => normalizeParsedItem(item, feedUrl, idx));
  const latest = items.find((item) => item.title || item.url) || null;
  const latestAt = latest?.publishedAt || null;
  const sourceDomain = inferSourceDomain(seedUrl, feedUrl, parsed);

  return {
    id: `f-${Buffer.from(feedUrl).toString('base64').replace(/=+$/g, '').slice(-12)}`,
    sourceSeed: seedUrl,
    sourceDomain,
    sourceHome: normalizeUrl(parsed?.link || '', feedUrl) || '',
    sourceIcon: iconForDomain(sourceDomain),
    title: String(parsed.title || sourceDomain || getDomain(feedUrl) || 'Feed').trim(),
    url: feedUrl,
    wrappedUrl: meta.wrappedUrl || '',
    discoveredVia: meta.kind || 'scan',
    format: parsed.feedType || 'rss',
    state: 'candidate',
    latestTitle: latest?.title || 'No items detected',
    latestUrl: latest?.url || '',
    latestAt,
    latestAge: latestAt ? formatAge(latestAt) : 'Unknown time',
    items
  };
}

function looksLikeFeedDocument(text, contentType, url = '') {
  const sample = String(text || '').slice(0, 1200).toLowerCase();
  const type = String(contentType || '').toLowerCase();
  if (FEED_TYPE_PATTERN.test(type)) return true;
  if (/\b(rss|feed|atom|xml|json)\b/i.test(url)) return true;
  if (sample.includes('<rss') || sample.includes('<feed') || sample.includes('<rdf:rdf') || sample.includes('"version":"https://jsonfeed.org/version')) return true;
  return false;
}

async function parseFeedFromUrl(feedUrl) {
  const cachedParsed = getCache(cache.parsedFeed, feedUrl);
  if (cachedParsed) return { parsed: cachedParsed, fromCache: true };

  const fetched = await fetchText(feedUrl, { cacheBucket: 'feedFetch' });
  if (!looksLikeFeedDocument(fetched.text, fetched.contentType, feedUrl)) {
    throw new Error('not-feed-like');
  }

  const parsed = await parser.parseString(fetched.text);
  if (!parsed || !Array.isArray(parsed.items) || !parsed.items.length) throw new Error('invalid-feed');
  setCache(cache.parsedFeed, feedUrl, parsed, CACHE_TTL.parsedFeed);
  return { parsed, fromCache: fetched.fromCache };
}

async function mapLimit(items, limit, mapper) {
  const out = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const idx = nextIndex;
      nextIndex += 1;
      out[idx] = await mapper(items[idx], idx);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return out;
}

async function validateCandidate(seed, candidate, emit) {
  const cached = getCache(cache.validation, candidate.url);
  if (cached) {
    if (cached.ok) {
      emit({ code: 'VALID', level: 'ok', message: `cache hit ${candidate.url}` });
      return { ok: true, feed: cached.feed };
    }
    emit({ code: 'SKIP', level: 'warn', message: `cached reject ${candidate.url}` });
    return { ok: false };
  }

  try {
    const result = await parseFeedFromUrl(candidate.url);
    const feed = toFeedRecord(seed, candidate.url, result.parsed, candidate);
    setCache(cache.validation, candidate.url, { ok: true, feed }, CACHE_TTL.validation);
    emit({ code: 'VALID', level: 'ok', message: `${result.parsed.feedType || 'rss'} ${candidate.url}` });
    return { ok: true, feed };
  } catch {
    setCache(cache.validation, candidate.url, { ok: false }, CACHE_TTL.validation);
    emit({ code: 'REJECT', level: 'warn', message: `invalid feed ${candidate.url}` });
    return { ok: false };
  }
}

async function discoverFeeds(seeds, onEvent) {
  const logs = [];
  const dedupe = new Map();

  const emit = (row) => {
    logs.push(row);
    if (onEvent) onEvent({ type: 'log', ...row });
  };
  const emitProgress = (stage, detail = {}) => {
    if (onEvent) onEvent({ type: 'progress', stage, ...detail });
  };

  emit({ code: 'RUN', level: 'ok', message: `discovery session started (${seeds.length} seed(s))` });
  emitProgress('start', { seeds: seeds.length, feeds: 0 });

  let validated = 0;
  let totalCandidates = 0;

  await mapLimit(seeds, SEED_CONCURRENCY, async (seed) => {
    emit({ code: 'FETCH', level: 'ok', message: `seed ${seed}` });
    emitProgress('scanning-seed', { seed });

    let page;
    try {
      page = await fetchText(seed, { cacheBucket: 'seedFetch' });
    } catch (err) {
      emit({ code: 'REJECT', level: 'warn', message: `seed failed ${seed} (${err.message})` });
      return;
    }

    const { found: extracted, stats } = extractCandidates(page.text, seed);
    const candidates = extracted.filter((candidate) => !candidate.rejectedBy);
    totalCandidates += candidates.length;

    emit({ code: 'DETECT', level: 'ok', message: `${seed} recovered ${stats.detected} candidates (${stats.skipped} skipped early)` });
    emitProgress('candidates-recovered', { seed, detected: stats.detected, skipped: stats.skipped, recovered: stats.recovered, totalCandidates });

    extracted.forEach((candidate) => {
      if (candidate.wrapperAction === 'unwrapped') {
        emit({ code: 'UNWRAP', level: 'ok', message: `recovered ${candidate.url}` });
      } else if (candidate.wrapperAction === 'unwrapped-empty') {
        emit({ code: 'SKIP', level: 'warn', message: `junk candidate ${candidate.url}` });
      } else if (candidate.rejectedBy) {
        if (stats.skipped <= 40) emit({ code: 'SKIP', level: 'warn', message: `${candidate.rejectedBy} ${candidate.url}` });
      }
    });

    await mapLimit(candidates, VALIDATION_CONCURRENCY, async (candidate) => {
      if (dedupe.has(candidate.url)) return;
      emitProgress('validating', { validated: validated + 1, total: Math.max(totalCandidates, validated + 1), feeds: dedupe.size });
      const result = await validateCandidate(seed, candidate, emit);
      validated += 1;
      if (!result.ok || !result.feed) return;
      if (!dedupe.has(candidate.url)) {
        dedupe.set(candidate.url, result.feed);
        if (onEvent) onEvent({ type: 'feed', feed: result.feed, totalFeeds: dedupe.size });
      }
      emitProgress('validating', { validated, total: Math.max(totalCandidates, validated), feeds: dedupe.size });
    });
  });

  const feeds = [...dedupe.values()].sort((a, b) => (b.latestAt || 0) - (a.latestAt || 0) || a.title.localeCompare(b.title));
  emit({ code: 'DONE', level: feeds.length ? 'ok' : 'warn', message: `${feeds.length} valid feeds discovered` });
  emitProgress('done', { feeds: feeds.length, validated, totalCandidates });
  return { feeds, logs };
}

async function loadReaderItems(feeds) {
  const logs = [];
  const items = [];

  await mapLimit(feeds, READER_CONCURRENCY, async (feed) => {
    const url = normalizeUrl(feed.url);
    if (!url) return;

    const cacheKey = `${feed.id || url}:${url}`;
    const cached = getCache(cache.readerItems, cacheKey);
    if (cached) {
      cached.forEach((item) => items.push(item));
      logs.push({ code: 'READER', level: 'ok', message: `cache hit ${url}` });
      return;
    }

    try {
      const parsedResult = await parseFeedFromUrl(url);
      const parsed = parsedResult.parsed;
      const sourceDomain = inferSourceDomain(feed.sourceSeed || url, url, parsed);
      const nextItems = [];
      (parsed.items || []).slice(0, 80).forEach((item, idx) => {
        const normalized = normalizeParsedItem(item, url, idx);
        nextItems.push({
          id: `${feed.id || Buffer.from(url).toString('base64').slice(-10)}-${idx}`,
          sourceId: feed.id || url,
          sourceLabel: feed.title || parsed.title || sourceDomain,
          sourceDomain,
          sourceIcon: iconForDomain(sourceDomain),
          feedUrl: url,
          ...normalized
        });
      });
      setCache(cache.readerItems, cacheKey, nextItems, CACHE_TTL.readerItems);
      nextItems.forEach((item) => items.push(item));
      logs.push({ code: 'VALID', level: 'ok', message: `reader loaded ${url}` });
    } catch {
      logs.push({ code: 'REJECT', level: 'warn', message: `reader failed ${url}` });
    }
  });

  items.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
  return { items, logs };
}

app.post('/api/discover', async (req, res) => {
  try {
    const seeds = Array.isArray(req.body?.seeds) ? req.body.seeds.map((s) => normalizeUrl(s)).filter(Boolean) : [];
    if (!seeds.length) return res.status(400).json({ error: 'No valid seeds supplied', feeds: [], logs: [] });
    return res.json(await discoverFeeds(seeds));
  } catch (err) {
    return res.status(500).json({ error: err.message || 'discover-failed', feeds: [], logs: [] });
  }
});

app.post('/api/discover-stream', async (req, res) => {
  const seeds = Array.isArray(req.body?.seeds) ? req.body.seeds.map((s) => normalizeUrl(s)).filter(Boolean) : [];
  if (!seeds.length) return res.status(400).json({ error: 'No valid seeds supplied' });

  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('x-accel-buffering', 'no');

  const send = (row) => res.write(`${JSON.stringify(row)}\n`);
  send({ type: 'session', ok: true, seeds: seeds.length });

  try {
    const result = await discoverFeeds(seeds, send);
    send({ type: 'done', feeds: result.feeds.length });
    return res.end();
  } catch (err) {
    send({ type: 'error', error: err.message || 'discover-failed' });
    return res.end();
  }
});

app.post('/api/reader-items', async (req, res) => {
  try {
    const feeds = Array.isArray(req.body?.feeds) ? req.body.feeds : [];
    return res.json(await loadReaderItems(feeds));
  } catch (err) {
    return res.status(500).json({ error: err.message || 'reader-failed', items: [], logs: [] });
  }
});

app.listen(PORT, () => {
  console.log(`RSS Discovery running on http://localhost:${PORT}`);
});
