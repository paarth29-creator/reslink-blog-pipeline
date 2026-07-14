// scripts/check-search-console.js
//
// Standalone, read-only check: fetches the last week of Search Console
// data (query + page performance) and prints it to the log. This is NOT
// wired into the publish pipeline and does not touch Sanity, OpenRouter,
// or anything else. Purely for seeing real numbers before deciding what
// the self-analysis / feedback loop phase should actually do with them,
// see next_phase_focus in the project handoff notes.
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

async function main() {
  const siteUrl = requireEnv("GSC_SITE_URL");

  // Search Console data typically lags 2-3 days behind real-time, so this
  // window ends 3 days ago rather than today, to avoid an artificially
  // thin tail from days that haven't fully settled yet.
  const end = new Date();
  end.setDate(end.getDate() - 3);
  const start = new Date(end);
  start.setDate(start.getDate() - 7);

  const startDate = formatDate(start);
  const endDate = formatDate(end);

  console.log(`Fetching Search Console data for ${siteUrl}, ${startDate} to ${endDate}...`);

  const rows = await fetchSearchConsoleData({
    siteUrl,
    startDate,
    endDate,
    dimensions: ["query", "page"],
    rowLimit: 25,
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

main().catch((err) => {
  console.error("Search Console check failed:", err.message);
  process.exit(1);
});
