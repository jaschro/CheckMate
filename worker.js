// CheckMate — Cloudflare Worker (KV storage)
//
//   GET  /                     serves the app (index.html) from the public repo
//   GET  /doc?token=...        -> { text, rev }
//   GET  /doc?token=...&rev=N  -> { text, rev } for an older revision
//   GET  /history?token=...    -> { head, keep }
//   PUT  /doc?token=...        body { text, rev, message? }
//                              -> { rev }, or 409 + { text, rev } if yours is stale
//
// Setup on the Worker:
//   Variables and Secrets
//     SECRET_TOKEN   Secret. A long random string. The app sends it on every request.
//     APP_URL        Text, optional. Where index.html is fetched from.
//                    Defaults to the public CheckMate repo.
//   Bindings
//     KV namespace, variable name: CM
//
// There is no GitHub token here. The notes live in KV; the app's HTML comes from a
// public URL. Nothing the Worker holds can read or write your GitHub account.
//
// Keys in KV:
//   head        { rev, at }        which revision is current
//   rev:<n>     the document text  every save keeps the previous ones
//
// Each save is two writes (the new revision, and head). The free plan allows
// 1,000 writes a day, so roughly 400 saves a day with room to spare.

const KEEP = 50;                       // how many past revisions to hold on to

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,PUT,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS }
  });

const DEFAULT_APP =
  "https://raw.githubusercontent.com/jaschro/CheckMate/main/index.html";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    // The app itself. Public URL, no credentials involved.
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const src = env.APP_URL || DEFAULT_APP;
      const res = await fetch(src, { cf: { cacheTtl: 60, cacheEverything: true } });
      if (!res.ok) return new Response(`Could not fetch the app from ${src}`, { status: 502 });
      return new Response(await res.text(), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" }
      });
    }

    if (url.searchParams.get("token") !== env.SECRET_TOKEN) {
      return json({ error: "bad token" }, 401);
    }
    if (!env.CM) {
      return json({ error: "no KV namespace bound as CM" }, 500);
    }

    async function head() {
      const raw = await env.CM.get("head");
      if (!raw) return { rev: 0, at: null };
      try { return JSON.parse(raw); } catch { return { rev: 0, at: null }; }
    }
    const textAt = async (rev) => (rev > 0 ? (await env.CM.get(`rev:${rev}`)) || "" : "");

    if (url.pathname === "/history" && request.method === "GET") {
      const h = await head();
      return json({ head: h.rev, at: h.at, keep: KEEP });
    }

    if (url.pathname === "/doc" && request.method === "GET") {
      const h = await head();
      const asked = url.searchParams.get("rev");
      if (asked) {
        const n = parseInt(asked, 10);
        if (!n || n > h.rev || n <= h.rev - KEEP) return json({ error: "no such revision" }, 404);
        return json({ text: await textAt(n), rev: n, head: h.rev });
      }
      return json({ text: await textAt(h.rev), rev: h.rev });
    }

    if (url.pathname === "/doc" && request.method === "PUT") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "expected JSON" }, 400); }
      if (typeof body.text !== "string") return json({ error: "text is required" }, 400);

      const h = await head();

      // Somebody else saved since this device loaded. Hand their version back
      // instead of clobbering it; the app asks which one to keep.
      // KV reads can lag a little, so this also catches a stale read — the cost
      // is an occasional prompt, never a silent overwrite.
      if (h.rev !== 0 && Number(body.rev) !== h.rev) {
        return json({ conflict: true, text: await textAt(h.rev), rev: h.rev }, 409);
      }

      // A write that drops most of the document is nearly always a bug.
      const before = (await textAt(h.rev)).split("\n").filter((l) => l.trim()).length;
      const after = body.text.split("\n").filter((l) => l.trim()).length;
      if (!body.allowShrink && before > 10 && after < before * 0.5) {
        return json({ error: "refusing to shrink the document", before, after }, 409);
      }

      const next = h.rev + 1;
      await env.CM.put(`rev:${next}`, body.text);
      await env.CM.put("head", JSON.stringify({ rev: next, at: new Date().toISOString() }));

      // Drop the revision that just fell off the end. Best effort.
      const stale = next - KEEP;
      if (stale > 0) { try { await env.CM.delete(`rev:${stale}`); } catch {} }

      return json({ rev: next });
    }

    return json({ error: "not found" }, 404);
  }
};
