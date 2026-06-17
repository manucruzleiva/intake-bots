// Cobblemon Picnic — Discord channel intake (runs in this PUBLIC repo for free, frequent polling).
//
// Polls the #bugs and #features Discord channels and opens a GitHub issue in the (private) mod repo
// for each NEW message. Also maintains reporters.json, which the mod's wiki reads to build its
// community credits page. State + reporters live here; issues are created cross-repo via a PAT.
//
// Env:
//   DISCORD_TOKEN        bot token (read access to the two channels)
//   MOD_REPO_TOKEN       PAT with Issues: write on MOD_REPO
//   MOD_REPO             "owner/repo" to file issues in (e.g. manucruzleiva/cobblemon-picnic)
//   BUG_CHANNEL_ID, FEATURE_CHANNEL_ID
//   STATE_PATH / REPORTERS_PATH  optional overrides

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const DISCORD = "https://discord.com/api/v10";
const GH = "https://api.github.com";
const { DISCORD_TOKEN, MOD_REPO_TOKEN, MOD_REPO, BUG_CHANNEL_ID, FEATURE_CHANNEL_ID } = process.env;
const STATE_PATH = process.env.STATE_PATH || "intake-state.json";
const REPORTERS_PATH = process.env.REPORTERS_PATH || "reporters.json";

const CHANNELS = [
  { id: BUG_CHANNEL_ID, kind: "bug", prefix: "[Bug]", labels: ["bug", "discord"] },
  { id: FEATURE_CHANNEL_ID, kind: "feature", prefix: "[Feature]", labels: ["enhancement", "discord"] },
].filter((c) => c.id);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback);

async function discord(path, init) {
  const res = await fetch(`${DISCORD}${path}`, {
    ...init,
    headers: { Authorization: `Bot ${DISCORD_TOKEN}`, ...(init?.headers || {}) },
  });
  if (!res.ok) throw new Error(`Discord ${path}: HTTP ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function createIssue(title, body, labels) {
  const res = await fetch(`${GH}/repos/${MOD_REPO}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MOD_REPO_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "cobblemon-picnic-intake",
    },
    body: JSON.stringify({ title, body, labels }),
  });
  if (!res.ok) throw new Error(`GitHub issue: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()).html_url;
}

// Fetch every message after `afterId`, oldest first, paginating in case there are many.
async function fetchNewMessages(channelId, afterId) {
  const collected = [];
  let cursor = afterId;
  for (let page = 0; page < 20; page++) {
    const batch = await discord(`/channels/${channelId}/messages?after=${cursor}&limit=100`);
    if (!batch.length) break;
    collected.push(...batch);
    const newest = batch.reduce((a, b) => (BigInt(b.id) > BigInt(a) ? b.id : a), cursor);
    if (batch.length < 100 || newest === cursor) break;
    cursor = newest;
  }
  const seen = new Set();
  return collected
    .filter((m) => (seen.has(m.id) ? false : seen.add(m.id)))
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

function titleFrom(prefix, content) {
  const firstLine = (content.split("\n")[0] || "").trim();
  const short = firstLine.length > 80 ? firstLine.slice(0, 77) + "…" : firstLine;
  return `${prefix} ${short || "(no text)"}`;
}

async function run() {
  if (!DISCORD_TOKEN || !MOD_REPO_TOKEN || !MOD_REPO) throw new Error("missing required env vars");
  if (!CHANNELS.length) throw new Error("set BUG_CHANNEL_ID and/or FEATURE_CHANNEL_ID");

  const state = readJson(STATE_PATH, {});
  const reporters = readJson(REPORTERS_PATH, {});
  let changed = false;

  for (const ch of CHANNELS) {
    const { guild_id } = await discord(`/channels/${ch.id}`);
    const last = state[ch.kind]?.lastId || null;

    if (!last) {
      const latest = await discord(`/channels/${ch.id}/messages?limit=1`);
      state[ch.kind] = { lastId: latest[0]?.id || "0" };
      changed = true;
      console.log(`[${ch.kind}] initialized at ${state[ch.kind].lastId} (no backfill)`);
      continue;
    }

    const messages = (await fetchNewMessages(ch.id, last)).filter((m) => !m.author?.bot && m.content?.trim());
    for (const m of messages) {
      const content = m.content.trim();
      const link = `https://discord.com/channels/${guild_id}/${ch.id}/${m.id}`;
      const body = [
        content,
        "",
        "---",
        `**Reported by:** ${m.author.username} (\`${m.author.id}\`) in Discord`,
        `**Message:** ${link}`,
        `**Posted:** ${m.timestamp}`,
        `*Imported automatically from the #${ch.kind} channel.*`,
      ].join("\n");

      const url = await createIssue(titleFrom(ch.prefix, content), body, ch.labels);
      console.log(`[${ch.kind}] ${m.id} -> ${url}`);

      const r = (reporters[m.author.username] ||= { count: 0, bugs: 0, features: 0 });
      r.count += 1;
      r[ch.kind === "bug" ? "bugs" : "features"] += 1;

      try {
        await discord(`/channels/${ch.id}/messages/${m.id}/reactions/${encodeURIComponent("✅")}/@me`, { method: "PUT" });
      } catch { /* ignore missing permission */ }

      state[ch.kind] = { lastId: m.id };
      changed = true;
      await sleep(1200); // stay clear of GitHub's secondary rate limits
    }
    console.log(`[${ch.kind}] imported ${messages.length} message(s)`);
  }

  if (changed) {
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
    writeFileSync(REPORTERS_PATH, JSON.stringify(reporters, null, 2) + "\n");
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
