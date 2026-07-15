// scripts/value-topic-brief.js
//
// The main pipeline's topic-scanner model does two jobs: (1) DISCOVER
// what to write about via live search, (2) FORMAT that into the brief
// content-writer.md expects. For this pipeline, job (1) doesn't apply,
// the topic is already picked from value-topics.js. Calling the scanner
// model anyway would have it search for a DIFFERENT topic than the one
// being forced on it, at best a wasted call, at worst a brief that
// contradicts itself. So this does job (2) only, directly in code.
//
// Field-by-field honesty note, since several brief fields normally come
// from tools this pipeline doesn't have (Google autocomplete, People
// Also Ask, related searches, a SERP scraper): those fields are marked
// explicitly as unavailable rather than filled with invented values.
// This isn't a shortcut, it's consistent with the project's own standing
// rule, less information published beats false information published,
// applied here to the brief itself, not just the final post.
//
//   PAA_QUESTIONS -> left NONE. content-writer.md's own FAQ rule already
//     covers this case explicitly: "If PAA_QUESTIONS has fewer than 7
//     items, add further genuinely distinct questions a skeptical,
//     experienced EPC would actually ask." Leaving it empty routes
//     through an already-supported fallback, not an unhandled gap.
//   AUTOCOMPLETE_VARIANTS / RELATED_SEARCHES -> left NONE, no SERP
//     autocomplete tool exists in this pipeline, inventing plausible-
//     sounding variants here would be exactly the kind of fabrication
//     the sourcing rules elsewhere in this project exist to prevent.
//   PRIMARY_SOURCE_CONFIRMED / CENTRAL_CLAIM -> left explicitly
//     unclassified. content-writer.md's own Step 1 (pre-write claim
//     inventory) already requires the writer to independently verify
//     source tier and establish claims from fetched content regardless
//     of what the brief says, this doesn't skip that check, it declines
//     to pre-empt it with a guess.
//   RECENCY_DEVELOPMENTS -> a real, live search result (see
//     gatherRecencyCheck in value-topic-search.js), not skipped and not
//     fabricated.
//   SOURCES_TO_FETCH -> the real, Jina-fetched, trust-gated URLs from
//     gatherEvergreenSourceContext, identical sourcing-integrity
//     standard as the main pipeline.
//   RELATED_RESLINK_BLOGS -> left NONE. The existing orchestrator.js
//     pattern this reuses explicitly disables "You May Also Like" via a
//     hard instruction override regardless of brief content, so this
//     field is inert either way, kept for format completeness only.

const SEO_CLUSTER_KEYWORDS = {
  C1: ["design software", "design tool", "pv design"],
  C2: ["layout", "panel layout"],
  C3: ["utility scale", "utility-scale"],
  C4: ["irradiance"],
  C5: ["cad", "simulation", "shading", "site analysis", "modeling", "engineering software"],
  C6: ["bom", "proposal", "quotation", "procurement", "documentation software", "epc software", "sld", "stringing"],
};

function matchSeoClusters(keyword) {
  const lower = keyword.toLowerCase();
  const matched = Object.entries(SEO_CLUSTER_KEYWORDS)
    .filter(([, terms]) => terms.some((t) => lower.includes(t)))
    .map(([code]) => code);
  return matched.length ? matched.join(", ") : "NONE";
}

// content-writer.md's own IMAGE SEARCH TERMS table, by blog type. Reused
// here as a starting suggestion only, the real backstop (safeguardImageQuery
// + MARKET_IMAGE_FALLBACKS in context.js) already runs downstream in the
// orchestrator regardless of what this suggests.
const IMAGE_ANGLE_BY_CATEGORY = {
  technical: "equipment or installation detail relevant to the specific topic, not generic panel imagery",
  regulatory_india: "Indian city skyline or commercial rooftop, not a flag or bare country name",
  regulatory_eu: "specific EU member-state city skyline (per the target market), not a flag or bare region name",
  financial: "commercial or industrial building exterior, project-scale context",
  business: "laptop office workspace technology",
  career: "laptop office workspace technology, or an engineer at a workstation",
  safety: "inverter equipment room or industrial electrical panel, not a hazard/warning image",
};

// Adds a year qualifier when it fits, per your own manual edit on the
// first post ("Solar Proposal Design Guide for EPCs" -> "... in 2026",
// better SEO/GEO context). This is only a SUGGESTION field though,
// content-writer.md generates the real meta title itself per its own
// rules and isn't required to use this verbatim. If it doesn't
// consistently show up in published posts after a few more runs, that's
// the signal to add a code-level backstop instead, same escalation
// pattern already used elsewhere in this project (word count, meta
// description length) rather than assuming a prompt-level nudge alone
// will hold.
function truncateTitle(keyword, maxChars = 55) {
  const year = new Date().getFullYear();
  const capitalized = keyword.replace(/\b\w/g, (c) => c.toUpperCase());
  const withYear = `${capitalized} in ${year}`;
  if (withYear.length <= maxChars) return withYear;
  if (capitalized.length <= maxChars) return capitalized; // year doesn't fit, drop it rather than truncate mid-word
  return capitalized.slice(0, maxChars - 3).trim() + "...";
}

export function formatRecencyDevelopments(recencyResults) {
  if (recencyResults === null) {
    return "NONE (recency search itself failed this run, see logs; treat as unchecked, not confirmed-absent, per the writer's own Step 1e requirement to run this check)";
  }
  if (!recencyResults.length) {
    return "NONE (recency search ran, found nothing indicating a development from the last 14 days)";
  }
  return recencyResults
    .map((r) => `${r.title || "(untitled result)"}, ${r.url}`)
    .join("\n");
}

function formatSecondaryKeywords(sourceResults) {
  const titled = sourceResults.filter((r) => r.title).slice(0, 5);
  if (!titled.length) return "NONE (no titled sources available to derive these from, not fabricated)";
  return titled.map((r) => r.title).join("\n");
}

function formatSourcesToFetch(sourceResults) {
  if (!sourceResults.length) {
    return "NONE (no sources cleared this pipeline's search-and-trust-gate this run, see logs; the writer must not proceed without real sources per Absolute Rule #1, expect this draft to fail lint or come back thin)";
  }
  return sourceResults.map((r) => r.url).join("\n");
}

// SUGGESTED_STRUCTURE is genuinely just a suggestion, content-writer.md's
// own Step 3 fixed skeleton (Definition/Context, Categorization,
// Urgency/Deadline, Action Checklist, Supporting Info, FAQ, Sources)
// governs the real output regardless of what's listed here. This gives
// generic, category-appropriate angles to adapt, not invented specifics
// dressed up as if they were topic-scanner's own research.
const STRUCTURE_HINTS_BY_CATEGORY = {
  technical: ["Fundamentals and how it works", "Practical implications for EPC project design", "Common mistakes or edge cases", "Relevant standards or benchmarks"],
  regulatory_india: ["What the regulation/scheme covers", "Eligibility and process", "What EPCs must do to comply", "Recent changes if any"],
  regulatory_eu: ["What the scheme/subsidy covers", "Eligibility and application process", "What EPCs must communicate to clients", "Deadlines or phase-out timelines if any"],
  financial: ["What drives the cost figure", "Regional/scale variation", "How EPCs use this in proposals", "Common estimation mistakes"],
  business: ["Why this matters for EPC growth", "Practical how-to guidance", "Common mistakes", "Tools or workflows that help"],
  career: ["What the role/path involves", "Skills and qualifications needed", "How to get started", "Career trajectory"],
  safety: ["Why this matters, real risk context", "Step-by-step correct procedure", "Common mistakes and their consequences", "Relevant standards or codes"],
};

export function buildBrief(topic, sourceContext, recencyResults) {
  const todayDate = new Date().toISOString().slice(0, 10);
  const structureHints = STRUCTURE_HINTS_BY_CATEGORY[topic.category] || STRUCTURE_HINTS_BY_CATEGORY.technical;

  return `---BEGIN BRIEF---

TOPIC: ${topic.keyword} (evergreen reference topic for EPCs, sourced as a keyword seed only from a competitor content-gap analysis, no competitor content read or referenced, market: ${topic.market})
MARKET: ${topic.market}
DATE: ${todayDate}
URGENCY: STANDARD
DEADLINE_DATE: N/A

PRIMARY_KEYWORD: ${topic.keyword}
META_TITLE_SUGGESTION: ${truncateTitle(topic.keyword)}
SECONDARY_KEYWORDS: ${formatSecondaryKeywords(sourceContext.results)}
PAA_QUESTIONS: NONE (no PAA data source available to this pipeline, use your own fallback rule for FAQ questions instead)
AUTOCOMPLETE_VARIANTS: NONE (no autocomplete data source available to this pipeline)
RELATED_SEARCHES: NONE (no SERP data source available to this pipeline)
SEO_CLUSTERS_APPLICABLE: ${matchSeoClusters(topic.keyword)}

PRIMARY_SOURCE_CONFIRMED: NOT PRE-CLASSIFIED by this pipeline, apply your own Step 1b/3c source-tier check against the fetched sources below
CENTRAL_CLAIM: NOT PRE-DETERMINED by this pipeline, establish this yourself per Step 1 using the fetched sources below
CENTRAL_CLAIM_SOURCE_URL: N/A

RECENCY_DEVELOPMENTS: ${formatRecencyDevelopments(recencyResults)}

SUGGESTED_STRUCTURE:
${structureHints.map((h) => `- ${h}`).join("\n")}
(adapt freely, your Step 3 fixed section skeleton governs the actual output regardless of this list)

SOURCES_TO_FETCH:
${formatSourcesToFetch(sourceContext.results)}

RELATED_RESLINK_BLOGS: NONE ("You May Also Like" is disabled for this pipeline regardless of this field, per explicit instruction elsewhere)

WORD_COUNT_TARGET: 2400-2800 (evergreen guide format; hard floor of 2000 words still applies via the pipeline's lint gate regardless of this target)

IMAGE_ANGLE: ${IMAGE_ANGLE_BY_CATEGORY[topic.category] || "commercial or industrial context relevant to the topic, not generic panel imagery, not a bare country/region name"}

---END BRIEF---`;
}
