# @pipeworx/idaho-code

Idaho Statutes (Idaho Code) — current statutory text by citation, amendment
history, and topic/keyword search over official chapter and section
catchlines, sourced live from legislature.idaho.gov.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1715+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `id_statute({citation})` — full text of one section by citation (e.g.
  `"18-4001"`, murder), with the official catchline, chapter/title context,
  and the amendment "History:" line Idaho prints on nearly every section.
- `id_search({query, limit?})` — topic/keyword search over the ~20,400 live
  section catchlines (plus their chapter's own catchline), e.g. `"landlord"`,
  `"concealed weapon permit"`. Not full-text search of statutory prose —
  Idaho publishes no keyless full-text search API (see "Data sources").

## Auth

Keyless. No signup, no activation gate.

## Data sources

- `https://legislature.idaho.gov/statutesrules/idstat/` — the Idaho Statutes
  title list (74 titles).
- `https://legislature.idaho.gov/statutesrules/idstat/Title{T}/` — chapter
  list for one title, with each chapter's official catchline.
- `https://legislature.idaho.gov/statutesrules/idstat/Title{T}/T{T}CH{C}/` —
  section list for one chapter, with each section's official catchline.
- `https://legislature.idaho.gov/statutesrules/idstat/Title{T}/T{T}CH{C}/SECT{T}-{N}/`
  — one section's full text.

All four are plain WordPress-served HTML, keyless, no rate limit observed.

### The citation does not literally name its chapter — but a formula recovers it

Idaho cites a section as `title-number` ("18-4001"), with no chapter digit
written out. The chapter IS recoverable, because Idaho's own numbering is a
strict `chapter*100 + sectionWithinChapter` block — verified live across
chapters 1, 5, 9, 40, 83 and 91 of Title 18, and chapter 1 of the single-
chapter Titles 4 and 29: chapter 1 holds "18-100".."18-1xx", chapter 40 holds
"18-4000".."18-4099", chapter 83 holds "18-8300".."18-8399". So
`chapter = floor(number / 100)`. `id_statute` uses that formula to build the
direct URL, then VERIFIES it rather than trusting it — see "THE VERIFICATION
CHAIN" in `src/index.ts`'s file header and the three-step fallback it
documents (confirm the computed chapter's own listing page before ever
reporting a citation doesn't exist). A wrong chapter guess must read as a
loud, investigable error, never as a quiet `found: false`.

### Honest 404s — no Oklahoma/Texas-style disguised 200

Verified live from BOTH a laptop `curl` and a throwaway `wrangler dev
--remote` Worker deployed to the production Cloudflare account (2026-10-07):
every URL shape returns the SAME status and byte length from both vantage
points. A nonexistent chapter or section returns a real HTTP 404 (a genuine
`error404` WordPress template, consistently 72,512 bytes) — not a 200 with
page furniture and no statute, the trap that sank an earlier Oklahoma pack
build (oscn.net answered a Cloudflare Worker differently from a laptop and
returned `found:false` on every live call despite passing every local
smoke). Idaho's site does not do that, confirmed both ways:

```
                                            curl (laptop)        wrangler dev --remote (CF edge, prod account)
Title18/T18CH40/SECT18-4001/ (real)        200 / 91,548B         200 / 91,548B
Title18/T18CH40/ (real chapter listing)    200 / 92,122B         200 / 92,122B
Title18/T18CH999/ (bad chapter)            404 / 72,512B         404 / 72,512B
Title18/T18CH40/SECT18-9999/ (gap number)  404 / 72,512B         404 / 72,512B
```

A transport or parse failure (non-404 HTTP error, or a 200 whose embedded
statute fragment can't be located) throws a loud error naming the upstream
status or the parse failure — it is never reported as `found: false`. Only a
confirmed-absent citation (verified against the chapter's own live listing,
not just a 404 on the direct guess) returns `found: false`.

### The embedded statute fragment

Each section page wraps a legacy Arbortext-generated HTML export (its own
`<html><head><body>`, Arbortext Epic 6.1, mid-2010s vintage) inside the site's
current WordPress theme. The statute text lives in that inner fragment's
top-level `<div>` blocks: a `TITLE N` line, the title name, a `CHAPTER C`
line, the chapter name, then the statute body (one or more divs — multi-
paragraph sections use a `<div>` per subsection), then a `History:` marker div
followed by one div holding the bracketed amendment citation. `src/index.ts`'s
`parseSectionFragment` extracts this; `scripts/bake-index.mjs`'s header has
more on why both the chapter AND section catchline levels are baked.

### Four capabilities — three available, one is not

- Citation lookup — `id_statute`.
- Topic/keyword search — `id_search`, over official catchlines (not full
  statutory prose).
- Amendments/enactment history — embedded in `id_statute`'s `history` field,
  Idaho's own "History:" line (e.g. `"[18-4001, added 1972, ch. 336, sec. 1,
  p. 928; am. 1977, ch. 154, sec. 1, p. 390; am. 2002, ch. 330, sec. 1, p.
  935.]"`), present on nearly every in-force section.
- Historical version (text as it read before an amendment) — **NOT
  AVAILABLE**. legislature.idaho.gov serves the current text only. Its
  Session Laws archive (`/statutesrules/sessionlaws/`) has one PDF volume per
  legislative session back to the 2000s, but those are organized by SESSION
  chapter number (e.g. "Chapters 1 - 162" for a whole year), unrelated to a
  Code citation's title/chapter numbering and not indexed by section —
  recovering a prior version would mean searching those volumes by hand for
  the amending act named in `history`. `id_statute` says this in every
  response rather than omitting the field silently.

### Baked index refresh

`src/id-index-data.ts` is GENERATED by `scripts/bake-index.mjs` from 74 title
pages plus their ~1,468 chapter listing pages (one-time, ~20,400 sections
captured). Re-run it after a legislative session's codification pass:

```
node scripts/bake-index.mjs > src/id-index-data.ts
```

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "idaho-code": {
      "url": "https://gateway.pipeworx.io/idaho-code/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/idaho-code/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1715+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/id_statute \
  -H 'Content-Type: application/json' \
  -d '{"citation":"18-4001"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/id_statute`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "idaho-code": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-idaho-code"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-idaho-code
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Idaho Code data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
