// Cobblemon Picnic — Discord channel intake (runs in this PUBLIC repo for free, frequent polling).
//
// Polls the #bug-report and #features-request channels and opens a GitHub issue in the (private) mod
// repo for each NEW report. Supports both forum channels (type 15/16 — each report is a forum post /
// thread) and plain text channels (type 0 — each report is a message). Also maintains reporters.json,
// which the mod's wiki reads to build its community credits page.
//
// Env:
//   DISCORD_TOKEN        bot token (read access to the two channels)
//   MOD_REPO_TOKEN       PAT with Issues: write on MOD_REPO
//   MOD_REPO             "owner/repo" to file issues in
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
const gt = (a, b) => BigInt(a) > BigInt(b); // snowflake compare

async function discord(path, init) {
  const res = await fetch(`${DISCORD}${path}`, {
    ...init,
    headers: { Authorization: `Bot ${DISCORD_TOKEN}`, ...(init?.headers || {}) },
  });
  if (!res.ok) throw new Error(`Discord ${path}: HTTP ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}
const discordSafe = (p, i) => discord(p, i).catch(() => null);

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

const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// --- Forum channels (type 15/16): each report is a thread/post -------------------------------
async function listForumPosts(channel, guildId) {
  const byId = new Map();
  const active = await discordSafe(`/guilds/${guildId}/threads/active`);
  for (const t of active?.threads || []) if (t.parent_id === channel.id) byId.set(t.id, t);

  let before = null;
  for (let i = 0; i < 10; i++) {
    const q = before ? `?before=${before}&limit=100` : `?limit=100`;
    const arc = await discordSafe(`/channels/${channel.id}/threads/archived/public${q}`);
    if (!arc?.threads?.length) break;
    for (const t of arc.threads) byId.set(t.id, t);
    if (!arc.has_more) break;
    before = arc.threads[arc.threads.length - 1].thread_metadata?.archive_timestamp;
    if (!before) break;
  }
  return [...byId.values()];
}

async function importForum(ch, channel, guildId, last, reporters) {
  const posts = (await listForumPosts(channel, guildId))
    .filter((t) => gt(t.id, last || "0"))
    .sort((a, b) => (gt(a.id, b.id) ? 1 : -1));

  let newLast = last || "0";
  for (const t of posts) {
    const starter = await discordSafe(`/channels/${t.id}/messages/${t.id}`);
    const content = starter?.content?.trim() || "_(no description — see the Discord thread)_";
    const author = starter?.author || { username: "unknown", id: t.owner_id || "" };
    const link = `https://discord.com/channels/${guildId}/${t.id}`;
    const body = [
      content,
      "",
      "---",
      `**Reported by:** ${author.username} (\`${author.id}\`) in Discord`,
      `**Thread:** ${link}`,
      `*Imported automatically from the #${channel.name} forum.*`,
    ].join("\n");

    const url = await createIssue(`${ch.prefix} ${trunc(t.name || "(untitled)", 90)}`, body, ch.labels);
    console.log(`[${ch.kind}] post ${t.id} "${t.name}" -> ${url}`);

    const r = (reporters[author.username] ||= { count: 0, bugs: 0, features: 0 });
    r.count += 1;
    r[ch.kind === "bug" ? "bugs" : "features"] += 1;

    try {
      await discord(`/channels/${t.id}/messages/${t.id}/reactions/${encodeURIComponent("✅")}/@me`, { method: "PUT" });
    } catch { /* ignore */ }

    if (gt(t.id, newLast)) newLast = t.id;
    await sleep(1200);
  }
  console.log(`[${ch.kind}] imported ${posts.length} forum post(s)`);
  return newLast;
}

// --- Text channels (type 0): each report is a message ----------------------------------------
async function importText(ch, channelId, guildId, last, reporters) {
  const collected = [];
  let cursor = last;
  for (let page = 0; page < 20; page++) {
    const batch = await discord(`/channels/${channelId}/messages?after=${cursor}&limit=100`);
    if (!batch.length) break;
    collected.push(...batch);
    const newest = batch.reduce((a, b) => (gt(b.id, a) ? b.id : a), cursor);
    if (batch.length < 100 || newest === cursor) break;
    cursor = newest;
  }
  const seen = new Set();
  const messages = collected
    .filter((m) => (seen.has(m.id) ? false : seen.add(m.id)))
    .filter((m) => !m.author?.bot && m.content?.trim())
    .sort((a, b) => (gt(a.id, b.id) ? 1 : -1));

  let newLast = last;
  for (const m of messages) {
    const content = m.content.trim();
    const link = `https://discord.com/channels/${guildId}/${channelId}/${m.id}`;
    const body = [
      content,
      "",
      "---",
      `**Reported by:** ${m.author.username} (\`${m.author.id}\`) in Discord`,
      `**Message:** ${link}`,
      `*Imported automatically from Discord.*`,
    ].join("\n");
    const title = trunc((content.split("\n")[0] || "").trim() || "(no text)", 90);
    const url = await createIssue(`${ch.prefix} ${title}`, body, ch.labels);
    console.log(`[${ch.kind}] msg ${m.id} -> ${url}`);

    const r = (reporters[m.author.username] ||= { count: 0, bugs: 0, features: 0 });
    r.count += 1;
    r[ch.kind === "bug" ? "bugs" : "features"] += 1;

    try {
      await discord(`/channels/${channelId}/messages/${m.id}/reactions/${encodeURIComponent("✅")}/@me`, { method: "PUT" });
    } catch { /* ignore */ }
    newLast = m.id;
    await sleep(1200);
  }
  console.log(`[${ch.kind}] imported ${messages.length} message(s)`);
  return newLast;
}

async function run() {
  if (!DISCORD_TOKEN || !MOD_REPO_TOKEN || !MOD_REPO) throw new Error("missing required env vars");
  if (!CHANNELS.length) throw new Error("set BUG_CHANNEL_ID and/or FEATURE_CHANNEL_ID");

  const state = readJson(STATE_PATH, {});
  const reporters = readJson(REPORTERS_PATH, {});
  let changed = false;

  for (const ch of CHANNELS) {
    const channel = await discord(`/channels/${ch.id}`);
    const guildId = channel.guild_id;
    const isForum = channel.type === 15 || channel.type === 16;
    const last = state[ch.kind]?.lastId || null;

    // Text channels skip backfill on first run (chat can be noisy); forums import existing posts.
    if (!last && !isForum) {
      const latest = await discord(`/channels/${ch.id}/messages?limit=1`);
      state[ch.kind] = { lastId: latest[0]?.id || "0" };
      changed = true;
      console.log(`[${ch.kind}] text channel initialized (no backfill)`);
      continue;
    }

    const newLast = isForum
      ? await importForum(ch, channel, guildId, last, reporters)
      : await importText(ch, ch.id, guildId, last, reporters);

    if (newLast && newLast !== (state[ch.kind]?.lastId || null)) {
      state[ch.kind] = { lastId: newLast };
      changed = true;
    }
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
