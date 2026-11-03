# swissreg — Build Report (Batch 20)

Rebuild of the `swissco-mcp` MCP server (npm `swissco-mcp`,
registry `ch.prospex/swissco`) from the firsthand spec in
`specs-batch20/swissreg.md`. Built 2026-10-27.

## Identity

- npm: `@reneturcios/swissreg` @ 0.1.0, bin `swissreg` → `dist/cli.js`
- MCP Registry name: `io.github.CloudCorpRecords/swissreg`
  (matches `package.json` `mcpName`, `server.json` `name`, and
  the Dockerfile `io.modelcontextprotocol.server.name` label)
- server.json description (93 chars, verified):
  "Swiss company data: register lookups, gazette publications,
  tenders, FINMA, LEI and research."
- server.json: npm package entry carries `"version": "0.1.0"`;
  the OCI entry (`ghcr.io/cloudcorprecords/swissreg:0.1.0`)
  carries **no** `version` field.

## Files (19-file factory set, per TEMPLATE.md §2)

package.json, server.json, Dockerfile, tsconfig.json
(byte-identical to builds/codescout/tsconfig.json, verified
with `cmp`), .gitignore, package-lock.json, README.md (fresh
prose), LICENSE (MIT, © 2026 Rene Turcios), CHANGELOG.md
(single 0.1.0 entry dated 2026-10-27), src/index.ts,
src/cli.ts, src/mcp.ts, src/types.ts, src/swiss.ts (core),
test/swiss.test.ts, and the four workflows under
.github/workflows/ (publish-container adapted:
IMAGE ghcr.io/cloudcorprecords/swissreg, smoke assertion on
server name `swissreg`).

## Implementation

- `src/mcp.ts`: low-level `Server` API
  (`sdk/server/index.js` + `StdioServerTransport`), explicit
  JSON-schema literals for all 9 tools
  (swissco_lookup, swissco_search, swissco_publications,
  swissco_events, swissco_tenders, swissco_vendor,
  swissco_finma, swissco_lei, swissco_research); no
  McpServer/zod. Tool descriptions are the spec's one-line
  summaries; per-property descriptions, enums and `required`
  lists as pinned in the spec.
- `src/swiss.ts`: envelope `{rows, count, notes}` built in
  that key order with the spec's pinned notes strings; UID
  normalisation (strip spaces/dots/dashes, upper-case) plus
  modulo-11 check-digit validation with the spec's exact
  error strings; injectable fetch and injectable clock
  (`now: () => Date`) driving the date defaults and trims
  (publications default yesterday→today, trimmed to newest
  7 days; events default 365 days ago, trimmed to newest
  365; tenders default 7 days ago); `limit` clamped at 100;
  rows projected onto the documented field lists in
  documented order (undocumented upstream fields dropped,
  e.g. researcher contacts in ARAMIS rows); wire
  reconstructions per source — LINDAS SPARQL POST with
  `results.bindings` parsing, gazette list + per-publication
  body fetch for `event_types`, simap projects/vendors, FINMA
  two-file merge, GLEIF JSON:API with relationship 404 read
  as no parent, ARAMIS — and the `via="rest"` credential gate
  naming ZEFIX_USER/ZEFIX_PASSWORD. Node built-ins only.
- CLI: one subcommand per tool taking a JSON argument
  string, `mcp`, `--version`; unknown subcommand → usage,
  exit 2.

## Verification (all real, run 2026-10-27)

- `npm run build` (tsc): exit 0.
- `npm test`: **32 tests, 32 pass, 0 fail** — fake fetch +
  fake clock only. Covers UID normalisation/check digit
  (valid + invalid), lookup projection and FINMA/LEI merges,
  search LINDAS vs REST (credential error, ignored-filter
  note), publications trim + client-side filters +
  event_types body path, events UID-confirmation mechanics,
  tenders pub_types validation, vendor UID vs text paths,
  FINMA filters + category error, LEI parents/children +
  404-parent, research language case-sensitivity + UID
  participant confirmation, envelope key order + count,
  limit clamp, and upstream error formats.
- `node dist/cli.js --version`: `0.1.0`; unknown command:
  usage, exit 2.
- Parity: `python3 harness/parity.py --original
  harness/fixtures/swissco-mcp-tools-original.json --rebuild
  "stdio:node builds/swissreg/dist/cli.js mcp" --out
  builds/swissreg/parity-out` → **PASS, parity 100.0, 9/9
  tools identical, no schema diffs**. The fixture was also
  deep-compared against the live tools/list output and is
  exactly equal (names, descriptions, and schemas).
- Lockfile: Route 3 only — clean temp dir with package.json
  alone, `npm install --package-lock-only --ignore-scripts
  --offline`; parses, name `@reneturcios/swissreg`, **128
  package entries**. Dependencies installed in the build dir
  with `npm install --ignore-scripts --offline` (no symlink
  fallback needed).

## Gap notes / deviations

- All upstream wire shapes are documented reconstructions
  from the published docs; **no live call was made**, and
  live behaviour against LINDAS / gazette / simap / FINMA /
  GLEIF / ARAMIS is unproven.
- `SWISSCO_STATE` on-disk caching is not reproduced (the core
  holds no disk cache) and `SWISSCO_INTERVAL` rate limiting
  is not reproduced, per the spec's recorded gaps; results
  are unaffected.
- Parent entities in lookup/LEI rows are entity names or
  null (never GLEIF relationship objects) — the spec's
  pinned simplification; a relationship 404 yields null,
  and lookup LEI parents are present as nulls when a record
  exists but reports no parent.
- In `swissco_lookup`, FINMA merge fields are mapped from
  the institution row (licence_type → finma_licence,
  supervisory_category → finma_category, city → finma_city,
  true boolean flags → finma_flags) — a reconstruction, as
  the upstream merge shape is not separately documented.
- No push, no publish.
