// The Discord server as code: ../server.json declares the guild, and this script makes the guild
// match it. Run by .github/workflows/server.yml.
//
//   node lib/server.mjs [--apply] [--prune] [--file <path>]
//   node lib/server.mjs --export [--file <path>]
//
// With no flag it is a dry run: it reads the guild, prints the diff and changes nothing. --apply
// makes the changes. --export writes the live guild in server.json's shape instead (to --file, or to
// stdout), which is how server.json was first written and how a change clicked by hand is adopted.
//
// Env: DISCORD_TOKEN (a bot with Administrator) and DISCORD_GUILD_ID. GITHUB_STEP_SUMMARY, when set,
// gets the diff and the ids of everything created.
//
// What is declared is managed; what is left out is not. A channel without a `topic` key keeps the
// topic it has, and an absent `welcome_screen` is never touched. Field names are Discord's API
// names; every reference to a role or a channel is by NAME, resolved at run time, so a file can
// name a channel this same run creates. `id` is optional and only pins the match: an object is
// found by its id, then by its name, and created when neither exists. An AutoMod alert action names
// its channel too: `{ "type": 2, "metadata": { "channel": "moderator-only" } }`.
//
// `guild.mfa_level` is declared and checked but never applied: only the owner can change it, so a
// difference is printed as a warning with the step to click.
//
// Nothing that is not in the file is deleted unless --prune is passed: the diff lists it as an
// extra and leaves it. A typo in server.json must not cost a channel and its threads.
//
// Order is part of the declaration: roles top to bottom as Server Settings lists them, channels
// top to bottom inside their category. Extras keep their place among the declared items.
//
// A text or announcement channel may declare `messages`: the bot's own posts in it, oldest first,
// each with Discord's `content` and `embeds`. Only a channel that declares the key is managed, and
// only the bot's posts in it: the n-th declared message is the bot's n-th oldest post, edited in
// place when it differs, posted when it is missing, and an extra (deleted with --prune) when the bot
// has more. The bot reads the channel's last 100 messages, so this is for channels people cannot
// write in. Every other channel's bot posts (release announcements) are never read.

import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://discord.com/api/v10";
const AUDIT_REASON = "server.json (intake-bots)";
const DEFAULT_FILE = resolve(fileURLToPath(import.meta.url), "../../server.json");

/** Permission flags by bit (discord-api-types). An unnamed bit round-trips as `bit<N>`. */
const PERMISSIONS = [
	"CreateInstantInvite", "KickMembers", "BanMembers", "Administrator", "ManageChannels", "ManageGuild",
	"AddReactions", "ViewAuditLog", "PrioritySpeaker", "Stream", "ViewChannel", "SendMessages",
	"SendTTSMessages", "ManageMessages", "EmbedLinks", "AttachFiles", "ReadMessageHistory", "MentionEveryone",
	"UseExternalEmojis", "ViewGuildInsights", "Connect", "Speak", "MuteMembers", "DeafenMembers", "MoveMembers",
	"UseVAD", "ChangeNickname", "ManageNicknames", "ManageRoles", "ManageWebhooks", "ManageGuildExpressions",
	"UseApplicationCommands", "RequestToSpeak", "ManageEvents", "ManageThreads", "CreatePublicThreads",
	"CreatePrivateThreads", "UseExternalStickers", "SendMessagesInThreads", "UseEmbeddedActivities",
	"ModerateMembers", "ViewCreatorMonetizationAnalytics", "UseSoundboard", "CreateGuildExpressions",
	"CreateEvents", "UseExternalSounds", "SendVoiceMessages", null, "SetVoiceChannelStatus", "SendPolls",
	"UseExternalApps", "PinMessages", "BypassSlowmode",
];

const CHANNEL_TYPES = { text: 0, voice: 2, category: 4, announcement: 5, stage: 13, forum: 15, media: 16 };
const TYPE_NAMES = Object.fromEntries(Object.entries(CHANNEL_TYPES).map(([k, v]) => [v, k]));
/** The only type change Discord accepts on an existing channel (Community guilds). */
const CONVERTIBLE = new Set([CHANNEL_TYPES.text, CHANNEL_TYPES.announcement]);
const THREADED = new Set([CHANNEL_TYPES.forum, CHANNEL_TYPES.media]);
const REQUIRE_TAG = 16;
const UNKNOWN_WELCOME_SCREEN = 10069;
/** Channels that can carry declared `messages`, and how far back the bot looks for its own. */
const MESSAGE_CHANNELS = new Set([CHANNEL_TYPES.text, CHANNEL_TYPES.announcement]);
const MESSAGE_WINDOW = 100;
const MESSAGE_MAX = 2000;

/** Channel fields compared as they are; everything else on a channel has its own handling. */
const CHANNEL_FIELDS = [
	"topic", "nsfw", "rate_limit_per_user", "bitrate", "user_limit",
	"default_auto_archive_duration", "default_thread_rate_limit_per_user",
	"default_reaction_emoji", "default_sort_order", "default_forum_layout",
];
const ROLE_FIELDS = ["color", "hoist", "mentionable", "unicode_emoji"];
const GUILD_FIELDS = [
	"description", "verification_level", "default_message_notifications", "explicit_content_filter",
	"system_channel_flags", "preferred_locale", "afk_timeout",
];
/** Guild fields that hold a channel id; server.json names the channel (`rules_channel`). */
const GUILD_CHANNELS = ["system_channel", "rules_channel", "public_updates_channel", "safety_alerts_channel", "afk_channel"];
const AUTOMOD_FIELDS = ["event_type", "trigger_metadata", "actions", "enabled"];
/**
 * Guild fields only the owner can change (POST /guilds/{id}/mfa needs ownership, and the bot is not
 * the owner). They are compared and exported, and a difference is a warning with the manual step.
 */
const OWNER_FIELDS = {
	mfa_level: "Server Settings → Safety Setup → Permissions → Require 2FA for moderator actions (your account needs 2FA first)",
};

// ---------------------------------------------------------------------------------------------
// Pure helpers

export function permissionBits(names = []) {
	let bits = 0n;
	for (const n of names) {
		const bit = /^bit(\d+)$/.exec(n)?.[1] ?? PERMISSIONS.indexOf(n);
		if (bit === -1) throw new Error(`unknown permission: ${n}`);
		bits |= 1n << BigInt(bit);
	}
	return bits.toString();
}

export function permissionNames(bits) {
	const out = [];
	for (let b = 0n, v = BigInt(bits ?? 0); v; b++, v >>= 1n) if (v & 1n) out.push(PERMISSIONS[Number(b)] ?? `bit${b}`);
	return out;
}

/**
 * True when every key of `want` is deep-equal in `have`. Keys `have` carries beyond `want` are the
 * API's defaults and are ignored; arrays must match element by element.
 */
export function covers(want, have) {
	if (want === have) return true;
	if (Array.isArray(want)) return Array.isArray(have) && want.length === have.length && want.every((w, i) => covers(w, have[i]));
	if (want && typeof want === "object") {
		return !!have && typeof have === "object" && Object.entries(want).every(([k, v]) => covers(v, have[k] ?? null));
	}
	return want == null ? have == null : false;
}

const show = (v) => (v === undefined ? "unset" : JSON.stringify(v));
const clip = (s, n = 60) => (s == null ? s : s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Embeds the bot sent. Discord adds link previews of its own, which the file never declares. */
export const richEmbeds = (m) => (m.embeds ?? []).filter((e) => (e.type ?? "rich") === "rich");

/** The first line of a message, for the diff. */
const preview = (m) => show(clip((m.content || richEmbeds(m)[0]?.title || "(embed)").split("\n")[0]));

/** Where two message texts first differ, for the diff: `line 3: "a" → "b"`. */
export function firstChange(a = "", b = "") {
	const x = a.split("\n");
	const y = b.split("\n");
	let k = 0;
	while (k < Math.max(x.length, y.length) && x[k] === y[k]) k++;
	return `line ${k + 1}: ${show(clip(x[k]))} → ${show(clip(y[k]))}`;
}

/**
 * The order `declared` asks for, with every extra of `live` kept where it is: an extra sits right
 * after the item it follows in `live`. Both are lists of keys.
 */
export function desiredOrder(declared, live) {
	const want = new Set(declared);
	const out = [...declared];
	let prev = null;
	for (const k of live) {
		if (!want.has(k)) out.splice(prev === null ? 0 : out.indexOf(prev) + 1, 0, k);
		prev = k;
	}
	return out;
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const byPosition = (a, b) => a.position - b.position || (BigInt(a.id) < BigInt(b.id) ? -1 : 1);

/** A fresh snowflake, for the onboarding prompt and option ids Discord requires on a PUT. */
let seq = 0n;
const snowflake = () => (((BigInt(Date.now()) - 1420070400000n) << 22n) | (seq++ & 0xfffn)).toString();

// ---------------------------------------------------------------------------------------------
// Validation

export function validate(spec) {
	const errors = [];
	const seen = (label, names) => {
		const dup = names.filter((n, i) => names.indexOf(n) !== i);
		for (const n of new Set(dup)) errors.push(`${label} "${n}" is declared twice`);
	};
	const channels = [...(spec.channels ?? []), ...(spec.categories ?? []).flatMap((c) => c.channels ?? [])];
	seen("role", (spec.roles ?? []).map((r) => r.name));
	seen("category", (spec.categories ?? []).map((c) => c.name));
	seen("channel", channels.map((c) => c.name));
	seen("automod rule", (spec.automod ?? []).map((r) => r.name));
	for (const c of channels) {
		if (!(c.type in CHANNEL_TYPES) || c.type === "category") errors.push(`channel "${c.name}": bad type "${c.type}"`);
		if (c.available_tags && !THREADED.has(CHANNEL_TYPES[c.type])) errors.push(`channel "${c.name}": available_tags on a ${c.type} channel`);
		if ((c.available_tags?.length ?? 0) > 20) errors.push(`channel "${c.name}": more than 20 tags`);
		if (c.messages !== undefined) {
			if (!MESSAGE_CHANNELS.has(CHANNEL_TYPES[c.type])) errors.push(`channel "${c.name}": messages on a ${c.type} channel`);
			if (!Array.isArray(c.messages)) errors.push(`channel "${c.name}": messages must be a list`);
			else c.messages.forEach((m, i) => {
				if (!m?.content && !m?.embeds?.length) errors.push(`channel "${c.name}": message ${i + 1} has no content and no embeds`);
				if ((m?.content?.length ?? 0) > MESSAGE_MAX) errors.push(`channel "${c.name}": message ${i + 1} is over ${MESSAGE_MAX} characters`);
			});
		}
	}
	for (const r of spec.roles ?? []) {
		if (r.managed && Object.keys(r).some((k) => !["name", "id", "managed"].includes(k))) {
			errors.push(`role "${r.name}" is managed by an integration: declare only its name and place`);
		}
	}
	if (!(spec.roles ?? []).some((r) => r.name === "@everyone")) errors.push(`roles: "@everyone" must be declared, last`);
	else if (spec.roles.at(-1).name !== "@everyone") errors.push(`roles: "@everyone" must be last`);
	return errors;
}

// ---------------------------------------------------------------------------------------------
// Discord

function client(token, { apply }) {
	const call = async (method, path, body) => {
		for (let attempt = 0; ; attempt++) {
			const res = await fetch(API + path, {
				method,
				headers: {
					Authorization: `Bot ${token}`,
					"Content-Type": "application/json",
					"X-Audit-Log-Reason": encodeURIComponent(AUDIT_REASON),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			if (res.status === 429 && attempt < 5) {
				const wait = Number((await res.json()).retry_after ?? 1);
				await new Promise((r) => setTimeout(r, Math.ceil(wait * 1000) + 100));
				continue;
			}
			const text = await res.text();
			const json = text ? JSON.parse(text) : null;
			if (!res.ok) {
				const err = new Error(`${method} ${path} → ${res.status} ${text.slice(0, 500)}`);
				err.code = json?.code;
				throw err;
			}
			return json;
		}
	};
	return {
		get: (p) => call("GET", p),
		write: (method, p, body) => {
			if (!apply) throw new Error(`dry run tried to write: ${method} ${p}`);
			return call(method, p, body);
		},
	};
}

/**
 * The live guild. `messages` maps a channel id to the bot's own posts there, oldest first, read only
 * for the channels `spec` gives `messages` to (matched by id, then by name).
 */
async function readGuild(api, guildId, spec) {
	const g = `/guilds/${guildId}`;
	const [guild, channels, roles, automod, onboarding, me] = await Promise.all([
		api.get(g),
		api.get(`${g}/channels`),
		api.get(`${g}/roles`),
		api.get(`${g}/auto-moderation/rules`),
		api.get(`${g}/onboarding`),
		api.get("/users/@me"),
	]);
	const welcome = await api.get(`${g}/welcome-screen`).catch((e) => {
		if (e.code === UNKNOWN_WELCOME_SCREEN) return null;
		throw e;
	});
	const messages = new Map();
	for (const c of declaredChannels(spec).filter((c) => c.messages !== undefined)) {
		const ch = channels.find((x) => x.id === c.id) ?? channels.find((x) => x.name === c.name && MESSAGE_CHANNELS.has(x.type));
		if (!ch || messages.has(ch.id)) continue;
		const recent = await api.get(`/channels/${ch.id}/messages?limit=${MESSAGE_WINDOW}`);
		messages.set(ch.id, recent.filter((m) => m.author.id === me.id).reverse());
	}
	return { guild, channels, roles, automod, onboarding, welcome, messages };
}

const declaredChannels = (spec) => [...(spec?.channels ?? []), ...(spec?.categories ?? []).flatMap((c) => c.channels ?? [])];

// ---------------------------------------------------------------------------------------------
// Export: the live guild in server.json's shape

function exportOverwrites(ch, roleName) {
	const out = {};
	for (const o of [...(ch.permission_overwrites ?? [])].sort((a, b) => a.id.localeCompare(b.id))) {
		const key = o.type === 0 ? roleName(o.id) : `user:${o.id}`;
		const entry = {};
		if (o.allow !== "0") entry.allow = permissionNames(o.allow);
		if (o.deny !== "0") entry.deny = permissionNames(o.deny);
		out[key] = entry;
	}
	return Object.keys(out).length ? out : undefined;
}

/** A message in server.json's shape: only what the file declares. */
const messageShape = (m) => ({ ...(m.content ? { content: m.content } : {}), ...(richEmbeds(m).length ? { embeds: richEmbeds(m) } : {}) });

function exportChannel(ch, roleName, messages) {
	const out = { name: ch.name, id: ch.id, type: TYPE_NAMES[ch.type] ?? ch.type };
	if (ch.topic) out.topic = ch.topic;
	if (ch.nsfw) out.nsfw = true;
	if (ch.rate_limit_per_user) out.rate_limit_per_user = ch.rate_limit_per_user;
	if (THREADED.has(ch.type)) {
		out.require_tag = !!(ch.flags & REQUIRE_TAG);
		out.available_tags = ch.available_tags.map(({ name, emoji_name, emoji_id, moderated }) => ({
			name,
			...(emoji_name ? { emoji_name } : {}),
			...(emoji_id ? { emoji_id } : {}),
			...(moderated ? { moderated } : {}),
		}));
		for (const k of ["default_reaction_emoji", "default_auto_archive_duration", "default_sort_order", "default_forum_layout"]) {
			if (ch[k] != null) out[k] = k === "default_reaction_emoji" ? stripNulls(ch[k]) : ch[k];
		}
	}
	const ow = exportOverwrites(ch, roleName);
	if (ow) out.overwrites = ow;
	if (messages) out.messages = messages.map(messageShape);
	return out;
}

const stripNulls = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));

/**
 * AutoMod actions in server.json's shape: an alert action names its channel (`channel`) instead of
 * carrying `channel_id`, and an empty `metadata` is dropped.
 */
export function namedActions(actions, channelName) {
	return actions.map(({ type, metadata = {} }) => {
		const { channel_id, ...rest } = metadata;
		const named = channel_id ? { ...rest, channel: channelName(channel_id) ?? `channel:${channel_id}` } : rest;
		return Object.keys(named).length ? { type, metadata: named } : { type };
	});
}

/** The inverse of namedActions, for the API. */
export function idActions(actions, channelId) {
	return actions.map(({ type, metadata }) => {
		if (!metadata?.channel) return metadata ? { type, metadata } : { type };
		const { channel, ...rest } = metadata;
		return { type, metadata: { ...rest, channel_id: channel.startsWith("channel:") ? channel.slice(8) : channelId(channel) } };
	});
}

export function exportServer(live) {
	const roleName = (id) => (id === live.guild.id ? "@everyone" : live.roles.find((r) => r.id === id)?.name ?? `role:${id}`);
	const channelName = (id) => live.channels.find((c) => c.id === id)?.name ?? null;
	const roles = [...live.roles].sort((a, b) => b.position - a.position || (BigInt(a.id) < BigInt(b.id) ? -1 : 1)).map((r) => {
		if (r.id === live.guild.id) return { name: "@everyone", permissions: permissionNames(r.permissions) };
		if (r.managed) return { name: r.name, id: r.id, managed: true };
		const out = { name: r.name, id: r.id, permissions: permissionNames(r.permissions) };
		for (const k of ROLE_FIELDS) if (r[k]) out[k] = r[k];
		return out;
	});
	const top = live.channels.filter((c) => !c.parent_id);
	const guild = {};
	for (const k of [...GUILD_FIELDS, ...Object.keys(OWNER_FIELDS)]) if (live.guild[k] != null) guild[k] = live.guild[k];
	for (const k of GUILD_CHANNELS) {
		const id = live.guild[`${k}_id`];
		if (id) guild[k] = channelName(id);
	}
	return {
		guild,
		roles,
		channels: top.filter((c) => c.type !== CHANNEL_TYPES.category).sort(byPosition).map((c) => exportChannel(c, roleName, live.messages?.get(c.id))),
		categories: top.filter((c) => c.type === CHANNEL_TYPES.category).sort(byPosition).map((cat) => {
			const out = { name: cat.name, id: cat.id };
			const ow = exportOverwrites(cat, roleName);
			if (ow) out.overwrites = ow;
			out.channels = live.channels.filter((c) => c.parent_id === cat.id).sort(byPosition).map((c) => exportChannel(c, roleName, live.messages?.get(c.id)));
			return out;
		}),
		automod: live.automod.map((r) => ({
			name: r.name,
			id: r.id,
			event_type: r.event_type,
			trigger_type: r.trigger_type,
			trigger_metadata: r.trigger_metadata,
			actions: namedActions(r.actions, channelName),
			enabled: r.enabled,
			exempt_roles: r.exempt_roles.map(roleName),
			exempt_channels: r.exempt_channels.map(channelName),
		})),
		welcome_screen: live.welcome && {
			enabled: live.guild.features.includes("WELCOME_SCREEN_ENABLED"),
			description: live.welcome.description,
			welcome_channels: live.welcome.welcome_channels.map((w) => ({ channel: channelName(w.channel_id), description: w.description, ...stripNulls({ emoji_name: w.emoji_name, emoji_id: w.emoji_id }) })),
		},
		onboarding: exportOnboarding(live.onboarding, roleName, channelName),
	};
}

function exportOnboarding(o, roleName, channelName) {
	return {
		enabled: o.enabled,
		mode: o.mode,
		default_channels: o.default_channel_ids.map(channelName),
		prompts: o.prompts.map((p) => ({
			title: p.title,
			type: p.type,
			single_select: p.single_select,
			required: p.required,
			in_onboarding: p.in_onboarding,
			options: p.options.map((op) => ({
				title: op.title,
				...(op.description ? { description: op.description } : {}),
				...(op.emoji?.name ? { emoji_name: op.emoji.name } : {}),
				...(op.emoji?.id ? { emoji_id: op.emoji.id } : {}),
				channels: op.channel_ids.map(channelName),
				roles: op.role_ids.map(roleName),
			})),
		})),
	};
}

/** JSON with two-space indent, and arrays of plain values on one line: a permission list stays readable. */
export function formatJson(value, indent = "") {
	const inner = indent + "  ";
	if (Array.isArray(value)) {
		if (!value.length) return "[]";
		if (value.every((v) => v === null || typeof v !== "object")) return `[${value.map((v) => JSON.stringify(v)).join(", ")}]`;
		return `[\n${value.map((v) => inner + formatJson(v, inner)).join(",\n")}\n${indent}]`;
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value).filter(([, v]) => v !== undefined);
		if (!entries.length) return "{}";
		return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${formatJson(v, inner)}`).join(",\n")}\n${indent}}`;
	}
	return JSON.stringify(value);
}

// ---------------------------------------------------------------------------------------------
// Plan: the diff as a list of steps. Each step has the line the diff prints and, unless it is an
// extra that stays, the call that applies it. Calls read ids through `ctx`, which learns the id of
// everything created earlier in the same run.

export function plan(spec, live, { prune = false } = {}) {
	const steps = [];
	const add = (sign, text, run) => steps.push({ sign, text, run });
	const g = `/guilds/${live.guild.id}`;
	const ctx = {
		roles: new Map(live.roles.map((r) => [r.id === live.guild.id ? "@everyone" : r.name, r.id])),
		channels: new Map(live.channels.filter((c) => c.type !== CHANNEL_TYPES.category).map((c) => [c.name, c.id])),
		categories: new Map(live.channels.filter((c) => c.type === CHANNEL_TYPES.category).map((c) => [c.name, c.id])),
		created: [],
	};
	const roleId = (name) => {
		if (name.startsWith("role:")) return name.slice(5);
		const id = ctx.roles.get(name);
		if (!id) throw new Error(`unknown role "${name}"`);
		return id;
	};
	const channelId = (name) => {
		if (name == null) return null;
		const id = ctx.channels.get(name);
		if (!id) throw new Error(`unknown channel "${name}"`);
		return id;
	};
	const overwriteList = (ow = {}) =>
		Object.entries(ow).map(([key, { allow, deny }]) => ({
			id: key.startsWith("user:") ? key.slice(5) : roleId(key),
			type: key.startsWith("user:") ? 1 : 0,
			allow: permissionBits(allow),
			deny: permissionBits(deny),
		}));

	// Every name a reference may use must exist in the file or in the guild.
	const declaredRoles = new Set((spec.roles ?? []).map((r) => r.name));
	const declaredChannels = new Set([...(spec.channels ?? []), ...(spec.categories ?? []).flatMap((c) => c.channels ?? [])].map((c) => c.name));
	const knownRole = (n) => n.startsWith("role:") || n.startsWith("user:") || declaredRoles.has(n) || ctx.roles.has(n);
	const knownChannel = (n) => n == null || declaredChannels.has(n) || ctx.channels.has(n);
	const refErrors = [];
	const checkOverwrites = (where, ow) => Object.keys(ow ?? {}).forEach((k) => knownRole(k) || refErrors.push(`${where}: unknown role "${k}"`));
	for (const c of spec.categories ?? []) checkOverwrites(`category "${c.name}"`, c.overwrites);
	for (const c of [...(spec.channels ?? []), ...(spec.categories ?? []).flatMap((x) => x.channels ?? [])]) checkOverwrites(`channel "${c.name}"`, c.overwrites);
	for (const k of GUILD_CHANNELS) if (spec.guild?.[k] !== undefined && !knownChannel(spec.guild[k])) refErrors.push(`guild.${k}: unknown channel "${spec.guild[k]}"`);
	for (const r of spec.automod ?? []) {
		(r.exempt_roles ?? []).forEach((n) => knownRole(n) || refErrors.push(`automod "${r.name}": unknown role "${n}"`));
		(r.exempt_channels ?? []).forEach((n) => knownChannel(n) || refErrors.push(`automod "${r.name}": unknown channel "${n}"`));
		for (const a of r.actions ?? []) {
			const n = a.metadata?.channel;
			if (n && !n.startsWith("channel:") && !knownChannel(n)) refErrors.push(`automod "${r.name}": unknown channel "${n}"`);
		}
	}
	for (const w of spec.welcome_screen?.welcome_channels ?? []) knownChannel(w.channel) || refErrors.push(`welcome_screen: unknown channel "${w.channel}"`);
	for (const n of spec.onboarding?.default_channels ?? []) knownChannel(n) || refErrors.push(`onboarding: unknown channel "${n}"`);
	for (const p of spec.onboarding?.prompts ?? []) {
		for (const op of p.options ?? []) {
			(op.channels ?? []).forEach((n) => knownChannel(n) || refErrors.push(`onboarding "${p.title}": unknown channel "${n}"`));
			(op.roles ?? []).forEach((n) => knownRole(n) || refErrors.push(`onboarding "${p.title}": unknown role "${n}"`));
		}
	}
	if (refErrors.length) throw new Error(refErrors.join("\n"));

	// Each live object is matched once: by the declared id, then by name.
	const matcher = (pool) => {
		const used = new Set();
		return {
			match(decl) {
				let hit = decl.id ? pool.find((x) => x.id === decl.id) : null;
				if (decl.id && !hit) add("!", `${decl.name}: id ${decl.id} is not in the guild; matching by name`);
				hit ??= pool.find((x) => !used.has(x.id) && x.name === decl.name);
				if (hit) used.add(hit.id);
				return hit;
			},
			extras: () => pool.filter((x) => !used.has(x.id)),
		};
	};
	// Deletes run last, after every move: a channel leaves a category before the category goes.
	const pruneSteps = [];

	// --- roles ------------------------------------------------------------------------------
	const bot = live.roles.filter((r) => r.managed && r.tags?.bot_id).sort((a, b) => b.position - a.position)[0];
	const roleMatch = matcher(live.roles.filter((r) => r.id !== live.guild.id));
	for (const r of (spec.roles ?? []).filter((r) => r.name !== "@everyone")) {
		const m = { hit: roleMatch.match(r) };
		const body = {};
		if (r.permissions) body.permissions = permissionBits(r.permissions);
		for (const k of ROLE_FIELDS) if (r[k] !== undefined) body[k] = r[k];
		if (!m.hit) {
			if (r.managed) throw new Error(`role "${r.name}" is managed by an integration and is not in the guild`);
			add("+", `create role "${r.name}"`, async (api) => {
				const made = await api.write("POST", `${g}/roles`, { name: r.name, ...body });
				ctx.roles.set(r.name, made.id);
				ctx.created.push(["role", r.name, made.id]);
			});
			continue;
		}
		ctx.roles.set(r.name, m.hit.id);
		if (r.managed) continue;
		const diffs = [];
		if (m.hit.name !== r.name) diffs.push(`name ${show(m.hit.name)} → ${show(r.name)}`);
		if (body.permissions !== undefined && body.permissions !== m.hit.permissions) diffs.push(permissionDiff(m.hit.permissions, body.permissions));
		for (const k of ROLE_FIELDS) if (body[k] !== undefined && body[k] !== m.hit[k]) diffs.push(`${k} ${show(m.hit[k])} → ${show(body[k])}`);
		if (!diffs.length) continue;
		if (bot && m.hit.position >= bot.position) add("!", `role "${r.name}" sits at or above the bot's role "${bot.name}": Discord refuses this edit until "${bot.name}" is dragged above it`);
		add("~", `role "${r.name}": ${diffs.join("; ")}`, (api) => api.write("PATCH", `${g}/roles/${m.hit.id}`, { name: r.name, ...body }));
	}
	const everyone = (spec.roles ?? []).find((r) => r.name === "@everyone");
	const liveEveryone = live.roles.find((r) => r.id === live.guild.id);
	if (everyone?.permissions) {
		const want = permissionBits(everyone.permissions);
		if (want !== liveEveryone.permissions) {
			add("~", `role "@everyone": ${permissionDiff(liveEveryone.permissions, want)}`, (api) => api.write("PATCH", `${g}/roles/${live.guild.id}`, { permissions: want }));
		}
	}
	for (const x of roleMatch.extras().filter((x) => !x.managed)) {
		extra(`role "${x.name}"`, (api) => api.write("DELETE", `${g}/roles/${x.id}`));
	}

	// Role order, top to bottom; @everyone stays at 0. Roles created this run start at the bottom.
	{
		const declared = (spec.roles ?? []).filter((r) => r.name !== "@everyone").map((r) => r.name);
		const liveNames = live.roles.filter((r) => r.id !== live.guild.id).sort((a, b) => b.position - a.position).map((r) => r.name);
		const projected = [...liveNames, ...declared.filter((n) => !liveNames.includes(n))];
		const want = desiredOrder(declared, projected);
		if (!sameList(want, projected)) {
			add("↕", `role order: ${projected.join(", ")} → ${want.join(", ")}`, (api) => {
				const ids = want.map((n) => ctx.roles.get(n)).filter(Boolean);
				return api.write("PATCH", `${g}/roles`, ids.map((id, i) => ({ id, position: ids.length - i })));
			});
		}
	}

	// --- channels ---------------------------------------------------------------------------
	const liveCategories = live.channels.filter((c) => c.type === CHANNEL_TYPES.category);
	const liveChannels = live.channels.filter((c) => c.type !== CHANNEL_TYPES.category);
	const categoryMatch = matcher(liveCategories);
	const channelMatch = matcher(liveChannels);
	// id → declared name, for every live channel and category the file adopts (a rename keeps the id).
	const declaredName = new Map();
	const containers = []; // { key, parent: category name | null, declared: [names] }
	const messageWork = []; // { c, liveId }: channels that declare `messages`, reconciled after every create

	const reconcileOverwrites = (label, liveOw, wantOw, targetId) => {
		const have = new Map((liveOw ?? []).map((o) => [o.id, o]));
		for (const [key, entry] of Object.entries(wantOw)) {
			const id = key.startsWith("user:") ? key.slice(5) : ctx.roles.get(key);
			const cur = id && have.get(id);
			const allow = permissionBits(entry.allow);
			const deny = permissionBits(entry.deny);
			if (cur && cur.allow === allow && cur.deny === deny) continue;
			const what = cur ? `${permissionDiff(cur.allow, allow, "allow")}; ${permissionDiff(cur.deny, deny, "deny")}` : `allow [${(entry.allow ?? []).join(", ")}] deny [${(entry.deny ?? []).join(", ")}]`;
			add(cur ? "~" : "+", `${label}: overwrite for ${key}: ${what}`, (api) => {
				const tid = targetId();
				const oid = key.startsWith("user:") ? key.slice(5) : roleId(key);
				return api.write("PUT", `/channels/${tid}/permissions/${oid}`, { type: key.startsWith("user:") ? 1 : 0, allow, deny });
			});
		}
		const wanted = new Set(Object.keys(wantOw).map((k) => (k.startsWith("user:") ? k.slice(5) : ctx.roles.get(k))));
		for (const o of liveOw ?? []) {
			if (wanted.has(o.id)) continue;
			const who = o.type === 0 ? live.roles.find((r) => r.id === o.id)?.name ?? `role:${o.id}` : `user:${o.id}`;
			extra(`${label}: overwrite for ${who}`, (api) => api.write("DELETE", `/channels/${targetId()}/permissions/${o.id}`));
		}
	};
	const reconcileChannel = (c, parentName) => {
		const m = { hit: channelMatch.match(c) };
		const type = CHANNEL_TYPES[c.type];
		const label = `channel #${c.name}`;
		if (c.messages !== undefined) messageWork.push({ c, liveId: m.hit?.id ?? null });
		if (!m.hit) {
			add("+", `create ${c.type} channel #${c.name}${parentName ? ` in "${parentName}"` : ""}`, async (api) => {
				const body = { name: c.name, type, parent_id: parentName ? ctx.categories.get(parentName) : null, permission_overwrites: overwriteList(c.overwrites) };
				for (const k of CHANNEL_FIELDS) if (c[k] !== undefined) body[k] = c[k];
				if (c.available_tags) body.available_tags = c.available_tags;
				const made = await api.write("POST", `${g}/channels`, body);
				if (c.require_tag) await api.write("PATCH", `/channels/${made.id}`, { flags: REQUIRE_TAG });
				ctx.channels.set(c.name, made.id);
				ctx.created.push(["channel", c.name, made.id]);
			});
			return;
		}
		const ch = m.hit;
		ctx.channels.set(c.name, ch.id);
		declaredName.set(ch.id, c.name);
		const body = {};
		const diffs = [];
		if (ch.name !== c.name) (body.name = c.name), diffs.push(`name ${show(ch.name)} → ${show(c.name)}`);
		if (ch.type !== type) {
			if (!(CONVERTIBLE.has(ch.type) && CONVERTIBLE.has(type))) {
				throw new Error(`${label}: Discord cannot turn a ${TYPE_NAMES[ch.type]} channel into a ${c.type} one; make the new channel by hand and adopt it, or rename this one`);
			}
			body.type = type;
			diffs.push(`type ${TYPE_NAMES[ch.type]} → ${c.type}`);
		}
		for (const k of CHANNEL_FIELDS) {
			if (c[k] === undefined || covers(c[k], ch[k] ?? null)) continue;
			body[k] = c[k];
			diffs.push(`${k} ${show(ch[k])} → ${show(c[k])}`);
		}
		if (c.require_tag !== undefined && !!(ch.flags & REQUIRE_TAG) !== c.require_tag) {
			body.flags = c.require_tag ? ch.flags | REQUIRE_TAG : ch.flags & ~REQUIRE_TAG;
			diffs.push(`require_tag ${!c.require_tag} → ${c.require_tag}`);
		}
		if (c.available_tags) {
			// Existing tags keep their ids, or every thread loses the tag it carries.
			const liveTags = ch.available_tags ?? [];
			const kept = c.available_tags.map((t) => ({ ...(liveTags.find((x) => x.name === t.name) ?? {}), ...t }));
			const extraTags = liveTags.filter((x) => !c.available_tags.some((t) => t.name === x.name));
			const next = prune ? kept : [...kept, ...extraTags];
			const strip = (t) => ({ name: t.name, emoji_name: t.emoji_name ?? null, emoji_id: t.emoji_id ?? null, moderated: !!t.moderated });
			if (!covers(next.map(strip), liveTags.map(strip))) {
				body.available_tags = next.map((t) => ({ ...(t.id ? { id: t.id } : {}), ...strip(t) }));
				diffs.push(`tags [${liveTags.map((t) => t.name).join(", ")}] → [${next.map((t) => t.name).join(", ")}]`);
			}
			for (const t of extraTags) if (!prune) add("?", `${label}: extra tag "${t.name}" (kept)`);
		}
		if (diffs.length) add("~", `${label}: ${diffs.join("; ")}`, (api) => api.write("PATCH", `/channels/${ch.id}`, body));
		if (c.overwrites !== undefined) reconcileOverwrites(label, ch.permission_overwrites, c.overwrites, () => ch.id);
	};

	for (const c of spec.channels ?? []) reconcileChannel(c, null);
	containers.push({ key: "uncategorized channels", parent: null, declared: (spec.channels ?? []).map((c) => c.name) });

	for (const cat of spec.categories ?? []) {
		const m = { hit: categoryMatch.match(cat) };
		const label = `category "${cat.name}"`;
		if (!m.hit) {
			add("+", `create ${label}`, async (api) => {
				const made = await api.write("POST", `${g}/channels`, { name: cat.name, type: CHANNEL_TYPES.category, permission_overwrites: overwriteList(cat.overwrites) });
				ctx.categories.set(cat.name, made.id);
				ctx.created.push(["category", cat.name, made.id]);
			});
		} else {
			ctx.categories.set(cat.name, m.hit.id);
			declaredName.set(m.hit.id, cat.name);
			if (m.hit.name !== cat.name) add("~", `${label}: name ${show(m.hit.name)} → ${show(cat.name)}`, (api) => api.write("PATCH", `/channels/${m.hit.id}`, { name: cat.name }));
			if (cat.overwrites !== undefined) reconcileOverwrites(label, m.hit.permission_overwrites, cat.overwrites, () => m.hit.id);
		}
		for (const c of cat.channels ?? []) reconcileChannel(c, cat.name);
		containers.push({ key: `channels of "${cat.name}"`, parent: cat.name, liveId: m.hit?.id, declared: (cat.channels ?? []).map((c) => c.name) });
	}
	for (const x of channelMatch.extras()) {
		const warn = THREADED.has(x.type) ? " — a forum: deleting it deletes every thread in it" : "";
		extra(`${TYPE_NAMES[x.type] ?? x.type} channel #${x.name}${warn}`, (api) => api.write("DELETE", `/channels/${x.id}`));
	}
	for (const x of categoryMatch.extras()) extra(`category "${x.name}"`, (api) => api.write("DELETE", `/channels/${x.id}`));

	// Channel order and parent. The order is checked against the live guild as it will be after
	// this run's creates and moves, and re-read before it is applied.
	{
		const declaredParent = new Map();
		for (const c of spec.channels ?? []) declaredParent.set(c.name, null);
		for (const cat of spec.categories ?? []) for (const c of cat.channels ?? []) declaredParent.set(c.name, cat.name);
		const liveName = (c) => declaredName.get(c.id) ?? c.name;
		const catName = (id) => declaredName.get(id) ?? liveCategories.find((c) => c.id === id)?.name;
		const moves = [];
		for (const ch of liveChannels) {
			const name = liveName(ch);
			if (!declaredParent.has(name)) continue;
			const want = declaredParent.get(name);
			const have = ch.parent_id ? catName(ch.parent_id) : null;
			if (want !== have) moves.push(`#${name}: ${show(have)} → ${show(want)}`);
		}
		for (const m of moves) add("→", `move ${m}`);
		const projectedIn = (parent) => {
			const inLive = liveChannels
				.filter((c) => {
					const name = liveName(c);
					const p = declaredParent.has(name) ? declaredParent.get(name) : c.parent_id ? catName(c.parent_id) : null;
					return p === parent;
				})
				.sort(byPosition)
				.map(liveName);
			const created = [...declaredParent.entries()].filter(([n, p]) => p === parent && !inLive.includes(n) && !liveChannels.some((c) => liveName(c) === n)).map(([n]) => n);
			return [...inLive, ...created];
		};
		const orderChanges = [];
		for (const box of containers) {
			const projected = projectedIn(box.parent);
			const want = desiredOrder(box.declared, projected);
			if (!sameList(want, projected)) orderChanges.push(`${box.key}: ${projected.join(", ")} → ${want.join(", ")}`);
		}
		const liveCatOrder = [...liveCategories].sort(byPosition).map((c) => catName(c.id));
		const createdCats = (spec.categories ?? []).map((c) => c.name).filter((n) => !liveCatOrder.includes(n));
		const projectedCats = [...liveCatOrder, ...createdCats];
		const wantCats = desiredOrder((spec.categories ?? []).map((c) => c.name), projectedCats);
		if (!sameList(wantCats, projectedCats)) orderChanges.push(`categories: ${projectedCats.join(", ")} → ${wantCats.join(", ")}`);
		for (const o of orderChanges) add("↕", `order of ${o}`);
		if (moves.length || orderChanges.length) {
			steps.push({ sign: "", text: "", run: (api) => applyChannelOrder(api, g, spec, ctx) });
		}
	}

	// --- messages ---------------------------------------------------------------------------
	// The n-th declared message is the bot's n-th oldest post in the channel. Mentions never ping.
	for (const { c, liveId } of messageWork) {
		const have = (liveId && live.messages?.get(liveId)) || [];
		const body = (m) => ({ content: m.content ?? "", embeds: m.embeds ?? [], allowed_mentions: { parse: [] } });
		c.messages.forEach((m, i) => {
			const cur = have[i];
			const label = `message ${i + 1} in #${c.name}`;
			if (!cur) {
				add("+", `post ${label}: ${preview(m)}`, async (api) => {
					const made = await api.write("POST", `/channels/${channelId(c.name)}/messages`, body(m));
					ctx.created.push(["message", `${i + 1} in #${c.name}`, made.id]);
				});
				return;
			}
			const sameText = (m.content ?? "") === cur.content;
			if (sameText && covers(m.embeds ?? [], richEmbeds(cur))) return;
			const what = sameText ? "embeds changed" : firstChange(cur.content, m.content ?? "");
			add("~", `edit ${label}: ${what}`, (api) => api.write("PATCH", `/channels/${channelId(c.name)}/messages/${cur.id}`, body(m)));
		});
		for (const x of have.slice(c.messages.length)) {
			extra(`bot message in #${c.name}: ${preview(x)}`, (api) => api.write("DELETE", `/channels/${channelId(c.name)}/messages/${x.id}`));
		}
	}

	// --- guild settings ---------------------------------------------------------------------
	if (spec.guild) {
		const body = {};
		const diffs = [];
		for (const k of GUILD_FIELDS) {
			if (spec.guild[k] === undefined || spec.guild[k] === live.guild[k]) continue;
			body[k] = spec.guild[k];
			diffs.push(`${k} ${show(live.guild[k])} → ${show(spec.guild[k])}`);
		}
		const lazy = [];
		for (const k of GUILD_CHANNELS) {
			if (spec.guild[k] === undefined) continue;
			const haveName = live.channels.find((c) => c.id === live.guild[`${k}_id`])?.name ?? null;
			const haveId = live.guild[`${k}_id`] ?? null;
			const wantId = spec.guild[k] == null ? null : ctx.channels.get(spec.guild[k]);
			if (wantId && wantId === haveId) continue;
			if (spec.guild[k] == null && haveId == null) continue;
			lazy.push(k);
			diffs.push(`${k} ${show(haveName)} → ${show(spec.guild[k])}`);
		}
		if (diffs.length) {
			add("~", `guild: ${diffs.join("; ")}`, (api) => {
				for (const k of lazy) body[`${k}_id`] = channelId(spec.guild[k]);
				return api.write("PATCH", g, body);
			});
		}
		for (const [k, how] of Object.entries(OWNER_FIELDS)) {
			if (spec.guild[k] === undefined || spec.guild[k] === live.guild[k]) continue;
			add("!", `guild: ${k} ${show(live.guild[k])} → ${show(spec.guild[k])} needs the owner, by hand: ${how}`);
		}
	}

	// --- automod ----------------------------------------------------------------------------
	if (spec.automod) {
		const ruleMatch = matcher(live.automod);
		for (const r of spec.automod) {
			const m = { hit: ruleMatch.match(r) };
			const body = (withType) => {
				const out = { name: r.name };
				if (withType) out.trigger_type = r.trigger_type;
				for (const k of AUTOMOD_FIELDS) if (r[k] !== undefined) out[k] = r[k];
				if (r.actions) out.actions = idActions(r.actions, channelId);
				if (r.exempt_roles) out.exempt_roles = r.exempt_roles.map(roleId);
				if (r.exempt_channels) out.exempt_channels = r.exempt_channels.map(channelId);
				return out;
			};
			const label = `automod rule "${r.name}"`;
			if (!m.hit) {
				add("+", `create ${label}`, async (api) => {
					const made = await api.write("POST", `${g}/auto-moderation/rules`, body(true));
					ctx.created.push(["automod rule", r.name, made.id]);
				});
				continue;
			}
			if (r.trigger_type !== undefined && r.trigger_type !== m.hit.trigger_type) {
				throw new Error(`${label}: trigger_type cannot change on an existing rule (${m.hit.trigger_type} → ${r.trigger_type}); rename it to create a new one`);
			}
			const diffs = [];
			if (m.hit.name !== r.name) diffs.push(`name ${show(m.hit.name)} → ${show(r.name)}`);
			const have = { ...m.hit, actions: namedActions(m.hit.actions, (id) => live.channels.find((c) => c.id === id)?.name) };
			for (const k of AUTOMOD_FIELDS) if (r[k] !== undefined && !covers(r[k], have[k])) diffs.push(`${k} ${show(have[k])} → ${show(r[k])}`);
			const sameSet = (names, ids, toId) => names === undefined || sameList([...names.map((n) => ctx[toId].get(n) ?? n)].sort(), [...ids].sort());
			if (!sameSet(r.exempt_roles, m.hit.exempt_roles, "roles")) diffs.push(`exempt_roles → [${r.exempt_roles.join(", ")}]`);
			if (!sameSet(r.exempt_channels, m.hit.exempt_channels, "channels")) diffs.push(`exempt_channels → [${r.exempt_channels.join(", ")}]`);
			if (diffs.length) add("~", `${label}: ${diffs.join("; ")}`, (api) => api.write("PATCH", `${g}/auto-moderation/rules/${m.hit.id}`, body(false)));
		}
		for (const x of ruleMatch.extras()) extra(`automod rule "${x.name}"`, (api) => api.write("DELETE", `${g}/auto-moderation/rules/${x.id}`));
	}

	// --- welcome screen and onboarding --------------------------------------------------------
	if (spec.welcome_screen) {
		const want = spec.welcome_screen;
		const have = live.welcome && {
			enabled: live.guild.features.includes("WELCOME_SCREEN_ENABLED"),
			description: live.welcome.description,
			welcome_channels: live.welcome.welcome_channels.map((w) => ({ channel: live.channels.find((c) => c.id === w.channel_id)?.name ?? null, description: w.description, emoji_name: w.emoji_name, emoji_id: w.emoji_id })),
		};
		if (!covers(want, have)) {
			add(have ? "~" : "+", `welcome screen: ${show(have)} → ${show(want)}`, (api) =>
				api.write("PATCH", `${g}/welcome-screen`, {
					enabled: want.enabled,
					description: want.description,
					welcome_channels: (want.welcome_channels ?? []).map((w) => ({ channel_id: channelId(w.channel), description: w.description, emoji_name: w.emoji_name ?? null, emoji_id: w.emoji_id ?? null })),
				}),
			);
		}
	}
	if (spec.onboarding) {
		const roleName = (id) => live.roles.find((r) => r.id === id)?.name ?? `role:${id}`;
		const channelName = (id) => live.channels.find((c) => c.id === id)?.name ?? null;
		const have = exportOnboarding(live.onboarding, roleName, channelName);
		if (!covers(spec.onboarding, have)) {
			add("~", `onboarding: ${show(have)} → ${show(spec.onboarding)}`, (api) =>
				api.write("PUT", `${g}/onboarding`, onboardingBody(spec.onboarding, live.onboarding, roleId, channelId)),
			);
		}
	}

	return { steps: [...steps, ...pruneSteps], ctx };

	function extra(text, run) {
		pruneSteps.push(prune ? { sign: "-", text: `delete ${text}`, run } : { sign: "?", text: `extra ${text} (kept: no --prune)` });
	}
}

function permissionDiff(from, to, label = "permissions") {
	const a = new Set(permissionNames(from));
	const b = new Set(permissionNames(to));
	const plus = [...b].filter((x) => !a.has(x)).map((x) => `+${x}`);
	const minus = [...a].filter((x) => !b.has(x)).map((x) => `-${x}`);
	return plus.length || minus.length ? `${label} ${[...plus, ...minus].join(" ")}` : `${label} unchanged`;
}

/** The PUT body for onboarding. A prompt or option keeps its live id when its title matches. */
function onboardingBody(want, live, roleId, channelId) {
	return {
		enabled: want.enabled,
		mode: want.mode ?? 0,
		default_channel_ids: (want.default_channels ?? []).map(channelId),
		prompts: (want.prompts ?? []).map((p) => {
			const lp = live.prompts.find((x) => x.title === p.title);
			return {
				id: lp?.id ?? snowflake(),
				title: p.title,
				type: p.type ?? 0,
				single_select: !!p.single_select,
				required: !!p.required,
				in_onboarding: p.in_onboarding ?? true,
				options: (p.options ?? []).map((op) => ({
					id: lp?.options.find((x) => x.title === op.title)?.id ?? snowflake(),
					title: op.title,
					description: op.description ?? null,
					emoji_name: op.emoji_name ?? null,
					emoji_id: op.emoji_id ?? null,
					channel_ids: (op.channels ?? []).map(channelId),
					role_ids: (op.roles ?? []).map(roleId),
				})),
			};
		}),
	};
}

/**
 * Positions and parents of every channel, recomputed from a fresh read: by now the run has created
 * what it had to, and Discord placed each new channel at the end of its category.
 */
async function applyChannelOrder(api, g, spec, ctx) {
	const channels = await api.get(`${g}/channels`);
	const updates = [];
	const place = (items, declared, parentId) => {
		const byId = new Map(items.map((c) => [c.id, c]));
		const liveIds = [...items].sort(byPosition).map((c) => c.id);
		const want = desiredOrder(declared.filter(Boolean), liveIds);
		const parentsOk = parentId === undefined || want.every((id) => (byId.get(id)?.parent_id ?? null) === parentId);
		if (sameList(want, liveIds) && parentsOk) return;
		want.forEach((id, i) => updates.push({ id, position: i, ...(parentId !== undefined ? { parent_id: parentId } : {}) }));
	};
	const declaredParent = new Map();
	for (const c of spec.channels ?? []) declaredParent.set(ctx.channels.get(c.name), null);
	for (const cat of spec.categories ?? []) for (const c of cat.channels ?? []) declaredParent.set(ctx.channels.get(c.name), ctx.categories.get(cat.name));
	const parentOf = (c) => (declaredParent.has(c.id) ? declaredParent.get(c.id) : c.parent_id ?? null);
	const nonCat = channels.filter((c) => c.type !== CHANNEL_TYPES.category);
	place(nonCat.filter((c) => parentOf(c) === null), (spec.channels ?? []).map((c) => ctx.channels.get(c.name)), null);
	for (const cat of spec.categories ?? []) {
		const cid = ctx.categories.get(cat.name);
		place(nonCat.filter((c) => parentOf(c) === cid), (cat.channels ?? []).map((c) => ctx.channels.get(c.name)), cid);
	}
	place(channels.filter((c) => c.type === CHANNEL_TYPES.category), (spec.categories ?? []).map((c) => ctx.categories.get(c.name)), undefined);
	if (updates.length) await api.write("PATCH", `${g}/channels`, updates);
}

// ---------------------------------------------------------------------------------------------

async function main(argv) {
	const flag = (f) => argv.includes(f);
	const fileArg = argv.indexOf("--file");
	const file = fileArg >= 0 ? resolve(argv[fileArg + 1]) : DEFAULT_FILE;
	const token = process.env.DISCORD_TOKEN;
	const guildId = process.env.DISCORD_GUILD_ID;
	if (!token || !guildId) throw new Error("DISCORD_TOKEN and DISCORD_GUILD_ID are required");
	const apply = flag("--apply");
	const prune = flag("--prune");
	const api = client(token, { apply });

	// An export reads the current file too, when there is one: the channels it gives `messages` keep
	// them, filled with the bot's live posts.
	if (flag("--export")) {
		const current = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
		const text = formatJson(exportServer(await readGuild(api, guildId, current))) + "\n";
		if (fileArg >= 0) writeFileSync(file, text);
		else process.stdout.write(text);
		return;
	}

	const spec = JSON.parse(readFileSync(file, "utf8"));
	const errors = validate(spec);
	if (errors.length) throw new Error(`server.json is invalid:\n${errors.join("\n")}`);
	const live = await readGuild(api, guildId, spec);
	const { steps, ctx } = plan(spec, live, { prune });
	const lines = steps.filter((s) => s.text).map((s) => `${s.sign} ${s.text}`);
	const changes = steps.filter((s) => s.text && "+~↕→-".includes(s.sign)).length;
	const extras = steps.filter((s) => s.sign === "?").length;
	const mode = (apply ? "apply" : "dry run") + (prune ? " + prune" : "");
	const head = changes ? `${changes} change(s)` : `nothing to do${extras ? ` (${extras} extra(s) kept)` : ""}`;
	console.log(`server.json → guild ${live.guild.name} [${mode}]: ${head}`);
	for (const l of lines) console.log(l);

	const failures = [];
	if (apply) {
		for (const s of steps.filter((s) => s.run)) {
			try {
				await s.run(api);
			} catch (e) {
				failures.push(`${s.text || "channel order"}: ${e.message}`);
				console.error(`::error::${s.text || "channel order"}: ${e.message}`);
			}
		}
		for (const [kind, name, id] of ctx.created) console.log(`created ${kind} "${name}" = ${id}`);
	}

	if (process.env.GITHUB_STEP_SUMMARY) {
		const md = [`### server.json [${mode}]: ${head}`, ""];
		if (lines.length) md.push("```diff", ...lines, "```", "");
		if (ctx.created.length) md.push("| Created | Name | Id |", "|---|---|---|", ...ctx.created.map(([k, n, id]) => `| ${k} | ${n} | \`${id}\` |`), "");
		if (failures.length) md.push("**Failed:**", ...failures.map((f) => `- ${f}`), "");
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join("\n") + "\n");
	}
	if (failures.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).catch((e) => {
		console.error(e.message);
		process.exit(1);
	});
}
