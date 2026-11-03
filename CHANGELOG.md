# Changelog

## 0.1.0 (2026-10-27)

- Initial release: nine read-only MCP tools and matching CLI
  subcommands over six Swiss public open-data sources —
  `swissco_lookup` and `swissco_search` (commercial register
  via LINDAS, with optional FINMA and LEI merges and an
  optional credentialed Zefix PublicREST search path),
  `swissco_publications` and `swissco_events` (Swiss Official
  Gazette of Commerce), `swissco_tenders` and `swissco_vendor`
  (simap), `swissco_finma` (FINMA authorised institutions),
  `swissco_lei` (GLEIF), and `swissco_research` (ARAMIS).
- Every tool returns the documented `{rows, count, notes}`
  envelope, Swiss UIDs are normalised and check-digit
  validated before any request, and `limit` is clamped at 100.
