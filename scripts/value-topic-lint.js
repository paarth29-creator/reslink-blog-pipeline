// scripts/value-topic-lint.js
//
// Duplicated from lint.js rather than imported, same tradeoff already
// made elsewhere in this pipeline (isolation over DRY). The one real
// behavior change: checkLinks() here accepts a list of URLs already
// proven real via Jina in THIS run (actual content fetched, not just an
// HTTP status check) and skips re-checking those specifically.
//
// Why: by the time a draft reaches lint, restrictSourcesToVerified() and
// restrictAllLinksToVerified() (both in context.js, unmodified) have
// already stripped every link that wasn't Jina-fetched. So every
// surviving link already passed a STRICTER check than a HEAD/GET request
// can offer, its actual content was read. Re-checking with a plain fetch
// is redundant when it passes, and actively wrong when a real source
// blocks bot-style requests (confirmed case: iea.org, which Jina reached
// fine but a plain HEAD/GET got a 403 from). Everything else in this
// file is unchanged from lint.js, same word count floor, same banned
// strings/domains, same structure checks.

const CONFIG = {
  hardMinWords: 2000,
  targetWords: 2200,
  maxWords: 4000,
  requiredKeywordClusters: [],
  bannedStrings: ["\u2014"], // em-dash
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
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[.*?\]\(.*?\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#*_>-]/g, " ");
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

function normalizeUrl(url) {
  try {
    return url.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
  } catch {
    return url;
  }
}

async function checkLinks(links, alreadyVerifiedUrls = []) {
  const verifiedSet = new Set(alreadyVerifiedUrls.map(normalizeUrl));
  const toCheck = links.filter((url) => !verifiedSet.has(normalizeUrl(url)));
  const skippedCount = links.length - toCheck.length;
  if (skippedCount) {
    console.log(`Skipping live re-check for ${skippedCount} link(s) already Jina-verified this run.`);
  }

  const broken = [];
  const headers = {
    "User-Agent": "Mozilla/5.0 (compatible; ReslinkBlogLinkChecker/1.0; +https://reslink.org)",
  };
  await Promise.all(
    toCheck.map(async (url) => {
      try {
        let res = await fetch(url, { method: "HEAD", redirect: "follow", headers });
        if (!res.ok) {
          res = await fetch(url, { method: "GET", redirect: "follow", headers });
        }
        if (!res.ok) broken.push(`${url} (status ${res.status})`);
      } catch (err) {
        broken.push(`${url} (unreachable: ${err.message})`);
      }
    })
  );
  return broken;
}

export async function runLintForValueTopics(markdown, verifiedUrls = []) {
  const errors = [];
  const warnings = [];

  const wordCount = countWords(markdown);
  if (wordCount < CONFIG.hardMinWords) {
    errors.push(`Too short: ${wordCount} words (hard minimum ${CONFIG.hardMinWords})`);
  } else if (wordCount < CONFIG.targetWords) {
    warnings.push(`Under stretch target: ${wordCount} words (aiming for ${CONFIG.targetWords}+), publishing anyway.`);
  }
  if (wordCount > CONFIG.maxWords) {
    warnings.push(`Longer than usual: ${wordCount} words (max ${CONFIG.maxWords})`);
  }

  for (const bad of CONFIG.bannedStrings) {
    if (markdown.includes(bad)) errors.push(`Contains banned character/string: "${bad}"`);
  }

  if (!/^#\s+.+/m.test(markdown)) errors.push("No H1 title found");
  if (!/^##\s+.+/m.test(markdown)) errors.push("No H2 subheading found");

  for (const cluster of CONFIG.requiredKeywordClusters) {
    const lower = markdown.toLowerCase();
    const hit = cluster.some((kw) => lower.includes(kw.toLowerCase()));
    if (!hit) errors.push(`No keyword from cluster found: [${cluster.join(", ")}]`);
  }

  const allLinks = markdown.match(/https?:\/\/[^\s)]+/g) || [];
  const bannedHits = allLinks.filter((url) =>
    CONFIG.bannedSourceDomains.some((domain) => url.toLowerCase().includes(domain))
  );
  if (bannedHits.length) {
    errors.push(`Contains link(s) to a banned source: ${[...new Set(bannedHits)].join(", ")}`);
  }

  const links = extractLinks(markdown);
  const broken = await checkLinks(links, verifiedUrls);
  if (broken.length) {
    errors.push(`Broken links: ${broken.join("; ")}`);
  }

  return { pass: errors.length === 0, errors, warnings, wordCount };
}
