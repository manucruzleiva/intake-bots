#!/usr/bin/env node
// Exporta el historial de #help (y los hilos que cuelgan de sus mensajes) a JSON, solo lectura:
// ningun POST/PATCH/DELETE. Sirve para auditar que cada pregunta o reporte tenga ticket o respuesta.
//
//   node lib/help-export.mjs [--days N] [--out help-export.json]
//
//   Env: DISCORD_TOKEN, DISCORD_GUILD_ID (mismos que server.yml). El canal se busca por nombre en server.json.
import { readFileSync, writeFileSync } from "node:fs";

const API = "https://discord.com/api/v10";
const arg = (name, def) => {
	const i = process.argv.indexOf(name);
	return i > 0 ? process.argv[i + 1] : def;
};
const days = Number(arg("--days", "0")); // 0 = todo el historial
const out = arg("--out", "help-export.json");
const { DISCORD_TOKEN: token, DISCORD_GUILD_ID: guild } = process.env;
if (!token || !guild) throw new Error("DISCORD_TOKEN and DISCORD_GUILD_ID are required");

const get = async (path) => {
	for (let attempt = 0; ; attempt++) {
		const res = await fetch(API + path, { headers: { Authorization: `Bot ${token}`, "User-Agent": "intake-bots help-export" } });
		if (res.status === 429 && attempt < 5) {
			const wait = Number((await res.json()).retry_after ?? 1);
			await new Promise((r) => setTimeout(r, Math.ceil(wait * 1000) + 100));
			continue;
		}
		if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${(await res.text()).slice(0, 300)}`);
		return res.json();
	}
};

const since = days ? Date.now() - days * 86_400_000 : 0;
const slim = (m, channel) => ({
	id: m.id,
	channel,
	url: `https://discord.com/channels/${guild}/${channel}/${m.id}`,
	author: m.author.username,
	bot: !!m.author.bot,
	at: m.timestamp,
	content: m.content,
	attachments: (m.attachments ?? []).map((a) => a.url),
	reply_to: m.message_reference?.message_id ?? null,
	thread: m.thread?.id ?? null,
});

// Pagina hacia atras, 100 por pedido, hasta `since` o el principio del canal.
async function history(channel) {
	const all = [];
	for (let before = ""; ; ) {
		const page = await get(`/channels/${channel}/messages?limit=100${before}`);
		for (const m of page) if (Date.parse(m.timestamp) >= since) all.push(m);
		if (page.length < 100 || Date.parse(page.at(-1).timestamp) < since) break;
		before = `&before=${page.at(-1).id}`;
	}
	return all.reverse();
}

const spec = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));
const help = JSON.stringify(spec).match(/"name":\s*"help",\s*"id":\s*"(\d+)"/)?.[1];
if (!help) throw new Error('channel "help" not found in server.json');

const messages = (await history(help)).map((m) => slim(m, help));
for (const m of [...messages]) if (m.thread) messages.push(...(await history(m.thread)).map((t) => slim(t, m.thread)));
writeFileSync(out, JSON.stringify({ guild, channel: help, exported_at: new Date().toISOString(), messages }, null, 1));
console.log(`#help: ${messages.length} messages → ${out}`);
