// YouTube search tool: finds real videos on a persona's own channels.
// Needs YOUTUBE_API_KEY in .env (YouTube Data API v3, free tier = 10,000 units/day).
// Cost per call: about 1 unit per channel lookup (cached) + 100 units per channel searched.

const API = 'https://www.googleapis.com/youtube/v3';

// "@chaiaurcode" -> "UC...". Cached so we only look each handle up once per run.
const channelIdCache = new Map();

async function getChannelId(handle, apiKey) {
  if (channelIdCache.has(handle)) return channelIdCache.get(handle);

  const url = `${API}/channels?part=id&forHandle=${encodeURIComponent(handle)}&key=${apiKey}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `YouTube API error ${res.status}`);

  const id = data.items?.[0]?.id;
  if (!id) throw new Error(`Channel not found for ${handle}`);
  channelIdCache.set(handle, id);
  return id;
}

// YouTube returns titles with HTML entities like &amp; and &#39;
function decodeHtml(text = '') {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// Free check (no API key, no quota) using YouTube's oEmbed endpoint.
// 404 = deleted / doesn't exist, 403 = private -> drop.
// 401 = embedding disabled, but the video still plays on youtube.com -> keep.
// Network errors -> keep (better to show a link than lose every result).
async function isVideoAvailable(url) {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`);
    return res.status !== 404 && res.status !== 403;
  } catch {
    return true;
  }
}

/**
 * Search videos on the given channels.
 * @param {string} query - topic, e.g. "docker"
 * @param {string[]} channelHandles - e.g. ["@chaiaurcode", "@HiteshCodeLab"]
 * @returns {Promise<{title: string, url: string, channel: string, publishedAt: string}[]>}
 */
export async function searchYouTube(query, channelHandles, maxResultsPerChannel = 3) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) throw new Error('YOUTUBE_API_KEY is not set');

  const results = [];

  for (const handle of channelHandles) {
    const channelId = await getChannelId(handle, apiKey);

    const params = new URLSearchParams({
      part: 'snippet',
      channelId,
      q: query,
      type: 'video',
      order: 'relevance',
      maxResults: String(maxResultsPerChannel),
      key: apiKey,
    });

    const res = await fetch(`${API}/search?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `YouTube API error ${res.status}`);

    for (const item of data.items ?? []) {
      results.push({
        id: item.id.videoId,
        thumbnail: item.snippet.thumbnails?.medium?.url ?? `https://i.ytimg.com/vi/${item.id.videoId}/mqdefault.jpg`,
        title: decodeHtml(item.snippet.title),
        url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
        channel: decodeHtml(item.snippet.channelTitle),
        publishedAt: item.snippet.publishedAt?.slice(0, 10),
      });
    }
  }

  const availability = await Promise.all(results.map((video) => isVideoAvailable(video.url)));
  const available = results.filter((_, i) => availability[i]);

  if (process.env.DEBUG) {
    console.log(`   📺 YouTube returned ${results.length} videos, ${available.length} available:`);
    available.forEach((v) => console.log(`      - ${v.title} (${v.url})`));
  }

  return available;
}
