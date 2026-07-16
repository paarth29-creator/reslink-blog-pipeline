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
import { portableTextToMarkdown } from "./portable-text-markdown.js";

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
2. Each correction has a "find_this" (the risky pattern, sometimes an exact phrase, sometimes a description like "Any claim that...") and a "replace_with" (the exact corrected wording to use). Locate the matching content in the draft using judgment where find_this is a description, then replace it with the given replace_with text, adapting only the minimum grammar needed for it to read naturally in context (tense, connecting words). Do not add anything beyond what replace_with already says.
3. CRITICAL, this is the single most common mistake made on this task: a flagged claim or pattern often appears MORE THAN ONCE in the same post, restated in a later paragraph, repeated in a supporting-info section, or echoed again in the FAQ answers. You must find and fix EVERY occurrence of each listed pattern across the ENTIRE document, not just the first one you encounter. Read the full document, including every FAQ answer, before considering a correction done. Fixing an issue in the body while leaving the identical claim untouched in an FAQ answer is a failure of this task, not a partial success.
4. If a listed correction's pattern genuinely does not appear anywhere in this draft, skip it, do not force a change. Note this in your change log.
5. Never add a new fact, figure, or claim beyond what a replace_with explicitly provides.
6. Do not touch the [[PROMO_IMAGE_MARKER_DO_NOT_REMOVE_OR_EDIT_THIS_LINE]] line if present, leave it exactly as-is, do not remove it, move it, or edit its text.
7. Do not change headings, structure, or anything else not covered by the listed corrections.
8. Before finalizing, verify your own work: for each correction you're marking as "applied" in your change log, confirm you searched the entire document for that pattern, not just the paragraph where you first noticed it. Only claim a fix is applied if you actually changed every instance of it.

Output the complete corrected draft, then a single HTML comment at the very end:
<!-- CHANGES: [one line per correction actually applied, or "not found, skipped" for any that weren't] -->`;

const RETRY_SYSTEM_PROMPT = `You are fixing a specific, narrow problem: a previous correction pass claimed to fix certain issues, but an independent check found the exact flagged phrases are still present, unchanged, elsewhere in the document (almost always because the fix was applied once but the same claim repeats later, often in an FAQ answer).

You will be given the current draft and a short list of phrases that must not appear anywhere in it, along with what each should say instead. Find every remaining occurrence of each phrase and fix it the same way the first occurrence was presumably already fixed. Do not touch anything else in the document, this is a narrow, targeted pass, not a rewrite.

Output the complete corrected draft, then a single HTML comment at the very end:
<!-- CHANGES: [one line per phrase, confirming it was found and fixed, or genuinely not found anywhere] -->`;

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

    // Independent check, not trusting the change log above. Real
    // example that motivated this: the model claimed "Mounting height
    // universalised – applied" while the flagged sentence was still
    // there, word for word. One targeted retry, naming the exact
    // phrases still found, rather than assuming the first pass worked.
    let stillPresent = findStillPresentFixes(correctedMarkdown, blog.fixes);
    if (stillPresent.length > 0) {
      console.log(`Independent check found ${stillPresent.length} claimed fix(es) still present verbatim, retrying with a targeted pass: ${stillPresent.map((f) => f.issue).join("; ")}`);
      const retryList = stillPresent
        .map((f) => `- Must not appear anywhere: "${f.find_this}"\n  Should instead say: ${f.replace_with}`)
        .join("\n\n");
      const retryMessage = `PHRASES STILL PRESENT (must not appear anywhere in the document):\n\n${retryList}\n\nCURRENT DRAFT:\n\n${correctedMarkdown}`;
      try {
        const retryResponse = await callOpenRouter(RETRY_SYSTEM_PROMPT, retryMessage);
        const retryChangesMatch = retryResponse.match(/<!--\s*CHANGES:([\s\S]*?)-->/i);
        const retryChangeLog = retryChangesMatch ? retryChangesMatch[1].trim() : "(no change log in retry response)";
        correctedMarkdown = retryResponse.replace(/<!--\s*CHANGES:[\s\S]*?-->/i, "").trim();
        changeLog += `\n\nRETRY PASS (targeted at phrases the independent check found still present): ${retryChangeLog}`;
        stillPresent = findStillPresentFixes(correctedMarkdown, blog.fixes);
      } catch (err) {
        console.log(`Retry call failed (${err.message}), proceeding with the pre-retry version, still-present issues noted below.`);
      }
    }
    if (stillPresent.length > 0) {
      console.log(`WARNING: ${stillPresent.length} flagged phrase(s) still present after retry, needs manual attention: ${stillPresent.map((f) => f.issue).join("; ")}`);
    } else {
      console.log("Independent check: no flagged phrases found still present.");
    }

    const outPath = `corrections-review/${blog.sanityDocId}.md`;
    const verificationBanner =
      stillPresent.length > 0
        ? `\n*** VERIFICATION WARNING (independent check, not the model's self-report): ***\n*** The following flagged phrase(s) are STILL PRESENT verbatim below, despite being ***\n*** claimed as fixed. Do not send this to Apply until these are manually corrected: ***\n${stillPresent.map((f) => `***   - ${f.issue}: "${f.find_this}"`).join("\n")}\n`
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
