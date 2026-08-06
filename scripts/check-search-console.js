// scripts/check-search-console.js
//
// Standalone, read-only check: fetches Search Console data (query + page
// performance) for two windows, last 7 days and last 28 days, and prints
// both to the log. Fetching both in the same run is required for the
// Rising-query check in the blog drafting playbook (Part 10), which flags
// a query when its 7-day impressions are a disproportionate share of its
// 28-day total, that comparison needs both windows at once.
//
// This is NOT wired into the publish pipeline and does not touch Sanity,
// OpenRouter, or anything else. Purely for seeing real numbers before
// deciding what the self-analysis / feedback loop phase should actually
// do with them, see next_phase_focus in the project handoff notes.
//
// Run via the "Check Search Console" GitHub Action (manual trigger only),
// or locally with: node --env-file=.env scripts/check-search-console.js
// (local use requires GSC_SERVICE_ACCOUNT_KEY and GSC_SITE_URL in .env,
// the JSON key must be on a single line if run locally).
import { fetchSearchConsoleData } from "./context.js";

function requireEnv(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return val;
}

function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

// Search Console data typically lags 2-3 days behind real-time, so every
// window ends 3 days ago rather than today, to avoid an artificially thin
// tail from days that haven't fully settled yet.
function getWindow(daysBack) {
  const end = new Date();
  end.setDate(end.getDate() - 3);
  const start = new Date(end);
  start.setDate(start.getDate() - daysBack);
  return { startDate: formatDate(start), endDate: formatDate(end) };
}

async function fetchAndPrint(siteUrl, label, daysBack) {
  const { startDate, endDate } = getWindow(daysBack);
  console.log(`\nFetching Search Console data for ${siteUrl}, ${label} (${startDate} to ${endDate})...`);

  const rows = await fetchSearchConsoleData({
    siteUrl,
    startDate,
    endDate,
    dimensions: ["query", "page"],
    rowLimit: 25000,
  });

  if (!rows.length) {
    console.log(
      `No rows returned. Either there's genuinely no data in this window yet, or GSC_SITE_URL doesn't exactly match the verified property. Check the property selector inside Search Console itself: a domain property needs "sc-domain:reslink.org", a URL-prefix property needs the full "https://reslink.org/" with trailing slash.`
    );
    return;
  }

  console.log(`\n${rows.length} row(s), sorted as returned by the API:\n`);
  for (const row of rows) {
    const [query, page] = row.keys;
    console.log(
      `"${query}" -> ${page}\n  clicks: ${row.clicks}, impressions: ${row.impressions}, CTR: ${(row.ctr * 100).toFixed(1)}%, avg position: ${row.position.toFixed(1)}\n`
    );
  }
}

async function main() {
  const siteUrl = requireEnv("GSC_SITE_URL");

  await fetchAndPrint(siteUrl, "last 7 days", 7);
  await fetchAndPrint(siteUrl, "last 28 days", 28);
}

main().catch((err) => {
  console.error("Search Console check failed:", err.message);
  process.exit(1);
});
