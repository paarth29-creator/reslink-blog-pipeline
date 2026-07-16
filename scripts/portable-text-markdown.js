// scripts/portable-text-markdown.js
//
// The recurring pipeline only ever goes Markdown -> Portable Text
// (@portabletext/markdown's markdownToPortableText, already used
// elsewhere). Correcting an ALREADY-LIVE post needs the reverse first:
// Portable Text -> Markdown, so an LLM can read and edit it as text,
// then Markdown -> Portable Text again to write it back. This file is
// only used by the one-off correction scripts, never imported by
// value-topic-orchestrator.js or orchestrator.js.
//
// Deliberately a small hand-written serializer, not a general-purpose
// library, because this pipeline's own Portable Text output has a known,
// constrained shape (it's the same converter that produced these posts
// in the first place): block styles normal/h1-h4/blockquote, bullet
// listItem, strong/em marks, link markDefs, one custom "callout" type,
// one custom "image" type. A general serializer would handle shapes this
// pipeline never actually produces; this handles exactly what it does.

// ---- Portable Text -> Markdown -------------------------------------------

// Image blocks carry no text an LLM could accidentally edit, but their
// exact position in the document matters (this pipeline places the promo
// creative deliberately, before the last 3 body paragraphs). Rather than
// re-run that placement logic during a correction pass (which could move
// it), the image is replaced with an inert text marker at its exact
// original position, and swapped back for the real block afterward,
// completely unchanged, wherever that marker ends up.
const IMAGE_MARKER = "[[PROMO_IMAGE_MARKER_DO_NOT_REMOVE_OR_EDIT_THIS_LINE]]";

function renderChildrenToMarkdown(children, markDefs) {
  const defsByKey = {};
  for (const def of markDefs || []) defsByKey[def._key] = def;

  return (children || [])
    .map((child) => {
      let text = child.text || "";
      const marks = child.marks || [];
      // Link marks reference a markDef by key, anything else (strong, em)
      // is a plain formatting mark, applied directly.
      const linkKey = marks.find((m) => defsByKey[m] && defsByKey[m]._type === "link");
      if (marks.includes("strong")) text = `**${text}**`;
      if (marks.includes("em")) text = `*${text}*`;
      if (linkKey) {
        const href = defsByKey[linkKey].href || "";
        text = `[${text}](${href})`;
      }
      return text;
    })
    .join("");
}

export function portableTextToMarkdown(blocks) {
  const lines = [];
  for (const block of blocks || []) {
    if (block._type === "image") {
      lines.push(IMAGE_MARKER);
      lines.push("");
      continue;
    }
    if (block._type === "callout") {
      // Original pre-conversion shape was a bare "TL;DR: ..." paragraph,
      // rendering it back that way lets the same TL;DR-detection logic
      // used elsewhere in this pipeline find and reconvert it later.
      lines.push(block.text || "");
      lines.push("");
      continue;
    }
    if (block._type !== "block") continue; // unknown block type, skip rather than guess

    const text = renderChildrenToMarkdown(block.children, block.markDefs);
    const style = block.style || "normal";
    const prefix = block.listItem === "bullet" ? "- " : block.listItem === "number" ? "1. " : "";

    if (style === "h1") lines.push(`# ${text}`);
    else if (style === "h2") lines.push(`## ${text}`);
    else if (style === "h3") lines.push(`### ${text}`);
    else if (style === "h4") lines.push(`#### ${text}`);
    else if (style === "blockquote") lines.push(`> ${text}`);
    else lines.push(`${prefix}${text}`);
    lines.push("");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---- Markdown -> Portable Text --------------------------------------------
//
// Reuses @portabletext/markdown's own converter for the bulk of the
// work (same one the recurring pipeline already trusts), then restores
// the callout and image blocks this pipeline's schema actually needs,
// same two-step pattern already used in value-topic-orchestrator.js,
// duplicated here rather than imported since that logic lives inside
// that file's main() rather than being exported.

function randomKey() {
  return Array.from({ length: 12 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

// promoImageBlock: pass the ORIGINAL image block object (unchanged) so
// it's restored exactly as it was, not regenerated.
export function markdownToPortableTextRestoringSpecialBlocks(markdown, markdownToPortableTextFn, promoImageBlock) {
  let contentBlocks = markdownToPortableTextFn(markdown);

  // Restore the TL;DR callout, same detection already used in the
  // recurring pipeline: first block whose text starts with "TL;DR".
  const tldrIndex = contentBlocks.findIndex((block) =>
    (block.children || []).some((child) => /^TL\s*;?\s*DR:?/i.test(child.text || ""))
  );
  if (tldrIndex !== -1) {
    const tldrText = (contentBlocks[tldrIndex].children || []).map((c) => c.text).join("");
    contentBlocks[tldrIndex] = { _type: "callout", _key: randomKey(), type: "info", text: tldrText };
  }

  // Restore the promo image at wherever the marker text landed, exact
  // original block, not regenerated, so a correction pass can never
  // accidentally change its asset, alt text, or link.
  if (promoImageBlock) {
    const markerIndex = contentBlocks.findIndex((block) =>
      (block.children || []).some((child) => (child.text || "").includes("PROMO_IMAGE_MARKER_DO_NOT_REMOVE"))
    );
    if (markerIndex !== -1) {
      contentBlocks.splice(markerIndex, 1, { ...promoImageBlock, _key: randomKey() });
    }
  }

  return contentBlocks;
}

export { IMAGE_MARKER };
