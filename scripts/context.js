// scripts/context.js
//
// Your topic-scanner prompt was written assuming three things exist:
//   1. A TARGET_MARKET to focus on
//   2. A list of recently published titles (for the 5-day topic lock)
//   3. The ability to run web searches
//
// The free model has none of these on its own. This file gathers all
// three ahead of time so they can be handed to the model as plain text,
// instead of the model trying (and failing) to fetch them itself.

// ---- 1. Market rotation --------------------------------------------------

const MARKET_WEIGHTS = [
  { market: "India", weight: 40 },
  { market: "United States", weight: 25 },
  { market: "European Union", weight: 10 },
  { market: "UK", weight: 5 },
  { market: "Philippines", weight: 5 },
  { market: "Thailand", weight: 5 },
  { market: "South Africa", weight: 5 },
  { market: "Australia", weight: 5 },
];
// 40% India, 25% US, 10% EU, 5% UK, remaining 20% split evenly across the
// four other markets (5% each). "European Union" replaces the old
// standalone "Germany" entry, broader regional coverage instead of one
// country. If you want Germany specifically back as its own slice, that's
// a one-line change here, nothing else depends on this list's shape.

export function pickTargetMarket() {
  const total = MARKET_WEIGHTS.reduce((sum, m) => sum + m.weight, 0);
  let roll = Math.random() * total;
  for (const m of MARKET_WEIGHTS) {
    if (roll < m.weight) return m.market;
    roll -= m.weight;
  }
  return MARKET_WEIGHTS[0].market;
}

// ---- 2. Recently published titles, for the 5-day topic lock -------------

export async function fetchPublishedTitles(sanityClient, documentType) {
  const fiveDaysAgo = new Date(
    Date.now() - 5 * 24 * 60 * 60 * 1000
  ).toISOString();
  const query = `*[_type == $type && defined(publishedAt) && publishedAt > $since]{title}`;
  try {
    const docs = await sanityClient.fetch(query, {
      type: documentType,
      since: fiveDaysAgo,
    });
    return docs.map((d) => d.title).filter(Boolean);
  } catch (err) {
    console.log(
      `Warning: couldn't fetch published titles from Sanity (${err.message}). Proceeding with an empty list, the topic lock won't have anything to check against this run.`
    );
    return [];
  }
}

// ---- 3. Pre-fetched web search, via Tavily's free tier -------------------

export async function tavilySearch(query, maxResults = 5) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error(
      "TAVILY_API_KEY is not set. Get a free key at tavily.com (no card required) and add it to .env."
    );
  }
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      search_depth: "basic", // 1 credit per search on the free tier, not 2
      max_results: maxResults,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Tavily error ${res.status}: ${body}`);
  }
  const data = await res.json();
  return (data.results || []).map((r) => ({
    title: r.title,
    url: r.url,
    content: r.content,
  }));
}

// Runs a small, fixed set of searches covering the topic-scanner's top
// priorities (time-critical deadlines, breaking news, general EPC-relevant
// developments) for one market. This is a deliberately scoped-down version
// of the full 15-20 search prompt, enough to ground the model in real
// results without burning through Tavily's free 1,000 credits/month.
export async function gatherSearchContext(targetMarket) {
  const now = new Date();
  const monthYear = now.toLocaleString("en-US", {
    month: "long",
    year: "numeric",
  });

  const queries = [
    {
      label: "Time-critical deadlines and policy changes",
      query: `${targetMarket} solar policy deadline OR regulatory change ${monthYear}`,
    },
    {
      label: "Breaking solar/EPC news, last 14 days",
      query: `${targetMarket} solar EPC news ${monthYear}`,
    },
    {
      label: "General solar market developments",
      query: `${targetMarket} commercial industrial solar market update ${monthYear}`,
    },
  ];

  const groups = [];
  for (const q of queries) {
    const results = await tavilySearch(q.query, 4);
    groups.push({ label: q.label, results });
  }
  return groups;
}

export function formatSearchResultsForPrompt(groups) {
  let out = "";
  for (const group of groups) {
    out += `\n### ${group.label}\n`;
    if (!group.results.length) {
      out += "(no results found)\n";
      continue;
    }
    for (const r of group.results) {
      out += `- ${r.title}\n  URL: ${r.url}\n  ${(r.content || "").slice(0, 500)}\n`;
    }
  }
  return out;
}

// ---- 3b. Search via Google News RSS, replacing Tavily search -------------
//
// A real, deliberately published feed, not a scraped search-results page,
// so it doesn't have the bot-detection fragility of scraping Google or
// DuckDuckGo directly. Real caveats: unofficial (Google doesn't document
// or support this), skews toward slightly stale news, and hands back
// Google's redirect links rather than the real article URL. That last
// part is fine here, Jina Reader (below) follows the redirect itself when
// it fetches, the same way a browser would.

function parseRSSItems(xml, limit = 4) {
  const clean = (s) =>
    (s || "")
      .replace(/^<!\[CDATA\[/, "")
      .replace(/\]\]>$/, "")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();

  const items = [];
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const block of blocks.slice(0, limit)) {
    const title = clean((block.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
    const link = ((block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "").trim();
    const desc = clean((block.match(/<description>([\s\S]*?)<\/description>/) || [])[1]);
    if (title && link) items.push({ title, url: link, content: desc });
  }
  return items;
}

async function fetchGoogleNewsRSS(query, limit = 4) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(
    query
  )}&hl=en-US&gl=US&ceid=US:en`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`RSS fetch error ${res.status}`);
    const xml = await res.text();
    return parseRSSItems(xml, limit);
  } catch (err) {
    console.log(`Warning: RSS search failed for "${query}" (${err.message}). Continuing with fewer results.`);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

// Same three-query shape as the old Tavily version, same output shape too,
// this is a drop-in replacement for gatherSearchContext above.
export async function gatherRSSSearchContext(targetMarket) {
  const now = new Date();
  const monthYear = now.toLocaleString("en-US", { month: "long", year: "numeric" });

  const queries = [
    { label: "Time-critical deadlines and policy changes", q: `${targetMarket} solar policy deadline` },
    { label: "Breaking solar/EPC news", q: `${targetMarket} solar EPC news ${monthYear}` },
    { label: "General solar market developments", q: `${targetMarket} commercial industrial solar market` },
  ];

  const groups = [];
  for (const item of queries) {
    const results = await fetchGoogleNewsRSS(item.q, 4);
    groups.push({ label: item.label, results });
  }
  return groups;
}

// ---- 4. Fetching the SOURCES_TO_FETCH URLs from the brief ----------------
//
// content-writer.md requires reading the actual pages listed in the brief
// before writing any claim ("Never write a claim without a fetched
// source"). The model has no fetch tool. Same gap as the topic scanner's
// search requirement, one stage later, so it gets the same fix: fetch it
// ourselves, hand over the content as plain text.

export function extractSourceUrls(briefText) {
  const section = briefText.match(
    /SOURCES_TO_FETCH:([\s\S]*?)(?:\n[A-Z_]+:|---END BRIEF---|$)/
  );
  const text = section ? section[1] : briefText;
  const urls = text.match(/https?:\/\/[^\s)]+/g) || [];
  return [...new Set(urls)].slice(0, 6); // dedupe, cap at 6 per run
}

export async function tavilyExtract(urls) {
  if (!urls.length) return { results: [], failed: [] };
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error(
      "TAVILY_API_KEY is not set. Get a free key at tavily.com and add it to .env."
    );
  }
  const res = await fetch("https://api.tavily.com/extract", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      urls,
      extract_depth: "basic", // 1 credit per 5 successful extractions
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Tavily extract error ${res.status}: ${body}`);
  }
  const data = await res.json();
  return {
    results: (data.results || []).map((r) => ({
      url: r.url,
      content: (r.raw_content || "").slice(0, 3000),
    })),
    failed: (data.failed_results || []).map((f) => f.url || f),
  };
}

// ---- 4c. Trusted-source filtering, code-level not prompt-only ------------
//
// content-writer.md already has a sourcing hierarchy (primary/government
// first, named trade press second, an explicit never-use list third), but
// that's a prompt-only rule, and the established pattern in this pipeline
// is that prompt-only rules don't reliably hold once a failure mode has
// shown up twice (word count, citation formatting). Rather than trust the
// model to self-police which of the Jina-fetched sources are credible,
// this filters them in code before they're ever handed over: an untrusted
// domain is treated exactly like a failed fetch, the writer softens or
// drops whatever claim depended on it, per its own existing sourcing
// rules. Less information published beats false information published.
//
// This list is deliberately maintained here, not regenerated from
// content-writer.md's prose list, so it can be tightened or extended
// independently. Add a domain any time a new legitimate primary/trade
// source needs to be trusted.
const TRUSTED_SOURCE_DOMAINS = [
  // Established trade press (mirrors content-writer.md's named list)
  "pv-tech.org",
  "pv-magazine.com",
  "pv-magazine-india.com",
  "mercomindia.com",
  "energetica-india.net",
  "solarpowerportal.co.uk",
  "philstar.com",
  "bangkokpost.com",
  "cleanenergywire.org",
  "energy-storage.news",
  "saurenergy.com",
  "solarquarter.com",
  "renewablewatch.in",
  "eqmagpro.com",
  "tilleke.com",
  "hunton.com",
];

// Any hostname ending in one of these suffixes is treated as a government
// or primary regulatory source and trusted automatically, so this list
// doesn't need every individual ministry/DISCOM domain added by hand.
const TRUSTED_GOV_SUFFIXES = [".gov.in", ".nic.in", ".gov", ".gov.uk"];

function isTrustedSourceDomain(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return false; // unparseable URL, never trust it
  }
  if (TRUSTED_GOV_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return true;
  return TRUSTED_SOURCE_DOMAINS.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
  );
}

// Applies the trusted-domain check to a jinaFetchMany() result. Anything
// from an untrusted domain moves from `results` into `failed`, so every
// downstream consumer (formatExtractedContentForPrompt,
// restrictSourcesToVerified, replaceOriginalUrlsWithResolved) treats it
// exactly like a source that simply couldn't be fetched, no separate
// code path needed anywhere else.
export function filterTrustedSources(extracted) {
  const trustedResults = [];
  const newlyUntrusted = [];
  for (const r of extracted.results) {
    if (isTrustedSourceDomain(r.url)) trustedResults.push(r);
    else newlyUntrusted.push(r.originalUrl || r.url);
  }
  return {
    results: trustedResults,
    failed: [...extracted.failed, ...newlyUntrusted],
    droppedForTrust: newlyUntrusted,
  };
}

export function formatExtractedContentForPrompt(extracted) {
  let out = "";
  for (const r of extracted.results) {
    out += `\n### Source (cite this exact URL, it's the real destination, not the Google redirect link you may see elsewhere): ${r.url}\n${r.content}\n`;
  }
  if (extracted.failed.length) {
    out += `\n### Could not fetch, treat any claim depending on these as unsourced per your own rules:\n`;
    for (const url of extracted.failed) out += `- ${url}\n`;
  }
  return out;
}

// ---- 4b. Fetching via Jina Reader, replacing Tavily Extract --------------
//
// Free, no key required for basic use (a key just raises the rate limit,
// nowhere near needed at our volume). Jina fetches the page itself and
// follows redirects the way a browser does, which is why the Google News
// redirect links from gatherRSSSearchContext can be handed to it directly,
// no manual unwrapping needed.

export async function jinaFetchOne(url) {
  const apiKey = process.env.JINA_API_KEY; // optional
  const headers = apiKey
    ? { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }
    : { Accept: "application/json" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Jina error ${res.status}`);

    // JSON mode gives back the real, final URL after Google's redirect
    // gets followed, that's what should get cited, not the ugly wrapper
    // link. Falling back to the original URL if the response shape isn't
    // what's expected, rather than failing the whole fetch over it.
    const raw = await res.text();
    try {
      const parsed = JSON.parse(raw);
      const data = parsed.data || parsed;
      return {
        resolvedUrl: data.url || url,
        content: (data.content || raw).slice(0, 3000),
      };
    } catch {
      return { resolvedUrl: url, content: raw.slice(0, 3000) };
    }
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Jina Reader didn't respond within 30s");
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export async function jinaFetchMany(urls) {
  const settled = await Promise.allSettled(
    urls.map((url) =>
      jinaFetchOne(url).then(({ resolvedUrl, content }) => ({
        originalUrl: url,
        url: resolvedUrl,
        content,
      }))
    )
  );
  const results = [];
  const failed = [];
  settled.forEach((outcome, i) => {
    if (outcome.status === "fulfilled") results.push(outcome.value);
    else failed.push(urls[i]);
  });
  return { results, failed };
}

// The model sees both the resolved URL (in the fetched-content block) and
// the original Google redirect link (in the brief's SOURCES_TO_FETCH
// list), and doesn't reliably pick the resolved one when citing sources.
// Rather than keep hoping the prompt fixes that, force it: replace every
// occurrence of each original URL with its resolved counterpart directly
// in the final draft, deterministic, not dependent on model behavior.
export function replaceOriginalUrlsWithResolved(markdown, extractedResults) {
  let cleaned = markdown;
  let replacedCount = 0;
  for (const r of extractedResults) {
    if (r.originalUrl && r.url && r.originalUrl !== r.url && cleaned.includes(r.originalUrl)) {
      cleaned = cleaned.split(r.originalUrl).join(r.url);
      replacedCount++;
    }
  }
  return { cleaned, replacedCount };
}

// ---- 6. Parsing the meta panel, instead of just discarding it ------------
//
// Your content-writer prompt's "meta panel" (hidden via HTML comment) has
// real, usable data in it, meta title, meta description, tags, it was
// just being thrown away along with the comment wrapper. Your real Sanity
// schema has actual fields for this: seoTitle, seoDescription, tags.

export function parseMetaPanel(rawMarkdown) {
  const match = rawMarkdown.match(/<!--([\s\S]*?)-->/);
  if (!match) return {};
  const panel = match[1];

  const get = (label) => {
    const re = new RegExp(`${label}:\\s*([^;]+)`, "i");
    const m = panel.match(re);
    if (!m) return undefined;
    return m[1].replace(/\(\d+\s*chars?\)\s*$/i, "").trim();
  };

  const seoTitle = get("Meta Title");
  const seoDescription = get("Meta Description");
  // The meta panel format is "Tags: [tag1, tag2, tag3]", the brackets are
  // part of the literal spec, not something the split()/trim() below ever
  // accounted for, so the first tag kept a leading "[" and the last kept
  // a trailing "]". Stripped here before splitting, plus a per-tag safety
  // strip in case a stray bracket ends up somewhere else in the list.
  const tagsRaw = get("Tags")?.replace(/^\[+/, "").replace(/\]+$/, "");
  const tags = tagsRaw
    ? tagsRaw
        .split(",")
        .map((t) => t.trim().replace(/^\[+|\]+$/g, "").trim())
        .filter(Boolean)
    : [];

  return { seoTitle, seoDescription, tags };
}

// Meta description hard cap: content-writer.md asks for 140-150 characters,
// but a prompt-only instruction has a track record of not holding on its
// own (same lesson as word-count enforcement). This enforces the ceiling
// deterministically by truncating at the last word boundary before the max,
// never mid-word. The floor (140) can't be safely auto-fixed without
// inventing filler text, so a too-short result is only flagged, not padded.
export function enforceMetaDescriptionLength(description, minChars = 140, maxChars = 150) {
  if (!description) return { text: description, truncated: false, tooShort: false };
  let text = description.trim();
  let truncated = false;
  if (text.length > maxChars) {
    const slice = text.slice(0, maxChars);
    const lastSpace = slice.lastIndexOf(" ");
    text = (lastSpace > minChars ? slice.slice(0, lastSpace) : slice).trim().replace(/[.,;:]+$/, "");
    truncated = true;
  }
  return { text, truncated, tooShort: text.length < minChars };
}

// TL;DR-specific extraction, separate from extractExcerpt (which truncates
// for the Sanity excerpt field). This one returns the full TL;DR text
// untruncated, so its real word count can be checked. content-writer.md
// asks for 90-110 words, a prompt-only target that doesn't reliably hold,
// same failure mode word count and citation formatting had before they
// got real code backstops.
export function extractTldrText(markdown) {
  const tldrMatch = markdown.match(/(?:\*\*)?TL\s*;?\s*DR:?(?:\*\*)?\s*([\s\S]*?)(?:\n\n|\n##|$)/i);
  if (!tldrMatch) return "";
  return tldrMatch[1].replace(/[#*_>`]/g, "").replace(/\s+/g, " ").trim();
}

export function tldrWordCount(markdown) {
  const text = extractTldrText(markdown);
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

export function extractExcerpt(markdown, maxLen = 200) {
  // content-writer.md now outputs TL;DR as a bare paragraph, no heading,
  // just starting with the literal text "TL;DR:", matching your real
  // published posts. Tolerant of minor formatting drift (optional bold
  // markers, "TL DR", "TLDR", etc), models aren't perfectly consistent.
  const tldrMatch = markdown.match(/(?:\*\*)?TL\s*;?\s*DR:?(?:\*\*)?\s*([\s\S]*?)(?:\n\n|\n##|$)/i);
  let text = tldrMatch ? tldrMatch[1] : "";

  // Fall back to the first real paragraph after the H1 if there's no
  // TL;DR. The title line itself is stripped out first, always, so it
  // can never end up inside the excerpt no matter what follows it.
  if (!text.trim()) {
    const withoutTitle = markdown.replace(/^#\s+.+\n+/, "");
    const paraMatch = withoutTitle.match(/([\s\S]*?)(?:\n##|\n\n|$)/);
    text = paraMatch ? paraMatch[1] : "";
  }

  text = text.replace(/[#*_>`]/g, "").replace(/\s+/g, " ").trim();
  return text.length > maxLen ? text.slice(0, maxLen - 3).trim() + "..." : text;
}

export function delinkUnverifiedReslinkLinks(markdown, verifiedUrls) {
  const verified = new Set(verifiedUrls);
  let strippedCount = 0;
  const cleaned = markdown.replace(
    /\[([^\]]+)\]\((https?:\/\/(?:www\.)?reslink\.org[^\s)]*)\)/g,
    (match, text, url) => {
      if (verified.has(url)) return match; // real, verified post, keep it
      strippedCount++;
      return text; // invented (demo pages, resources, etc.), drop the link, keep the text
    }
  );
  return { cleaned, strippedCount };
}

// The model sometimes invents plausible-looking titles even when handed
// the real post list, "Solar Design Software Benefits" instead of an
// actual title. delinkUnverifiedReslinkLinks correctly drops the fake
// link but leaves the fake title sitting there as dead, non-clickable
// text, which looks broken. This is more aggressive: drop the whole
// bullet if it's not a real, verified link, and drop the entire section,
// heading included, if nothing real survives.
export function cleanYouMayAlsoLikeSection(markdown, verifiedUrls) {
  const verified = new Set(verifiedUrls);
  const sectionMatch = markdown.match(/(#{2,3}\s*You May Also Like\s*\n+)([\s\S]*?)(?=\n#{1,3}\s|$)/i);
  if (!sectionMatch) return { cleaned: markdown, sectionRemoved: false };

  const [fullMatch, heading, body] = sectionMatch;
  const keptLines = body
    .split("\n")
    .filter((line) => {
      const linkMatch = line.match(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/);
      return linkMatch && verified.has(linkMatch[2]);
    });

  if (keptLines.length === 0) {
    const cleaned = markdown.replace(fullMatch, "").replace(/\n{3,}/g, "\n\n");
    return { cleaned, sectionRemoved: true };
  }

  const cleaned = markdown.replace(fullMatch, heading + keptLines.join("\n") + "\n");
  return { cleaned, sectionRemoved: false };
}

// Unconditional removal, "You May Also Like" is off entirely for now,
// regardless of whether any links in it happen to be real.
export function removeYouMayAlsoLikeSection(markdown) {
  const sectionMatch = markdown.match(/#{2,3}\s*You May Also Like\s*\n+[\s\S]*?(?=\n#{1,3}\s|$)/i);
  if (!sectionMatch) return { cleaned: markdown, removed: false };
  const cleaned = markdown.replace(sectionMatch[0], "").replace(/\n{3,}/g, "\n\n");
  return { cleaned, removed: true };
}

// Checking whether a URL merely responds (the existing lint broken-link
// check) isn't the same as knowing it's the right page. A source that
// 200s but was never actually fetched and read isn't verified, it's a
// guess that happened to resolve. Restrict the final Sources section to
// only what was genuinely fetched via Jina, drop anything else, fewer
// sources that are all real beats more sources with some risk of being
// wrong. Light URL normalization (trailing slash, protocol) so a
// legitimately-fetched source doesn't get dropped over formatting noise.
function normalizeUrl(url) {
  return url.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
}

// Real bug found in production: a hallucinated government URL, plausible
// path and all, showed up cited in the body, survived every existing
// cleanup step, and only got caught (unreliably) by lint's HTTP check at
// the very end. The reason: restrictSourcesToVerified below only checks
// the "## Sources" section. A citation link anywhere else in the
// document, inline in a paragraph, inside an EPC blockquote, wherever,
// was never checked against what was actually Jina-verified. This closes
// that gap: any link in the entire document that isn't a real,
// Jina-fetched URL gets de-linked (text kept, href dropped), the same
// integrity standard the Sources section already gets, just applied
// everywhere. reslink.org links are left alone here, delinkUnverifiedReslinkLinks
// already handles those separately with its own verified-post list.
export function restrictAllLinksToVerified(markdown, verifiedUrls) {
  const verifiedNormalized = new Set(verifiedUrls.map(normalizeUrl));
  let strippedCount = 0;
  const cleaned = markdown.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (match, text, url) => {
      if (/reslink\.org/i.test(url)) return match; // handled separately, leave it
      if (verifiedNormalized.has(normalizeUrl(url))) return match; // real, Jina-verified, keep it
      strippedCount++;
      return text; // unverified anywhere in the document, drop the link, keep the text
    }
  );
  return { cleaned, strippedCount };
}

export function restrictSourcesToVerified(markdown, verifiedUrls) {
  const verifiedNormalized = new Set(verifiedUrls.map(normalizeUrl));
  // Primarily matches "Sources" per content-writer.md's explicit rule,
  // but tolerates a few real variants seen in production (a renamed
  // heading like "Resources & Contacts") as a defensive backup, so this
  // check doesn't silently no-op just because the model missed the
  // exact-heading-text instruction on a given run.
  const sectionMatch = markdown.match(
    /(#{2,3}\s*(?:Sources|References|Resources(?:\s*(?:&|and)?\s*Contacts)?)\s*\n+)([\s\S]*?)(?=\n#{1,3}\s|$)/i
  );
  if (!sectionMatch) return { cleaned: markdown, removedCount: 0, sectionEmpty: false };

  const [fullMatch, heading, body] = sectionMatch;
  const lines = body.split("\n").filter((l) => l.trim().length > 0);
  let removedCount = 0;
  const keptLines = lines.filter((line) => {
    const urlMatch = line.match(/https?:\/\/[^\s)\]]+/);
    const isVerified = urlMatch && verifiedNormalized.has(normalizeUrl(urlMatch[0]));
    if (!isVerified) removedCount++;
    return isVerified;
  });

  if (keptLines.length === 0) {
    const cleaned = markdown.replace(fullMatch, "").replace(/\n{3,}/g, "\n\n");
    return { cleaned, removedCount, sectionEmpty: true };
  }
  const cleaned = markdown.replace(fullMatch, heading + keptLines.join("\n") + "\n");
  return { cleaned, removedCount, sectionEmpty: false };
}

// Guaranteed catch-all: any Google News redirect link that's still in the
// draft after replaceOriginalUrlsWithResolved has run, meaning it came
// from a brief field other than SOURCES_TO_FETCH and never got resolved,
// gets de-linked the same way. An unreadable redirect ID is never an
// acceptable citation, whether we have a real URL to swap it for or not.
export function stripUnresolvedGoogleRedirects(markdown) {
  let strippedCount = 0;
  const cleaned = markdown.replace(
    /\[([^\]]+)\]\((https?:\/\/news\.google\.com\/[^\s)]*)\)/g,
    (match, text) => {
      strippedCount++;
      return text;
    }
  );
  // Also catch bare (non-linked) redirect URLs the model sometimes pastes
  // in plain text rather than as a Markdown link.
  const cleaned2 = cleaned.replace(/https?:\/\/news\.google\.com\/rss\/articles\/[^\s)]*/g, () => {
    strippedCount++;
    return "";
  });
  return { cleaned: cleaned2, strippedCount };
}

// content-writer.md explicitly bans inline "(Source: ...)" citations
// interrupting body paragraphs, sources belong only in the Sources
// section. The prompt rule alone doesn't reliably hold, this strips any
// that survive. Handles one level of nested parens (a URL or quoted
// title inside the citation), not infinitely nested, that's not a shape
// this ever needs to handle in practice.
export function stripInlineSourceCitations(markdown) {
  let strippedCount = 0;
  // First pass: explicit "(Source: ...)" style, whatever's inside.
  let cleaned = markdown.replace(
    /\s*\((?:Source|Sources?):(?:[^()]|\([^()]*\))*\)/gi,
    () => {
      strippedCount++;
      return "";
    }
  );
  // Second, broader pass: any standalone parenthetical containing a bare
  // URL, regardless of wording ("Circular 2023/005, https://...", "per
  // https://...", etc). The model keeps finding new phrasings for the
  // same underlying habit, this catches the shape instead of the words.
  // Excludes real Markdown links, `(?<!\])` means this parenthetical
  // isn't the URL half of a [text](url) link.
  cleaned = cleaned.replace(/(?<!\])\s*\([^()]*https?:\/\/[^()\s]+[^()]*\)/g, () => {
    strippedCount++;
    return "";
  });
  // Third pass: 【N†URL】 style markers, a citation format some models
  // reproduce from training data resembling browsing-tool citation
  // syntax, even with no such tool involved. Full-width brackets are
  // essentially never used in normal English prose, safe to strip
  // aggressively without meaningful false-positive risk.
  cleaned = cleaned.replace(/\s*【[^【】]*】/g, () => {
    strippedCount++;
    return "";
  });
  // Clean up any stray double-spaces or space-before-punctuation left
  // behind by the removal.
  cleaned = cleaned.replace(/\s+([.,;:])/g, "$1").replace(/[ \t]{2,}/g, " ");
  return { cleaned, strippedCount };
}

// Real, reproducible bug seen twice now: the model occasionally writes a
// date with no spaces at all inside a bold label, "July42026" instead of
// "July 4, 2026". Two rounds of prompt instructions didn't fix it, this
// catches it deterministically. Narrow on purpose, month name directly
// followed by a 1-2 digit day directly followed by exactly 4 digits, this
// exact shape essentially only occurs from this specific bug, not from
// real prose.
export function fixSquishedDates(markdown) {
  const months =
    "January|February|March|April|May|June|July|August|September|October|November|December";
  const regex = new RegExp(`\\b(${months})(\\d{1,2})(\\d{4})(?!\\d)`, "g");
  let fixedCount = 0;
  const cleaned = markdown.replace(regex, (match, month, day, year) => {
    fixedCount++;
    return `${month} ${day}, ${year}`;
  });
  return { cleaned, fixedCount };
}

// Same failure category as fixSquishedDates, a number glued directly to
// the word after it, just showing up in durations now ("3months") instead
// of dates. Fixed in two narrow passes: first the number-word gap, then
// small numeric ranges ("0-3" -> "0 - 3"). The range fix is deliberately
// limited to 1-2 digit numbers on both sides so it never touches a
// standards code or model number ("IEC 61730-1", "TIS 1645-1") or a real
// compound word ("Tier-1", "25-year").
export function fixDurationSpacing(markdown) {
  let fixedCount = 0;
  let cleaned = markdown.replace(/(\d)(months?|days?|weeks?|years?|hours?|minutes?)\b/gi, (m, d, w) => {
    fixedCount++;
    return `${d} ${w}`;
  });
  cleaned = cleaned.replace(/\b(\d{1,2})\s*[-–]\s*(\d{1,2})\b/g, (m, a, b) => {
    fixedCount++;
    return `${a} - ${b}`;
  });
  return { cleaned, fixedCount };
}

// Categorization/supporting-info subheadings must be H4 with a bolded
// label ("#### **Label**"), never a bare H3, per content-writer.md.
// A prompt-only rule for this has drifted before (fixed manually once
// already), so this backstops it deterministically. Narrow on purpose:
// only touches a line that is *exactly* "### **Label**" with nothing else
// on it, the same shape as a legitimate H4 label just at the wrong
// heading level, so it won't touch a real H3 used for something else or
// a bolded phrase inside normal body text.
export function fixBoldedH3Headings(markdown) {
  let fixedCount = 0;
  const cleaned = markdown.replace(/^###\s+(\*\*[^*\n]+\*\*)\s*$/gm, (match, label) => {
    fixedCount++;
    return `#### ${label}`;
  });
  return { cleaned, fixedCount };
}

// ---- 7. Cover image: extract the prompt, generate it, upload it ---------
//
// content-writer.md already outputs two hero image prompt options inside
// the meta panel. This pulls Option A out, generates it via Pollinations
// (free, no key needed), and uploads the result to Sanity's asset store
// so it can be referenced as the post's cover image.

export function extractHeroImagePrompt(rawMarkdown) {
  const panelMatch = rawMarkdown.match(/<!--([\s\S]*?)-->/);
  if (!panelMatch) return null;
  const panel = panelMatch[1];

  const imgSection = panel.match(/Image Prompts:\s*([\s\S]+)$/i);
  if (!imgSection) return null;

  const optionA = imgSection[1].match(/Option A:\s*([^;\]]+)/i);
  if (optionA) return optionA[1].trim();

  // Fallback: whatever's there, capped to a sane length.
  return imgSection[1].replace(/[[\]]/g, "").trim().slice(0, 400) || null;
}

// Fallback search phrases per market, used when extractHeroImagePrompt
// returns nothing usable, or when the query safeguard below decides what
// the model produced is too bare to trust. Specific cities/landmarks
// instead of a bare country name, a bare country or region name (most of
// all "EU", "USA", or the country name alone) resolves to a flag graphic
// on stock photo search almost every time.
const MARKET_IMAGE_FALLBACKS = {
  "India": "Mumbai skyline rooftops",
  "United States": "American city skyline aerial",
  "European Union": "Berlin city skyline architecture",
  "UK": "London architecture skyline",
  "Philippines": "Manila Bay skyline",
  "Thailand": "Bangkok skyline Chao Phraya river",
  "South Africa": "Cape Town Table Mountain",
  "Australia": "Australian city skyline",
};

// Backstop for the flag-image problem: if the query the model produced is
// empty, is just the bare market/country name, or literally mentions
// "flag", swap in a known-good landmark/skyline search phrase for that
// market instead. This runs after content-writer.md's own instructions,
// which should mostly prevent this, but a code-level backstop doesn't
// depend on the model reliably following a prompt rule every single time.
export function safeguardImageQuery(query, targetMarket) {
  const trimmed = (query || "").trim();
  const isBareOrFlagLike =
    !trimmed ||
    Object.keys(MARKET_IMAGE_FALLBACKS).some((m) => trimmed.toLowerCase() === m.toLowerCase()) ||
    /\bflag\b/i.test(trimmed);
  if (isBareOrFlagLike && MARKET_IMAGE_FALLBACKS[targetMarket]) {
    return MARKET_IMAGE_FALLBACKS[targetMarket];
  }
  return trimmed || MARKET_IMAGE_FALLBACKS[targetMarket] || "solar energy commercial building";
}

export async function generateImage(prompt, { width = 1280, height = 720 } = {}) {
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(
    prompt
  )}?width=${width}&height=${height}&model=flux&nologo=true`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Pollinations error ${res.status}`);

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) {
      throw new Error(`Pollinations returned ${contentType || "unknown content type"}, not an image`);
    }

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    // Real generated photos run well over 50KB. A near-empty or broken
    // response is a real failure, not a quality judgment, catching a
    // blank/error image, not rejecting one that's merely unattractive.
    if (buffer.length < 20_000) {
      throw new Error(`Pollinations returned a suspiciously small file (${buffer.length} bytes), likely broken`);
    }
    return buffer;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("Pollinations didn't respond within 60s");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export async function uploadImageToSanity(sanityClient, buffer, filename) {
  const asset = await sanityClient.assets.upload("image", buffer, { filename });
  return asset._id;
}

// ---- 7a2. Universal promo creative, uploaded once, reused forever -------
//
// The same image on every post, linking to /demo/, not generated or
// searched per post. Upload it once via Sanity Studio's media library
// with this exact filename, and every future run finds and reuses it
// automatically, no re-uploading, no duplicate assets piling up.

// Confirmed real, already sitting in the Sanity media library, derived
// from the actual CDN URL: project cw3fr4fd matches, and 8000x4500
// matches the promo banner spec exactly. No lookup needed, no upload
// step needed, this ID is permanent as long as the asset isn't deleted
// from Sanity's media library.
export const PROMO_IMAGE_ASSET_ID = "image-4978883d208c7a22ca5c7cf812912b2eb79fa955-8000x4500-png";
export const PROMO_IMAGE_LINK = "https://www.reslink.org/demo/";
// Real Sanity schema, confirmed from a live document: the image block's
// link field is a nested object with "href" and "openInNewTab", not a
// bare string. Alt text is required by the schema (Studio flags it with
// a warning icon when empty), so it's set here too, fixed for every post
// since it's the same image every time.
export const PROMO_IMAGE_ALT = "Reslink 3D solar design software";

// ---- 7b. Real stock photo search, now the primary path -------------------
//
// Unsplash tried first, then Pexels if Unsplash has nothing good. Both
// real, free, and both require crediting the photographer whenever a
// photo is actually used, that's the getHeroImage return value's
// `attribution` field, log it or display it, don't silently drop it.

export async function searchUnsplashImage(query) {
  const accessKey = process.env.UNSPLASH_ACCESS_KEY;
  if (!accessKey) {
    throw new Error("UNSPLASH_ACCESS_KEY is not set. Get a free key at unsplash.com/developers.");
  }
  const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(
    query
  )}&per_page=1&orientation=landscape`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Client-ID ${accessKey}` },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Unsplash search error ${res.status}`);
    const data = await res.json();
    const photo = data?.results?.[0];
    if (!photo) throw new Error(`Unsplash had no results for "${query}"`);

    return {
      imageUrl: photo.urls.full,
      photographerName: photo.user.name,
      photographerLink: photo.user.links.html,
      downloadLocation: photo.links.download_location,
      source: "Unsplash",
    };
  } finally {
    clearTimeout(timeout);
  }
}

// Unsplash's API guidelines require pinging this endpoint whenever a
// photo is actually used, separate from the license itself. Best-effort,
// a failure here shouldn't block publishing the post.
async function pingUnsplashDownload(downloadLocation) {
  const accessKey = process.env.UNSPLASH_ACCESS_KEY;
  try {
    await fetch(`${downloadLocation}?client_id=${accessKey}`);
  } catch (err) {
    console.log(`Warning: Unsplash download ping failed (${err.message}), not blocking on this.`);
  }
}

export async function searchPexelsImage(query) {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) {
    throw new Error("PEXELS_API_KEY is not set. Get a free key at pexels.com/api.");
  }
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(
    query
  )}&per_page=1&orientation=landscape`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    // Pexels wants the raw key in this header, not a "Bearer" or
    // "Client-ID" prefix, different convention from Unsplash.
    const res = await fetch(url, {
      headers: { Authorization: apiKey },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Pexels search error ${res.status}`);
    const data = await res.json();
    const photo = data?.photos?.[0];
    if (!photo) throw new Error(`Pexels had no results for "${query}"`);

    return {
      imageUrl: photo.src.large2x,
      photographerName: photo.photographer,
      photographerLink: photo.photographer_url,
      source: "Pexels",
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadImage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Image download error ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
}

// Stock search first (Unsplash, then Pexels), generation only as a last
// resort if neither turns up a real match. Returns null (not a throw) if
// everything fails, publishing without a cover image, same
// graceful-degradation pattern as everywhere else in this pipeline.
export async function getHeroImage(query) {
  try {
    const photo = await searchUnsplashImage(query);
    const buffer = await downloadImage(photo.imageUrl);
    await pingUnsplashDownload(photo.downloadLocation);
    return {
      buffer,
      source: "unsplash",
      attribution: `Photo by ${photo.photographerName} on Unsplash (${photo.photographerLink})`,
    };
  } catch (unsplashErr) {
    console.log(`Unsplash search failed (${unsplashErr.message}), trying Pexels...`);
  }

  try {
    const photo = await searchPexelsImage(query);
    const buffer = await downloadImage(photo.imageUrl);
    return {
      buffer,
      source: "pexels",
      attribution: `Photo by ${photo.photographerName} on Pexels (${photo.photographerLink})`,
    };
  } catch (pexelsErr) {
    console.log(`Pexels search also failed (${pexelsErr.message}), falling back to generation as a last resort...`);
  }

  try {
    const buffer = await generateImage(query);
    return { buffer, source: "generated", attribution: null };
  } catch (genErr) {
    console.log(`Generation also failed (${genErr.message}), publishing without a cover image.`);
    return null;
  }
}

// ---- 5. Real Reslink post links, for "You May Also Like" -----------------
//
// Your topic-scanner brief asks for RELATED_RESLINK_BLOGS via a
// site:reslink.org search, another live search the model can't actually
// run, so it was inventing URLs instead. Same fix pattern as everywhere
// else: pull the real thing from Sanity directly, hand it over as fact.

export async function fetchRecentPosts(sanityClient, documentType, limit = 8) {
  const query = `*[_type == $type && defined(slug.current)] | order(_createdAt desc) [0...$limit]{title, "slug": slug.current}`;
  try {
    const docs = await sanityClient.fetch(query, { type: documentType, limit });
    return docs
      .filter((d) => d.title && d.slug)
      .map((d) => ({ title: d.title, url: `https://reslink.org/blogs/${d.slug}` }));
  } catch (err) {
    console.log(
      `Warning: couldn't fetch recent posts from Sanity (${err.message}). "You May Also Like" will have nothing real to link to this run.`
    );
    return [];
  }
}

export function formatRecentPostsForPrompt(posts) {
  if (!posts.length) {
    return "(No other posts exist yet to link to. Omit the \"You May Also Like\" section entirely rather than inventing links.)";
  }
  return posts.map((p) => `- ${p.title}\n  ${p.url}`).join("\n");
}

// ---- 8. Google Search Console, read-only search performance data --------
//
// Authenticates via a service account (not OAuth), the right approach for
// an unattended pipeline, no browser consent screen, no expiring token.
// GSC_SERVICE_ACCOUNT_KEY holds the full contents of the downloaded JSON
// key file. GSC_SITE_URL must exactly match how the property is verified
// in Search Console: "sc-domain:reslink.org" for a domain property, or
// the full "https://reslink.org/" (with trailing slash) for a URL-prefix
// property. Check the property selector dropdown inside Search Console
// itself if unsure which one applies.
//
// This is intentionally just a data-fetching function, not wired into any
// decision-making yet. What the pipeline should actually do with this
// data (the "self-analysis and feedback loop") is still an open design
// question, not something to guess at silently inside a helper function.

export async function fetchSearchConsoleData({
  siteUrl,
  startDate,
  endDate,
  dimensions = ["query", "page"],
  rowLimit = 25,
} = {}) {
  const rawKey = process.env.GSC_SERVICE_ACCOUNT_KEY;
  if (!rawKey) {
    throw new Error(
      "GSC_SERVICE_ACCOUNT_KEY is not set. Create a service account in Google Cloud, download its JSON key, and add the full contents as this env var / GitHub secret."
    );
  }

  let credentials;
  try {
    credentials = JSON.parse(rawKey);
  } catch (err) {
    throw new Error(
      `GSC_SERVICE_ACCOUNT_KEY isn't valid JSON (${err.message}). Make sure the entire downloaded .json file's contents were pasted in as-is, not a file path or a partial copy.`
    );
  }

  // Lazy import: googleapis is a large package, only load it when this
  // function is actually called, not on every pipeline run.
  const { google } = await import("googleapis");

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
  });

  const searchconsole = google.searchconsole({ version: "v1", auth });

  const response = await searchconsole.searchanalytics.query({
    siteUrl,
    requestBody: {
      startDate,
      endDate,
      dimensions,
      rowLimit,
      dataState: "final", // excludes the last couple of days' still-settling data
    },
  });

  return (response.data.rows || []).map((row) => ({
    keys: row.keys,
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: row.ctr,
    position: row.position,
  }));
}
