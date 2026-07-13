// scripts/lint.js
//
// The quality gate. Runs BEFORE anything touches Sanity.
// If this returns pass: false, the orchestrator stops and alerts you
// instead of publishing.
//
// Edit CONFIG below to match your own rules (word count, required
// keywords, etc). Nothing here needs an API key, it's pure text checks.

const CONFIG = {
  // Below this, something is genuinely broken, not just short, a 74-word
  // non-answer, a reasoning trace, empty sections. Real block.
  hardMinWords: 800,
  // The actual goal. Missing this doesn't block publish, a complete,
  // well-structured post at 1800 words is real and usable, just gets a
  // warning noted instead of being thrown away.
  targetWords: 2000,
  maxWords: 4000,
  // Add your own keyword clusters here if you want the lint to check for
  // at least one match per cluster. Leave empty to skip this check.
  requiredKeywordClusters: [
    // ["solar design software", "solar plant design", "PV design software"],
  ],
  // Any of these characters/strings fail the check if found.
  bannedStrings: ["\u2014"], // em-dash
  // Matches content-writer.md's NEVER USE list. Prompt-level rules get
  // violated by free models regularly enough tonight that this needed a
  // real code backstop, not just an instruction. Add a domain here any
  // time a new low-credibility source shows up in a published draft.
  bannedSourceDomains: [
    "surgepv.com",
    "enjoyelec.com",
    "ratedpower.com",
    "amperfied.in",
    "pvprosolar.com",
    "arka360.com",
    "taiyangnews.info",
  ],
};

function countWords(markdown) {
  const stripped = markdown
    .replace(/```[\s\S]*?```/g, " ") // code blocks
    .replace(/`[^`]*`/g, " ") // inline code
    .replace(/!\[.*?\]\(.*?\)/g, " ") // images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links -> link text
    .replace(/[#*_>-]/g, " "); // md syntax chars
  return stripped.split(/\s+/).filter(Boolean).length;
}

function extractLinks(markdown) {
  const links = [];
  const re = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let match;
  while ((match = re.exec(markdown)) !== null) {
    links.push(match[2]);
  }
  return links;
}

async function checkLinks(links) {
  const broken = [];
  await Promise.all(
    links.map(async (url) => {
      try {
        const res = await fetch(url, { method: "HEAD", redirect: "follow" });
        if (!res.ok) broken.push(`${url} (status ${res.status})`);
      } catch (err) {
        broken.push(`${url} (unreachable: ${err.message})`);
      }
    })
  );
  return broken;
}

export async function runLint(markdown) {
  const errors = [];
  const warnings = [];

  // 1. Word count: hard block only below hardMinWords (genuinely broken
  // output), a warning, not a block, for anything between that floor and
  // the real target. A complete post that's merely shorter than ideal
  // still gets published, it's not the same problem as a 74-word non-answer.
  const wordCount = countWords(markdown);
  if (wordCount < CONFIG.hardMinWords) {
    errors.push(`Too short: ${wordCount} words (hard minimum ${CONFIG.hardMinWords}, likely broken/incomplete output)`);
  } else if (wordCount < CONFIG.targetWords) {
    warnings.push(`Under target: ${wordCount} words (aiming for ${CONFIG.targetWords}+), publishing anyway, this is a real, usable post, just shorter than ideal`);
  }
  if (wordCount > CONFIG.maxWords) {
    warnings.push(`Longer than usual: ${wordCount} words (max ${CONFIG.maxWords})`);
  }

  // 2. Banned characters/strings (e.g. em-dash)
  for (const bad of CONFIG.bannedStrings) {
    if (markdown.includes(bad)) {
      errors.push(`Contains banned character/string: "${bad}"`);
    }
  }

  // 3. Structure: needs at least one H1 and one H2
  if (!/^#\s+.+/m.test(markdown)) errors.push("No H1 title found");
  if (!/^##\s+.+/m.test(markdown)) errors.push("No H2 subheading found");

  // 4. Keyword clusters (optional, only runs if you filled in CONFIG above)
  for (const cluster of CONFIG.requiredKeywordClusters) {
    const lower = markdown.toLowerCase();
    const hit = cluster.some((kw) => lower.includes(kw.toLowerCase()));
    if (!hit) {
      errors.push(`No keyword from cluster found: [${cluster.join(", ")}]`);
    }
  }

  // 4b. Banned source domains. Code backstop for content-writer.md's
  // NEVER USE list, prompt-only rules get violated by free models
  // regularly, this catches it before publish instead of after.
  const allLinks = markdown.match(/https?:\/\/[^\s)]+/g) || [];
  const bannedHits = allLinks.filter((url) =>
    CONFIG.bannedSourceDomains.some((domain) => url.toLowerCase().includes(domain))
  );
  if (bannedHits.length) {
    errors.push(`Contains link(s) to a banned source: ${[...new Set(bannedHits)].join(", ")}`);
  }

  // 5. Broken links
  const links = extractLinks(markdown);
  const broken = await checkLinks(links);
  if (broken.length) {
    errors.push(`Broken links: ${broken.join("; ")}`);
  }

  return {
    pass: errors.length === 0,
    errors,
    warnings,
    wordCount,
  };
}

// Allows `npm run test-lint` against a local file for a quick manual check
if (import.meta.url === `file://${process.argv[1]}`) {
  const fs = await import("fs/promises");
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: node scripts/lint.js path/to/draft.md");
    process.exit(1);
  }
  const markdown = await fs.readFile(path, "utf8");
  const result = await runLint(markdown);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.pass ? 0 : 1);
}
