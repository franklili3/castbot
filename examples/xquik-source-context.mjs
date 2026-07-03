// Fetch reviewed X/Twitter source context from Xquik and save it for prompts.
//
// Usage:
//   XQUIK_API_KEY=... node examples/xquik-source-context.mjs

import { mkdir, writeFile } from 'fs/promises';

const apiKey = process.env.XQUIK_API_KEY;
const query = process.env.XQUIK_TWEET_QUERY || 'bitcoin OR crypto OR web3';
const limit = process.env.XQUIK_TWEET_LIMIT || '10';
const outputFile = process.env.XQUIK_SOURCE_FILE || 'data/xquik-sources.json';

if (!apiKey) {
  throw new Error('XQUIK_API_KEY is required');
}

function toArray(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ['tweets', 'results', 'items', 'data']) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.data?.tweets)) return payload.data.tweets;
  return [];
}

function textOf(row) {
  return row?.text || row?.fullText || row?.full_text || row?.content || '';
}

function authorOf(row) {
  return row?.author?.username || row?.authorUsername || row?.username || 'xquik';
}

function urlOf(row) {
  return row?.url || row?.tweetUrl || row?.tweet_url || '';
}

const endpoint = new URL('https://xquik.com/api/v1/x/tweets/search');
endpoint.searchParams.set('q', query);
endpoint.searchParams.set('limit', limit);

const response = await fetch(endpoint, {
  headers: {
    'X-API-Key': apiKey,
  },
  signal: AbortSignal.timeout(15000),
});

if (!response.ok) {
  throw new Error(`Xquik request failed with HTTP ${response.status}`);
}

const rows = toArray(await response.json())
  .map((row) => ({
    type: 'xquik',
    source: `Xquik search: ${query}`,
    title: textOf(row).slice(0, 120),
    description: textOf(row).slice(0, 500),
    author: authorOf(row),
    link: urlOf(row),
    pubDate: row?.createdAt || row?.created_at || row?.timestamp || '',
    addedAt: new Date().toISOString(),
  }))
  .filter((row) => row.description.length > 0);

await mkdir(outputFile.split('/').slice(0, -1).join('/') || '.', { recursive: true });
await writeFile(outputFile, JSON.stringify(rows, null, 2));

console.log(`Saved ${rows.length} Xquik source rows to ${outputFile}`);
