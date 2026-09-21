// CheckMate — Cloudflare Worker (KV storage + a connector for Claude)
//
//   GET  /                     serves the app (index.html) from the public repo
//   GET  /doc?token=...        -> { text, rev }
//   GET  /doc?token=...&rev=N  -> { text, rev } for an older revision
//   GET  /history?token=...    -> { head, keep }
//   PUT  /doc?token=...        body { text, rev, message? }
//                              -> { rev }, or 409 + { text, rev } if yours is stale
//
//   POST /mcp/<MCP_TOKEN>      The connector. Claude talks MCP (Model Context
//                              Protocol) here: it asks what tools exist, then calls
//                              them. Add https://<this worker>/mcp/<MCP_TOKEN> as a
//                              custom connector in Claude's settings.
//
// Setup on the Worker:
//   Variables and Secrets
//     SECRET_TOKEN   Secret. The app's key. The app sends it on every request.
//     MCP_TOKEN      Secret. Claude's key, deliberately separate from the app's.
//                    Delete it and Claude is cut off; the app and your phone
//                    keep working. Leave it unset and the connector stays off.
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
// 1,000 writes a day, so roughly 400 saves a day with room to spare. Claude's
// changes go through exactly the same revisions, so any of them can be undone.

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

// Compare secrets without leaking, through timing, how much of a guess was right.
function same(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const A = new TextEncoder().encode(a), B = new TextEncoder().encode(b);
  if (A.length !== B.length) return false;
  if (globalThis.crypto && crypto.subtle && crypto.subtle.timingSafeEqual) {
    return crypto.subtle.timingSafeEqual(A, B);
  }
  let d = 0;
  for (let i = 0; i < A.length; i++) d |= A[i] ^ B[i];
  return d === 0;
}

/* ------------------------------------------------------------------ storage */

async function readHead(env) {
  const raw = await env.CM.get("head");
  if (!raw) return { rev: 0, at: null };
  try { return JSON.parse(raw); } catch { return { rev: 0, at: null }; }
}
const textAt = async (env, rev) => (rev > 0 ? (await env.CM.get(`rev:${rev}`)) || "" : "");

async function commit(env, h, text) {
  const next = h.rev + 1;
  await env.CM.put(`rev:${next}`, text);
  await env.CM.put("head", JSON.stringify({ rev: next, at: new Date().toISOString() }));
  // Drop the revision that just fell off the end. Best effort.
  const stale = next - KEEP;
  if (stale > 0) { try { await env.CM.delete(`rev:${stale}`); } catch {} }
  return next;
}

/* ------------------------------------------------------------------ the file format
   A port of the app's parser and serializer. The file is the contract between
   the two, so these must read and write it exactly as the app does. Edits are
   spliced in: blocks the connector does not touch keep every byte they had. */

const SLOT_RE = /^(?:\d{4}-\d{2}-\d{2}|[A-Z][a-z]{2})[T@]?\d{1,2}(?::\d{2})?(?:[ap]m?)?$/;
const ID_RE = /(?:\s+|^)\^(\S+)\s*$/;
const TABLE_RE = /^\s*<!--\s*domains:\s*(.*?)\s*-->\s*$/;

function parseEst(tok) {
  const m = /^([\d.]+)(m|h)$/.exec(tok);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Math.round(m[2] === "h" ? n * 60 : n);
}
function estToken(m) {
  if (m >= 60) return (m % 60 === 0 ? m / 60 : (m / 60).toFixed(1)) + "h";
  return m + "m";
}
const dedent = (line, n) => line.replace(new RegExp("^ {0," + n + "}"), "");
function cleanDomain(v) {
  return String(v || "").replace(/[#=,\[\]()~!@>^]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
}

function readTable(body) {
  const map = {};
  body.split(",").forEach((pair) => {
    const kv = pair.split("=");
    if (kv.length === 2 && kv[0].trim()) map[kv[0].trim()] = kv[1].trim() === "Work" ? "Work" : "Personal";
  });
  return map;
}
const tableLine = (map) =>
  "<!-- domains: " + Object.keys(map).map((d) => d + "=" + map[d]).join(", ") + " -->";

function blockFrom(ls, id, table) {
  const known = (d) => d.indexOf(" ") < 0 || Object.prototype.hasOwnProperty.call(table, d);
  const first = ls[0];
  const h = /^\s*##\s+(.*)$/.exec(first);
  if (h) return { kind: "head", text: h[1].replace(/\s+$/, ""), depth: 0, id };

  const t = /^(\s*)- \[([ xX\-])\](?:\s(.*))?$/.exec(first);
  if (!t) {
    const pad0 = /^(\s*)/.exec(first)[1].length;
    const nl = ls.map((l) => dedent(l, pad0));
    for (let k = 0; k < nl.length && /^<br\s*\/?>$/i.test(nl[k].trim()); k++) nl[k] = "";
    return { kind: "note", depth: Math.floor(pad0 / 2), id, text: nl.join("\n").replace(/\s+$/, "") };
  }

  const pad = t[1].length;
  const o = { kind: "task", state: t[2].toLowerCase() === " " ? " " : t[2].toLowerCase(),
              depth: Math.floor(pad / 2), id };
  let rest = t[3] || "", m2, go = true;
  while (go) {
    go = false;
    if ((m2 = /\s+\[([^\]]*)\]\((\S+)\)$/.exec(rest))) { o.link = { title: m2[1], url: m2[2] }; rest = rest.slice(0, m2.index); go = true; continue; }
    if ((m2 = /\s+#([A-Za-z][\w-]*(?: [A-Za-z][\w-]*){0,3})$/.exec(rest)) && known(m2[1])) {
      o.domain = m2[1]; rest = rest.slice(0, m2.index); go = true; continue;
    }
    if ((m2 = /\s+=(Work|Personal)$/.exec(rest))) { o.realm = m2[1]; rest = rest.slice(0, m2.index); go = true; continue; }
    if ((m2 = /\s+!([123])$/.exec(rest))) { o.imp = +m2[1]; rest = rest.slice(0, m2.index); go = true; continue; }
    if ((m2 = /\s+~([\d.]+[mh])$/.exec(rest))) { o.est = parseEst(m2[1]); rest = rest.slice(0, m2.index); go = true; continue; }
    if ((m2 = /\s+@(\d{4}-\d{2}-\d{2})$/.exec(rest))) { o.due = m2[1]; rest = rest.slice(0, m2.index); go = true; continue; }
    if ((m2 = /\s+>(\S+)$/.exec(rest)) && (m2[1] === "?" || SLOT_RE.test(m2[1]))) {
      if (m2[1] === "?") o.sched = true; else o.slot = m2[1];
      rest = rest.slice(0, m2.index); go = true; continue;
    }
  }
  o.text = rest.replace(/\s+$/, "");

  const tail = ls.slice(1);
  let blankAt = -1;
  for (let i = 0; i < tail.length; i++) { if (tail[i].trim() === "") { blankAt = i; break; } }
  const cont = blankAt < 0 ? tail : tail.slice(0, blankAt);
  const det = blankAt < 0 ? [] : tail.slice(blankAt + 1);
  if (cont.length) o.text = o.text + "\n" + cont.map((l) => dedent(l, pad + 6)).join("\n");
  if (det.length) {
    const d = det.map((l) => dedent(l, pad + 6)).join("\n").replace(/\s+$/, "");
    if (d !== "") o.details = d;
  }
  return o;
}

// The lines one item is written as, "^id" on the last. Same rules as the app.
function itemLines(it) {
  const pad = "  ".repeat(it.depth || 0);
  const block = [];
  if (it.kind === "head") {
    block.push("## " + it.text);
  } else if (it.kind === "note") {
    const nls = String(it.text).split("\n");
    let lead = nls.some((l) => l !== "");
    nls.forEach((l) => {
      if (l !== "") lead = false;
      block.push(l === "" ? (lead ? pad + "<br>" : "") : pad + l);
    });
  } else {
    const lines = String(it.text).split("\n");
    const bits = [(pad + "- [" + (it.state || " ") + "] " + lines[0]).replace(/\s+$/, "")];
    if (it.domain) bits.push("#" + it.domain);
    if (it.realm) bits.push("=" + it.realm);
    if (it.imp) bits.push("!" + it.imp);
    if (it.est) bits.push("~" + estToken(it.est));
    if (it.due) bits.push("@" + it.due);
    if (it.slot) bits.push(">" + String(it.slot).replace(/\s/g, ""));
    else if (it.sched) bits.push(">?");
    if (it.link) bits.push("[" + (it.link.title || "link") + "](" + it.link.url + ")");
    block.push(bits.join("  "));
    for (let i = 1; i < lines.length; i++) block.push(pad + "      " + lines[i]);
    if (it.details) {
      block.push("");
      String(it.details).split("\n").forEach((l) => block.push(l === "" ? "" : pad + "      " + l));
    }
  }
  const last = block.length - 1;
  block[last] = (block[last] === "" ? "" : block[last] + "  ") + "^" + it.id;
  return block;
}

// The file as: what comes before the blocks (the domain table), the blocks each
// holding their own raw lines, and whatever trails the last one.
function splitDoc(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  let table = {}, tableAt = -1;
  for (let k = 0; k < lines.length && k < 5; k++) {
    const m = TABLE_RE.exec(lines[k]);
    if (!m) { if (lines[k].trim() !== "") break; else continue; }
    table = readTable(m[1]); tableAt = k; break;
  }
  const pre = tableAt >= 0 ? lines.slice(0, tableAt + 1) : [];
  const body = tableAt >= 0 ? lines.slice(tableAt + 1) : lines;
  const blocks = [];
  let buf = [], raw = [];
  for (const line of body) {
    raw.push(line);
    const m = ID_RE.exec(line);
    if (!m) { if (line.trim() !== "" || buf.length) buf.push(line); continue; }
    buf.push(line.replace(ID_RE, ""));
    blocks.push({ id: m[1], raw, item: blockFrom(buf, m[1], table) });
    buf = []; raw = [];
  }
  return { pre, tableAt, table, blocks, tail: raw };
}
function joinDoc(doc) {
  const pre = doc.pre.slice();
  if (doc.tableDirty) {
    const line = tableLine(doc.table);
    if (doc.tableAt >= 0) pre[doc.tableAt] = line;
    else { pre.unshift(line, ""); }
  }
  const out = pre.concat(...doc.blocks.map((b) => b.raw), doc.tail);
  return out.join("\n");
}
// Rewrite one block in place, keeping the blank lines that separated it from
// the block above.
function rewrite(b) {
  let k = 0;
  while (k < b.raw.length && b.raw[k].trim() === "") k++;
  b.raw = b.raw.slice(0, k).concat(itemLines(b.item));
}
function freshBlock(item) {
  const raw = itemLines(item);
  return { id: item.id, item, raw: item.kind === "head" ? [""].concat(raw) : raw };
}

/* ------------------------------------------------------------------ helpers on a doc */

const realmOf = (doc, it) => it.realm || (it.domain ? doc.table[it.domain] || "Personal" : null);
const findIdx = (doc, id) => doc.blocks.findIndex((b) => b.id === String(id).replace(/^\^/, ""));
function nextId(doc) {
  let n = 0;
  doc.blocks.forEach((b) => { const v = parseInt(String(b.id).replace(/\D/g, ""), 10); if (v > n) n = v; });
  return "n" + (n + 1);
}
// a block plus everything indented under it, stopping at a heading
function subtreeEnd(doc, i) {
  const d = doc.blocks[i].item.depth || 0;
  let j = i + 1;
  while (j < doc.blocks.length) {
    const x = doc.blocks[j].item;
    if (x.kind === "head" || (x.depth || 0) <= d) break;
    j++;
  }
  return j;
}
function headingIdx(doc, name) {
  const want = String(name).trim().toLowerCase();
  return doc.blocks.findIndex((b) => b.item.kind === "head" && b.item.text.trim().toLowerCase() === want);
}
function sectionEnd(doc, h) {
  let j = h + 1;
  while (j < doc.blocks.length && doc.blocks[j].item.kind !== "head") j++;
  return j;
}
function sectionOf(doc, i) {
  for (let j = i - 1; j >= 0; j--) if (doc.blocks[j].item.kind === "head") return doc.blocks[j].item.text;
  return null;
}
const sectionRealm = (name) => {
  const t = String(name || "").trim().toLowerCase();
  return t === "work" ? "Work" : t === "personal" ? "Personal" : null;
};
// Position wins, exactly as dragging in the app: a task under Work or Personal
// is filed there; an override is only recorded when it disagrees with the domain.
function adopt(doc, i) {
  const it = doc.blocks[i].item;
  if (it.kind !== "task") return;
  const sr = sectionRealm(sectionOf(doc, i));
  const nat = it.domain ? doc.table[it.domain] || "Personal" : null;
  it.realm = sr && sr !== nat ? sr : undefined;
}
function useDomain(doc, raw, realmHint) {
  const d = cleanDomain(raw);
  if (!d) return null;
  // match an existing domain regardless of case, so "legal" lands on "Legal"
  const hit = Object.keys(doc.table).find((k) => k.toLowerCase() === d.toLowerCase());
  if (hit) return hit;
  doc.table[d] = realmHint === "Work" ? "Work" : "Personal";
  doc.tableDirty = true;
  return d;
}
const STATE = { open: " ", waiting: "-", done: "x" };
const STATE_NAME = { " ": "open", "-": "waiting", x: "done" };

function describe(doc, it, opts = {}) {
  const pad = "  ".repeat(it.depth || 0);
  if (it.kind === "head") return "\n## " + it.text + "   (" + it.id + ")";
  const lines = String(it.text).split("\n");
  let head;
  if (it.kind === "note") {
    head = pad + it.id + "  " + (lines[0] || "(blank)");
  } else {
    const bits = [];
    if (it.domain) bits.push(it.domain);
    if (it.realm) bits.push("filed under " + it.realm);
    if (it.imp) bits.push("p" + it.imp);
    if (it.est) bits.push(estToken(it.est));
    if (it.due) bits.push("due " + it.due);
    if (it.slot) bits.push("booked " + it.slot);
    else if (it.sched) bits.push("marked to schedule");
    if (it.link) bits.push("link " + it.link.url);
    if (it.details && !opts.details) bits.push("has notes");
    head = pad + it.id + "  [" + (it.state || " ") + "] " + lines[0] + (bits.length ? "   · " + bits.join(" · ") : "");
  }
  const more = lines.slice(1).map((l) => pad + "        " + l);
  if (opts.details && it.details) {
    more.push(pad + "        notes:");
    String(it.details).split("\n").forEach((l) => more.push(pad + "          " + l));
  }
  return [head].concat(more).join("\n");
}
const brief = (it) => '"' + String(it.text).split("\n")[0].slice(0, 80) + '"';

/* ------------------------------------------------------------------ the tools */

const INSTRUCTIONS =
  "CheckMate is Jason's personal todo list: a plain-text notepad where some lines are tasks. " +
  "Tasks have a state ([ ] open, [-] waiting on someone else, [x] done), an optional domain " +
  "(a tag such as Alcedine or House), a priority 1-3 (1 highest, 2 high, 3 regular, the default), and optional " +
  "estimate, due date and a mark asking for them to be scheduled. Every domain belongs to a realm, " +
  "Work or Personal. Items are grouped under headings, normally Work and Personal. Always call " +
  "checkmate_list before changing anything, and refer to items by their id (n12). To finish a task, " +
  "set its status to done rather than deleting it: Jason keeps completed items on the list. Every " +
  "change is saved as a new revision, and checkmate_undo reverses the last one.";

const TOOLS = [
  {
    name: "checkmate_list",
    title: "Read the todo list",
    description:
      "Read Jason's CheckMate list. Returns every item with its id, grouped under its heading, " +
      "indented to show nesting. Filters are optional and combine. By default shows open and " +
      "waiting tasks plus plain-text notes; completed tasks are left out unless status is done or all.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", "waiting", "done", "all"],
                  description: "open (the default) shows open and waiting tasks; waiting, done or all narrow or widen that." },
        realm: { type: "string", enum: ["Work", "Personal"], description: "Only items in this realm." },
        domain: { type: "string", description: "Only tasks tagged with this domain." },
        query: { type: "string", description: "Only items whose text or notes contain this, ignoring case." },
        include_notes: { type: "boolean", description: "Show plain-text lines as well as tasks. Default true." },
        include_details: { type: "boolean", description: "Print each task's notes in full. Default false." }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(doc, a) {
      const want = a.status || "open";
      const q = a.query ? String(a.query).toLowerCase() : null;
      const dom = a.domain ? String(a.domain).toLowerCase() : null;
      const narrowed = !!(a.realm || dom);
      const notes = a.include_notes !== false && !narrowed;
      const keep = doc.blocks.map((b) => {
        const it = b.item;
        if (it.kind === "head") return false;
        if (q && (String(it.text) + " " + (it.details || "")).toLowerCase().indexOf(q) < 0) return false;
        if (it.kind === "note") return notes;
        if (want === "open" && it.state === "x") return false;
        if (want === "waiting" && it.state !== "-") return false;
        if (want === "done" && it.state !== "x") return false;
        if (a.realm && realmOf(doc, it) !== a.realm) return false;
        if (dom && String(it.domain || "").toLowerCase() !== dom) return false;
        return true;
      });
      // a heading shows when something under it does, as in the app
      doc.blocks.forEach((b, i) => {
        if (b.item.kind !== "head") return;
        const end = sectionEnd(doc, i);
        // unfiltered, show every heading, even an empty one: it is a place to add to
        keep[i] = keep.slice(i + 1, end).some(Boolean) || (!narrowed && !q && want === "open");
      });
      const shown = doc.blocks.filter((_, i) => keep[i]);
      const tasks = shown.filter((b) => b.item.kind === "task").length;
      const work = Object.keys(doc.table).filter((d) => doc.table[d] === "Work");
      const pers = Object.keys(doc.table).filter((d) => doc.table[d] !== "Work");
      const out = [
        "CheckMate, revision " + doc.rev + " — " + tasks + " task" + (tasks === 1 ? "" : "s") + " shown",
        "Work domains: " + (work.join(", ") || "none") + " · Personal domains: " + (pers.join(", ") || "none")
      ];
      if (!shown.length) out.push("", "Nothing matches.");
      shown.forEach((b) => out.push(describe(doc, b.item, { details: !!a.include_details })));
      return { text: out.join("\n") };
    }
  },

  {
    name: "checkmate_add",
    title: "Add to the todo list",
    description:
      "Add a task (or a plain-text line) to Jason's CheckMate list. Placement, in order of precedence: " +
      "under parent_id as a subtask; right after after_id; at the end of the named section; otherwise " +
      "at the end of the Work or Personal section that matches the domain's realm; otherwise at the end. " +
      "A domain that does not exist yet is created, in the realm given (or the section's realm, or Personal).",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The task, as Jason would write it. **bold**, *italic* and <u>underline</u> work; write a literal * as \\*." },
        kind: { type: "string", enum: ["task", "note"], description: "task (default) or a plain line of text." },
        domain: { type: "string", description: "Domain tag, e.g. Alcedine, House, Travel." },
        priority: { type: "integer", enum: [1, 2, 3], description: "1 highest, 2 high, 3 regular (the default)." },
        due: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Due date, YYYY-MM-DD." },
        estimate_minutes: { type: "integer", minimum: 1, description: "How long it should take." },
        schedule: { type: "boolean", description: "Mark it for scheduling onto the calendar." },
        details: { type: "string", description: "Notes that live behind the task, not on the line. Markdown: tables, bullet and numbered lists, # headings, **bold**, *italic*, <u>underline</u>, [links](https://…), `code` and ``` blocks all display formatted in the app." },
        link: { type: "string", description: "A URL to keep with the task." },
        section: { type: "string", description: "Heading to add it under, e.g. Work or Personal. Created if missing." },
        after_id: { type: "string", description: "Put it right after this item (and anything nested under it)." },
        parent_id: { type: "string", description: "Nest it under this item as a subtask." },
        realm: { type: "string", enum: ["Work", "Personal"], description: "Only used when the domain is new." }
      },
      required: ["text"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async run(doc, a) {
      if (!String(a.text || "").trim() && a.kind !== "note") throw new Error("text is required");
      const kind = a.kind === "note" ? "note" : "task";
      let at = doc.blocks.length, depth = 0, where = "at the end";
      if (a.parent_id) {
        const p = findIdx(doc, a.parent_id);
        if (p < 0) throw new Error("no item " + a.parent_id);
        at = subtreeEnd(doc, p); depth = (doc.blocks[p].item.depth || 0) + 1;
        where = "under " + doc.blocks[p].id + " " + brief(doc.blocks[p].item);
      } else if (a.after_id) {
        const p = findIdx(doc, a.after_id);
        if (p < 0) throw new Error("no item " + a.after_id);
        at = subtreeEnd(doc, p);
        depth = doc.blocks[p].item.kind === "head" ? 0 : doc.blocks[p].item.depth || 0;
        where = "after " + doc.blocks[p].id;
      } else {
        let name = a.section;
        const realmHint = a.realm || (a.domain ? doc.table[Object.keys(doc.table)
          .find((k) => k.toLowerCase() === cleanDomain(a.domain).toLowerCase())] : null);
        if (!name && realmHint && headingIdx(doc, realmHint) >= 0) name = realmHint;
        if (name) {
          let h = headingIdx(doc, name);
          if (h < 0) {
            const hb = freshBlock({ kind: "head", text: String(name).trim(), depth: 0, id: nextId(doc) });
            doc.blocks.push(hb); h = doc.blocks.length - 1;
          }
          at = sectionEnd(doc, h);
          where = "under " + doc.blocks[h].item.text;
        }
      }
      const secRealm = sectionRealm(sectionOf(doc, at));
      const it = { kind, depth, id: nextId(doc), text: String(a.text || "") };
      if (kind === "task") {
        it.state = " ";
        it.imp = a.priority || 3;
        if (a.domain) it.domain = useDomain(doc, a.domain, a.realm || secRealm);
        if (a.due) it.due = a.due;
        if (a.estimate_minutes) it.est = Math.round(a.estimate_minutes);
        if (a.schedule) it.sched = true;
        if (a.details) it.details = String(a.details);
        if (a.link) it.link = { title: "", url: String(a.link).trim() };
      }
      doc.blocks.splice(at, 0, freshBlock(it));
      if (kind === "task") { adopt(doc, at); rewrite(doc.blocks[at]); }
      return { changed: true, text: "Added " + it.id + " " + where + ":\n" + describe(doc, it) };
    }
  },

  {
    name: "checkmate_update",
    title: "Change an item",
    description:
      "Change one item on Jason's CheckMate list by id. Pass only what should change. Use status done " +
      "to tick a task off. Passing status to a plain-text line turns it into a task. Empty string clears " +
      "a field (domain, due, details, link, slot); priority 0 or estimate 0 clears those. section moves " +
      "the item, with anything nested under it, to the end of that heading, and files it under that " +
      "realm the way dragging does in the app.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The item's id, e.g. n43." },
        text: { type: "string" },
        status: { type: "string", enum: ["open", "waiting", "done"] },
        domain: { type: "string" },
        priority: { type: "integer", enum: [0, 1, 2, 3] },
        due: { type: "string", description: "YYYY-MM-DD, or empty to clear." },
        estimate_minutes: { type: "integer", minimum: 0 },
        schedule: { type: "boolean", description: "Mark or unmark for scheduling." },
        slot: { type: "string", description: "The calendar slot it was booked into, e.g. Tue10:30a or 2026-09-22T15:00. Empty clears." },
        details: { type: "string" },
        link: { type: "string" },
        section: { type: "string", description: "Move it to the end of this heading." },
        realm: { type: "string", enum: ["Work", "Personal"], description: "Only used when the domain is new." }
      },
      required: ["id"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(doc, a) {
      let i = findIdx(doc, a.id);
      if (i < 0) throw new Error("no item " + a.id + ". Call checkmate_list for current ids.");
      const it = doc.blocks[i].item;
      const was = describe(doc, it);
      const has = (k) => Object.prototype.hasOwnProperty.call(a, k);

      if (has("text")) it.text = String(a.text);
      if (it.kind === "head") {
        if (Object.keys(a).some((k) => !["id", "text"].includes(k))) throw new Error("a heading only has text");
      } else {
        if (has("status")) {
          if (it.kind === "note") { it.kind = "task"; if (!it.imp) it.imp = 3; }
          it.state = STATE[a.status];
        }
        const taskOnly = ["domain", "priority", "due", "estimate_minutes", "schedule", "slot", "details", "link"];
        if (it.kind === "note" && taskOnly.some(has)) throw new Error(a.id + " is plain text. Set a status first to make it a task.");
        if (has("domain")) it.domain = a.domain ? useDomain(doc, a.domain, a.realm) : undefined;
        if (has("priority")) it.imp = a.priority || undefined;
        if (has("due")) {
          if (a.due && !/^\d{4}-\d{2}-\d{2}$/.test(a.due)) throw new Error("due must be YYYY-MM-DD");
          it.due = a.due || undefined;
        }
        if (has("estimate_minutes")) it.est = a.estimate_minutes ? Math.round(a.estimate_minutes) : undefined;
        if (has("schedule")) { it.sched = !!a.schedule; if (a.schedule) it.slot = undefined; }
        if (has("slot")) {
          const s = String(a.slot || "").replace(/\s/g, "");
          if (s && !SLOT_RE.test(s)) throw new Error("slot should look like Tue10:30a or 2026-09-22T15:00");
          it.slot = s || undefined; if (s) it.sched = false;
        }
        if (has("details")) it.details = a.details || undefined;
        if (has("link")) it.link = a.link ? { title: (it.link && it.link.title) || "", url: String(a.link).trim() } : undefined;
      }

      let moved = "";
      if (has("section") && it.kind !== "head") {
        const end = subtreeEnd(doc, i);
        const grp = doc.blocks.splice(i, end - i);
        const base = grp[0].item.depth || 0;
        grp.forEach((b) => { b.item.depth = (b.item.depth || 0) - base; });
        let h = headingIdx(doc, a.section);
        if (h < 0) { doc.blocks.push(freshBlock({ kind: "head", text: String(a.section).trim(), depth: 0, id: nextId(doc) })); h = doc.blocks.length - 1; }
        const at = sectionEnd(doc, h);
        doc.blocks.splice(at, 0, ...grp);
        grp.forEach((_, k) => { adopt(doc, at + k); rewrite(doc.blocks[at + k]); });
        i = at;
        moved = " and moved it under " + doc.blocks[h].item.text;
      }
      if (it.kind === "task" && !moved) adopt(doc, i);
      rewrite(doc.blocks[i]);
      return { changed: true, text: "Updated " + it.id + moved + ".\nwas: " + was.trim() + "\nnow: " + describe(doc, it).trim() };
    }
  },

  {
    name: "checkmate_delete",
    title: "Delete items",
    description:
      "Remove items from Jason's CheckMate list by id. To finish a task, use checkmate_update with " +
      "status done instead: he keeps completed items. Deleting a heading or a parent leaves the items " +
      "under it in place. Every deletion can be reversed with checkmate_undo.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, minItems: 1, description: "Ids to remove, e.g. [\"n50\"]." },
        confirm_large: { type: "boolean", description: "Required to remove more than half the list at once." }
      },
      required: ["ids"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async run(doc, a) {
      const want = new Set((a.ids || []).map((x) => String(x).replace(/^\^/, "")));
      const gone = doc.blocks.filter((b) => want.has(b.id));
      const missing = [...want].filter((x) => !gone.some((b) => b.id === x));
      if (!gone.length) throw new Error("none of those ids exist: " + missing.join(", "));
      const before = doc.blocks.length;
      if (!a.confirm_large && before > 10 && gone.length > before / 2) {
        throw new Error("that would remove " + gone.length + " of " + before + " items. Pass confirm_large if that is really intended.");
      }
      doc.blocks = doc.blocks.filter((b) => !want.has(b.id));
      return {
        changed: true,
        text: "Deleted " + gone.map((b) => b.id + " " + brief(b.item)).join(", ") + "." +
              (missing.length ? " Not found: " + missing.join(", ") + "." : "") +
              " checkmate_undo brings them back."
      };
    }
  },

  {
    name: "checkmate_undo",
    title: "Undo the last change",
    description:
      "Put Jason's CheckMate list back the way it was before the last change — made by Claude, the app, " +
      "or another device — or back to a specific revision. The restore is saved as a new revision, so " +
      "undo can itself be undone. The last 50 revisions are kept.",
    inputSchema: {
      type: "object",
      properties: {
        to_rev: { type: "integer", minimum: 1, description: "Revision to go back to. Default: the one before the current." }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async run(doc, a, env) {
      const target = a.to_rev || doc.rev - 1;
      if (target < 1 || target >= doc.rev || target <= doc.rev - KEEP) {
        throw new Error("revision " + target + " is not available. Current is " + doc.rev + "; the oldest kept is " + Math.max(1, doc.rev - KEEP + 1) + ".");
      }
      const old = await textAt(env, target);
      const count = (d) => d.blocks.filter((b) => b.item.kind === "task").length;
      const now = count(doc), then = count(splitDoc(old));
      return { changed: true, replace: old,
               text: "Restored revision " + target + ". Tasks: " + now + " before, " + then + " after." };
    }
  }
];

/* ------------------------------------------------------------------ MCP over HTTP */

const rpc = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcErr = (id, code, message) => ({ jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message } });
const mcpJson = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

// Tools only, so the protocol has been stable across versions: answer in the
// version the client asked for.
function pickVersion(p) {
  const v = p && p.protocolVersion;
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "2025-06-18";
}

async function callTool(env, name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { error: rpcErr(null, -32602, "Unknown tool: " + name) };
  const h = await readHead(env);
  const doc = splitDoc(await textAt(env, h.rev));
  doc.rev = h.rev;
  try {
    const r = await tool.run(doc, args || {}, env);
    let text = r.text;
    if (r.changed) {
      const next = await commit(env, h, r.replace !== undefined ? r.replace : joinDoc(doc));
      text += "\n(saved as revision " + next + ")";
    }
    return { result: { content: [{ type: "text", text }], isError: false } };
  } catch (e) {
    // A tool that could not do what was asked says why, and changes nothing.
    return { result: { content: [{ type: "text", text: String(e && e.message || e) }], isError: true } };
  }
}

async function one(env, m) {
  if (!m || typeof m !== "object" || m.jsonrpc !== "2.0" || typeof m.method !== "string") {
    return rpcErr(m && m.id, -32600, "Invalid Request");
  }
  const notice = m.id === undefined || m.id === null;
  switch (m.method) {
    case "initialize":
      return rpc(m.id, {
        protocolVersion: pickVersion(m.params),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "checkmate", title: "CheckMate", version: "1.0.0" },
        instructions: INSTRUCTIONS
      });
    case "ping":
      return notice ? null : rpc(m.id, {});
    case "tools/list":
      return rpc(m.id, { tools: TOOLS.map(({ name, title, description, inputSchema, annotations }) =>
        ({ name, title, description, inputSchema, annotations })) });
    case "tools/call": {
      const p = m.params || {};
      const r = await callTool(env, p.name, p.arguments);
      if (r.error) return rpcErr(m.id, r.error.error.code, r.error.error.message);
      return rpc(m.id, r.result);
    }
    default:
      if (notice || m.method.startsWith("notifications/")) return null;
      return rpcErr(m.id, -32601, "Method not found: " + m.method);
  }
}

async function mcp(request, env, key) {
  if (!env.MCP_TOKEN) {
    return mcpJson({ error: "The connector is off: set MCP_TOKEN on the Worker to turn it on." }, 503);
  }
  if (!same(key, env.MCP_TOKEN)) return mcpJson({ error: "bad token" }, 401);
  if (!env.CM) return mcpJson({ error: "no KV namespace bound as CM" }, 500);
  // No server-initiated stream and no sessions: plain request, plain answer.
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  }
  let body;
  try { body = await request.json(); } catch { return mcpJson(rpcErr(null, -32700, "Parse error")); }
  const batch = Array.isArray(body);
  const replies = [];
  for (const m of batch ? body : [body]) {
    const r = await one(env, m);
    if (r) replies.push(r);
  }
  if (!replies.length) return new Response(null, { status: 202 });
  return mcpJson(batch ? replies : replies[0]);
}

/* ------------------------------------------------------------------ routes */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // The connector. Its key is in the path, or in an Authorization header for
    // clients that can send one. It never accepts the app's key.
    const mm = /^\/mcp(?:\/([^/]+))?\/?$/.exec(url.pathname);
    if (mm) {
      const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      let key = bearer;
      if (mm[1]) { try { key = decodeURIComponent(mm[1]); } catch { key = ""; } }
      return mcp(request, env, key);
    }

    // No OAuth here: the connector's key is in its URL. Say so plainly, so a
    // client looking for OAuth metadata moves on instead of trying to sign in.
    if (url.pathname.startsWith("/.well-known/")) return new Response("Not found", { status: 404 });

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

    if (!same(url.searchParams.get("token"), env.SECRET_TOKEN)) {
      return json({ error: "bad token" }, 401);
    }
    if (!env.CM) {
      return json({ error: "no KV namespace bound as CM" }, 500);
    }

    if (url.pathname === "/history" && request.method === "GET") {
      const h = await readHead(env);
      return json({ head: h.rev, at: h.at, keep: KEEP });
    }

    if (url.pathname === "/doc" && request.method === "GET") {
      const h = await readHead(env);
      const asked = url.searchParams.get("rev");
      if (asked) {
        const n = parseInt(asked, 10);
        if (!n || n > h.rev || n <= h.rev - KEEP) return json({ error: "no such revision" }, 404);
        return json({ text: await textAt(env, n), rev: n, head: h.rev });
      }
      return json({ text: await textAt(env, h.rev), rev: h.rev });
    }

    if (url.pathname === "/doc" && request.method === "PUT") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "expected JSON" }, 400); }
      if (typeof body.text !== "string") return json({ error: "text is required" }, 400);

      const h = await readHead(env);

      // Somebody else saved since this device loaded. Hand their version back
      // instead of clobbering it; the app asks which one to keep.
      // KV reads can lag a little, so this also catches a stale read — the cost
      // is an occasional prompt, never a silent overwrite.
      if (h.rev !== 0 && Number(body.rev) !== h.rev) {
        return json({ conflict: true, text: await textAt(env, h.rev), rev: h.rev }, 409);
      }

      // A write that drops most of the document is nearly always a bug.
      const before = (await textAt(env, h.rev)).split("\n").filter((l) => l.trim()).length;
      const after = body.text.split("\n").filter((l) => l.trim()).length;
      if (!body.allowShrink && before > 10 && after < before * 0.5) {
        return json({ error: "refusing to shrink the document", before, after }, 409);
      }

      return json({ rev: await commit(env, h, body.text) });
    }

    return json({ error: "not found" }, 404);
  }
};

