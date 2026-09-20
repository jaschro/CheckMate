# CheckMate — setup, step by step

Your notes live in **Cloudflare KV**, keyed by revision. A Cloudflare Worker is the
only thing that touches them: it checks your token, reads and writes KV, and serves
the app itself. This repo holds only the code, so it can stay public.

```
phone / desktop  ──►  Worker  ──►  Cloudflare KV   (todo text, last 50 revisions)
                        │
                        └──────►  this public repo (index.html)
                        ▲
                     Claude
```

There is **no GitHub token anywhere**. If you created one earlier for this, you can
delete it: github.com/settings/tokens?type=beta

Work through these in order. Each step says what you should see when it worked.

---

## Step 1 — push this folder

Double-click **`push.bat`**.

The first time it sets the folder up as the repo and pushes. A browser window will
probably open asking you to sign in to GitHub — that is Git asking permission to
push on your behalf. Approve it.

**Worked when:** the window says `Pushed.` and github.com/jaschro/CheckMate lists
`index.html`, `worker.js`, `SETUP.md`.

The repo stays **public** — it holds no personal data, only the app's code.

---

## Step 2 — create the KV namespace

1. **dash.cloudflare.com** → left sidebar → **Storage & Databases** → **KV**
2. **Create a namespace**
3. Call it `checkmate`
4. **Add**

**Worked when:** `checkmate` appears in the KV list.

---

## Step 3 — create the Worker

1. Left sidebar → **Workers & Pages** → **Create** → **Start with Hello World!** → **Deploy**
   (accept the generated name, or call it `checkmate`)
2. When it finishes, click **Edit code**
3. Select everything in the editor and delete it
4. Open `worker.js` from this folder, copy all of it, paste it in
5. **Deploy** (top right)

**Worked when:** the Worker has a URL like `https://checkmate.<something>.workers.dev`.
Opening it now will show an error — it has nothing configured yet. That is expected.

---

## Step 4 — connect the KV namespace to the Worker

Worker → **Settings** → **Bindings** → **Add** → **KV namespace**

| Field | Value |
| --- | --- |
| Variable name | `CM` |
| KV namespace | `checkmate` |

The variable name must be exactly `CM` — that is the name the code looks for.

---

## Step 5 — add the token

Worker → **Settings** → **Variables and Secrets** → **Add**

| Name | Type | Value |
| --- | --- | --- |
| `SECRET_TOKEN` | Secret | a long random string you choose |

That one secret is the whole security model, so make it long and random — not
something guessable.

Then **Deploy** again. Bindings and variables only take effect on a deploy.

**Worked when:** opening the Worker's URL shows the CheckMate app instead of an error.
It is fetching `index.html` from the public repo and serving it.

---

## Step 6 — connect the app

1. Open the Worker's URL
2. Top right, the pill reads **local only** — tap it
3. **Worker URL**: paste the Worker's URL
4. **Token**: paste the same `SECRET_TOKEN`
5. **Connect**

**Worked when:** the pill turns to **saved**. Type something, wait a second, and it
should blink *saving…* then *saved*.

Do this once per device. The URL and token live in that browser only.

---

## Step 7 — put it on your phone

Open the Worker's URL in Safari or Chrome on your phone, connect it the same way,
then **Share → Add to Home Screen**. It opens full screen like an app.

---

## How it behaves

- **Saving** is debounced: one write per pause in typing, not one per keystroke.
- **Revisions.** Every save is a new revision and the last 50 are kept. Nothing is
  overwritten in place, so an accidental wipe is recoverable.
- **Two devices at once.** Every write carries the revision it was based on. If the
  document moved since this device loaded it, the write is refused and you are asked
  which version to keep. Nothing is ever silently overwritten.
- **Offline.** The last loaded copy is cached in the browser, so the app opens and
  works. The pill reads *offline* and it saves once it can reach the Worker.
- **Shrink guard.** The Worker refuses any write that drops more than half the
  document unless explicitly told to allow it.

### One thing to know about KV

Cloudflare KV is fast but only *eventually* consistent — a write on your phone can
take a moment to be visible everywhere. The revision check turns that into an
occasional "changed elsewhere" prompt rather than lost work: a device holding a stale
revision cannot overwrite a newer one. If you see that prompt and nothing obviously
changed, taking the other version is the safe answer.

## Updating the app later

`index.html` is served from the public repo, so `push.bat` deploys it. The Worker
itself only needs redeploying when `worker.js` changes.

## If something goes wrong

| What you see | What it usually means |
| --- | --- |
| `{"error":"bad token"}` | the token in the app does not match `SECRET_TOKEN` |
| `{"error":"no KV namespace bound as CM"}` | the binding in Step 4 is missing or misnamed |
| `Could not fetch the app from ...` | the repo is not pushed yet, or is private |
| Pill stuck on **offline** | wrong Worker URL in the app, or no connection |
| Pill says **changed elsewhere** | the other device saved first — pick which to keep |
| App shows sample data, **local only** | not connected yet — tap the pill |

## Getting an old version back

`GET {worker}/history?token=...` gives the current revision number.
`GET {worker}/doc?token=...&rev=N` gives that revision's text.
Or just ask Claude.
