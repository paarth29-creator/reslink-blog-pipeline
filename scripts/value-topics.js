// scripts/value-topics.js
//
// The 20 topics selected from the competitor content-gap analysis
// (SurgePV, RatedPower, Aurora Solar, Arka360, 346 ranked pages, 4
// competitors). Per agreed scope: each topic's Primary Keyword is used
// ONLY as a seed for the existing sourcing-safe pipeline. No competitor
// article content is ever fetched or referenced. Explicit exclusions
// from scope: no glossary, no comparison/review, no commercial-intent
// content, value-driven Blog/Article-style topics only.
//
// REFRAMED, confirmed 2026-07-15 (originally flagged for reading as
// excluded categories: comparison, glossary, or a near-duplicate entry).
//
//   - id 17 was "utility scale BESS comparison 2026" (comparison
//     content, excluded). Reframed to a selection-guide angle: still
//     covers technology types, but as an informational buyer's guide,
//     not an X vs Y comparison.
//   - id 18 was "NTP COD solar project definition" (glossary content,
//     excluded). Reframed to a timeline/milestone explainer, using the
//     two terms as anchors for a process article rather than defining
//     them in isolation.
//   - id 3 and id 8 ("tilt angle azimuth" vs "tilt angle optimization")
//     were a near-duplicate pair. Merged into a single id 3 covering
//     both the fundamentals and the practical optimization angle. id 8
//     is intentionally absent below, not a gap, the topic was folded
//     into id 3 rather than run twice.
//
// category drives which trusted-domain set value-topic-search.js scopes
// Tavily's include_domains to (see CATEGORY_DOMAIN_MAP there).

export const VALUE_TOPICS = [
  { id: 1, market: "Global", category: "business", keyword: "solar proposal design guide" },
  { id: 2, market: "European Union", category: "regulatory_eu", keyword: "solar subsidies Germany 2025" },
  { id: 3, market: "Global", category: "technical", keyword: "solar panel tilt angle and azimuth optimization guide" },
  { id: 4, market: "Global", category: "technical", keyword: "solar panel efficiency guide" },
  { id: 5, market: "India", category: "regulatory_india", keyword: "steps to set up solar plant India" },
  { id: 6, market: "European Union", category: "regulatory_eu", keyword: "solar panels Spain 2026 subsidies" },
  { id: 7, market: "Global", category: "business", keyword: "solar proposal template 2026" },
  { id: 9, market: "Global", category: "technical", keyword: "solar panel degradation rate real world" },
  { id: 10, market: "Global", category: "financial", keyword: "utility scale solar farm cost per MW" },
  { id: 11, market: "India", category: "regulatory_india", keyword: "solar energy laws regulations India" },
  { id: 12, market: "Global", category: "technical", keyword: "solar panel orientation south vs east-west" },
  { id: 13, market: "India", category: "regulatory_india", keyword: "solar export control zero export" },
  { id: 14, market: "Global", category: "technical", keyword: "next generation solar panels 2026" },
  { id: 15, market: "Global", category: "safety", keyword: "how to disconnect solar panels safely" },
  { id: 16, market: "Global", category: "career", keyword: "how to become a solar PV designer" },
  { id: 17, market: "Global", category: "technical", keyword: "utility scale BESS technology types selection guide for EPCs" },
  { id: 18, market: "Global", category: "technical", keyword: "NTP to COD milestones in solar project development" },
  { id: 19, market: "Global", category: "safety", keyword: "solar installation electrical wiring guide" },
  { id: 20, market: "Global", category: "business", keyword: "solar company marketing strategies" },
];

export function getTopicsNeedingReview() {
  return VALUE_TOPICS.filter((t) => t.needsReview);
}
