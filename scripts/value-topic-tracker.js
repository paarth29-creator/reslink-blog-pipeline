// scripts/value-topic-tracker.js
//
// Real Sanity-based tracking (querying published posts directly, same
// pattern as fetchPublishedTitles in context.js) was explicitly deferred.
// But "defer the implementation" isn't the same as "no tracking at all":
// GitHub Actions runs are stateless, nothing persists between runs
// without SOME mechanism, and 20 topics at 7/day means every topic gets
// picked within 3 days if nothing tracks what already ran.
//
// This is a deliberately minimal stopgap: a JSON file, committed back to
// the repo by the GitHub Action after each run (same mv/git-push pattern
// already used for every other file in this project, nothing new to
// learn). Swap this whole file out once real Sanity-based tracking is
// built, nothing else in this pipeline depends on its internals beyond
// the three functions exported here.

import fs from "fs/promises";

const TRACKER_PATH = "data/value-topics-published.json";

async function readTrackerFile() {
  try {
    const raw = await fs.readFile(TRACKER_PATH, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return { published: [] }; // first run ever, file doesn't exist yet
    throw new Error(`${TRACKER_PATH} exists but isn't valid JSON (${err.message}). Fix or delete it manually before rerunning.`);
  }
}

async function writeTrackerFile(data) {
  await fs.mkdir("data", { recursive: true });
  await fs.writeFile(TRACKER_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");
}

// Returns the first topic (in list order) not yet marked published.
// Deliberately simple and deterministic, not random, so a failed run is
// easy to reason about (it'll just retry the same topic next time,
// nothing subtle about which one gets picked).
// Returns the first topic (in list order) not yet marked published, or
// null if every topic in the list is done. Returning null rather than
// throwing is deliberate: an exhausted list isn't an error condition by
// itself, whether that should mean "fail loudly so I notice" or "stop
// quietly until more topics are added" is a decision the caller makes,
// not this function. As of 2026-07-16, the orchestrator treats null as
// a clean, non-failing exit.
export async function pickNextUnpublishedTopic(topics) {
  const tracker = await readTrackerFile();
  const publishedIds = new Set(tracker.published.map((p) => p.id));
  const next = topics.find((t) => !publishedIds.has(t.id));
  return next || null;
}

export async function markTopicPublished(topic, { sanityDocId, title } = {}) {
  const tracker = await readTrackerFile();
  tracker.published.push({
    id: topic.id,
    keyword: topic.keyword,
    title: title || null,
    sanityDocId: sanityDocId || null,
    publishedAt: new Date().toISOString(),
  });
  await writeTrackerFile(tracker);
}

export async function getPublishedCount() {
  const tracker = await readTrackerFile();
  return tracker.published.length;
}
