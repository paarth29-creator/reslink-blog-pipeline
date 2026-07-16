// scripts/blog-corrections-apply.js
//
// Step 2 of 2. Reads the ALREADY-REVIEWED files from corrections-review/
// (written by blog-corrections-generate.js, and readable/editable by a
// human before this ever runs) and patches each corresponding live
// Sanity doc's "content" field only. Nothing else on the document
// (title, slug, seoTitle, category, publishedAt, etc.) is touched.
//
// Deliberately requires the review file to already exist, if
// blog-corrections-generate.js hasn't been run (or a specific file was
// deleted because that blog shouldn't be touched), this script simply
// has nothing to apply for that doc and skips it, it never regenerates
// content itself.

import fs from "fs/promises";
import { createClient } from "@sanity/client";
import { BLOG_CORRECTIONS } from "./blog-corrections-data.js";
import { markdownToPortableTextRestoringSpecialBlocks } from "./portable-text-markdown.js";
import { markdownToPortableText } from "@portabletext/markdown";

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

async function main() {
  for (const blog of BLOG_CORRECTIONS) {
    const reviewPath = `corrections-review/${blog.sanityDocId}.md`;
    console.log(`\n=== ${blog.title} (${blog.sanityDocId}) ===`);

    let fileContent;
    try {
      fileContent = await fs.readFile(reviewPath, "utf8");
    } catch {
      console.log(`No review file at ${reviewPath}, nothing to apply, skipping.`);
      continue;
    }

    // Strip the review-only header comment before converting, everything
    // after the closing --> is the actual corrected post content.
    const bodyMarkdown = fileContent.replace(/^<!--[\s\S]*?-->\s*/, "").trim();
    if (!bodyMarkdown) {
      console.log("Review file is empty after stripping the header comment, skipping.");
      continue;
    }

    // Need the doc's real, current promo image block to restore exactly,
    // fetched fresh rather than assumed, in case it changed since generate ran.
    let doc;
    try {
      doc = await sanity.getDocument(blog.sanityDocId);
    } catch (err) {
      console.log(`Could not fetch this doc to confirm it still exists (${err.message}), skipping.`);
      continue;
    }
    if (!doc) {
      console.log("Doc not found (may have been deleted since review was generated), skipping.");
      continue;
    }
    const existingImageBlock = (doc.content || []).find((b) => b._type === "image") || null;

    const newContentBlocks = markdownToPortableTextRestoringSpecialBlocks(bodyMarkdown, markdownToPortableText, existingImageBlock);

    try {
      await sanity.patch(blog.sanityDocId).set({ content: newContentBlocks }).commit();
      console.log(`Patched successfully, content field only, ${newContentBlocks.length} blocks.`);
    } catch (err) {
      console.log(`Patch failed (${err.message}), this doc was NOT changed.`);
    }
  }

  console.log("\nDone. Spot-check a few of the live URLs directly.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
