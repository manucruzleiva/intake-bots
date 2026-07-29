/**
 * Cobblemon Ditto HM — Discord → GitHub Issues intake bot
 *
 * Polls configured forum channels for new threads and creates GitHub Issues
 * in the private mod repo. Replies to threads with a "tracked" notice
 * (without the private repo URL). When maintainers close an issue with
 * "fixed in vX.X.X" in the body, the bot resolves the Discord thread.
 *
 * Required env vars (set as GitHub Actions secrets):
 *   DISCORD_TOKEN         Discord bot token
 *   DISCORD_GUILD_ID      Guild (server) ID
 *   DISCORD_BUG_CHANNEL_ID     Forum channel for bug reports
 *   DISCORD_FEATURE_CHANNEL_ID Forum channel for feature requests
 *   GITHUB_TOKEN          PAT with issues:write on the target repo
 *   GITHUB_REPO           owner/repo  (e.g. manucruzleiva/cobblemon-ditto-hms)
 */

const https = require("https");

// ── Env ────────────────────────────────────────────────────────────────────
const DISCORD_TOKEN   = process.env.DISCORD_TOKEN;
const GUILD_ID        = process.env.DISCORD_GUILD_ID;
const BUG_CHANNEL     = process.env.DISCORD_BUG_CHANNEL_ID;
const FEATURE_CHANNEL = process.env.DISCORD_FEATURE_CHANNEL_ID;
const GH_TOKEN        = process.env.GITHUB_TOKEN;
const GH_REPO         = process.env.GITHUB_REPO; // owner/repo

if (!DISCORD_TOKEN || !GUILD_ID || !GH_TOKEN || !GH_REPO) {
  console.error("Missing required environment variables.");
  process.exit(1);
}

// ── HTTP helpers ───────────────────────────────────────────────────────────
function request(url, opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function discordGet(path) {
  const u = new URL(`https://discord.com/api/v10${path}`);
  const r = await request(u, {
    method: "GET",
    headers: { Authorization: `Bot ${DISCORD_TOKEN}`, "User-Agent": "CobblemonDittoHMBot/1.0" },
  });
  if (r.status >= 400) throw new Error(`Discord GET ${path} → ${r.status}`);
  return r.body;
}

async function discordPost(path, payload) {
  const body = JSON.stringify(payload);
  const u    = new URL(`https://discord.com/api/v10${path}`);
  return request(u, {
    method: "POST",
    headers: {
      Authorization: `Bot ${DISCORD_TOKEN}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      "User-Agent": "CobblemonDittoHMBot/1.0",
    },
  }, body);
}

async function ghGet(path) {
  const u = new URL(`https://api.github.com${path}`);
  const r = await request(u, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      "User-Agent": "CobblemonDittoHMBot/1.0",
      Accept: "application/vnd.github+json",
    },
  });
  return r.body;
}

async function ghPost(path, payload) {
  const body = JSON.stringify(payload);
  const u    = new URL(`https://api.github.com${path}`);
  return request(u, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      "User-Agent": "CobblemonDittoHMBot/1.0",
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  }, body);
}

// ── State: persisted via GitHub Actions cache (simple JSON file) ──────────
const STATE_FILE = "bot/state.json";
const fs = require("fs");

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return { tracked: {} }; }  // threadId → issueNumber
}

function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ── Core logic ─────────────────────────────────────────────────────────────
async function fetchActiveThreads(channelId) {
  // Active (open) threads in a forum channel
  const r = await discordGet(`/channels/${channelId}/threads?archived=false&limit=100`);
  return r.threads || [];
}

async function getFirstMessage(threadId) {
  // The starter message is the first in the thread's message list
  const msgs = await discordGet(`/channels/${threadId}/messages?limit=1&after=0`);
  return Array.isArray(msgs) && msgs.length ? msgs[msgs.length - 1] : null;
}

async function createIssue(title, body, labels) {
  const r = await ghPost(`/repos/${GH_REPO}/issues`, { title, body, labels });
  return r.body;
}

async function postTrackedReply(threadId, issueNumber) {
  await discordPost(`/channels/${threadId}/messages`, {
    content: `✅ **Tracked!** This has been logged as an issue by the team. We'll update this thread when it's resolved.`,
  });
}

async function processChannel(channelId, label, state) {
  let threads;
  try { threads = await fetchActiveThreads(channelId); }
  catch (e) { console.warn(`Could not fetch ${channelId}: ${e.message}`); return; }

  for (const thread of threads) {
    if (state.tracked[thread.id]) continue;  // already filed

    const msg = await getFirstMessage(thread.id).catch(() => null);
    const description = msg
      ? msg.content.slice(0, 5000)
      : "*(no description)*";

    const issue = await createIssue(
      thread.name,
      `**From Discord:** [${thread.name}](https://discord.com/channels/${GUILD_ID}/${thread.id})\n\n${description}`,
      [label, "community"],
    );

    if (issue && issue.number) {
      state.tracked[thread.id] = issue.number;
      await postTrackedReply(thread.id, issue.number);
      console.log(`Filed #${issue.number}: ${thread.name}`);
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────
(async () => {
  const state = loadState();

  if (BUG_CHANNEL)     await processChannel(BUG_CHANNEL,     "bug",     state);
  if (FEATURE_CHANNEL) await processChannel(FEATURE_CHANNEL, "feature", state);

  saveState(state);
  console.log("Done. Tracked threads:", Object.keys(state.tracked).length);
})();
