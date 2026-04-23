const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;

const FEED_GUESSES = ['/feed', '/feed.xml', '/rss', '/rss.xml', '/atom.xml', '/index.xml', '/feed.json'];
const CANDIDATE_HINTS = /rss|feed|atom|xml|jsonfeed|subscribe/i;
const BINARY_EXT = /\.(png|jpe?g|gif|webp|svg|ico|pdf|zip|gz|mp4|mp3|avi|mov|woff2?|ttf)(\?|$)/i;

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function text(res, status, value, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': contentType });
  res.end(value);
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
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
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

function matchesAll(str, regex) {
  const out = [];
  let m;
  while ((m = regex.exec(str))) out.push(m);
  return out;
}

function decodeXml(s) {
  return String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function tag(block, name) {
  const esc = name.replace(':', '\\:');
  const m = block.match(new RegExp(`<${esc}[^>]*>([\\s\\S]*?)<\\/${esc}>`, 'i'));
  return m ? decodeXml(stripHtml(m[1])) : '';
}

function parseJsonFeed(text, feedUrl) {
  const obj = JSON.parse(text);
  if (!obj || !Array.isArray(obj.items) || !(obj.version || obj.feed_url || obj.home_page_url)) throw new Error('not-json-feed');
  return {
    title: String(obj.title || getDomain(feedUrl) || 'JSON Feed').trim(),
    format: 'json',
    items: obj.items.slice(0, 80).map((it, idx) => ({
      id: it.id || `${feedUrl}#j${idx}`,
      title: String(it.title || 'Untitled item').trim(),
      url: normalizeUrl(it.url || it.external_url || '', feedUrl) || feedUrl,
      excerpt: stripHtml(it.summary || it.content_text || it.content_html || '').slice(0, 360),
      publishedAt: parseDateMaybe(it.date_published || it.date_modified),
      author: it.author?.name || ''
    }))
  };
}

function parseRss(text, feedUrl) {
  const channel = text.match(/<channel[\s\S]*?<\/channel>/i)?.[0] || text;
  const itemBlocks = matchesAll(channel, /<item\b[\s\S]*?<\/item>/gi).map(m => m[0]).slice(0, 80);
  if (!itemBlocks.length && !/<rss|rdf\:rdf|channel/i.test(text)) throw new Error('not-rss');
  return {
    title: tag(channel, 'title') || getDomain(feedUrl) || 'RSS Feed',
    format: 'rss',
    items: itemBlocks.map((item, idx) => ({
      id: tag(item, 'guid') || `${feedUrl}#r${idx}`,
      title: tag(item, 'title') || 'Untitled item',
      url: normalizeUrl(tag(item, 'link'), feedUrl) || feedUrl,
      excerpt: stripHtml(tag(item, 'description') || tag(item, 'content:encoded')).slice(0, 360),
      publishedAt: parseDateMaybe(tag(item, 'pubDate') || tag(item, 'dc:date')),
      author: tag(item, 'author') || tag(item, 'dc:creator')
    }))
  };
}

function parseAtom(text, feedUrl) {
  const feed = text.match(/<feed\b[\s\S]*?<\/feed>/i)?.[0];
  if (!feed) throw new Error('not-atom');
  const entries = matchesAll(feed, /<entry\b[\s\S]*?<\/entry>/gi).map(m => m[0]).slice(0, 80);
  if (!entries.length) throw new Error('not-atom');
  return {
    title: tag(feed, 'title') || getDomain(feedUrl) || 'Atom Feed',
    format: 'atom',
    items: entries.map((entry, idx) => {
      const link = entry.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["']alternate["'][^>]*>/i)?.[1]
        || entry.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*>/i)?.[1]
        || entry.match(/<link[^>]*href=["']([^"']+)["'][^>]*>/i)?.[1]
        || '';
      return {
        id: tag(entry, 'id') || `${feedUrl}#a${idx}`,
        title: tag(entry, 'title') || 'Untitled item',
        url: normalizeUrl(link, feedUrl) || feedUrl,
        excerpt: stripHtml(tag(entry, 'summary') || tag(entry, 'content')).slice(0, 360),
        publishedAt: parseDateMaybe(tag(entry, 'published') || tag(entry, 'updated')),
        author: tag(entry, 'name') || tag(entry, 'author')
      };
    })
  };
}

function parseFeedPayload(text, contentType, feedUrl) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('empty-feed');
  if (trimmed.startsWith('{') || /json/i.test(contentType)) {
    try { return parseJsonFeed(trimmed, feedUrl); } catch {}
  }
  try { return parseRss(trimmed, feedUrl); } catch {}
  return parseAtom(trimmed, feedUrl);
}

function extractCandidates(html, seedUrl) {
  const set = new Set();
  const linkMatches = matchesAll(html, /<link\b[^>]*rel=["'][^"']*alternate[^"']*["'][^>]*>/gi);
  linkMatches.forEach(([row]) => {
    const href = row.match(/href=["']([^"']+)["']/i)?.[1] || '';
    const type = (row.match(/type=["']([^"']+)["']/i)?.[1] || '').toLowerCase();
    if (!href || !/(rss|atom|xml|json)/i.test(type)) return;
    const normalized = normalizeUrl(href, seedUrl);
    if (normalized && !BINARY_EXT.test(normalized)) set.add(normalized);
  });

  const aMatches = matchesAll(html, /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi);
  aMatches.forEach((m) => {
    const href = m[1] || '';
    const label = stripHtml(m[2] || '');
    if (!CANDIDATE_HINTS.test(`${href} ${label}`)) return;
    const normalized = normalizeUrl(href, seedUrl);
    if (normalized && !BINARY_EXT.test(normalized)) set.add(normalized);
  });

  FEED_GUESSES.forEach((g) => {
    const normalized = normalizeUrl(g, seedUrl);
    if (normalized) set.add(normalized);
  });

  return [...set];
}

function toFeedRecord(seedUrl, feedUrl, parsed) {
  const latest = parsed.items.find(i => i.title || i.url) || null;
  const latestAt = latest?.publishedAt || null;
  return {
    id: `f-${Buffer.from(feedUrl).toString('base64').replace(/=+$/g, '').slice(-12)}`,
    sourceSeed: seedUrl,
    sourceDomain: getDomain(seedUrl),
    title: parsed.title,
    url: feedUrl,
    format: parsed.format,
    state: 'candidate',
    latestTitle: latest?.title || 'No items detected',
    latestUrl: latest?.url || '',
    latestAt,
    latestAge: latestAt ? formatAge(latestAt) : 'unknown',
    items: parsed.items
  };
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
    candidates.forEach(c => logs.push({ code: 'DETECT', level: 'ok', message: `candidate ${c}` }));

    for (const candidate of candidates) {
      if (dedupe.has(candidate)) continue;
      try {
        const feed = await fetchText(candidate);
        const parsed = parseFeedPayload(feed.text, feed.contentType, candidate);
        dedupe.set(candidate, toFeedRecord(seed, candidate, parsed));
        logs.push({ code: 'VALID', level: 'ok', message: `${parsed.format} ${candidate}` });
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
      const fetched = await fetchText(url);
      const parsed = parseFeedPayload(fetched.text, fetched.contentType, url);
      parsed.items.forEach((item, idx) => {
        items.push({
          id: `${feed.id || Buffer.from(url).toString('base64').slice(-10)}-${idx}`,
          sourceId: feed.id || url,
          sourceLabel: feed.title || parsed.title,
          sourceDomain: feed.sourceDomain || getDomain(url),
          feedUrl: url,
          title: item.title,
          excerpt: item.excerpt,
          publishedAt: item.publishedAt,
          url: item.url,
          author: item.author || ''
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

function serveStatic(req, res) {
  const reqPath = req.url === '/' ? '/test.html' : req.url.split('?')[0];
  const filePath = path.join(ROOT, reqPath);
  if (!filePath.startsWith(ROOT)) return text(res, 403, 'forbidden');
  fs.readFile(filePath, (err, data) => {
    if (err) return text(res, 404, 'not found');
    const ext = path.extname(filePath).toLowerCase();
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
    text(res, 200, data, types[ext] || 'application/octet-stream');
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1_000_000) reject(new Error('body-too-large'));
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('invalid-json')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/discover') {
    try {
      const body = await readJsonBody(req);
      const seeds = Array.isArray(body.seeds) ? body.seeds.map(s => normalizeUrl(s)).filter(Boolean) : [];
      if (!seeds.length) return json(res, 400, { error: 'No valid seeds supplied', feeds: [], logs: [] });
      return json(res, 200, await discoverFeeds(seeds));
    } catch (err) {
      return json(res, 500, { error: err.message || 'discover-failed', feeds: [], logs: [] });
    }
  }

  if (req.method === 'POST' && req.url === '/api/reader-items') {
    try {
      const body = await readJsonBody(req);
      const feeds = Array.isArray(body.feeds) ? body.feeds : [];
      return json(res, 200, await loadReaderItems(feeds));
    } catch (err) {
      return json(res, 500, { error: err.message || 'reader-failed', items: [], logs: [] });
    }
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`RSS Discovery running on http://localhost:${PORT}`);
});
