import nacl from "tweetnacl";

const DISCORD_API = "https://discord.com/api/v10";
const EMBED_COLOR = 0xF2C94C;

let INDEX_CACHE = null;
let INDEX_CACHE_TS = 0;
const INDEX_TTL_MS = 5 * 60 * 1000;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function hexToBytes(hex) {
  if (!hex || typeof hex !== "string") return new Uint8Array();
  const clean = hex.trim();
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  return bytes;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function slugify(s) {
  return (s || "")
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function stripEmbedUrls(embeds) {
  if (!Array.isArray(embeds)) return [];
  return embeds.map((e) => {
    if (!e || typeof e !== "object") return e;
    const { url, ...rest } = e;
    return rest;
  });
}

function normalizeHttpUrl(u) {
  if (!u || typeof u !== "string") return "";
  const s = u.trim();
  if (s.startsWith("//")) return "https:" + s;
  if (/^https?:\/\//i.test(s)) return s;
  return "";
}

function sanitizeEmbed(e) {
  if (!e || typeof e !== "object") return e;
  const out = { ...e };

  if (out.thumbnail && out.thumbnail.url) {
    const nu = normalizeHttpUrl(out.thumbnail.url);
    if (nu) out.thumbnail.url = nu; else delete out.thumbnail;
  }

  if (out.image && out.image.url) {
    const nu = normalizeHttpUrl(out.image.url);
    if (nu) out.image.url = nu; else delete out.image;
  }

  if (out.author && out.author.icon_url) {
    const nu = normalizeHttpUrl(out.author.icon_url);
    if (nu) out.author.icon_url = nu; else delete out.author.icon_url;
  }

  return out;
}
function enforceEmbedStyle(embeds) {
  const clean = stripEmbedUrls(embeds).map(sanitizeEmbed).filter(Boolean);
  return clean.map((e) => ({ ...e, color: EMBED_COLOR }));
}

function chunkEmbeds(embeds, size = 10) {
  const out = [];
  for (let i = 0; i < embeds.length; i += size) out.push(embeds.slice(i, i + size));
  return out;
}

function normalizePayloadToMessages(payload) {
  if (!payload) return [];
  if (payload.messages && Array.isArray(payload.messages)) {
    return payload.messages
      .filter((m) => m && Array.isArray(m.embeds) && m.embeds.length)
      .flatMap((m) => chunkEmbeds(m.embeds, 10).map((embeds) => ({ embeds })));
  }
  if (payload.embeds && Array.isArray(payload.embeds)) {
    return payload.embeds.length ? chunkEmbeds(payload.embeds, 10).map((embeds) => ({ embeds })) : [];
  }
  if (Array.isArray(payload)) {
    return payload.length ? chunkEmbeds(payload, 10).map((embeds) => ({ embeds })) : [];
  }
  return [];
}

function optionMap(options) {
  const out = {};
  if (!Array.isArray(options)) return out;
  for (const o of options) {
    if (!o) continue;
    if (o.type === 1 && Array.isArray(o.options)) {
      Object.assign(out, optionMap(o.options));
      continue;
    }
    out[o.name] = o.value;
  }
  return out;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "user-agent": "GuildAssistantDB/1.0" } });
  const txt = await res.text();
  if (!res.ok) throw new Error(`fetch ${res.status} ${url} :: ${txt.slice(0, 200)}`);
  return JSON.parse(txt);
}

async function getIndex(env) {
  const now = Date.now();
  if (INDEX_CACHE && now - INDEX_CACHE_TS < INDEX_TTL_MS) return INDEX_CACHE;

  const url = `${env.GITHUB_RAW_BASE}/index.json`;
  console.log("getIndex", url);
  const idx = await fetchJson(url);

  INDEX_CACHE = idx;
  INDEX_CACHE_TS = now;
  return idx;
}

function bestMatch(items, queryName) {
  const q = slugify(queryName);
  if (!q) return null;
  return (
    items.find((it) => slugify(it.slug || "") === q) ||
    items.find((it) => slugify(it.name || "") === q) ||
    items.find((it) => slugify(it.name || "").includes(q)) ||
    null
  );
}

function topMatches(items, queryName, limit = 10) {
  const q = slugify(queryName);
  if (!q) return [];
  return items
    .map((it) => {
      const n = slugify(it.name || "");
      const s = slugify(it.slug || "");
      let score = 0;
      if (s === q || n === q) score += 100;
      if (n.includes(q)) score += 50;
      if (s.includes(q)) score += 40;
      return { it, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.it);
}

async function patchDiscord(url, body) {
  for (let i = 0; i < 6; i++) {
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const txt = await res.text().catch(() => "");
    if (res.ok) return true;
    console.log("PATCH fail", res.status, txt.slice(0, 200));
    await sleep(300 * (i + 1));
  }
  return false;
}

async function postDiscord(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const txt = await res.text().catch(() => "");
  if (!res.ok) console.log("POST fail", res.status, txt.slice(0, 200));
  return res.ok;
}

async function editOriginal(env, interaction, embeds) {
  const url = `${DISCORD_API}/webhooks/${env.DISCORD_APPLICATION_ID}/${interaction.token}/messages/@original`;
  const body = { allowed_mentions: { parse: [] }, embeds: enforceEmbedStyle(embeds).slice(0, 10) };
  console.log("editOriginal", url, body.embeds.length);
  await patchDiscord(url, body);
}

async function sendFollowups(env, interaction, messages) {
  const url = `${DISCORD_API}/webhooks/${env.DISCORD_APPLICATION_ID}/${interaction.token}`;
  for (const m of messages) {
    const embeds = enforceEmbedStyle(m.embeds || []).slice(0, 10);
    if (!embeds.length) continue;
    console.log("followup", embeds.length);
    await postDiscord(url, { allowed_mentions: { parse: [] }, embeds });
  }
}

async function handlePerso(env, interaction, opts) {
  const game = (opts.jeu || "").toString().toLowerCase();
  const name = (opts.nom || "").toString();
  console.log("handlePerso", game, name);

  const idx = await getIndex(env);
  const items = (idx.items || []).filter((it) => it.game === game && it.type === "character");

  const pick = bestMatch(items, name);
  if (!pick) {
    const sugg = topMatches(items, name, 10);
    const lines = sugg.map((s) => `â€¢ ${s.name}`).join("\n") || "Aucun rÃ©sultat.";
    await editOriginal(env, interaction, [{ title: "RÃ©sultats", description: lines, color: EMBED_COLOR }]);
    return;
  }

  const payloadUrl = `${env.GITHUB_RAW_BASE}/${pick.embeds_path}`;
  console.log("fetch embeds", payloadUrl);
  const payload = await fetchJson(payloadUrl);
  const messages = normalizePayloadToMessages(payload);

  if (!messages.length) {
    await editOriginal(env, interaction, [{ title: "Erreur", description: "Aucun embed trouvÃ©.", color: 0xE74C3C }]);
    return;
  }

  await editOriginal(env, interaction, messages[0].embeds || []);
  const rest = messages.slice(1);
  if (rest.length) await sendFollowups(env, interaction, rest);
}

async function processInteraction(env, interaction) {
  try {
    const cmd = interaction?.data?.name;
    const opts = optionMap(interaction?.data?.options || []);
    console.log("processInteraction", cmd, JSON.stringify(opts));

    if (cmd === "perso") return await handlePerso(env, interaction, opts);

    await editOriginal(env, interaction, [{ title: "Commande inconnue", description: `/${cmd}`, color: EMBED_COLOR }]);
  } catch (e) {
    console.log("processInteraction error", String(e?.message || e));
    await editOriginal(env, interaction, [{ title: "Erreur", description: String(e?.message || e), color: 0xE74C3C }]);
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("ok", { status: 200 });

    const signature = request.headers.get("X-Signature-Ed25519");
    const timestamp = request.headers.get("X-Signature-Timestamp");
    const body = await request.text();

    const publicKey = env.DISCORD_PUBLIC_KEY;
    if (!publicKey) return new Response("Missing DISCORD_PUBLIC_KEY", { status: 500 });

    const ok = nacl.sign.detached.verify(
      new TextEncoder().encode(timestamp + body),
      hexToBytes(signature),
      hexToBytes(publicKey)
    );
    if (!ok) return new Response("Bad request signature", { status: 401 });

    const interaction = JSON.parse(body);

    if (interaction.type === 1) return json({ type: 1 });

    if (interaction.type === 2) {
      ctx.waitUntil(processInteraction(env, interaction));
      return json({
        type: 4,
        data: {
          allowed_mentions: { parse: [] },
          embeds: [{ title: "Chargementâ€¦", description: "Je rÃ©cupÃ¨re les infos.", color: EMBED_COLOR }],
        },
      });
    }

    return json({ type: 4, data: { content: "Unsupported interaction." } });
  },
};