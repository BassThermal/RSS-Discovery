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
const BINARY_EXT = /\.(png|jpe?g|gif|webp|svg|ico|pdf|zip|gz|mp4|mp3|avi|mov|woff2?|ttf)(\?|$)/i;

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

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  return { text: await res.text(), contentType: res.headers.get('content-type') || '' };
}

function extractCandidates(html, seedUrl) {
  const $ = cheerio.load(html);
  const found = new Set();

  $('link[rel]').each((_, el) => {
    const rel = ($(el).attr('rel') || '').toLowerCase();
    if (!rel.includes('alternate')) return;

    const href = $(el).attr('href') || '';
    const type = ($(el).attr('type') || '').toLowerCase();
    if (!href || (!FEED_TYPE_PATTERN.test(type) && !FEED_HINT_PATTERN.test(href))) return;

    const normalized = normalizeUrl(href, seedUrl);
    if (normalized && !BINARY_EXT.test(normalized)) found.add(normalized);
  });

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const label = ($(el).text() || '').trim();
    if (!FEED_HINT_PATTERN.test(`${href} ${label}`)) return;

    const normalized = normalizeUrl(href, seedUrl);
    if (normalized && !BINARY_EXT.test(normalized)) found.add(normalized);
  });

  FEED_GUESSES.forEach((guess) => {
    const normalized = normalizeUrl(guess, seedUrl);
    if (normalized) found.add(normalized);
  });

  return [...found];
}

function normalizeParsedItem(item, feedUrl, idx) {
  const url = normalizeUrl(item.link || item.guid || item.id || '', feedUrl) || feedUrl;
  const publishedAt = parseDateMaybe(item.isoDate || item.pubDate || item.published || item.updated);

  return {
    id: item.guid || item.id || `${feedUrl}#${idx}`,
    title: String(item.title || 'Untitled item').trim(),
    url,
    excerpt: stripHtml(item.contentSnippet || item.summary || item.content || '').slice(0, 360),
    publishedAt,
    author: item.creator || item.author || ''
  };
}

function toFeedRecord(seedUrl, feedUrl, parsed) {
  const items = (parsed.items || []).slice(0, 80).map((item, idx) => normalizeParsedItem(item, feedUrl, idx));
  const latest = items.find((item) => item.title || item.url) || null;
  const latestAt = latest?.publishedAt || null;

  return {
    id: `f-${Buffer.from(feedUrl).toString('base64').replace(/=+$/g, '').slice(-12)}`,
    sourceSeed: seedUrl,
    sourceDomain: getDomain(seedUrl),
    title: String(parsed.title || getDomain(feedUrl) || 'Feed').trim(),
    url: feedUrl,
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
  if (!parsed || !Array.isArray(parsed.items) || !parsed.items.length) {
    throw new Error('invalid-feed');
  }
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
    candidates.forEach((candidate) => logs.push({ code: 'DETECT', level: 'ok', message: `candidate ${candidate}` }));

    for (const candidate of candidates) {
      if (dedupe.has(candidate)) continue;
      try {
        const parsed = await parseFeedFromUrl(candidate);
        dedupe.set(candidate, toFeedRecord(seed, candidate, parsed));
        logs.push({ code: 'VALID', level: 'ok', message: `${parsed.feedType || 'rss'} ${candidate}` });
      } catch {
        logs.push({ code: 'REJECT', level: 'warn', message: `invalid feed ${candidate}` });
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
      (parsed.items || []).slice(0, 80).forEach((item, idx) => {
        const normalized = normalizeParsedItem(item, url, idx);
        items.push({
          id: `${feed.id || Buffer.from(url).toString('base64').slice(-10)}-${idx}`,
          sourceId: feed.id || url,
          sourceLabel: feed.title || parsed.title || getDomain(url),
          sourceDomain: feed.sourceDomain || getDomain(url),
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
    if (!seeds.length) {
      return res.status(400).json({ error: 'No valid seeds supplied', feeds: [], logs: [] });
    }

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
