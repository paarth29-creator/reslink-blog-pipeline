// scripts/value-topic-orchestrator.js
//
// Separate entry point from scripts/orchestrator.js. Never imported by
// it, never imported from it, no shared runtime state. Runs on its own
// schedule via .github/workflows/publish-value-topics.yml (manual
// trigger only until this has at least one verified real run), so it
// can never interfere with the 3x/day publish-blog.yml cron.
//
// Reuses, unmodified, by import: every cleanup/formatting function from
// context.js (dates, headings, link verification, image handling,
// Sanity helpers), runLint from lint.js, and content-writer.md itself
// completely unchanged, per the agreed scope for this initiative.
//
// Duplicated locally (not imported): the OpenRouter calling stack
// (callOpenRouterOnce/Adaptive/WithRetries/callOpenRouter), alert(),
// requireEnv(), slugify(), extractTitle(), randomKey(). orchestrator.js
// isn't structured as an importable module (everything lives inside its
// main()), so there's nothing to import from it even if that were
// desired. This is the same tradeoff already made in
// value-topic-search.js: a little duplication in exchange for zero risk
// to the live pipeline.

import fs from "fs/promises";
import { markdownToPortableText } from "@portabletext/markdown";
import { createClient } from "@sanity/client";
import { runLintForValueTopics, CONFIG as LINT_CONFIG } from "./value-topic-lint.js";
import {
  parseMetaPanel,
  enforceMetaDescriptionLength,
  extractExcerpt,
  delinkUnverifiedReslinkLinks,
  removeYouMayAlsoLikeSection,
  fixSquishedDates,
  fixDurationSpacing,
  fixBoldedH3Headings,
  restrictSourcesToVerified,
  restrictAllLinksToVerified,
  replaceOriginalUrlsWithResolved,
  stripUnresolvedGoogleRedirects,
  stripInlineSourceCitations,
  extractHeroImagePrompt,
  safeguardImageQuery,
  getHeroImage,
  uploadImageToSanity,
  fetchRecentPosts,
  PROMO_IMAGE_ASSET_ID,
  PROMO_IMAGE_LINK,
  PROMO_IMAGE_ALT,
} from "./context.js";
import { VALUE_TOPICS } from "./value-topics.js";
import { gatherEvergreenSourceContext, gatherRecencyCheck } from "./value-topic-search.js";
import { buildBrief, formatRecencyDevelopments } from "./value-topic-brief.js";
import { pickNextUnpublishedTopic, markTopicPublished } from "./value-topic-tracker.js";
import { RESLINK_FACTS } from "./value-topic-reslink-context.js";

// ---- Config, mirrors orchestrator.js's own values ------------------------

const PRIMARY_MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-oss-120b";
const FALLBACK_MODEL = process.env.OPENROUTER_FALLBACK_MODEL || "meta-llama/llama-3.3-70b-instruct:free";
const SANITY_DOCUMENT_TYPE = process.env.SANITY_DOCUMENT_TYPE || "post";

function requireEnv(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return val;
}

const sanity = createClient({
  projectId: requireEnv("SANITY_PROJECT_ID"),
  dataset: requireEnv("SANITY_DATASET"),
  token: requireEnv("SANITY_API_TOKEN"),
  apiVersion: "2026-03-01",
  useCdn: false,
});

// ---- OpenRouter calling stack, duplicated from orchestrator.js, unchanged ----

async function callOpenRouterOnce(systemPrompt, userPrompt, { disableReasoning, model }) {
  const timeoutMs = Number(process.env.OPENROUTER_TIMEOUT_MS) || 90_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 16000,
  };
  if (disableReasoning) body.reasoning = { effort: "none" };

  let res;
  try {
    res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${requireEnv("OPENROUTER_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`OpenRouter didn't respond within ${timeoutMs / 1000}s, likely an overloaded free model. Try rerunning.`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const bodyText = await res.text();
    const err = new Error(`OpenRouter error ${res.status}: ${bodyText}`);
    err.status = res.status;
    err.bodyText = bodyText;
    try {
      const retryAfter = JSON.parse(bodyText)?.error?.metadata?.retry_after_seconds;
      if (typeof retryAfter === "number") err.retryAfterMs = Math.ceil(retryAfter * 1000);
    } catch {
      // ignore, fall back to default backoff below
    }
    throw err;
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`OpenRouter returned no content: ${JSON.stringify(data)}`);
  return content;
}

async function callOpenRouterAdaptive(systemPrompt, userPrompt, model) {
  try {
    return await callOpenRouterOnce(systemPrompt, userPrompt, { disableReasoning: true, model });
  } catch (err) {
    const mandatoryReasoning = err.status === 400 && /reasoning is mandatory/i.test(err.bodyText || "");
    if (!mandatoryReasoning) throw err;
    console.log("This model requires reasoning enabled, retrying without the override...");
    return await callOpenRouterOnce(systemPrompt, userPrompt, { disableReasoning: false, model });
  }
}

async function callOpenRouterWithRetries(systemPrompt, userPrompt, model) {
  const MAX_ATTEMPTS = 5;
  const DEFAULT_BACKOFF_MS = [10_000, 20_000, 30_000, 45_000];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await callOpenRouterAdaptive(systemPrompt, userPrompt, model);
    } catch (err) {
      if (err.status !== 429 || attempt === MAX_ATTEMPTS) throw err;
      const wait = err.retryAfterMs ? err.retryAfterMs + 1000 : DEFAULT_BACKOFF_MS[attempt - 1];
      console.log(`${model} rate-limited, waiting ${Math.round(wait / 1000)}s before retry ${attempt + 1}/${MAX_ATTEMPTS}...`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

async function callOpenRouter(systemPrompt, userPrompt) {
  try {
    return await callOpenRouterWithRetries(systemPrompt, userPrompt, PRIMARY_MODEL);
  } catch (err) {
    if (err.status !== 429) throw err;
    console.log(`${PRIMARY_MODEL} still rate-limited, falling back to ${FALLBACK_MODEL}...`);
    return await callOpenRouterWithRetries(systemPrompt, userPrompt, FALLBACK_MODEL);
  }
}

async function alert(message) {
  console.log(`[ALERT] ${message}`);
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) return;
  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `[value-topic pipeline] ${message}` }),
    });
  } catch (err) {
    console.error("Failed to send Slack alert:", err.message);
  }
}

function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 96);
}

function extractTitle(markdown) {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : "Untitled post";
}

function randomKey() {
  return Array.from({ length: 12 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

// ---- Main pipeline ---------------------------------------------------------

async function main() {
  console.log(`Value-topic pipeline. Using model: ${PRIMARY_MODEL} (fallback: ${FALLBACK_MODEL})`);

  const topic = await pickNextUnpublishedTopic(VALUE_TOPICS);
  console.log(`Topic selected: id ${topic.id}, "${topic.keyword}" (market: ${topic.market}, category: ${topic.category})`);

  console.log("Gathering evergreen source context (Tavily, domain-scoped, then Jina-verified)...");
  const sourceContext = await gatherEvergreenSourceContext(topic);
  if (!sourceContext.results.length) {
    throw new Error(
      `No sources cleared search-and-trust-gate for topic id ${topic.id} ("${topic.keyword}"). Not proceeding to the writer. Check CATEGORY_DOMAIN_MAP in value-topic-search.js for this category ("${topic.category}"), it may need more/different trusted domains.`
    );
  }

  console.log("Running recency check (mandatory per content-writer.md Step 1e, even for evergreen topics)...");
  const recencyResults = await gatherRecencyCheck(topic);

  const brief = buildBrief(topic, sourceContext, recencyResults);
  console.log(`Brief constructed. ${sourceContext.results.length} verified source(s) for the writer.`);

  const writerPrompt = await fs.readFile("prompts/content-writer.md", "utf8");

  let writerUserMessage = `Write the full blog post in Markdown, based on this brief:

${brief}

NOTE: You do not have a live fetch tool in this environment. The URLs listed in SOURCES_TO_FETCH above have already been fetched for you, their content is below. Treat this as the fetched content required by Step 1c, do not say you are fetching anything, just use this directly. Any URL not listed below could not be fetched, treat claims depending on it as unsourced per your own rules.

${sourceContext.results.map((r) => `\n### Source (cite this exact URL): ${r.url}\n${r.content}\n`).join("")}

Do not generate a "You May Also Like" section at all, it's disabled for now, skip straight from FAQs to Sources.

Also, more generally: never link to any reslink.org page you haven't been explicitly given a real URL for anywhere in this document, demo pages, resource downloads, or anything else, describe it in plain text with no link instead.`;

  // Real bug found across two separate real runs (id 1 and id 2, both
  // landing suspiciously close together at 1573-1885 words despite
  // different topics/categories/source counts, the consistency was the
  // tell). This rough count used to run on the RAW draft, meta panel and
  // fact-check panel comments still included. The fact-check panel must
  // cover every claim, "not a highlights reel" per content-writer.md's
  // own rule, so it's genuinely substantial text, and it gets stripped
  // out before the real lint count runs. Net effect: this check could
  // see a draft as "long enough" and stop expanding, while the real,
  // published-relevant word count (after stripping) came in meaningfully
  // shorter. Stripping comments here first means this check now measures
  // the same thing the real lint gate measures.
  const roughWordCount = (text) => {
    const withoutComments = text.replace(/<!--[\s\S]*?-->/g, " ");
    return withoutComments.replace(/[#*_>`[\]()-]/g, " ").split(/\s+/).filter(Boolean).length;
  };

  let rawMarkdown;
  // Bumped 3 -> 4. Last run landed at 1996/2000, 4 words under, after the
  // rough-count fix closed most of the previous gap (1654 -> 1996). The
  // residual miss is small formatting-character differences between this
  // rough count and lint's real one, not the same bug as before. Same
  // reasoning already used elsewhere in this project for widening
  // OpenRouter's retry budget: nobody's watching a terminal waiting on
  // this, one more attempt costs nothing.
  const MAX_WRITER_ATTEMPTS = 4;
  let previousDraft = null;
  let previousWordCount = null;

  for (let attempt = 1; attempt <= MAX_WRITER_ATTEMPTS; attempt++) {
    let message;
    if (attempt === 1) {
      message = writerUserMessage;
    } else if (previousDraft) {
      const shortfall = LINT_CONFIG.hardMinWords - previousWordCount;
      message = `Here is a draft you wrote for this brief, ${previousWordCount} words, ${shortfall} words short of the ${LINT_CONFIG.hardMinWords}-word floor:

${previousDraft}

Do not rewrite this from scratch. Do not change the title, the central claim, or the sources. Expand it by adding real content in exactly these three places:

1. Definition/context section: add 1-2 more paragraphs, real-world context, a relevant data point, or a comparison to how this worked before, sourced the same way as the rest of the post, not filler.
2. One of the categorization or supporting-info subsections (H4s): pick whichever one has the least depth right now, add 1-2 more paragraphs covering a practical detail an EPC would actually need.
3. FAQ section: add one more genuinely useful question a skeptical EPC reader would actually ask, with a full, sourced answer, not a one-liner.

Hard rule for this expansion pass specifically: do not invent any new specific number, percentage, weighting factor, ratio, or statistic that isn't directly present in the source content you were given. Needing more words is never a reason to state a figure you're not sourcing. If a section needs more depth, add real explanation, mechanism, procedural detail, or context that follows from what's already sourced, in plain language, not new numbers dressed up as precision. A confirmed real source check on a previous draft found exactly this failure, a specific-sounding percentage attributed to a real citation that the actual article never stated, that is the mistake this rule exists to prevent.

Output the complete expanded post, still following every rule from your instructions.`;
    } else {
      message = writerUserMessage;
    }

    const candidate = await callOpenRouter(writerPrompt, message);
    const hasH1 = /^#\s+.+/m.test(candidate);
    const wordCount = roughWordCount(candidate);
    const longEnough = wordCount >= LINT_CONFIG.hardMinWords + 250; // same ~250-word buffer as before, now scaled to the real 1700 floor instead of the old 2000 one

    if (hasH1 && longEnough) {
      rawMarkdown = candidate;
      break;
    }

    rawMarkdown = candidate;
    if (hasH1) {
      previousDraft = candidate;
      previousWordCount = wordCount;
    } else {
      previousDraft = null;
    }

    const reason = !hasH1 ? "no H1 found" : `too short (about ${wordCount} words, need ${LINT_CONFIG.hardMinWords}+)`;
    console.log(`Content writer output rejected before linting: ${reason} (attempt ${attempt}/${MAX_WRITER_ATTEMPTS})`);
    if (attempt === MAX_WRITER_ATTEMPTS) {
      console.log("Giving up on pre-lint retries, passing the last attempt through to the full lint gate anyway.");
    }
  }

  console.log("--- Raw draft from content writer (before cleanup) ---");
  console.log(rawMarkdown);
  console.log("--- end raw draft ---");

  const meta = parseMetaPanel(rawMarkdown);

  const allComments = rawMarkdown.match(/<!--[\s\S]*?-->/g) || [];
  const factCheckComment = allComments.find((c) => /\[VERIFIED\]|\[SOFTENED\]|\[NOT INCLUDED\]|\[RECENCY CHECK\]/.test(c));
  if (factCheckComment) {
    console.log("--- Fact-check panel (internal only, not published) ---");
    console.log(factCheckComment.replace(/<!--|-->/g, "").trim());
    console.log("--- end fact-check panel ---");
  }

  const emDashCount = (rawMarkdown.match(/\u2014/g) || []).length;
  let markdown = rawMarkdown.replace(/<!--[\s\S]*?-->/g, "").trim();
  markdown = markdown.replace(/\s*\u2014\s*/g, ", ");
  if (emDashCount) console.log(`Replaced ${emDashCount} em-dash(es) with a comma before linting.`);

  markdown = markdown.replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, "").trim();

  const { cleaned: ymalCleaned } = removeYouMayAlsoLikeSection(markdown);
  markdown = ymalCleaned;

  console.log("Fetching real published posts (for the reslink.org link safety net)...");
  const recentPosts = await fetchRecentPosts(sanity, SANITY_DOCUMENT_TYPE);
  const { cleaned: delinkedMarkdown, strippedCount: delinkedCount } = delinkUnverifiedReslinkLinks(markdown, recentPosts.map((p) => p.url));
  markdown = delinkedMarkdown;
  if (delinkedCount) console.log(`De-linked ${delinkedCount} invented reslink.org URL(s).`);

  const { cleaned: resolvedMarkdown, replacedCount } = replaceOriginalUrlsWithResolved(markdown, sourceContext.results);
  markdown = resolvedMarkdown;
  if (replacedCount) console.log(`Replaced ${replacedCount} redirect URL(s) with resolved links.`);

  const { cleaned: noRedirectsMarkdown, strippedCount: redirectsStripped } = stripUnresolvedGoogleRedirects(markdown);
  markdown = noRedirectsMarkdown;
  if (redirectsStripped) console.log(`Stripped ${redirectsStripped} unresolved redirect link(s).`);

  const { cleaned: noInlineCitesMarkdown, strippedCount: citesStripped } = stripInlineSourceCitations(markdown);
  markdown = noInlineCitesMarkdown;
  if (citesStripped) console.log(`Stripped ${citesStripped} inline citation(s).`);

  markdown = markdown.replace(/<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s+[^<>]*)?\/?>/g, " ").replace(/[ \t]+/g, " ").trim();

  const { cleaned: datesFixedMarkdown, fixedCount: datesFixed } = fixSquishedDates(markdown);
  markdown = datesFixedMarkdown;
  if (datesFixed) console.log(`Fixed ${datesFixed} squished date(s).`);

  const { cleaned: durationFixedMarkdown, fixedCount: durationFixed } = fixDurationSpacing(markdown);
  markdown = durationFixedMarkdown;
  if (durationFixed) console.log(`Fixed ${durationFixed} duration spacing issue(s).`);

  const { cleaned: headingsFixedMarkdown, fixedCount: headingsFixed } = fixBoldedH3Headings(markdown);
  markdown = headingsFixedMarkdown;
  if (headingsFixed) console.log(`Fixed ${headingsFixed} bolded H3 heading(s).`);

  const { cleaned: allLinksVerifiedMarkdown, strippedCount: unverifiedLinksStripped } = restrictAllLinksToVerified(
    markdown,
    sourceContext.results.map((r) => r.url)
  );
  markdown = allLinksVerifiedMarkdown;
  if (unverifiedLinksStripped) console.log(`De-linked ${unverifiedLinksStripped} unverified citation link(s).`);

  const { cleaned: sourcesRestrictedMarkdown, removedCount: sourcesRemoved } = restrictSourcesToVerified(
    markdown,
    sourceContext.results.map((r) => r.url)
  );
  markdown = sourcesRestrictedMarkdown;
  if (sourcesRemoved) console.log(`Removed ${sourcesRemoved} unverified source(s) from the Sources section.`);

  // ---- Pre-publish audit: claim verification + competitor/Reslink balance ----
  //
  // Real justification for this, not a hypothetical: a prior run cited a
  // "0.9 weighting factor" and "±12% market-premium volatility" as
  // sourced from a real Clean Energy Wire article that, checked directly,
  // never stated either figure. That's the exact failure this step
  // exists to catch, independently, against the real fetched text, not
  // the writer's own self-report.
  //
  // Fails CLOSED: if this call itself errors out, this does not fall
  // back to publishing an unaudited draft. Skipping verification
  // silently would defeat the entire point of adding it. Same treatment
  // as a lint failure, alert, publish nothing, retry next scheduled run.
  console.log("Running pre-publish audit (claim verification + competitor balance)...");
  const auditPrompt = await fs.readFile("prompts/value-topic-audit.md", "utf8");
  const preAuditMarkdown = markdown;
  const preAuditWordCount = preAuditMarkdown.split(/\s+/).filter(Boolean).length;

  const auditUserMessage = `TOPIC CONTEXT: "${topic.keyword}" (category: ${topic.category}, market: ${topic.market})

DRAFT TO AUDIT:

${preAuditMarkdown}

WRITER'S OWN FACT-CHECK PANEL (a starting index, not proof, verify independently against the real fetched source text below):
${factCheckComment ? factCheckComment.replace(/<!--|-->/g, "").trim() : "(none found in the raw draft)"}

REAL FETCHED SOURCE TEXT (the actual content the writer was given, check every claim against this, not against what the draft merely attributes to a source):
${sourceContext.results.map((r) => `\n### Source: ${r.url}\n${r.content}\n`).join("")}

RECENCY SEARCH RESULTS (for the Currentness check, real search run separately for this topic, not the same as the sources above):
${formatRecencyDevelopments(recencyResults)}

${RESLINK_FACTS}

Apply all checks now. Output per your instructions.`;

  let auditedRaw;
  try {
    auditedRaw = await callOpenRouter(auditPrompt, auditUserMessage);
  } catch (err) {
    await alert(
      `Value-topic pipeline: pre-publish audit call itself failed, nothing published (publishing an unaudited draft was not an option). Topic: id ${topic.id}, "${topic.keyword}". Error: ${err.message}`
    );
    process.exit(1);
  }

  // Check the critical-block verdict FIRST, before any other parsing.
  // This is a fundamentally different outcome from a malformed audit
  // response (handled below): here the audit did its job correctly and
  // found something serious enough that no subtraction-only fix solves
  // it. Falling back to the pre-audit draft in this case would publish
  // exactly the thing that was just flagged as unsafe, so this must
  // never reach that fallback path.
  const blockMatch = auditedRaw.match(/AUDIT_VERDICT:\s*DO_NOT_PUBLISH[\s\S]*?REASON:\s*(.+)/i);
  if (blockMatch) {
    const reason = blockMatch[1].trim();
    console.log(`Pre-publish audit blocked this post: ${reason}`);
    await alert(
      `Value-topic pipeline: pre-publish audit found a critical, unfixable-by-subtraction problem and blocked publishing. Topic: id ${topic.id}, "${topic.keyword}". Reason: ${reason}`
    );
    process.exit(1);
  }

  const auditLogMatch = auditedRaw.match(/<!--\s*AUDIT:([\s\S]*?)-->/i);
  const auditLog = auditLogMatch ? auditLogMatch[1].trim() : null;
  const auditedMarkdown = auditedRaw.replace(/<!--\s*AUDIT:[\s\S]*?-->/i, "").trim();

  const auditedWordCount = auditedMarkdown.split(/\s+/).filter(Boolean).length;
  const auditHasH1 = /^#\s+.+/m.test(auditedMarkdown);
  // Sanity check, not a stylistic nitpick: the audit prompt explicitly
  // forbids adding new content, subtraction/correction only. A material
  // word-count INCREASE is direct evidence that rule wasn't followed, so
  // rather than trust it, fall back to the pre-audit draft and say so
  // loudly. A small tolerance (+40 words) allows for minor rewording of
  // a corrected sentence without false-triggering on that alone.
  const auditGrewSuspiciously = auditedWordCount > preAuditWordCount + 40;

  if (!auditHasH1 || auditGrewSuspiciously || !auditedMarkdown.trim()) {
    const reason = !auditHasH1
      ? "audit output lost the H1"
      : !auditedMarkdown.trim()
      ? "audit output was empty"
      : `audit output grew from ${preAuditWordCount} to ${auditedWordCount} words, which the subtraction-only rule shouldn't allow`;
    console.log(`Audit output failed its sanity check (${reason}), falling back to the pre-audit draft. This post is publishing WITHOUT the benefit of this audit pass.`);
    await alert(
      `Value-topic pipeline: pre-publish audit output was rejected by its own sanity check (${reason}) and the pre-audit draft was published instead, unaudited. Topic: id ${topic.id}, "${topic.keyword}". Worth a manual read of this specific post.`
    );
    // markdown stays as preAuditMarkdown, no reassignment
  } else {
    markdown = auditedMarkdown;
    if (auditLog && !/no issues found/i.test(auditLog)) {
      console.log(`Audit made changes: ${auditLog}`);
    } else {
      console.log("Audit found no issues.");
    }
  }

  console.log("Running the lint / quality gate...");
  const lint = await runLintForValueTopics(markdown, sourceContext.results.map((r) => r.url));
  console.log(`Word count: ${lint.wordCount}`);
  if (lint.warnings.length) console.log("Warnings:", lint.warnings);

  if (!lint.pass) {
    console.log("--- Draft content (for debugging) ---");
    console.log(markdown || "(completely empty)");
    console.log("--- end draft content ---");
    await alert(
      `Value-topic draft FAILED lint, nothing published.\n\nTopic: id ${topic.id}, "${topic.keyword}"\n\nErrors:\n- ${lint.errors.join("\n- ")}`
    );
    process.exit(1);
  }

  const title = extractTitle(markdown);
  const markdownWithoutH1 = markdown.replace(/^#\s+.+\n+/, "");

  console.log("Converting to Portable Text...");
  let contentBlocks = markdownToPortableText(markdownWithoutH1);

  const tldrIndex = contentBlocks.findIndex((block) => (block.children || []).some((child) => /^TL\s*;?\s*DR:?/i.test(child.text || "")));
  if (tldrIndex !== -1) {
    const tldrText = (contentBlocks[tldrIndex].children || []).map((c) => c.text).join("");
    contentBlocks[tldrIndex] = { _type: "callout", _key: randomKey(), type: "info", text: tldrText };
    console.log("Converted TL;DR paragraph into a real callout block.");
  }

  try {
    // Real bug found in your first published post: bullet list items
    // convert to the same shape as a normal paragraph (_type: "block",
    // style: "normal"), just with an added listItem property, so they
    // were counting toward "paragraph 3" and pulling the insertion point
    // earlier than intended. Excluding anything with listItem set fixes
    // it, only true prose paragraphs count now.
    const paragraphIndices = contentBlocks.map((b, i) => (b._type === "block" && b.style === "normal" && !b.listItem ? i : -1)).filter((i) => i !== -1);
    if (paragraphIndices.length > 0) {
      const target = Math.min(3, paragraphIndices.length) - 1;
      const insertAfter = paragraphIndices[target];
      contentBlocks.splice(insertAfter + 1, 0, {
        _type: "image",
        _key: randomKey(),
        asset: { _type: "reference", _ref: PROMO_IMAGE_ASSET_ID },
        alt: PROMO_IMAGE_ALT,
        link: { href: PROMO_IMAGE_LINK, openInNewTab: true },
      });
      console.log(`Inserted the promo creative after paragraph ${target + 1}.`);
    }
  } catch (err) {
    console.log(`Promo creative skipped (${err.message}).`);
  }

  const doc = {
    _type: SANITY_DOCUMENT_TYPE,
    title,
    slug: { _type: "slug", current: slugify(title) },
    content: contentBlocks,
    publishedAt: new Date().toISOString(),
    featured: false,
    estimatedReadTime: Math.max(1, Math.round(lint.wordCount / 200)),
    excerpt: meta.seoDescription || extractExcerpt(markdown),
    author: { name: "Shashank", role: "Founder" },
    category: { _type: "reference", _ref: "d67174a7-8783-4848-bad8-0bcf361b573a" },
  };
  if (meta.seoTitle) doc.seoTitle = meta.seoTitle;
  else doc.seoTitle = title;
  if (meta.seoDescription) doc.seoDescription = meta.seoDescription;
  else doc.seoDescription = doc.excerpt;
  if (meta.tags && meta.tags.length) doc.tags = meta.tags;

  const metaDescResult = enforceMetaDescriptionLength(doc.seoDescription);
  doc.seoDescription = metaDescResult.text;
  if (metaDescResult.truncated) console.log("Meta description truncated to fit the 140-150 char cap.");
  if (metaDescResult.tooShort) console.log(`Warning: meta description is only ${metaDescResult.text.length} chars, under the 140 floor.`);

  const normalize = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalize(doc.excerpt) === normalize(doc.title)) {
    doc.excerpt = extractExcerpt(markdown);
  }
  if (normalize(doc.seoDescription) === normalize(doc.seoTitle)) {
    doc.seoDescription = doc.excerpt;
  }

  console.log("Finding cover image...");
  try {
    const imagePrompt = safeguardImageQuery(extractHeroImagePrompt(rawMarkdown) || title, topic.market);
    const hero = await getHeroImage(imagePrompt);
    if (hero) {
      const assetId = await uploadImageToSanity(sanity, hero.buffer, `${slugify(title)}-cover.jpg`);
      doc.coverImage = { _type: "image", asset: { _type: "reference", _ref: assetId } };
      console.log(`Cover image uploaded (source: ${hero.source}).`);
      if (hero.attribution) {
        console.log(`ATTRIBUTION REQUIRED (Unsplash terms): ${hero.attribution}`);
        await alert(`Cover image used an Unsplash photo, attribution required: ${hero.attribution}`);
      }
    } else {
      console.log("Cover image search failed, publishing without one.");
    }
  } catch (err) {
    console.log(`Cover image failed (${err.message}), publishing without one.`);
  }

  console.log(`Publishing "${title}" to Sanity...`);
  const created = await sanity.create(doc);

  await markTopicPublished(topic, { sanityDocId: created._id, title });

  await alert(`New value-topic blog post published: "${title}" (topic id ${topic.id}, Sanity doc: ${created._id}, ${lint.wordCount} words)`);
  console.log("Done.");
}

main().catch(async (err) => {
  console.error(err);
  await alert(`Value-topic pipeline crashed before publishing anything: ${err.message}`);
  process.exit(1);
});
