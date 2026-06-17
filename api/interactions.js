// Cobblemon Picnic — Discord interactions endpoint (Vercel Edge Function).
//
// Serverless replacement for the gateway bot: Discord POSTs slash-command interactions here, this
// verifies the Ed25519 signature and opens a GitHub issue, then replies (ephemeral) with the link.
// Free + zero-maintenance. Setup steps live in discord-bot/SERVERLESS.md.
//
// Required env vars (set in the Vercel project): DISCORD_PUBLIC_KEY, GITHUB_TOKEN, GITHUB_REPO.

import nacl from "tweetnacl";

export const config = { runtime: "edge" };

const GITHUB_REPO = () => process.env.GITHUB_REPO || "manucruzleiva/cobblemon-picnic";

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function verifySignature(rawBody, signature, timestamp) {
  const publicKey = process.env.DISCORD_PUBLIC_KEY;
  if (!publicKey || !signature || !timestamp) return false;
  try {
    return nacl.sign.detached.verify(
      new TextEncoder().encode(timestamp + rawBody),
      hexToBytes(signature),
      hexToBytes(publicKey),
    );
  } catch {
    return false;
  }
}

function reply(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function createIssue(title, body, labels) {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO()}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "cobblemon-picnic-bot",
    },
    body: JSON.stringify({ title, body, labels }),
  });
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()).html_url;
}

export default async function handler(request) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  const rawBody = await request.text();

  if (!verifySignature(rawBody, signature, timestamp)) {
    return new Response("invalid request signature", { status: 401 });
  }

  const interaction = JSON.parse(rawBody);

  // PING -> PONG (Discord uses this to validate the endpoint).
  if (interaction.type === 1) return reply({ type: 1 });

  // APPLICATION_COMMAND
  if (interaction.type === 2) {
    const name = interaction.data?.name;
    const opts = Object.fromEntries((interaction.data?.options || []).map((o) => [o.name, o.value]));
    const u = interaction.member?.user || interaction.user || {};
    const reporter = u.username ? `${u.username} (${u.id})` : "unknown";

    const isBug = name === "bug";
    const title = `[${isBug ? "Bug" : "Feature"}] ${opts.title || "(no title)"}`;
    const lines = [opts.description || "", "", "---"];
    if (opts.version) lines.push(`**Game/mod version:** ${opts.version}`);
    lines.push(`**Reported by:** ${reporter} via Discord`);
    lines.push("*Filed automatically by the Cobblemon Picnic Discord bot.*");
    const labels = isBug ? ["bug", "discord"] : ["enhancement", "discord"];

    try {
      const url = await createIssue(title, lines.join("\n"), labels);
      return reply({ type: 4, data: { flags: 64, content: `${isBug ? "🐛" : "✨"} Thanks! Filed → ${url}` } });
    } catch (e) {
      return reply({ type: 4, data: { flags: 64, content: `⚠️ Couldn't file it: ${e.message}` } });
    }
  }

  return new Response("unknown interaction type", { status: 400 });
}
