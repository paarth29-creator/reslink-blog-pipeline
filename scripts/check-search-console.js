// scripts/check-search-console.js
//
// Standalone, read-only check: fetches Search Console data (query + page
// performance) for two windows, last 7 days and last 28 days, computes
// which queries are "Rising" per the blog drafting playbook's Part 10
// definition (7-day impressions are a disproportionate share of the
// 28-day total, or the query wasn't present in the 28-day pull at all),
// and prints Rising queries first, followed by both full windows.
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

async function fetchWindow(siteUrl, label, daysBack) {
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
      `No rows returned for ${label}. Either there's genuinely no data in this window yet, or GSC_SITE_URL doesn't exactly match the verified property. Check the property selector inside Search Console itself: a domain property needs "sc-domain:reslink.org", a URL-prefix property needs the full "https://reslink.org/" with trailing slash.`
    );
  }

  return rows;
}

function printRows(rows, label) {
  if (!rows.length) return;
  console.log(`\n${rows.length} row(s) for ${label}, sorted as returned by the API:\n`);
  for (const row of rows) {
    const [query, page] = row.keys;
    console.log(
      `"${query}" -> ${page}\n  clicks: ${row.clicks}, impressions: ${row.impressions}, CTR: ${(row.ctr * 100).toFixed(1)}%, avg position: ${row.position.toFixed(1)}\n`
    );
  }
}

// A query+page pair is unique within a single query+page dimension pull,
// so this key is safe to use for matching a row across the two windows.
function rowKey(row) {
  const [query, page] = row.keys;
  return `${query}\u0000${page}`;
}

// Playbook Part 10: a query is "Rising" if its 7-day impressions are a
// disproportionate share of its 28-day total, or if it's new and doesn't
// appear in the 28-day pull at all. Flat, even distribution over 28 days
// would put 7/28 = 25% of impressions in the last week, so 0.50 here means
// "at least double what flat distribution would predict." This threshold
// is a starting guess, not calibrated against real data yet, adjust if it
// turns out too noisy or too quiet in practice.
const RISING_SHARE_THRESHOLD = 0.5;

function findRisingQueries(sevenDayRows, twentyEightDayRows) {
  const twentyEightDayMap = new Map();
  for (const row of twentyEightDayRows) {
    twentyEightDayMap.set(rowKey(row), row.impressions);
  }

  const rising = [];
  for (const row of sevenDayRows) {
    const [query, page] = row.keys;
    const twentyEightDayImpressions = twentyEightDayMap.get(rowKey(row));

    if (twentyEightDayImpressions === undefined) {
      // Present in the 7-day pull but no matching row in the 28-day pull.
      // The 7-day window sits inside the 28-day window so this should be
      // rare, but can happen at API row-limit or tie-ordering boundaries.
      // Flag it rather than drop it, per Part 10: small volume still counts.
      rising.push({
        query,
        page,
        sevenDay: row.impressions,
        twentyEightDay: null,
        reason: "not found in the 28-day pull",
      });
      continue;
    }

    const share = row.impressions / twentyEightDayImpressions;
    if (share >= RISING_SHARE_THRESHOLD) {
      rising.push({
        query,
        page,
        sevenDay: row.impressions,
        twentyEightDay: twentyEightDayImpressions,
        reason: `${(share * 100).toFixed(0)}% of 28-day impressions landed in the last 7 days`,
      });
    }
  }

  rising.sort((a, b) => b.sevenDay - a.sevenDay);
  return rising;
}

function printRising(rising) {
  console.log(
    `\n=== RISING QUERIES (7-day share >= ${(RISING_SHARE_THRESHOLD * 100).toFixed(0)}% of 28-day total, or new) ===\n`
  );
  if (!rising.length) {
    console.log("None this cycle.\n");
    return;
  }
  for (const r of rising) {
    const twentyEightDayLabel = r.twentyEightDay === null ? "n/a" : r.twentyEightDay;
    console.log(
      `"${r.query}" -> ${r.page}\n  7-day impressions: ${r.sevenDay}, 28-day impressions: ${twentyEightDayLabel} (${r.reason})\n`
    );
  }
}

async function main() {
  const siteUrl = requireEnv("GSC_SITE_URL");

  const sevenDayRows = await fetchWindow(siteUrl, "last 7 days", 7);
  const twentyEightDayRows = await fetchWindow(siteUrl, "last 28 days", 28);

  const rising = findRisingQueries(sevenDayRows, twentyEightDayRows);
  printRising(rising);

  printRows(sevenDayRows, "last 7 days");
  printRows(twentyEightDayRows, "last 28 days");
}

main().catch((err) => {
  console.error("Search Console check failed:", err.message);
  process.exit(1);
});
