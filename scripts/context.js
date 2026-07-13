import { createClient } from '@sanity/client';
import { parseISO, differenceInDays } from 'date-fns';

// --- Market selection ---

const MARKETS = [
  { name: 'India', weight: 40 },
  { name: 'United States', weight: 25 },
  { name: 'EU', weight: 10 },
  { name: 'UK', weight: 5 },
  { name: 'Philippines', weight: 5 },
  { name: 'Thailand', weight: 5 },
  { name: 'South Africa', weight: 5 },
  { name: 'Australia', weight: 5 },
];

export function pickTargetMarket() {
  const totalWeight = MARKETS.reduce((sum, m) => sum + m.weight, 0);
  let rand = Math.random() * totalWeight;
  for (const market of MARKETS) {
    rand -= market.weight;
    if (rand <= 0) return market.name;
  }
  return MARKETS[0].name;
}

// --- Fetch recent posts from Sanity ---

export async function fetchRecentPosts(sanity, days = 5) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString();
  const query = `*[_type == "blogPost" && publishedAt >= $cutoff] | order(publishedAt desc) { title, slug }`;
  const result = await sanity.fetch(query, { cutoff: cutoffStr });
  return result || [];
}

// --- Google News RSS search ---

export async function gatherRSSSearchContext(market) {
  const query = `solar+energy+${encodeURIComponent(market)}+policy`;
  const url = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;
  try {
    const res = await fetch(url);
    const text = await res.text();
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(text)) !== null) {
      const item = match[1];
      const titleMatch = item.match(/<title>([^<]*)<\/title>/);
      const linkMatch = item.match(/<link>([^<]*)<\/link>/);
      const descMatch = item.match(/<description>([^<]*)<\/description>/);
      if (titleMatch && linkMatch) {
        items.push({
          title: titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim(),
          url: linkMatch[1],
          content: descMatch ? descMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '',
        });
      }
    }
    return [{ label: 'Google News RSS', results: items.slice(0, 10) }];
  } catch (e) {
    console.error('RSS fetch error:', e.message);
    return [{ label: 'Google News RSS', results: [] }];
  }
}

// --- Jina Reader ---

export async function jinaFetchMany(urls) {
  const results = [];
  for (const url of urls) {
    try {
      const res = await fetch(`https://r.jina.ai/${url}`, {
        headers: { 'Accept': 'application/json' }
      });
      const data = await res.json();
      const content = data.data?.content || data.content || '';
      const resolvedUrl = data.data?.url || data.url || url;
      results.push({ success: true, url: resolvedUrl, content, originalUrl: url });
    } catch (e) {
      results.push({ success: false, url, error: e.message, originalUrl: url });
    }
  }
  return results;
}

// --- Formatting helpers ---

export function formatSearchResultsForPrompt(results) {
  let output = '';
  for (const group of results) {
    output += `\n=== ${group.label} ===\n`;
    for (const item of group.results) {
      output += `- ${item.title}\n  URL: ${item.url}\n  Snippet: ${item.content || 'N/A'}\n`;
    }
  }
  return output || 'No search results available.';
}

export function formatExtractedContentForPrompt(extracted) {
  let output = '';
  for (const item of extracted) {
    if (!item.success) continue;
    output += `\n=== Source: ${item.url} ===\n${item.content.substring(0, 8000)}\n`;
  }
  return output || 'No source content available.';
}

// --- Meta panel parsing ---

export function parseMetaPanel(markdown) {
  const meta = { seoTitle: '', seoDescription: '', tags: [] };
  const match = markdown.match(/<!--\s*Meta Panel:\s*([\s\S]*?)-->/);
  if (!match) return meta;
  const lines = match[1].split(';').map(s => s.trim());
  for (const line of lines) {
    if (line.startsWith('Meta Title:')) meta.seoTitle = line.replace('Meta Title:', '').trim();
    if (line.startsWith('Meta Description:')) meta.seoDescription = line.replace('Meta Description:', '').trim();
    if (line.startsWith('Tags:')) meta.tags = line.replace('Tags:', '').split(',').map(t => t.trim());
    if (line.startsWith('Image Prompts:')) {
      const prompts = line.replace('Image Prompts:', '').trim();
      const opts = prompts.split(';').map(p => p.trim());
      meta.imageOptionA = opts[0]?.replace('Option A:', '').trim() || '';
      meta.imageOptionB = opts[1]?.replace('Option B:', '').trim() || '';
    }
  }
  return meta;
}

// --- Excerpt extraction ---

export function extractExcerpt(markdown, maxLen = 200) {
  const tldrMatch = markdown.match(/TL;DR:\s*([^\n]+)/);
  if (tldrMatch) return tldrMatch[1].trim().substring(0, maxLen);
  const firstPara = markdown.match(/^#\s+.*\n\n([^\n]+)/m);
  if (firstPara) return firstPara[1].trim().substring(0, maxLen);
  return markdown.substring(0, maxLen).trim();
}

// --- Slugify ---

export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 80);
}

// --- Extract title ---

export function extractTitle(markdown) {
  const match = markdown.match(/^#\s+(.+)/m);
  return match ? match[1].trim() : '';
}

// --- Image ---

export async function getHeroImage(prompt, sanity) {
  // Try Unsplash first
  const unsplashKey = process.env.UNSPLASH_ACCESS_KEY;
  if (unsplashKey) {
    try {
      const res = await fetch(`https://api.unsplash.com/photos/random?query=${encodeURIComponent(prompt)}&orientation=landscape`, {
        headers: { 'Authorization': `Client-ID ${unsplashKey}` }
      });
      const data = await res.json();
      if (data.urls?.raw) {
        const imgRes = await fetch(data.urls.raw);
        const buffer = Buffer.from(await imgRes.arrayBuffer());
        const asset = await sanity.assets.upload('image', buffer, { filename: `cover-${Date.now()}.jpg` });
        return { _id: asset._id, source: 'unsplash', photographer: data.user?.name };
      }
    } catch (e) { console.log('Unsplash fallback:', e.message); }
  }

  // Try Pexels
  const pexelsKey = process.env.PEXELS_API_KEY;
  if (pexelsKey) {
    try {
      const res = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(prompt)}&per_page=1&orientation=landscape`, {
        headers: { 'Authorization': pexelsKey }
      });
      const data = await res.json();
      if (data.photos?.length > 0) {
        const photo = data.photos[0];
        const imgRes = await fetch(photo.src.original);
        const buffer = Buffer.from(await imgRes.arrayBuffer());
        const asset = await sanity.assets.upload('image', buffer, { filename: `cover-${Date.now()}.jpg` });
        return { _id: asset._id, source: 'pexels', photographer: photo.photographer };
      }
    } catch (e) { console.log('Pexels fallback:', e.message); }
  }

  // Fallback: Pollinations (generation)
  try {
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1280&height=720&nologo=true`;
    const imgRes = await fetch(url);
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    const asset = await sanity.assets.upload('image', buffer, { filename: `cover-${Date.now()}.jpg` });
    return { _id: asset._id, source: 'pollinations' };
  } catch (e) {
    console.log('Pollinations fallback:', e.message);
  }

  return null;
}

// --- Cleanup functions ---

export function stripInlineSourceCitations(markdown) {
  return markdown.replace(/\(Source:?\s*[^)]*\)/gi, '')
                 .replace(/\([^)]*https?:\/\/[^\s)]+[^)]*\)/g, '');
}

export function delinkUnverifiedReslinkLinks(markdown, verifiedPosts) {
  const validSlugs = verifiedPosts.map(p => p.slug?.current).filter(Boolean);
  const validUrls = validSlugs.map(s => `reslink.org/${s}`);
  return markdown.replace(/\[([^\]]*)\]\((https?:\/\/[^)]*reslink\.org[^)]*)\)/g, (match, text, url) => {
    if (validUrls.some(v => url.includes(v))) return match;
    return text;
  });
}

export function fixSquishedDates(markdown) {
  return markdown.replace(/\b([A-Z][a-z]+)(\d{1,2})(\d{4})\b/g, '$1 $2, $3');
}

export function fixNumericRangeSpacing(markdown) {
  return markdown.replace(/(\d+)\s*[-–]\s*(\d+)\s*([a-z]+)/gi, '$1–$2 $3');
}

export function removeYouMayAlsoLikeSection(markdown) {
  return markdown.replace(/\n?#+\s*You May Also Like\s*.*?(\n#+|\n\n|$)/is, '');
}

export function restrictSourcesToVerified(markdown, verifiedUrls) {
  const lines = markdown.split('\n');
  let inSources = false;
  const filtered = [];
  for (const line of lines) {
    if (/^#+\s*Sources/i.test(line)) {
      inSources = true;
      filtered.push(line);
      continue;
    }
    if (inSources) {
      if (line.startsWith('#') || line.trim() === '') {
        inSources = false;
        filtered.push(line);
        continue;
      }
      const urls = line.match(/https?:\/\/[^\s)]+/g);
      if (urls && urls.some(u => verifiedUrls.some(v => u.includes(v)))) {
        filtered.push(line);
      }
    } else {
      filtered.push(line);
    }
  }
  return filtered.join('\n');
}

// --- Exports ---

export {
  pickTargetMarket,
  fetchRecentPosts,
  gatherRSSSearchContext,
  jinaFetchMany,
  formatSearchResultsForPrompt,
  formatExtractedContentForPrompt,
  parseMetaPanel,
  extractExcerpt,
  slugify,
  extractTitle,
  getHeroImage,
  stripInlineSourceCitations,
  delinkUnverifiedReslinkLinks,
  fixSquishedDates,
  fixNumericRangeSpacing,
  removeYouMayAlsoLikeSection,
  restrictSourcesToVerified
};
