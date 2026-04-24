const express = require('express');
const path = require('path');
const cheerio = require('cheerio');
const Parser = require('rss-parser');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const parser = new Parser({ timeout: 12000 });

const FEED_GUESSES = ['/feed', '/feed.xml', '/rss', '/rss.xml', '/atom.xml', '/index.xml', '/feed.json'];
const FEED_TYPE_PATTERN = /(application\/(rss|atom)\+xml|application\/xml|text\/xml|application\/feed\+json|application\/json)/i;
const FEED_HINT_PATTERN = /(rss|feed|atom|xml|jsonfeed|subscribe)/i;
const HARD_FEED_PATH_PATTERN = /\/(feed|rss|atom)(\b|[\/_-])/i;
const BINARY_EXT = /\.(png|jpe?g|gif|webp|svg|ico|pdf|zip|gz|mp4|mp3|avi|mov|woff2?|ttf)(\?|$)/i;
const SOCIAL_DOMAINS = new Set(['twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'pinterest.com', 'youtube.com']);
const TOOL_PATH_PATTERN = /(privacy|terms|about|contact|career|careers|adverti|login|signup|account|support|help|docs?|documentation|publisher|widget|widgets|builder|combiner|scheduler|embed|oembed|wp-json|api|jobs?|faq)/i;
const FEEDSPOT_JUNK_PATH = /(rss-feed|top-rss|blog|directory|news\/|news$|magazines?|podcasts?|websites?|infiniterss\.php)/i;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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

function formatAge(ts) {
  if (!ts) return 'unknown';
  const delta = Date.now() - ts;
  if (delta < 0) return 'future';
  const h = Math.floor(delta / 3600000);
  if (h < 1) return `${Math.max(1, Math.floor(delta / 60000))}m ago`;
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function stripHtml(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'RSS-Discovery/1.0 (+local-proxy)',
      accept: 'text/html,application/xml,text/xml,application/rss+xml,application/atom+xml,application/feed+json,application/json,*/*'
    }
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { text: await res.text(), contentType: res.headers.get('content-type') || '' };
}

function unwrapKnownWrapper(candidateUrl) {
  try {
    const url = new URL(candidateUrl);
    const host = url.hostname.replace(/^www\./, '');
    const qUrl = normalizeUrl(url.searchParams.get('url') || url.searchParams.get('u') || '');
    if (host.endsWith('feedspot.com') && url.pathname.toLowerCase().includes('infiniterss.php') && qUrl) {
      return { canonical: qUrl, wrapped: candidateUrl, kind: 'feedspot-wrapper' };
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

    if (host.endsWith('feedspot.com') && pathname.includes('infiniterss.php')) {
      const qUrl = normalizeUrl(url.searchParams.get('url') || url.searchParams.get('u') || '');
      if (!qUrl) return 'feedspot-wrapper-empty';
    }

    if (/\bq=site:\b/i.test(query) && !url.searchParams.get('q')?.replace(/site:/i, '').trim()) return 'empty-site-wrapper';

    if (/\/wp-json\//i.test(pathname) || /\/oembed\b/i.test(pathname) || /[?&](rest_route|oembed)=/i.test(query)) return 'embed-endpoint';

    if (TOOL_PATH_PATTERN.test(pathname) && !HARD_FEED_PATH_PATTERN.test(pathname)) return 'nav-or-tool-page';

    if (host.endsWith('feedspot.com') && FEEDSPOT_JUNK_PATH.test(pathname) && !host.startsWith('rss.')) return 'feedspot-directory-page';

    const fromAnchor = `${(context.anchorText || '').toLowerCase()} ${(context.rel || '').toLowerCase()}`;
    if (/(privacy|terms|about|careers?|docs?|contact|support|widgets?)/.test(fromAnchor) && !HARD_FEED_PATH_PATTERN.test(pathname)) return 'nav-link';

    const isLikelyFeed = HARD_FEED_PATH_PATTERN.test(pathname) || FEED_HINT_PATTERN.test(pathname) || FEED_HINT_PATTERN.test(query);
    if (!isLikelyFeed && host.endsWith('feedspot.com')) return 'non-feedspot-page';

    return null;
  } catch {
    return 'invalid-url';
  }
}

function extractCandidates(html, seedUrl) {
  const $ = cheerio.load(html);
  const found = [];
  const seen = new Set();

  function addCandidate(href, context = {}) {
    const normalized = normalizeUrl(href, seedUrl);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    const rejectedBy = rejectCandidate(normalized, context);
    if (rejectedBy) return;

    const unwrapped = unwrapKnownWrapper(normalized);
    const canonical = unwrapped.canonical;
    if (!canonical || seen.has(canonical)) return;
    seen.add(canonical);
    const canonicalRejectedBy = rejectCandidate(canonical, context);
    if (canonicalRejectedBy) return;

    found.push({ url: canonical, wrappedUrl: unwrapped.wrapped, kind: context.kind || unwrapped.kind || 'anchor' });
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
    if (!FEED_HINT_PATTERN.test(`${href} ${label}`)) return;
    addCandidate(href, { kind: 'anchor', anchorText: label, rel });
  });

  FEED_GUESSES.forEach((guess) => addCandidate(guess, { kind: 'guess' }));
  return found;
}

function normalizeParsedItem(item, feedUrl, idx) {
  const url = normalizeUrl(item.link || item.guid || item.id || '', feedUrl) || feedUrl;
  const publishedAt = parseDateMaybe(item.isoDate || item.pubDate || item.published || item.updated);

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
    title: String(parsed.title || sourceDomain || getDomain(feedUrl) || 'Feed').trim(),
    url: feedUrl,
    wrappedUrl: meta.wrappedUrl || '',
    discoveredVia: meta.kind || 'scan',
    format: parsed.feedType || 'rss',
    state: 'candidate',
    latestTitle: latest?.title || 'No items detected',
    latestUrl: latest?.url || '',
    latestAt,
    latestAge: latestAt ? formatAge(latestAt) : 'unknown',
    items
  };
}

async function parseFeedFromUrl(feedUrl) {
  const fetched = await fetchText(feedUrl);
  const parsed = await parser.parseString(fetched.text);
  if (!parsed || !Array.isArray(parsed.items) || !parsed.items.length) throw new Error('invalid-feed');
  return parsed;
}

async function discoverFeeds(seeds) {
  const logs = [{ code: 'RUN', level: 'ok', message: `discovery session started (${seeds.length} seed(s))` }];
  const dedupe = new Map();

  for (const seed of seeds) {
    logs.push({ code: 'FETCH', level: 'ok', message: `seed ${seed}` });
    let page;
    try {
      page = await fetchText(seed);
    } catch (err) {
      logs.push({ code: 'ERROR', level: 'error', message: `seed failed ${seed} (${err.message})` });
      continue;
    }

    const candidates = extractCandidates(page.text, seed);
    candidates.forEach((candidate) => logs.push({ code: 'DETECT', level: 'ok', message: `candidate ${candidate.url}` }));

    for (const candidate of candidates) {
      if (dedupe.has(candidate.url)) continue;
      try {
        const parsed = await parseFeedFromUrl(candidate.url);
        dedupe.set(candidate.url, toFeedRecord(seed, candidate.url, parsed, candidate));
        logs.push({ code: 'VALID', level: 'ok', message: `${parsed.feedType || 'rss'} ${candidate.url}` });
      } catch {
        logs.push({ code: 'REJECT', level: 'warn', message: `invalid feed ${candidate.url}` });
      }
    }
  }

  logs.push({ code: 'DONE', level: dedupe.size ? 'ok' : 'warn', message: `${dedupe.size} valid feeds discovered` });
  return { feeds: [...dedupe.values()], logs };
}

async function loadReaderItems(feeds) {
  const logs = [];
  const items = [];

  for (const feed of feeds) {
    const url = normalizeUrl(feed.url);
    if (!url) continue;

    try {
      const parsed = await parseFeedFromUrl(url);
      const sourceDomain = inferSourceDomain(feed.sourceSeed || url, url, parsed);
      (parsed.items || []).slice(0, 80).forEach((item, idx) => {
        const normalized = normalizeParsedItem(item, url, idx);
        items.push({
          id: `${feed.id || Buffer.from(url).toString('base64').slice(-10)}-${idx}`,
          sourceId: feed.id || url,
          sourceLabel: feed.title || parsed.title || sourceDomain,
          sourceDomain,
          feedUrl: url,
          ...normalized
        });
      });
      logs.push({ code: 'VALID', level: 'ok', message: `reader loaded ${url}` });
    } catch {
      logs.push({ code: 'REJECT', level: 'warn', message: `reader failed ${url}` });
    }
  }

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
