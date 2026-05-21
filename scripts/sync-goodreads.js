// scripts/sync-goodreads.js
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const fs = require('fs');
const path = require('path');

const GOODREADS_USER_ID = process.env.GOODREADS_USER_ID;
const GOOGLE_BOOKS_API_KEY = process.env.GOOGLE_BOOKS_API_KEY;

if (!GOODREADS_USER_ID) {
  console.error('❌ GOODREADS_USER_ID is required');
  process.exit(1);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchGoodreadsShelf(userId, shelf) {
  const url = `https://www.goodreads.com/review/list_rss/${userId}?shelf=${shelf}&per_page=200`;
  console.log(`  Fetching shelf "${shelf}" for user ${userId}…`);
  const res = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GoodreadsSync/1.0)' },
    timeout: 30000,
  });
  return res.data;
}

function parseRss(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    cdataPropName: '__cdata',
  });
  const result = parser.parse(xml);
  const items = result?.rss?.channel?.item;
  if (!items) return [];
  return Array.isArray(items) ? items : [items];
}

function extractField(item, key) {
  const val = item[key];
  if (!val) return '';
  if (typeof val === 'object' && val.__cdata) return val.__cdata.toString().trim();
  return val.toString().trim();
}

function extractRating(item) {
  const raw = extractField(item, 'user_rating');
  const n = parseInt(raw, 10);
  return isNaN(n) ? 0 : n;
}

function extractTitle(item) {
  return extractField(item, 'title')
    .replace(/\s*\(.*?\)\s*/g, '')
    .trim();
}

function cleanAuthor(raw) {
  if (raw.includes(',')) {
    const parts = raw.split(',').map(s => s.trim());
    return `${parts[1]} ${parts[0]}`;
  }
  return raw;
}

async function enrichWithGoogleBooks(title, author) {
  const query = encodeURIComponent(`intitle:${title} inauthor:${author}`);
  const keyParam = GOOGLE_BOOKS_API_KEY ? `&key=${GOOGLE_BOOKS_API_KEY}` : '';
  const url = `https://www.googleapis.com/books/v1/volumes?q=${query}&maxResults=1${keyParam}`;

  try {
    const res = await axios.get(url, { timeout: 10000 });
    const items = res.data?.items;
    if (!items || items.length === 0) return null;

    const info = items[0].volumeInfo || {};
    const cover =
      info.imageLinks?.extraLarge ||
      info.imageLinks?.large ||
      info.imageLinks?.medium ||
      info.imageLinks?.thumbnail ||
      null;

    const coverUrl = cover
      ? cover.replace('http://', 'https://').replace('&zoom=1', '') + '&zoom=3'
      : null;

    const series = extractSeries(info.title, info.subtitle, info.description);

    return {
      cover: coverUrl,
      series: series,
      description: info.description ? info.description.substring(0, 600) : null,
      publishedDate: info.publishedDate || null,
      pageCount: info.pageCount || null,
      categories: info.categories || [],
    };
  } catch (err) {
    console.warn(`    ⚠ Google Books failed for "${title}": ${err.message}`);
    return null;
  }
}

function extractSeries(title = '', subtitle = '', description = '') {
  const patterns = [
    /\(([^,#)]+),?\s*[#n°tome]*\s*\d+\)/i,
    /tome\s+\d+\s+(?:de|of|du)\s+(.+)/i,
    /volume\s+\d+\s+(?:de|of|du)\s+(.+)/i,
  ];
  const combined = `${title} ${subtitle} ${description}`.substring(0, 300);
  for (const re of patterns) {
    const m = combined.match(re);
    if (m) return m[1].trim();
  }
  return null;
}

async function main() {
  console.log(`\n📚 Starting Goodreads sync for user ${GOODREADS_USER_ID}\n`);

  const shelves = [
    { shelf: 'read', status: 'lu' },
    { shelf: 'currently-reading', status: 'en cours' },
  ];

  const allBooks = [];
  const seen = new Set();

  for (const { shelf, status } of shelves) {
    let xml;
    try {
      xml = await fetchGoodreadsShelf(GOODREADS_USER_ID, shelf);
    } catch (err) {
      console.error(`  ❌ Could not fetch shelf "${shelf}": ${err.message}`);
      continue;
    }

    const items = parseRss(xml);
    console.log(`  → Found ${items.length} books on shelf "${shelf}"`);

    for (const item of items) {
      const rawTitle = extractField(item, 'title');
      const rawAuthor = extractField(item, 'author_name');
      const goodreadsId = extractField(item, 'book_id') || extractField(item, 'guid');
      const link = extractField(item, 'link');
      const rating = extractRating(item);
      const dateRead = extractField(item, 'user_read_at') || extractField(item, 'user_date_added') || null;
      const grCover = extractField(item, 'book_image_url') || null;

      const title = extractTitle({ title: rawTitle });
      const author = cleanAuthor(rawAuthor || extractField(item, 'author'));
      const key = `${title}-${author}`.toLowerCase();

      if (seen.has(key)) continue;
      seen.add(key);

      console.log(`    📖 "${title}" by ${author}`);

      let enriched = null;
      try {
        enriched = await enrichWithGoogleBooks(title, author);
        await sleep(300);
      } catch (e) {}

      allBooks.push({
        id: goodreadsId || key,
        title,
        author,
        status,
        rating: rating > 0 ? rating : null,
        dateRead: dateRead ? new Date(dateRead).toISOString().split('T')[0] : null,
        cover: enriched?.cover || (grCover ? grCover.replace('http://', 'https://') : null),
        saga: enriched?.series || null,
        description: enriched?.description || null,
        publishedDate: enriched?.publishedDate || null,
        pageCount: enriched?.pageCount || null,
        categories: enriched?.categories || [],
        goodreadsUrl: link || `https://www.goodreads.com/book/show/${goodreadsId}`,
        syncedAt: new Date().toISOString(),
      });
    }
  }

  allBooks.sort((a, b) => {
    if (a.status === 'en cours' && b.status !== 'en cours') return -1;
    if (b.status === 'en cours' && a.status !== 'en cours') return 1;
    if (a.dateRead && b.dateRead) return b.dateRead.localeCompare(a.dateRead);
    return 0;
  });

  const outDir = path.join(process.cwd(), 'data');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'books.json');

  const output = {
    userId: GOODREADS_USER_ID,
    syncedAt: new Date().toISOString(),
    total: allBooks.length,
    books: allBooks,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\n✅ Synced ${allBooks.length} books → data/books.json\n`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
