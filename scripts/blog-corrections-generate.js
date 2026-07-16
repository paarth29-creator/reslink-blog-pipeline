// scripts/blog-corrections-generate.js
//
// Step 1 of 2 for fixing the 10 already-live posts. This script is
// READ-ONLY against Sanity: it fetches each post's current content,
// applies the specific corrections from blog-corrections-data.js via an
// LLM call, and writes the result to corrections-review/<docId>.md for
// a human read before anything goes live. Nothing here can modify a
// live post. That happens only in blog-corrections-apply.js, a
// separate script, run separately, after review.
//
// One-off task, not part of the recurring pipeline. Never imported by
// orchestrator.js or value-topic-orchestrator.js.

import fs from "fs/promises";
import { createClient } from "@sanity/client";
import { BLOG_CORRECTIONS } from "./blog-corrections-data.js";
import { portableTextToMarkdown, IMAGE_MARKER } from "./portable-text-markdown.js";

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

const PRIMARY_MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-oss-120b";

async function callOpenRouter(systemPrompt, userPrompt) {
  const timeoutMs = 120_000;
  const MAX_ATTEMPTS = 5; // same retry budget as the recurring pipeline, same reasoning: nothing is time-critical here, more patience costs nothing
  const DEFAULT_BACKOFF_MS = [10_000, 20_000, 30_000, 45_000];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${requireEnv("OPENROUTER_API_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: PRIMARY_MODEL,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          max_tokens: 16000,
        }),
      });
      if (!res.ok) {
        const bodyText = await res.text();
        if (res.status === 429 && attempt < MAX_ATTEMPTS) {
          let waitMs = DEFAULT_BACKOFF_MS[attempt - 1];
          try {
            const retryAfter = JSON.parse(bodyText)?.error?.metadata?.retry_after_seconds;
            if (typeof retryAfter === "number") waitMs = Math.ceil(retryAfter * 1000) + 1000;
          } catch {
            // fall back to default backoff
          }
          console.log(`Rate-limited, waiting ${Math.round(waitMs / 1000)}s before retry ${attempt + 1}/${MAX_ATTEMPTS}...`);
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }
        throw new Error(`OpenRouter error ${res.status}: ${bodyText}`);
      }
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error(`OpenRouter returned no content: ${JSON.stringify(data)}`);
      return content;
    } catch (err) {
      if (err.name === "AbortError" && attempt < MAX_ATTEMPTS) {
        console.log(`Timed out, retrying (${attempt + 1}/${MAX_ATTEMPTS})...`);
        continue;
      }
      if (attempt === MAX_ATTEMPTS) throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}

const CORRECTION_SYSTEM_PROMPT = `You apply a specific, pre-determined list of corrections to a blog post. You did not write this post and you are not fact-checking it yourself, someone else already did that work and gave you the exact list of what to fix.

ABSOLUTE RULES:
1. Apply ONLY the corrections explicitly listed. Do not fix, improve, or reword anything not on the list, even if you notice something else that looks wrong.
2. Each correction has a "find_this" (the risky pattern, sometimes an exact phrase, sometimes a description like "Any claim that...") and a "replace_with" (the exact corrected wording to use, or a deletion instruction). Locate the matching content in the draft using judgment where find_this is a description, then apply the replace_with instruction exactly, adapting only the minimum grammar needed for it to read naturally in context.
3. CRITICAL: a flagged claim or pattern often appears MORE THAN ONCE in the same post, restated in a later paragraph, repeated in a supporting-info section, or echoed again in the FAQ answers. Find and fix EVERY occurrence across the ENTIRE document, not just the first one. Fixing an issue in the body while leaving the identical claim untouched in an FAQ answer is a failure, not a partial success.
4. If a correction instructs deleting content entirely, delete it completely and let the surrounding text read naturally, as if it was never there. NEVER write a placeholder, note, or explanation where deleted content used to be. Never write internal phrases like "not found", "skipped", "not applicable", or any other bookkeeping language as if it were real article content, a reader must never see any trace of this correction process itself. If a whole FAQ question must be deleted, delete the entire question and answer pair and renumber everything after it, never leave a numbered question with placeholder text as its answer.
5. If a correction instructs removing an unsupported specific figure or statistic, remove it completely or replace it only with the exact qualifying language the replace_with provides. Do NOT invent a different specific number to fill the gap, that recreates the exact problem being fixed with a new fabricated figure instead of the old one.
6. If a listed correction's pattern genuinely does not appear anywhere in this draft, leave that part of the document completely untouched and note this in your change log only, never insert anything into the visible text about it.
7. Never add a new fact, figure, or claim beyond what a replace_with explicitly provides.
8. Do not touch the [[PROMO_IMAGE_MARKER_DO_NOT_REMOVE_OR_EDIT_THIS_LINE]] line if present.
9. Do not change headings, structure, or anything else not covered by the listed corrections, except where a correction explicitly requires removing a heading (e.g. deleting an entire FAQ entry).

Output the complete corrected draft, then a single HTML comment at the very end:
<!-- CHANGES: [one line per correction actually applied, or "not found, skipped" for any that weren't, this comment is internal only and will never appear in the visible document] -->`;

const VERIFICATION_SYSTEM_PROMPT = `You are an independent auditor checking whether a correction pass actually did what it claims. You did not make the corrections yourself. Do not trust the change log the correction pass produced, verify against the actual document text directly, skeptically, as if the claims might be wrong, because they sometimes are.

You will be given the original list of required corrections and the corrected document. For EVERY correction in the list, check the ENTIRE document, including every FAQ answer, every supporting-info subsection, and the sources list, not just where you'd expect to find it:

1. Is the flagged pattern, or a clear semantic restatement of it, still present anywhere? A correction is only genuinely done if every occurrence is gone, not just the first one.
2. If the correction instructed deleting a topic/entity/section entirely, is that topic genuinely absent everywhere, headings, body text, and sources list included?
3. Does the document contain any internal bookkeeping or instruction-style text that leaked into the visible content (phrases like "not found", "skipped", raw correction instructions, anything that reads like a note-to-self rather than real article content)?
4. For any correction that asked to remove an unsupported figure or statistic, does the document now contain a DIFFERENT specific number in that same spot that isn't actually supported either, a fabricated replacement rather than a genuine removal?

Output ONLY this, nothing else:

If everything genuinely checks out: VERIFICATION: CLEAN

If not, for each real problem found:
VERIFICATION: ISSUES FOUND
- [which correction]: [exact quote of the problem text still in the document]: [why this is still a problem]`;

const RETRY_SYSTEM_PROMPT = `You are fixing specific problems an independent verification pass found in a previous correction attempt. You will be given the current draft and a list of exact problems that must be fixed. Fix precisely these, search the entire document for every occurrence of each one, including FAQ answers and supporting sections. Do not touch anything else. If a problem is a deletion that wasn't fully completed, complete the deletion, no placeholder text, no leftover trace. If a problem is a fabricated replacement figure, remove it entirely rather than inventing yet another number.

CRITICAL: if you see a line reading exactly [[PROMO_IMAGE_MARKER_DO_NOT_REMOVE_OR_EDIT_THIS_LINE]] anywhere in the document, you must leave it completely untouched, in its exact original position. Do not delete it, move it, or treat it as something to clean up, it is not a mistake in the document, it is required and intentional.

Output the complete corrected draft, then a single HTML comment at the very end:
<!-- CHANGES: [one line per problem, confirming it was fixed] -->`;

// Real bug found in production: the model's own change log claimed
// "Mounting height universalised – applied" while the exact flagged
// sentence was still sitting in the document, completely unchanged.
// Self-reported success can't be trusted on its own, same lesson this
// whole project already learned once for fabricated statistics, showing
// up again in a different part of the pipeline. This is a code-level
// check independent of what the model claims.
//
// Only checks find_this entries that read as literal quotes from the
// article, not generic pattern descriptions ("Any claim that...",
// "Any wording saying..."), those can't be substring-matched since the
// description itself never appeared verbatim in the original draft.
// The heuristic (does NOT start with "Any ") is simple but reliable
// against how blog-corrections-data.js is actually written.
function looksLikeExactPhrase(findThis) {
  return !/^any\s/i.test(findThis.trim());
}

function normalizeForComparison(s) {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?,;:]+$/, ""); // trailing punctuation stripped, the article's actual sentence often continues past where find_this ends (comma instead of the period find_this was written with)
}

function findStillPresentFixes(markdown, fixes) {
  const normalizedDoc = normalizeForComparison(markdown);
  return fixes.filter(
    (fix) => looksLikeExactPhrase(fix.find_this) && normalizedDoc.includes(normalizeForComparison(fix.find_this))
  );
}

// Cheap, free, deterministic check for our own known bookkeeping
// vocabulary leaking into the visible document, real failure found in
// production: "not found, skipped" (language this exact prompt asks the
// model to use internally) got pasted directly into a live FAQ answer.
// This doesn't need an LLM call, we know exactly which phrases we
// ourselves introduced into the internal vocabulary.
const BOOKKEEPING_LEAK_PATTERNS = [/not found,?\s*skipped/i, /not applicable/i, /\bapplied\b\s*$/im];

function findBookkeepingLeaks(markdown) {
  return BOOKKEEPING_LEAK_PATTERNS.filter((pattern) => pattern.test(markdown));
}

// Second, distinct deterministic layer: real failure found in
// production, a replace_with instruction ("Remove this figure, or
// clearly label it as an illustrative scenario with stated assumptions
// for...") got pasted verbatim as if it were the article's own content,
// not one of the shorter internal-vocabulary phrases above. Only checks
// replace_with entries that read as instructions to the model (start
// with an imperative verb) rather than substantive replacement prose,
// since many replace_with entries in blog-corrections-data.js ARE meant
// to be inserted as real sentences, this only flags the ones that
// clearly aren't. A near-verbatim match of a full instruction sentence
// essentially never happens by legitimate coincidence, so this carries
// effectively zero false-positive risk when it does fire.
const INSTRUCTION_VERB_PATTERN = /^(remove|delete|clarify|label|verify|replace this|drop|omit)\b/i;

function findLeakedInstructionText(markdown, fixes) {
  const normalizedDoc = normalizeForComparison(markdown);
  return fixes.filter(
    (fix) => INSTRUCTION_VERB_PATTERN.test(fix.replace_with.trim()) && normalizedDoc.includes(normalizeForComparison(fix.replace_with))
  );
}

// Fully deterministic, no LLM judgment needed: if the original document
// had the promo image marker, the corrected one must too. Real bug
// found in production: the retry prompt had no instruction protecting
// this marker (only the main correction prompt did), so every file that
// needed a retry silently lost its promo image entirely, since the
// apply script finds where to reinsert the real image block by locating
// this exact marker text. This check can't be fooled by a plausible-
// sounding change log the way the LLM-based checks theoretically could.
function promoMarkerWasLost(originalMarkdown, correctedMarkdown) {
  return originalMarkdown.includes(IMAGE_MARKER) && !correctedMarkdown.includes(IMAGE_MARKER);
}
async function main() {
  await fs.mkdir("corrections-review", { recursive: true });

  for (const blog of BLOG_CORRECTIONS) {
    console.log(`\n=== ${blog.title} (${blog.sanityDocId}) ===`);

    let doc;
    try {
      doc = await sanity.getDocument(blog.sanityDocId);
    } catch (err) {
      console.log(`Could not fetch this doc (${err.message}), skipping.`);
      continue;
    }
    if (!doc) {
      console.log("Doc not found (may have been deleted), skipping.");
      continue;
    }
    if (!doc.content || !Array.isArray(doc.content)) {
      console.log("No content field found on this doc, skipping.");
      continue;
    }

    const originalMarkdown = portableTextToMarkdown(doc.content);
    console.log(`Fetched, ${originalMarkdown.split(/\s+/).length} words. Applying ${blog.fixes.length} correction(s)...`);

    const fixList = blog.fixes
      .map((f, i) => `${i + 1}. [${f.severity}] ${f.issue}\n   find_this: ${f.find_this}\n   replace_with: ${f.replace_with}`)
      .join("\n\n");

    const userMessage = `CORRECTIONS TO APPLY:\n\n${fixList}\n\nDRAFT:\n\n${originalMarkdown}`;

    let response;
    try {
      response = await callOpenRouter(CORRECTION_SYSTEM_PROMPT, userMessage);
    } catch (err) {
      console.log(`Correction call failed (${err.message}), skipping this blog, nothing written.`);
      continue;
    }

    const changesMatch = response.match(/<!--\s*CHANGES:([\s\S]*?)-->/i);
    let changeLog = changesMatch ? changesMatch[1].trim() : "(no change log found in response)";
    let correctedMarkdown = response.replace(/<!--\s*CHANGES:[\s\S]*?-->/i, "").trim();

    // Two independent layers, neither of which trusts the correction
    // pass's own change log, real lesson from production: that log has
    // claimed fixes that didn't happen, at least four different ways
    // (a repeat left untouched, a placeholder pasted in as content, a
    // "delete everywhere" only partially done, an unsupported figure
    // swapped for a different unsupported figure).
    //
    // Layer 1, free and deterministic: our own known bookkeeping
    // vocabulary leaking into the visible text.
    let bookkeepingLeaks = findBookkeepingLeaks(correctedMarkdown);
    let instructionLeaks = findLeakedInstructionText(correctedMarkdown, blog.fixes);
    let markerLost = promoMarkerWasLost(originalMarkdown, correctedMarkdown);

    // Layer 2, a genuinely separate LLM call whose only job is auditing
    // this specific correction pass's actual output, adversarially, not
    // asked to also do any editing itself.
    const verifyMessage = `CORRECTIONS THAT WERE SUPPOSED TO BE APPLIED:\n\n${fixList}\n\nDOCUMENT TO CHECK:\n\n${correctedMarkdown}`;
    let verificationIssues = [];
    try {
      const verificationResponse = await callOpenRouter(VERIFICATION_SYSTEM_PROMPT, verifyMessage);
      if (/ISSUES FOUND/i.test(verificationResponse)) {
        verificationIssues = verificationResponse
          .split("\n")
          .filter((line) => line.trim().startsWith("-"))
          .map((line) => line.trim());
      }
    } catch (err) {
      console.log(`Verification call failed (${err.message}), proceeding without that layer for this blog, relying on the deterministic checks only.`);
    }

    const hasRealIssues = bookkeepingLeaks.length > 0 || instructionLeaks.length > 0 || markerLost || verificationIssues.length > 0;
    if (hasRealIssues) {
      console.log(`Verification found real problems, retrying: ${bookkeepingLeaks.length} bookkeeping leak(s), ${instructionLeaks.length} leaked instruction text, ${markerLost ? 1 : 0} lost promo marker, ${verificationIssues.length} independently-verified issue(s).`);
      const retryProblems = [
        ...bookkeepingLeaks.map((p) => `- Internal bookkeeping text leaked into visible content, matching pattern: ${p}`),
        ...instructionLeaks.map((f) => `- The literal correction instruction text was pasted in as if it were article content, for "${f.issue}". It must be actually applied/removed, not quoted verbatim.`),
        ...(markerLost ? [`- The [[PROMO_IMAGE_MARKER_DO_NOT_REMOVE_OR_EDIT_THIS_LINE]] line was removed. It must be restored, add it back near where the third real body paragraph ends, do not otherwise change surrounding content to fit it in.`] : []),
        ...verificationIssues,
      ].join("\n");
      const retryMessage = `PROBLEMS FOUND BY INDEPENDENT VERIFICATION:\n\n${retryProblems}\n\nCURRENT DRAFT:\n\n${correctedMarkdown}`;
      try {
        const retryResponse = await callOpenRouter(RETRY_SYSTEM_PROMPT, retryMessage);
        const retryChangesMatch = retryResponse.match(/<!--\s*CHANGES:([\s\S]*?)-->/i);
        const retryChangeLog = retryChangesMatch ? retryChangesMatch[1].trim() : "(no change log in retry response)";
        correctedMarkdown = retryResponse.replace(/<!--\s*CHANGES:[\s\S]*?-->/i, "").trim();
        changeLog += `\n\nRETRY PASS (targeted at independently-verified problems): ${retryChangeLog}`;
        // Re-check after the retry, same layers, don't just assume it worked.
        bookkeepingLeaks = findBookkeepingLeaks(correctedMarkdown);
        instructionLeaks = findLeakedInstructionText(correctedMarkdown, blog.fixes);
        markerLost = promoMarkerWasLost(originalMarkdown, correctedMarkdown);
        try {
          const reverifyResponse = await callOpenRouter(VERIFICATION_SYSTEM_PROMPT, `CORRECTIONS THAT WERE SUPPOSED TO BE APPLIED:\n\n${fixList}\n\nDOCUMENT TO CHECK:\n\n${correctedMarkdown}`);
          verificationIssues = /ISSUES FOUND/i.test(reverifyResponse)
            ? reverifyResponse.split("\n").filter((line) => line.trim().startsWith("-")).map((line) => line.trim())
            : [];
        } catch {
          // If re-verification itself fails to run, don't silently claim clean, keep whatever was last known.
        }
      } catch (err) {
        console.log(`Retry call failed (${err.message}), proceeding with the pre-retry version, problems noted below.`);
      }
    }

    const stillHasIssues = bookkeepingLeaks.length > 0 || instructionLeaks.length > 0 || markerLost || verificationIssues.length > 0;
    if (stillHasIssues) {
      console.log(`WARNING: real problems remain after retry, needs manual attention.`);
    } else {
      console.log("Independent verification: clean.");
    }

    const outPath = `corrections-review/${blog.sanityDocId}.md`;
    const verificationBanner = stillHasIssues
      ? `\n*** VERIFICATION WARNING (independent check, not the model's self-report): ***\n*** Real problems were found and were NOT fully resolved even after a retry. ***\n*** Do not send this to Apply until these are manually corrected: ***\n${bookkeepingLeaks.map((p) => `***   - Internal bookkeeping text leaked into content (pattern: ${p})`).join("\n")}\n${instructionLeaks.map((f) => `***   - Correction instruction text leaked in verbatim for: ${f.issue}`).join("\n")}\n${markerLost ? "***   - PROMO IMAGE MARKER WAS LOST, applying this file as-is would silently drop the promo creative from the live post\n" : ""}${verificationIssues.map((v) => `***   ${v}`).join("\n")}\n`
      : "";
    const fileContent = `<!--
REVIEW FILE, not live. Generated by blog-corrections-generate.js.
Original doc: ${blog.sanityDocId}
Title: ${blog.title}
Word count: original ${originalMarkdown.split(/\s+/).length} -> corrected ${correctedMarkdown.split(/\s+/).length}
${verificationBanner}
CHANGES APPLIED:
${changeLog}

To publish this: review the content below, edit this file directly if anything needs adjusting,
then run blog-corrections-apply.js, which reads this exact file and patches the live Sanity doc.
-->

${correctedMarkdown}
`;
    await fs.writeFile(outPath, fileContent, "utf8");
    console.log(`Written: ${outPath}`);
    console.log(`Changes: ${changeLog}`);
  }

  console.log("\nDone. Review the files in corrections-review/ before running blog-corrections-apply.js.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
