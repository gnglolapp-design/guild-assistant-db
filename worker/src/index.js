import nacl from "tweetnacl";

const EMBED_COLOR = 0xC99700; // #C99700
const USER_AGENT = "guild-assistant-db/1.0";

function hexToBytes(hex) {
  if (!hex || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function verifyDiscordSignature(request, publicKeyHex) {
  const sigHex = request.headers.get("x-signature-ed25519") || request.headers.get("X-Signature-Ed25519");
  const ts = request.headers.get("x-signature-timestamp") || request.headers.get("X-Signature-Timestamp");
  if (!sigHex || !ts) return false;

  const sig = hexToBytes(sigHex);
  const pub = hexToBytes(publicKeyHex);
  if (!sig || !pub) return false;

  const bodyBuf = await request.clone().arrayBuffer();
  const bodyBytes = new Uint8Array(bodyBuf);
  const tsBytes = new TextEncoder().encode(ts);

  const msg = new Uint8Array(tsBytes.length + bodyBytes.length);
  msg.set(tsBytes, 0);
  msg.set(bodyBytes, tsBytes.length);

  return nacl.sign.detached.verify(msg, sig, pub);
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!r.ok) throw new Error(`fetch ${url} -> ${r.status}`);
  return await r.json();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function enforceEmbedStyle(embeds) {
  if (!Array.isArray(embeds)) return [];
  // Supprime url pour éviter le titre cliquable + applique la couleur.
  return embeds.map((e) => {
    if (!e || typeof e !== "object") return e;
    const { url, ...rest } = e;
    return { ...rest, color: EMBED_COLOR };
  });
}

function chunkEmbeds(embeds, size = 10) {
  const out = [];
  const arr = Array.isArray(embeds) ? embeds : [];
  for (let i = 0; i < arr.length; i += size) {
    out.push({ embeds: arr.slice(i, i + size) });
  }
  return out;
}

function normalizeMessagesPayload(payload) {
  // Supporte :
  // - ancien format : { embeds: [...] }
  // - nouveau format : { messages: [ { embeds:[...] }, ... ] }
  // Toujours : max 10 embeds / message
  if (!payload || typeof payload !== "object") return [];

  if (Array.isArray(payload.messages)) {
    return payload.messages
      .filter((m) => m && Array.isArray(m.embeds) && m.embeds.length)
      .flatMap((m) => chunkEmbeds(m.embeds, 10));
  }

  if (Array.isArray(payload.embeds) && payload.embeds.length) {
    return chunkEmbeds(payload.embeds, 10);
  }

  return [];
}

function frError(content) {
  return {
    type: 4,
    data: {
      allowed_mentions: { parse: [] },
      content,
    },
  };
}

function stripEmbedUrls(embeds) {
  if (!Array.isArray(embeds)) return [];
  return embeds.map((e) => {
    if (!e || typeof e !== "object") return e;
    const { url, ...rest } = e;
    return rest;
  });
}
function frEmbedsResponse(embeds) {
  const clean = stripEmbedUrls(embeds).slice(0, 10);
  return {
    type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
    data: {
      allowed_mentions: { parse: [] },
      embeds: clean,
    },
  };
}

function normalize(s) {
  return (s || "").toString().trim().toLowerCase();
}

function fuzzyScore(query, target) {
  // simple et efficace : score par inclusion / prÃƒÂ©fixe
  if (!query || !target) return 0;
  if (target === query) return 100;
  if (target.startsWith(query)) return 80;
  if (target.includes(query)) return 60;
  return 0;
}

async function handleRecherche(env, query, game) {
  const base = env.GITHUB_RAW_BASE;
  const idx = await fetchJson(`${base}/index.json`);
  const q = normalize(query);
  const g = normalize(game);

  const ranked = idx.items
    .filter(x => !g || normalize(x.game) === g)
    .map(x => {
      const s1 = fuzzyScore(q, normalize(x.name));
      const s2 = fuzzyScore(q, normalize(x.slug));
      return { x, score: Math.max(s1, s2) };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  if (ranked.length === 0) {
    return frError("Je nÃ¢â‚¬â„¢ai rien trouvÃƒÂ©. Essaie un autre mot-clÃƒÂ© (ex: `melio`, `red`, `demon`).");
  }

  const lines = ranked.map(r => {
    const typeFr = r.x.type === "character" ? "Perso" : r.x.type === "boss" ? "Boss" : r.x.type;
    return `Ã¢â‚¬Â¢ **${typeFr}** Ã¢â‚¬â€ ${r.x.name} *(jeu: ${r.x.game})*`;
  }).join("\n");

  return {
    type: 4,
    data: {
      allowed_mentions: { parse: [] },
      embeds: [{
        title: "RÃƒÂ©sultats",
        description: lines,
        color: EMBED_COLOR,
        footer: { text: "Guild Assistant DB" }
      }]
    }
  };
}

async function postDiscordWebhookJson(url, body, maxRetries = 4) {
  // Gestion simple des rate limits (429) : on attend retry_after puis on retente.
  // On conserve une petite pause entre les posts mÃƒÂªme hors 429.
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": USER_AGENT },
      body: JSON.stringify(body),
    });

    if (r.status !== 429) {
      await sleep(250);
      return r;
    }

    let retryMs = 1200;
    const h = r.headers.get("retry-after");
    if (h) {
      const s = Number(h);
      if (Number.isFinite(s) && s > 0) retryMs = Math.ceil(s * 1000);
    }

    try {
      const j = await r.json();
      const s = Number(j?.retry_after);
      if (Number.isFinite(s) && s > 0) retryMs = Math.ceil(s * 1000);
    } catch (_) {
      // ignore
    }

    retryMs = Math.min(retryMs + attempt * 250, 8000);
    await sleep(retryMs);
  }
}

async function sendFollowups(env, interaction, messages) {
  const appId = env.DISCORD_APPLICATION_ID || interaction.application_id;
  const token = interaction.token;
  if (!appId || !token) return;

  const url = `https://discord.com/api/v10/webhooks/${appId}/${token}`;

  let i = 0;
  for (const m of messages) {
    const embeds = enforceEmbedStyle((m.embeds || [])).slice(0, 10);
    if (!embeds.length) continue;

    const content = i === 0 ? "suite" : "suite";
    await postDiscordWebhookJson(url, {
      allowed_mentions: { parse: [] },
      content,
      embeds,
    });
    i++;
  }
}
async function handleEntity(env, interaction, ctx, type, game, nameOrSlug) {
  const base = env.GITHUB_RAW_BASE;
  const idx = await fetchJson(`${base}/index.json`);
  const q = normalize(nameOrSlug);
  const g = normalize(game);

  const candidates = idx.items.filter(x => x.type === type && (!g || normalize(x.game) === g));
  if (candidates.length === 0) {
    return frError("Aucune donnÃƒÂ©e disponible pour ce jeu pour lÃ¢â‚¬â„¢instant.");
  }

  let best = null;
  let bestScore = -1;
  for (const x of candidates) {
    const s = Math.max(fuzzyScore(q, normalize(x.name)), fuzzyScore(q, normalize(x.slug)));
    if (s > bestScore) { bestScore = s; best = x; }
  }
  if (!best || bestScore <= 0) {
    return frError(`Je nÃ¢â‚¬â„¢ai pas trouvÃƒÂ© ce ${type === "character" ? "perso" : "boss"}. Essaie /recherche.`);
  }

  const payload = await fetchJson(`${base}/${best.embeds_path}`);

  const messages = normalizeMessagesPayload(payload);

  if (messages.length === 0 || !Array.isArray(messages[0].embeds) || messages[0].embeds.length === 0) {
    return frError("DonnÃƒÂ©e trouvÃƒÂ©e, mais embeds vides. (La sync nÃ¢â‚¬â„¢a peut-ÃƒÂªtre pas encore gÃƒÂ©nÃƒÂ©rÃƒÂ© la fiche.)");
  }

  const firstEmbeds = messages[0].embeds;
  const rest = messages.slice(1);

  if (rest.length > 0 && ctx) {
    ctx.waitUntil(sendFollowups(env, interaction, rest));
  }

  return frEmbedsResponse(firstEmbeds);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname !== "/interactions") {
      return new Response("OK", { status: 200 });
    }
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const publicKey = env.DISCORD_PUBLIC_KEY;
    if (!publicKey) {
      return new Response("DISCORD_PUBLIC_KEY manquant", { status: 500 });
    }

    const ok = await verifyDiscordSignature(request, publicKey);
    if (!ok) {
      return new Response("Invalid request signature", { status: 401 });
    }

    const interaction = await request.json();

    // PING -> PONG (Discord valide lÃ¢â‚¬â„¢endpoint comme ÃƒÂ§a)
    if (interaction.type === 1) {
      return Response.json({ type: 1 });
    }

    // Slash command
    if (interaction.type === 2) {
      const name = normalize(interaction.data?.name);

      const opts = interaction.data?.options || [];
      const getOpt = (n) => {
        const o = opts.find(x => normalize(x.name) === normalize(n));
        return o ? o.value : null;
      };

      try {
        if (name === "recherche") {
          const texte = getOpt("texte");
          const game = getOpt("jeu") || "";
          if (!texte) return Response.json(frError("Il me faut `texte`."));
          return Response.json(await handleRecherche(env, texte, game));
        }

        if (name === "perso") {
          const who = getOpt("nom");
          const game = getOpt("jeu") || "";
          if (!who) return Response.json(frError("Il me faut `nom`."));
          return Response.json(await handleEntity(env, interaction, ctx, "character", game, who));
        }

        if (name === "boss") {
          const who = getOpt("nom");
          const game = getOpt("jeu") || "";
          if (!who) return Response.json(frError("Il me faut `nom`."));
          return Response.json(await handleEntity(env, interaction, ctx, "boss", game, who));
        }

        return Response.json(frError("Commande inconnue."));
      } catch (e) {
        return Response.json(frError(`Erreur interne : ${String(e).slice(0, 180)}`));
      }
    }

    return Response.json(frError("Interaction non gÃƒÂ©rÃƒÂ©e."));
  }
};
