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
const BINARY_EXT = /\.(png|jpe?g|gif|webp|svg|ico|pdf|zip|gz|mp4|mp3|avi|mov|woff2?|ttf|7z|exe|dmg)(\?|$)/i;
const SOCIAL_DOMAINS = new Set(['twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'pinterest.com', 'youtube.com', 'linkedin.com', 't.me']);
const TOOL_PATH_PATTERN = /(privacy|terms|about|contact|career|careers|adverti|login|signup|account|support|help|docs?|documentation|publisher|widget|widgets|builder|combiner|scheduler|embed|oembed|wp-json|api|jobs?|faq|cookies?|policy)/i;
const FEEDSPOT_JUNK_PATH = /(rss-feed|top-rss|blog|directory|news\/|news$|magazines?|podcasts?|websites?|infiniterss\.php)/i;
const JUNK_HOST_PATTERNS = [/^feedspot\.com$/i, /(?:^|\.)feedspot\.com$/i, /(?:^|\.)facebook\.com$/i, /(?:^|\.)twitter\.com$/i, /(?:^|\.)x\.com$/i];
const SCAN_LINK_HINT_PATTERN = /\/(feed|rss|atom|blog|news|articles|stories|posts|subscribe|press|updates|category|tag)(\/|$|\?|#)/i;

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

function getScanConfig(scanMode = 'standard') {
  const mode = String(scanMode || 'standard').toLowerCase();
  if (mode === 'quick') {
    return { mode: 'quick', maxDepth: 0, maxPagesPerSeed: 1 };
  }
  if (mode === 'deep') {
    return { mode: 'deep', maxDepth: 2, maxPagesPerSeed: 50 };
  }
  return { mode: 'standard', maxDepth: 1, maxPagesPerSeed: 12 };
}

async function fetchText(url, options = {}) {
  const { cacheBucket = 'feedFetch', timeoutMs = 15000 } = options;
  const targetMap = cache[cacheBucket] || cache.feedFetch;
  const ttl = CACHE_TTL[cacheBucket] || CACHE_TTL.feedFetch;
  const cached = getCache(targetMap, url);
  if (cached) return { ...cached, fromCache: true };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error(`fetch-timeout ${url}`)), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
    headers: {
      'user-agent': 'RSS-Discovery/1.0 (+local-proxy)',
      accept: 'text/html,application/xml,text/xml,application/rss+xml,application/atom+xml,application/feed+json,application/json,*/*'
    },
    signal: controller.signal
    });
  } catch (err) {
    if (controller.signal.aborted) throw new Error(`fetch-timeout ${url}`);
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = { text: await res.text(), contentType: res.headers.get('content-type') || '' };
  setCache(targetMap, url, payload, ttl);
  return { ...payload, fromCache: false };
}

function isSocialHost(host) {
  return [...SOCIAL_DOMAINS].some((d) => host === d || host.endsWith(`.${d}`));
}

function isLikelyHtmlDocument(text, contentType) {
  const type = String(contentType || '').toLowerCase();
  if (type && !type.includes('html') && !type.includes('text/plain')) return false;
  const sample = String(text || '').slice(0, 1200).toLowerCase();
  return sample.includes('<html') || sample.includes('<head') || sample.includes('<body') || sample.includes('<!doctype html');
}

function extractInternalScanLinks(html, pageUrl, rootHost, depth) {
  const $ = cheerio.load(html);
  const links = [];
  const seen = new Set();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const normalized = normalizeUrl(href, pageUrl);
    if (!normalized || seen.has(normalized)) return;

    let parsed;
    try {
      parsed = new URL(normalized);
    } catch {
      return;
    }

    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const pathAndQuery = `${parsed.pathname || ''}${parsed.search || ''}`.toLowerCase();
    if (rootDomain(host) !== rootHost) return;
    if (isSocialHost(host)) return;
    if (BINARY_EXT.test(pathAndQuery)) return;
    if (TOOL_PATH_PATTERN.test(pathAndQuery) && !SCAN_LINK_HINT_PATTERN.test(pathAndQuery)) return;

    const anchorText = ($(el).text() || '').toLowerCase();
    const likelyByText = /\b(feed|rss|atom|blog|news|articles|stories|posts|subscribe|press|updates|category|tag)\b/.test(anchorText);
    if (!SCAN_LINK_HINT_PATTERN.test(pathAndQuery) && !likelyByText) {
      if (depth > 0) return;
      if (parsed.pathname.split('/').filter(Boolean).length > 1) return;
    }

    seen.add(normalized);
    links.push(normalized);
  });

  return links;
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


function isFeedLikeUrl(inputUrl) {
  try {
    const url = new URL(inputUrl);
    const host = url.hostname.toLowerCase();
    const path = (url.pathname || '').toLowerCase();
    const query = (url.search || '').toLowerCase();
    const combined = `${path}${query}`;

    if (host.includes('feedburner.com')) return true;
    if (/\bjsonfeed\b/.test(combined)) return true;
    if (/(^|\/)(feed|rss|atom|rssfeed|rss-feed)(\b|[\/_-])/.test(path)) return true;
    if (/(feed|rss|atom|rssfeed|rss-feed)\.xml\b/.test(path)) return true;
    if (/\/rssfeed\/\d+/i.test(path)) return true;
    for (const [, value] of url.searchParams.entries()) {
      const decoded = String(value || '').toLowerCase();
      if (/(rss|feed|atom|xml)/.test(decoded)) return true;
    }
    if (/\.xml\b/.test(path) && /(rss|feed|atom|news)/.test(path)) return true;
    return false;
  } catch {
    return false;
  }
}

function hasFeedIntent(context = {}, rawUrl = '') {
  if (context.kind === 'link-rel' || context.kind === 'guess') return true;
  if (isFeedLikeUrl(rawUrl)) return true;

  const rel = String(context.rel || '').toLowerCase();
  const type = String(context.type || '').toLowerCase();
  const anchorText = String(context.anchorText || '').toLowerCase();

  if (/(alternate|feed|rss|atom)/.test(rel)) return true;
  if (FEED_TYPE_PATTERN.test(type)) return true;
  if (/(rss|feed|atom|subscribe|syndication)/.test(anchorText)) return true;
  return false;
}

function isFeedspotDirectory(url) {
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase() === 'rss.feedspot.com' && /_rss_feeds\/?$/i.test(u.pathname);
  } catch {
    return false;
  }
}
function rejectCandidate(rawUrl, context = {}) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    const pathname = url.pathname.toLowerCase();
    const query = url.search.toLowerCase();

    if (BINARY_EXT.test(rawUrl)) return 'binary-ext';
    if (isSocialHost(host)) return 'social-domain';
    if (JUNK_HOST_PATTERNS.some((pattern) => pattern.test(host)) && !FEED_HINT_PATTERN.test(pathname + query)) return 'known-junk-host';

    if (host.endsWith('feedspot.com') && pathname.includes('infiniterss.php')) return 'wrapper-not-feed';
    if (/\bq=site:\b/i.test(query) && !url.searchParams.get('q')?.replace(/site:/i, '').trim()) return 'empty-site-wrapper';
    if (/\/wp-json\//i.test(pathname) || /\/oembed\b/i.test(pathname) || /[?&](rest_route|oembed)=/i.test(query)) return 'embed-endpoint';
    if (TOOL_PATH_PATTERN.test(pathname) && !HARD_FEED_PATH_PATTERN.test(pathname)) return 'nav-or-tool-page';
    if (host.endsWith('feedspot.com') && FEEDSPOT_JUNK_PATH.test(pathname) && !host.startsWith('rss.')) return 'feedspot-directory-page';

    const fromAnchor = `${(context.anchorText || '').toLowerCase()} ${(context.rel || '').toLowerCase()}`;
    if (/(privacy|terms|about|careers?|docs?|contact|support|widgets?|home|tools?)/.test(fromAnchor) && !HARD_FEED_PATH_PATTERN.test(pathname) && !isFeedLikeUrl(rawUrl)) return 'nav-link';

    const isLikelyFeed = isFeedLikeUrl(rawUrl) || HARD_FEED_PATH_PATTERN.test(pathname) || FEED_HINT_PATTERN.test(pathname) || FEED_HINT_PATTERN.test(query);
    if (!isLikelyFeed && (host.endsWith('feedspot.com') || context.kind === 'guess')) return 'unlikely-feed';

    return null;
  } catch {
    return 'invalid-url';
  }
}

function extractCandidates(html, pageUrl) {
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
    const normalized = normalizeUrl(href, pageUrl);
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
    const href = $(el).attr('href') || '';
    const type = ($(el).attr('type') || '').toLowerCase();
    if (!href || (!FEED_TYPE_PATTERN.test(type) && !FEED_HINT_PATTERN.test(href))) return;
    addCandidate(href, { kind: 'link-rel', rel, type });
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

async function collectCandidatesFromSeed(seed, scanConfig, emit, emitProgress) {
  const seedHost = getDomain(seed);
  const seedRoot = rootDomain(seedHost);
  const queue = [{ url: seed, depth: 0 }];
  const visited = new Set();
  const pagesScanned = [];
  const extractedRows = [];

  while (queue.length && pagesScanned.length < scanConfig.maxPagesPerSeed) {
    const current = queue.shift();
    if (!current || visited.has(current.url)) continue;
    visited.add(current.url);

    emit({ code: 'FETCH', level: 'ok', message: `scan page ${current.url}` });
    emitProgress('scanning-page', { page: current.url, depth: current.depth, scanned: pagesScanned.length + 1, pageLimit: scanConfig.maxPagesPerSeed });

    let page;
    try {
      page = await fetchText(current.url, { cacheBucket: 'seedFetch' });
    } catch (err) {
      emit({ code: 'SKIP', level: 'warn', message: `page failed ${current.url} (${err.message})` });
      continue;
    }

    if (!isLikelyHtmlDocument(page.text, page.contentType)) {
      emit({ code: 'SKIP', level: 'warn', message: `non-html page ${current.url}` });
      continue;
    }

    pagesScanned.push(current.url);
    const { found, stats } = extractCandidates(page.text, current.url);
    extractedRows.push(...found);

    emit({ code: 'DETECT', level: 'ok', message: `${current.url} recovered ${stats.detected} candidates (${stats.skipped} skipped early)` });

    if (current.depth >= scanConfig.maxDepth) continue;
    const internalLinks = extractInternalScanLinks(page.text, current.url, seedRoot, current.depth);
    internalLinks.forEach((link) => {
      if (!visited.has(link) && !queue.some((q) => q.url === link) && queue.length + pagesScanned.length < scanConfig.maxPagesPerSeed * 2) {
        queue.push({ url: link, depth: current.depth + 1 });
      }
    });
  }

  return { extracted: extractedRows, pagesScanned };
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
    state: 'included',
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

async function discoverFeeds(seeds, options = {}, onEvent) {
  const logs = [];
  const dedupe = new Map();
  const scanConfig = getScanConfig(options.scanMode);

  const emit = (row) => {
    logs.push(row);
    if (onEvent) onEvent({ type: 'log', ...row });
  };
  const emitProgress = (stage, detail = {}) => {
    if (onEvent) onEvent({ type: 'progress', stage, ...detail });
  };

  emit({ code: 'RUN', level: 'ok', message: `discovery session started (${seeds.length} seed(s), ${scanConfig.mode} mode)` });
  emitProgress('start', { seeds: seeds.length, feeds: 0, scanMode: scanConfig.mode, scanConfig });

  let validated = 0;
  let totalCandidates = 0;

  await mapLimit(seeds, SEED_CONCURRENCY, async (seed) => {
    emit({ code: 'FETCH', level: 'ok', message: `seed ${seed}` });
    emitProgress('scanning-seed', { seed, scanMode: scanConfig.mode });

    emit({ code: 'CHECK', level: 'ok', message: `direct-feed check ${seed}` });
    const directCandidate = { url: seed, wrappedUrl: '', kind: 'direct-seed' };
    const directResult = await validateCandidate(seed, directCandidate, emit);
    validated += 1;
    if (directResult.ok && directResult.feed && !dedupe.has(seed)) {
      dedupe.set(seed, directResult.feed);
      if (onEvent) onEvent({ type: 'feed', feed: directResult.feed, totalFeeds: dedupe.size });
      emit({ code: 'VALID', level: 'ok', message: `direct feed accepted ${seed}` });
    }

    const { extracted } = await collectCandidatesFromSeed(seed, scanConfig, emit, emitProgress);
    const uniqueCandidates = [];
    const seen = new Set();

    extracted.forEach((candidate) => {
      if (candidate.wrapperAction === 'unwrapped') {
        emit({ code: 'UNWRAP', level: 'ok', message: `recovered ${candidate.url}` });
      } else if (candidate.wrapperAction === 'unwrapped-empty') {
        emit({ code: 'SKIP', level: 'warn', message: `junk candidate ${candidate.url}` });
      } else if (candidate.rejectedBy) {
        const reason = candidate.rejectedBy === 'non-feed-anchor' ? 'SKIP non-feed-anchor' : candidate.rejectedBy;
        emit({ code: 'SKIP', level: 'warn', message: `${reason} ${candidate.url}` });
      }

      if (candidate.rejectedBy || seen.has(candidate.url)) return;
      seen.add(candidate.url);
      uniqueCandidates.push(candidate);
    });

    emit({ code: 'CAND', level: 'ok', message: `CANDIDATES raw ${uniqueCandidates.length} (${seed})` });
    const feedspotScoped = isFeedspotDirectory(seed);
    const keptCandidates = uniqueCandidates;
    if (feedspotScoped) {
      emit({ code: 'CAND', level: 'ok', message: `CANDIDATES kept ${keptCandidates.length} (${seed})` });
    }

    totalCandidates += keptCandidates.length;
    emitProgress('candidates-recovered', { seed, totalCandidates, unique: keptCandidates.length });

    await mapLimit(keptCandidates, VALIDATION_CONCURRENCY, async (candidate) => {
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
  emitProgress('done', { feeds: feeds.length, validated, totalCandidates, scanMode: scanConfig.mode });
  return { feeds, logs, scanMode: scanConfig.mode, scanConfig };
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

function getDiscoverRequestBody(req) {
  const seeds = Array.isArray(req.body?.seeds) ? req.body.seeds.map((s) => normalizeUrl(s)).filter(Boolean) : [];
  const scanMode = getScanConfig(req.body?.scanMode).mode;
  const freshnessRaw = req.body?.freshnessDays;
  const freshnessDays = freshnessRaw === null || freshnessRaw === undefined || freshnessRaw === '' ? null : Number(freshnessRaw);
  return {
    seeds,
    scanMode,
    freshnessDays: Number.isFinite(freshnessDays) && freshnessDays > 0 ? freshnessDays : null
  };
}

app.post('/api/discover', async (req, res) => {
  try {
    const body = getDiscoverRequestBody(req);
    if (!body.seeds.length) return res.status(400).json({ error: 'No valid seeds supplied', feeds: [], logs: [] });
    return res.json(await discoverFeeds(body.seeds, { scanMode: body.scanMode, freshnessDays: body.freshnessDays }));
  } catch (err) {
    return res.status(500).json({ error: err.message || 'discover-failed', feeds: [], logs: [] });
  }
});

app.post('/api/discover-stream', async (req, res) => {
  const body = getDiscoverRequestBody(req);
  if (!body.seeds.length) return res.status(400).json({ error: 'No valid seeds supplied' });
  console.log('[discover-stream] request', {
    seedCount: body.seeds.length,
    scanMode: body.scanMode,
    firstSeed: body.seeds[0] || null
  });

  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('x-accel-buffering', 'no');

  const send = (row) => res.write(`${JSON.stringify(row)}\n`);
  send({ type: 'session', ok: true, seeds: body.seeds.length, scanMode: body.scanMode, freshnessDays: body.freshnessDays });

  try {
    const result = await discoverFeeds(body.seeds, { scanMode: body.scanMode, freshnessDays: body.freshnessDays }, send);
    send({ type: 'done', feeds: result.feeds.length, scanMode: result.scanMode });
    return res.end();
  } catch (err) {
    console.error('[discover-stream] error', err);
    send({ type: 'error', error: err.message || 'discover-failed' });
    return res.end();
  }
});

app.get('/api/health', (_, res) => {
  res.json({
    ok: true,
    service: 'rss-discovery',
    node: process.version,
    time: new Date().toISOString()
  });
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
