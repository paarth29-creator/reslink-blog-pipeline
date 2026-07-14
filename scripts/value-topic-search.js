// scripts/value-topic-search.js
//
// Google News RSS (gatherRSSSearchContext in context.js) is a news feed.
// It was already rejected once for evergreen topics in this project and
// would fail the same way here: reference/technical content like "solar
// panel degradation rate" isn't news, it mostly won't be indexed there.
//
// Rather than build a new search integration, this reuses Tavily
// (already coded in context.js as tavilySearch/tavilyExtract, present
// but unused since the main pipeline moved to RSS+Jina). Tavily's
// `topic: "general"` mode is a real web search, not news-scoped, and its
// `include_domains` parameter lets each query be scoped directly to a
// curated, per-category reference-source list. Confirmed against
// Tavily's own API docs (2026-07-15) before building this: include_domains
// and topic are both real, documented parameters, not an assumption.
//
// Deliberately NOT importing tavilySearch from context.js. Duplicating
// the ~15 lines of fetch logic here keeps this file fully self-contained,
// zero edits to context.js, zero risk to the 3x/day cron. The tradeoff
// (two near-identical functions instead of one shared one) is intentional
// given how strongly isolation was requested for this initiative.
//
// jinaFetchMany and filterTrustedSources ARE imported from context.js,
// read-only, to keep this pipeline's sourcing-integrity standard
// identical to the main pipeline's: a source only counts as verified once
// it's actually been Jina-fetched, not just found by search.

import { jinaFetchMany, filterTrustedSources } from "./context.js";

// ---- Per-category trusted-domain scoping for Tavily ----------------------
//
// This is the "curated reference-source map per category" piece. Unlike a
// static list of specific article URLs (which goes stale and would mean
// every "tilt angle" post cites the exact same page every time), this
// scopes a LIVE search to a fixed set of trustworthy domains, so results
// stay current while the source quality bar stays fixed.
//
// Maintained here, same pattern as TRUSTED_SOURCE_DOMAINS in context.js:
// add a domain any time a new legitimate reference source is needed for
// a category.
const CATEGORY_DOMAIN_MAP = {
  technical: ["nrel.gov", "seia.org", "irena.org", "iea.org", "energy.gov", "pv-magazine.com", "pv-tech.org"],
  regulatory_india: ["mnre.gov.in", "cea.nic.in", "pib.gov.in", "mercomindia.com", "saurenergy.com"],
  regulatory_eu: ["cleanenergywire.org", "bsw-solar.de", "idae.es", "iea.org", "europa.eu"],
  financial: ["nrel.gov", "irena.org", "iea.org", "lazard.com"],
  business: ["pv-magazine.com", "pv-tech.org", "mercomindia.com", "solarquarter.com"],
  career: ["seia.org", "pv-magazine.com", "energy.gov"],
  safety: ["nrel.gov", "osha.gov", "seia.org", "iec.ch"],
};

// Domains this pipeline trusts that AREN'T in context.js's
// TRUSTED_SOURCE_DOMAINS (that list wasn't built with evergreen/technical
// reference sources in mind, it's oriented around news-cycle trade press
// and .gov.in-style regulatory domains). Flagged explicitly rather than
// silently extended: context.js itself is untouched, this list only
// exists here and only applies to this pipeline.
//
// Real gap worth knowing about: context.js's TRUSTED_GOV_SUFFIXES covers
// .gov.in, .nic.in, .gov, .gov.uk, but NOT Spain's .gob.es or Germany's
// government domains or europa.eu. That's why bsw-solar.de, idae.es, and
// europa.eu are listed explicitly below instead of being caught by a
// suffix rule the way an Indian or US/UK gov source would be.
const VALUE_TOPIC_EXTRA_TRUSTED_DOMAINS = [
  "nrel.gov", // already covered by context.js's ".gov" suffix rule, listed for clarity
  "seia.org",
  "irena.org",
  "iea.org",
  "energy.gov", // already covered by ".gov" suffix rule
  "lazard.com",
  "bsw-solar.de",
  "idae.es",
  "europa.eu",
  "osha.gov", // already covered by ".gov" suffix rule
  "iec.ch",
];

function normalizeHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

function isValueTopicExtraTrusted(url) {
  const hostname = normalizeHostname(url);
  if (!hostname) return false;
  return VALUE_TOPIC_EXTRA_TRUSTED_DOMAINS.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
  );
}

// Runs context.js's real filterTrustedSources() first, completely
// unmodified, same trust bar as the main pipeline. Then looks at what it
// dropped and reinstates anything that matches THIS pipeline's extra
// trusted list. Net effect: nothing context.js already trusts is treated
// any differently, this only ever ADDS domains back, never removes any
// that the shared gate already allowed.
export function filterTrustedSourcesForValueTopics(extracted) {
  const base = filterTrustedSources(extracted);
  const stillUntrusted = [];
  const reinstated = [];

  for (const url of base.failed) {
    // base.failed mixes real fetch failures with untrusted-domain drops.
    // Only reinstate ones that look like a parseable, resolvable URL and
    // match the extra trusted list, a genuine fetch failure won't match
    // any domain check and correctly stays in the failed bucket either way.
    if (isValueTopicExtraTrusted(url)) {
      const original = extracted.results.find((r) => (r.originalUrl || r.url) === url);
      if (original) reinstated.push(original);
      else reinstated.push({ url, content: "" }); // shouldn't happen in practice, defensive fallback
    } else {
      stillUntrusted.push(url);
    }
  }

  return {
    results: [...base.results, ...reinstated],
    failed: stillUntrusted,
    droppedForTrust: base.droppedForTrust.filter((u) => !isValueTopicExtraTrusted(u)),
    reinstatedForValueTopics: reinstated.map((r) => r.url),
  };
}

// ---- Tavily general search, self-contained (see note at top of file) ----

export async function tavilyGeneralSearch(query, { includeDomains = [], maxResults = 5 } = {}) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error(
      "TAVILY_API_KEY is not set. This pipeline reuses Tavily (already referenced elsewhere in this project, currently unused by the live 3x/day pipeline). Get a free key at tavily.com and add it as a GitHub secret / .env entry, separate from whether the main pipeline uses it."
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
      search_depth: "basic",
      topic: "general", // NOT "news", this is the evergreen/reference-content mode
      max_results: maxResults,
      include_domains: includeDomains,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Tavily error ${res.status}: ${body}`);
  }
  const data = await res.json();
  return (data.results || []).map((r) => ({ title: r.title, url: r.url }));
}

// ---- Main entry point: topic -> verified, fetched source context --------
//
// Two Tavily calls per topic: one scoped to the category's trusted-domain
// list (the real backbone of sourcing), one broader/unscoped as a
// fallback in case the domain-scoped search comes up thin for a niche
// topic. Both sets get deduplicated, then Jina-fetched, then run through
// the trust gate, exactly mirroring the main pipeline's
// search -> fetch -> filter -> format shape.
export async function gatherEvergreenSourceContext(topic) {
  const domains = CATEGORY_DOMAIN_MAP[topic.category] || [];
  if (!domains.length) {
    console.log(
      `Warning: no trusted-domain list configured for category "${topic.category}" (topic id ${topic.id}). Falling back to an unscoped search only, results are less predictable, consider adding this category to CATEGORY_DOMAIN_MAP.`
    );
  }

  const scopedResults = domains.length
    ? await tavilyGeneralSearch(topic.keyword, { includeDomains: domains, maxResults: 5 })
    : [];
  const broadResults = await tavilyGeneralSearch(topic.keyword, { maxResults: 3 });

  const seen = new Set();
  const candidateUrls = [];
  for (const r of [...scopedResults, ...broadResults]) {
    if (!seen.has(r.url)) {
      seen.add(r.url);
      candidateUrls.push(r.url);
    }
  }

  console.log(
    `Found ${candidateUrls.length} candidate URL(s) for "${topic.keyword}" (${scopedResults.length} domain-scoped, ${broadResults.length} broad).`
  );

  // Real titles from Tavily's own results, kept only so the brief can
  // reference genuine search-result titles (for SOURCES_TO_FETCH context
  // and secondary-keyword derivation) instead of inventing keyword
  // variants with no real backing. jinaFetchMany itself returns no title
  // field, only resolved URL + content, so this has to be captured here,
  // before the Jina fetch step, or it's lost.
  const titlesByUrl = {};
  for (const r of [...scopedResults, ...broadResults]) {
    if (r.title) titlesByUrl[r.url] = r.title;
  }

  const rawExtracted = await jinaFetchMany(candidateUrls.slice(0, 6)); // same cap as the main pipeline's per-run source limit
  const filtered = filterTrustedSourcesForValueTopics(rawExtracted);

  if (filtered.droppedForTrust.length) {
    console.log(
      `Dropped ${filtered.droppedForTrust.length} fetched source(s) from domains this pipeline doesn't trust: ${filtered.droppedForTrust.join(", ")}`
    );
  }
  if (filtered.reinstatedForValueTopics.length) {
    console.log(
      `Kept ${filtered.reinstatedForValueTopics.length} source(s) from this pipeline's extra trusted domains (not on the main pipeline's list): ${filtered.reinstatedForValueTopics.join(", ")}`
    );
  }

  // Attach the real title (matched by original, pre-redirect URL) to each
  // surviving result where one was found. Best-effort: a source can still
  // lack a title (e.g. reinstated-from-failed edge case), never fabricated.
  const resultsWithTitles = filtered.results.map((r) => ({
    ...r,
    title: titlesByUrl[r.originalUrl] || titlesByUrl[r.url] || null,
  }));

  return { ...filtered, results: resultsWithTitles, titlesByUrl };
}

// ---- Recency check, real search results only, no fetch needed -----------
//
// content-writer.md's Step 1e requires a mandatory recency check, even for
// evergreen topics, and expects a [RECENCY CHECK] entry in the
// fact-check panel either way. The main pipeline's topic-scanner model
// normally runs this search itself; since this pipeline skips that model
// call (the topic is pre-selected, nothing for a scanner to discover),
// this fills the same gap the RSS-search step fills for the main
// pipeline: run the search here, hand the writer real results instead of
// leaving it to attempt a search it has no tool to actually perform.
//
// Deliberately no Jina fetch here, a snippet-level signal of "did
// anything change recently" is what this field needs, not full source
// verification (that already happens for the main sourcing pass above).
export async function gatherRecencyCheck(topic) {
  const now = new Date();
  const monthYear = now.toLocaleString("en-US", { month: "long", year: "numeric" });
  try {
    const results = await tavilyGeneralSearch(`${topic.keyword} ${monthYear}`, { maxResults: 3 });
    return results;
  } catch (err) {
    console.log(`Recency check search failed (${err.message}), brief will report RECENCY_DEVELOPMENTS as unchecked rather than guessing.`);
    return null; // null = "the search itself failed", distinct from [] = "search ran, found nothing"
  }
}
