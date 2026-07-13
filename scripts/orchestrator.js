// scripts/orchestrator.js
//
// Runs the whole pipeline, in order:
//   1. Ask the topic-scanner agent for today's topic
//   2. Ask the content-writer agent to write the blog (Markdown)
//   3. Run it through the lint gate (scripts/lint.js)
//   4. If it fails: alert you, stop, publish nothing
//   5. If it passes: convert Markdown -> Portable Text, push to Sanity, alert you
//
// This file reads all its secrets from environment variables. Locally,
// put them in a .env file (see .env.example) and load with `node --env-file=.env`.
// In GitHub Actions, they come from repo secrets (see the workflow file).

import fs from "fs/promises";
import { markdownToPortableText } from "@portabletext/markdown";
import { createClient } from "@sanity/client";
import { runLint } from "./lint.js";
import {
  pickTargetMarket,
  fetchPublishedTitles,
  gatherRSSSearchContext,
  formatSearchResultsForPrompt,
  extractSourceUrls,
  jinaFetchMany,
  replaceOriginalUrlsWithResolved,
  stripUnresolvedGoogleRedirects,
  stripInlineSourceCitations,
  formatExtractedContentForPrompt,
  fetchRecentPosts,
  formatRecentPostsForPrompt,
  parseMetaPanel,
  extractExcerpt,
  delinkUnverifiedReslinkLinks,
  removeYouMayAlsoLikeSection,
  fixSquishedDates,
  fixDurationSpacing,
  restrictSourcesToVerified,
  extractHeroImagePrompt,
  getHeroImage,
  uploadImageToSanity,
} from "./context.js";

// ---- Config -----------------------------------------------------------

const PRIMARY_MODEL =
  process.env.OPENROUTER_MODEL || "openai/gpt-oss-120b:free";
const FALLBACK_MODEL =
  process.env.OPENROUTER_FALLBACK_MODEL || "meta-llama/llama-3.3-70b-instruct:free";
// Pinned deliberately, not left on the random openrouter/free router.
// That randomness was the root cause of the reasoning-trace failure a
// while back, since it could land on any free model, including
// unpredictable ones. gpt-oss-120b:free is independently rated as the
// strongest free option for thorough, multi-section writing right now.
// The fallback only gets called once the primary has exhausted its own
// retries, never picked first, see callOpenRouter below. Override either
// one via .env, no code change needed to switch.

const SANITY_DOCUMENT_TYPE = process.env.SANITY_DOCUMENT_TYPE || "post";

const sanity = createClient({
  projectId: requireEnv("SANITY_PROJECT_ID"),
  dataset: requireEnv("SANITY_DATASET"),
  token: requireEnv("SANITY_API_TOKEN"),
  apiVersion: "2026-03-01",
  useCdn: false,
});

// ---- Helpers ------------------------------------------------------------

function requireEnv(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return val;
}

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
    // Generous headroom. When reasoning turns out to be mandatory (see
    // below), the model needs real room to think before it even gets to
    // the actual answer, a tight default is what caused the original
    // reasoning-trace failure, it ran out of room mid-thought.
    max_tokens: 16000,
  };
  // Some free models "think out loud" before answering and can burn their
  // entire response budget on that, leaving nothing for the actual post.
  // This turns that off where the model supports it. Some other models
  // (gpt-oss-120b on at least one provider) flatly require reasoning and
  // reject the request if it's disabled, that's handled by the caller
  // retrying with disableReasoning: false.
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
      throw new Error(
        `OpenRouter didn't respond within ${timeoutMs / 1000}s, likely an overloaded free model. Try rerunning, the auto-router will probably pick a different model next time.`
      );
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
      // Body wasn't the shape we expected, fall back to our own schedule below.
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
    const mandatoryReasoning =
      err.status === 400 && /reasoning is mandatory/i.test(err.bodyText || "");
    if (!mandatoryReasoning) throw err;
    console.log("This model requires reasoning enabled, retrying without the override...");
    return await callOpenRouterOnce(systemPrompt, userPrompt, { disableReasoning: false, model });
  }
}

// Free-tier providers get overloaded by aggregate traffic across everyone
// using them, nothing to do with our own request volume. A 429 here means
// "try again shortly", the textbook response is a short wait and retry,
// not a code fix. When the server tells us exactly how long via
// retry_after_seconds, trust that over our own guessed schedule.
async function callOpenRouterWithRetries(systemPrompt, userPrompt, model) {
  const MAX_ATTEMPTS = 3;
  const DEFAULT_BACKOFF_MS = [10_000, 20_000];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await callOpenRouterAdaptive(systemPrompt, userPrompt, model);
    } catch (err) {
      if (err.status !== 429 || attempt === MAX_ATTEMPTS) throw err;
      const wait = err.retryAfterMs ? err.retryAfterMs + 1000 : DEFAULT_BACKOFF_MS[attempt - 1];
      console.log(
        `${model} is temporarily rate-limited upstream, waiting ${Math.round(wait / 1000)}s (${
          err.retryAfterMs ? "server-specified" : "default"
        }) before retry ${attempt + 1}/${MAX_ATTEMPTS}...`
      );
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

// PRIMARY_MODEL is always tried first, in full, retries and all. The
// fallback model only gets called once the primary has genuinely
// exhausted every attempt and is still rate-limited, never picked
// upfront, and never used for any error other than persistent 429s.
async function callOpenRouter(systemPrompt, userPrompt) {
  try {
    return await callOpenRouterWithRetries(systemPrompt, userPrompt, PRIMARY_MODEL);
  } catch (err) {
    if (err.status !== 429) throw err;
    console.log(
      `${PRIMARY_MODEL} still rate-limited after all retries, falling back to ${FALLBACK_MODEL} for this call...`
    );
    return await callOpenRouterWithRetries(systemPrompt, userPrompt, FALLBACK_MODEL);
  }
}

async function alert(message) {
  console.log(`[ALERT] ${message}`);
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) return; // No Slack configured, console log + GitHub Actions
                          // job-failure email is your fallback.
  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    });
  } catch (err) {
    console.error("Failed to send Slack alert:", err.message);
  }
}

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 96);
}

function extractTitle(markdown) {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : "Untitled post";
}

// Matches the shape Portable Text expects for a block's _key, a short
// random hex string, same pattern as the keys in your real published
// posts.
function randomKey() {
  return Array.from({ length: 12 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

// ---- Main pipeline --------------------------------------------------------

async function main() {
  console.log(`Using model: ${PRIMARY_MODEL} (fallback if rate-limited: ${FALLBACK_MODEL})`);

  // Step 1: topic scanner
  const topicPrompt = await fs.readFile("prompts/topic-scanner.md", "utf8");

  const todayDate = new Date().toISOString().slice(0, 10);
  const targetMarket = pickTargetMarket();
  console.log(`Target market for today: ${targetMarket}`);

  console.log("Checking Sanity for recently published titles (topic lock)...");
  const publishedTitles = await fetchPublishedTitles(sanity, SANITY_DOCUMENT_TYPE);
  console.log(`Found ${publishedTitles.length} title(s) published in the last 5 days.`);

  console.log("Running pre-fetched web searches (Google News RSS)...");
  const searchGroups = await gatherRSSSearchContext(targetMarket);
  const searchContext = formatSearchResultsForPrompt(searchGroups);

  const topicUserMessage = `TODAY_DATE: ${todayDate}
TARGET_MARKET: ${targetMarket}
PUBLISHED_TITLES: ${publishedTitles.length ? publishedTitles.join(", ") : "(none)"}

NOTE: You do not have a live web search tool in this environment. The
searches your instructions call for have already been run for you, using
these exact result sets below. Do not say you are searching or describe
search steps, just use this data directly to produce the brief.

${searchContext}

Now produce the brief per your instructions, using only the information above.`;

  console.log("Asking the topic scanner for today's topic...");
  let topic;
  const MAX_TOPIC_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_TOPIC_ATTEMPTS; attempt++) {
    const candidate = await callOpenRouter(topicPrompt, topicUserMessage);
    if (/---BEGIN BRIEF---/.test(candidate) && /TOPIC:/.test(candidate)) {
      topic = candidate;
      break;
    }
    console.log(
      `Topic scanner returned a malformed brief on attempt ${attempt}/${MAX_TOPIC_ATTEMPTS}${
        attempt < MAX_TOPIC_ATTEMPTS ? ", retrying..." : ""
      }`
    );
    if (attempt === MAX_TOPIC_ATTEMPTS) {
      throw new Error(
        `Topic scanner failed to produce a valid brief after ${MAX_TOPIC_ATTEMPTS} attempts. Last response: ${candidate.slice(0, 300)}`
      );
    }
  }
  console.log(`Topic chosen: ${topic.slice(0, 200)}`);

  // Step 2: content writer
  const writerPrompt = await fs.readFile("prompts/content-writer.md", "utf8");

  console.log("Fetching the brief's SOURCES_TO_FETCH URLs (Jina Reader)...");
  const sourceUrls = extractSourceUrls(topic);
  console.log(`Found ${sourceUrls.length} source URL(s) in the brief.`);
  const extracted = await jinaFetchMany(sourceUrls);
  if (extracted.failed.length) {
    console.log(
      `Could not fetch ${extracted.failed.length} of them, the writer will soften or drop claims that depend on those, per its own sourcing rules.`
    );
  }
  const sourceContext = formatExtractedContentForPrompt(extracted);

  console.log("Fetching real published posts (for the general reslink.org link safety net)...");
  const recentPosts = await fetchRecentPosts(sanity, SANITY_DOCUMENT_TYPE);
  console.log(`Found ${recentPosts.length} real post(s) on record.`);

  console.log("Asking the content writer to draft the post...");
  const writerUserMessage = `Write the full blog post in Markdown, based on this brief:

${topic}

NOTE: You do not have a live fetch tool in this environment. The URLs
listed in SOURCES_TO_FETCH above have already been fetched for you, their
content is below. Treat this as the fetched content required by Step 1c,
do not say you are fetching anything, just use this directly. Any URL not
listed below could not be fetched, treat claims depending on it as
unsourced per your own rules.

${sourceContext}

Do not generate a "You May Also Like" section at all, it's disabled for now, skip straight from FAQs to Sources.

Also, more generally: never link to any reslink.org page you haven't been explicitly given a real URL for anywhere in this document, demo pages, resource downloads, or anything else, describe it in plain text with no link instead.`;

  // Rough count for retry purposes, lint.js does the precise, authoritative
  // count later, this is just deciding whether to burn a retry attempt.
  const roughWordCount = (text) => text.replace(/[#*_>`[\]()-]/g, " ").split(/\s+/).filter(Boolean).length;

  let rawMarkdown;
  const MAX_WRITER_ATTEMPTS = 3;
  let previousDraft = null;
  let previousWordCount = null;

  for (let attempt = 1; attempt <= MAX_WRITER_ATTEMPTS; attempt++) {
    let message;
    if (attempt === 1) {
      message = writerUserMessage;
    } else if (previousDraft) {
      // Genuine expand-in-place: hand back the actual draft and ask for
      // more depth in what's already there, not a blind rewrite from
      // scratch. Each API call has no memory of the last one, so without
      // this the "retry" was really just re-rolling dice with a sterner
      // note attached, editing something in front of the model is a much
      // more reliable task than hoping a second full generation lands
      // longer by chance.
      const shortfall = 2000 - previousWordCount;
      message = `Here is a draft you wrote for this brief, ${previousWordCount} words, ${shortfall} words short of the 2000-word floor:

${previousDraft}

Do not rewrite this from scratch. Do not change the title, the central claim, or the sources. Expand it by adding real content in exactly these three places:

1. Definition/context section: add 1-2 more paragraphs, real-world context, a relevant historical data point, or a comparison to how this worked before, sourced the same way as the rest of the post, not filler.
2. One of the categorization or supporting-info subsections (H4s): pick whichever one has the least depth right now, add 1-2 more paragraphs covering a practical detail an EPC would actually need, an edge case, a common complication, something concrete.
3. FAQ section: add one more genuinely useful question a skeptical EPC reader would actually ask, with a full, sourced answer, not a one-liner.

Every addition must be specific to this exact topic, not generic padding. Output the complete expanded post, still following every rule from your instructions (structure, sourcing, no em-dashes, no tables, meta panel, fact-check panel, no inline citation brackets).`;
    } else {
      // Previous attempt had no H1 at all, nothing usable to expand, ask
      // fresh instead.
      message = writerUserMessage;
    }

    const candidate = await callOpenRouter(writerPrompt, message);
    const hasH1 = /^#\s+.+/m.test(candidate);
    const wordCount = roughWordCount(candidate);
    const longEnough = wordCount >= 1900; // small grace margin under lint's hard 2000 floor

    if (hasH1 && longEnough) {
      rawMarkdown = candidate;
      break;
    }

    rawMarkdown = candidate;
    if (hasH1) {
      previousDraft = candidate;
      previousWordCount = wordCount;
    } else {
      previousDraft = null; // garbage output, nothing worth expanding next round
    }

    const reason = !hasH1
      ? "no H1 found, likely a reasoning trace that never finished"
      : `too short (about ${wordCount} words, need 2000+)`;
    console.log(
      `Content writer output rejected before linting: ${reason} (attempt ${attempt}/${MAX_WRITER_ATTEMPTS})${
        attempt < MAX_WRITER_ATTEMPTS ? ", retrying..." : ""
      }`
    );
    if (attempt === MAX_WRITER_ATTEMPTS) {
      console.log("Giving up on pre-lint retries, passing the last attempt through to the full lint gate anyway.");
    }
  }

  // Pull the real data out of the meta panel before it gets stripped.
  const meta = parseMetaPanel(rawMarkdown);

  // Both the meta panel and the fact-check panel are internal-only now,
  // wrapped in HTML comments so they never reach the published post. The
  // fact-check panel is a real QA signal though, worth keeping visible to
  // you even though readers never see it, not just silently discarded.
  const allComments = rawMarkdown.match(/<!--[\s\S]*?-->/g) || [];
  const factCheckComment = allComments.find(
    (c) => /\[VERIFIED\]|\[SOFTENED\]|\[NOT INCLUDED\]|\[RECENCY CHECK\]/.test(c)
  );
  if (factCheckComment) {
    console.log("--- Fact-check panel (internal only, not published) ---");
    console.log(factCheckComment.replace(/<!--|-->/g, "").trim());
    console.log("--- end fact-check panel ---");
  }

  // 1. Your prompt's meta/image/fact-check panels are hidden via HTML
  //    comments, which only works on an actual HTML page. In Markdown it
  //    just becomes visible junk in the published post, so strip them
  //    (their useful data was already pulled out above).
  // 2. Your content rules ban em-dashes outright, and free models reach
  //    for them regardless of instructions. Rather than throw away an
  //    otherwise-good draft over one punctuation mark, fix it mechanically.
  const hadComments = allComments.length > 0;
  const emDashCount = (rawMarkdown.match(/\u2014/g) || []).length;

  let markdown = rawMarkdown.replace(/<!--[\s\S]*?-->/g, "").trim();
  markdown = markdown.replace(/\s*\u2014\s*/g, ", ");

  if (hadComments) console.log(`Stripped ${allComments.length} internal HTML comment block(s) from the draft (meta panel, fact-check panel).`);
  if (emDashCount) console.log(`Replaced ${emDashCount} em-dash(es) with a comma before linting.`);
  if (meta.seoTitle || meta.seoDescription) console.log("Extracted SEO title/description/tags from the meta panel before discarding it.");

  // Markdown "---" divider lines convert to a "horizontal-rule" Portable
  // Text block, a type your Sanity schema doesn't allow. The API happily
  // stores it anyway (it doesn't check schema), then Studio flags it as
  // invalid the moment a human opens the document. Strip these before
  // they ever become a block in the first place.
  const hadDividers = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/m.test(markdown);
  markdown = markdown.replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, "").trim();
  if (hadDividers) console.log("Stripped horizontal-rule divider(s), unsupported block type in this schema.");

  // Off entirely for now, per explicit instruction, not conditional on
  // whether the model happened to get it right this time.
  const { cleaned: ymalCleaned, removed: ymalRemoved } = removeYouMayAlsoLikeSection(markdown);
  markdown = ymalCleaned;
  if (ymalRemoved) console.log("Removed 'You May Also Like' section (disabled for now).");

  // Any reslink.org link the model invented, demo pages, resource
  // downloads, whatever, that isn't one of your real fetched posts, gets
  // de-linked (text kept, link dropped) rather than blocking publish or
  // shipping a dead link. Real URLs for these pages come later.
  const { cleaned: delinkedMarkdown, strippedCount: delinkedCount } =
    delinkUnverifiedReslinkLinks(markdown, recentPosts.map((p) => p.url));
  markdown = delinkedMarkdown;
  if (delinkedCount) {
    console.log(`De-linked ${delinkedCount} invented reslink.org URL(s), kept the text, dropped the fake link.`);
  }

  // Guaranteed cleanup, not dependent on the model choosing correctly:
  // any Google redirect link that survived into the draft gets swapped
  // for its real resolved URL directly.
  const { cleaned: resolvedMarkdown, replacedCount } = replaceOriginalUrlsWithResolved(markdown, extracted.results);
  markdown = resolvedMarkdown;
  if (replacedCount) {
    console.log(`Replaced ${replacedCount} Google redirect URL(s) with their real resolved links.`);
  }

  // Catch-all: covers URLs from brief fields other than SOURCES_TO_FETCH
  // (PRIMARY_SOURCE_CONFIRMED, CENTRAL_CLAIM_SOURCE_URL, etc), which the
  // resolved-URL swap above has no mapping for since they were never
  // fetched via Jina. Never publish a raw redirect link, resolved or not.
  const { cleaned: noRedirectsMarkdown, strippedCount: redirectsStripped } = stripUnresolvedGoogleRedirects(markdown);
  markdown = noRedirectsMarkdown;
  if (redirectsStripped) {
    console.log(`Stripped ${redirectsStripped} unresolved Google redirect link(s), kept the text.`);
  }

  // The prompt bans inline "(Source: ...)" citations interrupting body
  // text, and the model still does it sometimes anyway, real code
  // backstop instead of hoping the instruction holds.
  const { cleaned: noInlineCitesMarkdown, strippedCount: citesStripped } = stripInlineSourceCitations(markdown);
  markdown = noInlineCitesMarkdown;
  if (citesStripped) {
    console.log(`Stripped ${citesStripped} inline "(Source: ...)" citation(s) from the body.`);
  }

  // The model occasionally reaches for raw HTML elements (accordions,
  // divs, etc), old habit from the original HTML-output prompt. Each one
  // produces a Portable Text block type your schema doesn't allow. Rather
  // than chase each new tag individually, strip any raw HTML tag
  // generally, keep the text inside it, drop the tag itself.
  const hadRawHtml = /<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s+[^<>]*)?\/?>/.test(markdown);
  markdown = markdown.replace(/<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s+[^<>]*)?\/?>/g, " ").replace(/[ \t]+/g, " ").trim();
  if (hadRawHtml) console.log("Stripped raw HTML tag(s) from the draft, kept the text inside them.");

  // Real bug seen twice now (July42026, January12027), two prompt-only
  // fixes didn't hold, this catches it deterministically.
  const { cleaned: datesFixedMarkdown, fixedCount: datesFixed } = fixSquishedDates(markdown);
  markdown = datesFixedMarkdown;
  if (datesFixed) console.log(`Fixed ${datesFixed} squished date(s) missing their spaces.`);

  // Same bug, different shape: "3months" instead of "July42026". Also
  // adds spaces around small numeric ranges ("0-3" -> "0 - 3") per
  // explicit request, scoped narrowly to avoid technical identifiers.
  const { cleaned: durationFixedMarkdown, fixedCount: durationFixed } = fixDurationSpacing(markdown);
  markdown = durationFixedMarkdown;
  if (durationFixed) console.log(`Fixed ${durationFixed} duration/range spacing issue(s).`);

  // Restrict the final Sources list to only what was actually fetched
  // and verified via Jina, not just whatever the model wrote. A source
  // that merely responds isn't the same as one that was actually read.
  const { cleaned: sourcesRestrictedMarkdown, removedCount: sourcesRemoved } = restrictSourcesToVerified(
    markdown,
    extracted.results.map((r) => r.url)
  );
  markdown = sourcesRestrictedMarkdown;
  if (sourcesRemoved) {
    console.log(`Removed ${sourcesRemoved} unverified source(s) from the Sources section, kept only what was actually fetched.`);
  }

  // Step 3: lint gate
  console.log("Running the lint / quality gate...");
  const lint = await runLint(markdown);
  console.log(`Word count: ${lint.wordCount}`);
  if (lint.warnings.length) console.log("Warnings:", lint.warnings);

  if (!lint.pass) {
    console.log("--- Draft content (for debugging) ---");
    console.log(markdown || "(completely empty)");
    console.log("--- end draft content ---");
    await alert(
      `Blog draft FAILED the lint gate, nothing was published.\n\nErrors:\n- ${lint.errors.join(
        "\n- "
      )}\n\nTopic was: ${topic.slice(0, 200)}\n\nDraft was: ${markdown.slice(0, 500) || "(completely empty)"}`
    );
    process.exit(1); // Also marks the GitHub Actions run as failed
  }

  // Step 4: convert Markdown -> Portable Text
  // Title comes out first, and its H1 line gets stripped from the body,
  // your page template already renders the title field as the visual H1,
  // leaving it in the body meant it was showing up twice.
  const title = extractTitle(markdown);
  const markdownWithoutH1 = markdown.replace(/^#\s+.+\n+/, "");

  console.log("Converting to Portable Text...");
  let contentBlocks = markdownToPortableText(markdownWithoutH1);

  // Your schema has a real "callout" block type, and TL;DR is meant to
  // use it (confirmed from a real published post's raw data), not sit as
  // a plain paragraph. The generic Markdown converter has no way to know
  // that custom type exists, so find the TL;DR block after conversion and
  // swap it for a real callout.
  const tldrIndex = contentBlocks.findIndex((block) =>
    (block.children || []).some((child) => /^TL\s*;?\s*DR:?/i.test(child.text || ""))
  );
  if (tldrIndex !== -1) {
    const tldrText = (contentBlocks[tldrIndex].children || []).map((c) => c.text).join("");
    contentBlocks[tldrIndex] = {
      _type: "callout",
      _key: randomKey(),
      type: "info",
      text: tldrText,
    };
    console.log("Converted TL;DR paragraph into a real callout block.");
  }

  const doc = {
    _type: SANITY_DOCUMENT_TYPE,
    title,
    slug: { _type: "slug", current: slugify(title) },
    content: contentBlocks, // your schema's real field name, not "body"
    publishedAt: new Date().toISOString(),
    featured: false,
    estimatedReadTime: Math.max(1, Math.round(lint.wordCount / 200)),
    excerpt: meta.seoDescription || extractExcerpt(markdown), // required field, never left empty
    author: { name: "Shashank", role: "Co-founder" },
    // Hardcoded to your "Solar In 2026" category's real document ID, taken
    // from the Energy Storage Summit post you shared. Every post gets the
    // same category for now. Once you send the full category list, this
    // becomes a real lookup by topic/market instead of one fixed value.
    category: {
      _type: "reference",
      _ref: "d67174a7-8783-4848-bad8-0bcf361b573a",
    },
  };
  if (meta.seoTitle) doc.seoTitle = meta.seoTitle;
  else doc.seoTitle = title; // guaranteed fallback, per your instruction

  if (meta.seoDescription) doc.seoDescription = meta.seoDescription;
  else doc.seoDescription = doc.excerpt; // guaranteed fallback, per your instruction
  if (meta.tags && meta.tags.length) doc.tags = meta.tags;
  // Not populated yet, needs more work than this pass covers:
  //   category -> a reference to an existing category document, needs
  //               matching/creating one, not just a string

  // Guard against the model reusing one field's text for another, which
  // it does sometimes, title as the excerpt, SEO title as the SEO
  // description. If two fields that should be distinct come out
  // identical, don't trust the duplicate, derive the real one instead.
  const normalize = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  if (normalize(doc.excerpt) === normalize(doc.title)) {
    console.log("Model reused the title as the excerpt, deriving a real one from the body instead.");
    doc.excerpt = extractExcerpt(markdown);
  }
  if (normalize(doc.seoDescription) === normalize(doc.seoTitle)) {
    console.log("Model reused the SEO title as the SEO description, falling back to the excerpt instead.");
    doc.seoDescription = doc.excerpt;
  }

  console.log("Finding cover image (stock photo search first, generation as last resort)...");
  try {
    const imagePrompt = extractHeroImagePrompt(rawMarkdown) || title;
    const hero = await getHeroImage(imagePrompt);
    if (hero) {
      const assetId = await uploadImageToSanity(sanity, hero.buffer, `${slugify(title)}-cover.jpg`);
      doc.coverImage = { _type: "image", asset: { _type: "reference", _ref: assetId } };
      console.log(`Cover image uploaded (source: ${hero.source}).`);
      if (hero.attribution) {
        // Unsplash's terms require this credit be shown somewhere on the
        // page whenever their photo is used. There's no field for it in
        // the current schema, so surfacing it here rather than silently
        // dropping a real compliance requirement. Add a real field for
        // this whenever you're ready, this is the one thing in the whole
        // pipeline that isn't fully wired end to end yet.
        console.log(`ATTRIBUTION REQUIRED (Unsplash terms): ${hero.attribution}`);
        await alert(`Cover image used an Unsplash photo, attribution required: ${hero.attribution}`);
      }
    } else {
      console.log("Both the generator and the photo search failed, publishing without a cover image.");
    }
  } catch (err) {
    console.log(`Cover image failed (${err.message}), publishing without one rather than blocking.`);
  }

  console.log(`Publishing "${title}" to Sanity...`);
  const created = await sanity.create(doc);

  await alert(
    `New blog post published: "${title}" (Sanity doc: ${created._id}, ${lint.wordCount} words)`
  );
  console.log("Done.");
}

main().catch(async (err) => {
  console.error(err);
  await alert(`Pipeline crashed before publishing anything: ${err.message}`);
  process.exit(1);
});
