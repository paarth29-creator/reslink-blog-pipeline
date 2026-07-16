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
      const body = await res.text();
      throw new Error(`OpenRouter error ${res.status}: ${body}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error(`OpenRouter returned no content: ${JSON.stringify(data)}`);
    return content;
  } finally {
    clearTimeout(timeout);
  }
}

const CORRECTION_SYSTEM_PROMPT = `You apply a specific, pre-determined list of corrections to a blog post. You did not write this post and you are not fact-checking it yourself, someone else already did that work and gave you the exact list of what to fix.

ABSOLUTE RULES:
1. Apply ONLY the corrections explicitly listed. Do not fix, improve, or reword anything not on the list, even if you notice something else that looks wrong.
2. Each correction has a "find_this" (the risky pattern, sometimes an exact phrase, sometimes a description like "Any claim that...") and a "replace_with" (the exact corrected wording to use). Locate the matching content in the draft using judgment where find_this is a description, then replace it with the given replace_with text, adapting only the minimum grammar needed for it to read naturally in context (tense, connecting words). Do not add anything beyond what replace_with already says.
3. If a listed correction's pattern genuinely does not appear anywhere in this draft, skip it, do not force a change. Note this in your change log.
4. Never add a new fact, figure, or claim beyond what a replace_with explicitly provides.
5. Do not touch the [[PROMO_IMAGE_MARKER_DO_NOT_REMOVE_OR_EDIT_THIS_LINE]] line if present, leave it exactly as-is, do not remove it, move it, or edit its text.
6. Do not change headings, structure, or anything else not covered by the listed corrections.

Output the complete corrected draft, then a single HTML comment at the very end:
<!-- CHANGES: [one line per correction actually applied, or "not found, skipped" for any that weren't] -->`;

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
    const changeLog = changesMatch ? changesMatch[1].trim() : "(no change log found in response)";
    const correctedMarkdown = response.replace(/<!--\s*CHANGES:[\s\S]*?-->/i, "").trim();

    const outPath = `corrections-review/${blog.sanityDocId}.md`;
    const fileContent = `<!--
REVIEW FILE, not live. Generated by blog-corrections-generate.js.
Original doc: ${blog.sanityDocId}
Title: ${blog.title}
Word count: original ${originalMarkdown.split(/\s+/).length} -> corrected ${correctedMarkdown.split(/\s+/).length}

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
