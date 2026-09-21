# Connecting Claude to CheckMate

This gives Claude five tools — list, add, update, delete, undo — in every
conversation: claude.ai on the web, the phone app, the desktop app, Cowork.

Three things to do, about ten minutes. Each step ends with a **Worked when**
check. Don't move on until it passes.

> **The connector's key is not in this file, on purpose.** This folder is
> pushed to a public GitHub repo. Claude gave you the key in chat. Keep it
> there, in Cloudflare, and in Claude's settings — nowhere else.

---

## Step 1 — Give the Worker Claude's key

1. Go to **dash.cloudflare.com** → **Workers & Pages** → click **checkmate**.
2. Open the **Settings** tab → **Variables and Secrets** → **Add**.
3. Fill in:
   - **Type:** Secret
   - **Variable name:** `MCP_TOKEN` (exactly this, all capitals)
   - **Value:** the key Claude gave you in chat
4. Click **Deploy** (or **Save**).

**Worked when:** the list shows both `SECRET_TOKEN` and `MCP_TOKEN`, each with
its value hidden.

This is a *different* key from `SECRET_TOKEN`. The app and your phone keep using
theirs; this one is only Claude's. To cut Claude off later, delete `MCP_TOKEN`
here. Nothing else stops working.

---

## Step 2 — Paste in the new Worker code

1. Still on **checkmate**, click **Edit code** (top right).
2. Click into `worker.js` on the right, **Ctrl+A** to select everything, and
   delete it.
3. Open `worker.js` from this folder, copy all of it, paste it in.
4. Click **Deploy**.

**Worked when**, in a browser:

| Open this | You should see |
|---|---|
| `https://checkmate.jasonchroman.workers.dev/` | the app, as before |
| `https://checkmate.jasonchroman.workers.dev/mcp/` + the key | `Method Not Allowed` |
| `https://checkmate.jasonchroman.workers.dev/mcp/wrong` | `{"error":"bad token"}` |

`Method Not Allowed` is the good answer: the connector is there and the key
opened it. It only talks to Claude, which sends POST requests, not to browsers.

---

## Step 3 — Tell Claude where it is

1. In Claude (claude.ai in a browser is easiest), open **Settings** →
   **Connectors** → **Add custom connector**. The labels may differ slightly.
2. Fill in:
   - **Name:** `CheckMate`
   - **URL:** `https://checkmate.jasonchroman.workers.dev/mcp/` followed
     immediately by the key — no space, no trailing slash
3. Leave **Advanced settings** (OAuth) empty. There is no OAuth here; the key is
   in the URL.
4. Click **Add**.

**Worked when:** CheckMate appears in your connectors list. If it lets you
look inside it, you'll see five tools: `checkmate_list`, `checkmate_add`,
`checkmate_update`, `checkmate_delete`, `checkmate_undo`.

Adding it once in your account makes it available on every device you sign in
to Claude on.

---

## Step 4 — Try it

Start a **new** conversation and ask:

> What's on my CheckMate list?

Claude should call `checkmate_list` and read it back. The first time it uses
each tool it may ask your permission — that's Claude's normal prompt, and you
can choose to always allow the read-only one.

Then try a write:

> Add "test from Claude" to CheckMate under Personal.

It should appear in the app within a couple of minutes, or immediately if you
switch to the app's tab. Then:

> Undo that.

---

## If something is off

| What you see | What it means | Fix |
|---|---|---|
| `The connector is off` | `MCP_TOKEN` isn't set | Step 1 |
| `{"error":"bad token"}` with the right key | Either the old Worker code is still running, or the two copies of the key differ | Redo Step 2 and make sure you clicked **Deploy**; if it persists, re-paste the key in Step 1 — watch for a stray space |
| Claude says it can't reach the server | URL typo, or it has a trailing `/` | Step 3 |
| The app says "changed elsewhere" | You were editing while Claude changed the list | Take the other version, or keep yours — nothing is lost either way |

## What Claude can and can't do

- **Read** the whole list, filtered by status, realm, domain or search.
- **Add** tasks or plain lines, anywhere — under a heading, after an item, or as
  a subtask. New domains are added to your Work/Personal table.
- **Change** anything on an item, tick it off, or move it between Work and
  Personal (which files it there, the same as dragging in the app).
- **Delete** items. It's told you keep finished tasks, so it marks them done
  instead of deleting them. It refuses to delete more than half the list at once
  unless told that's really intended.
- **Undo.** Every change — Claude's, the app's, your phone's — is saved as a new
  revision, and the last 50 are kept. "Undo that" reverses the last change;
  "put it back how it was this morning" can go further.

It cannot see your GitHub, your other Cloudflare Workers, or anything but this
one list.
