# swissreg

Nine read-only questions about Swiss companies, answered from
the public registers Switzerland itself publishes — no account
needed for the core paths, because the sources are open data:
the commercial register via LINDAS, the Swiss Official Gazette
of Commerce, the simap procurement platform, FINMA's list of
authorised institutions, the GLEIF legal-entity database, and
the federal ARAMIS research database.

Every answer comes back in the same envelope: a JSON object
with `rows` (each row carrying exactly the fields documented
for that tool, in order), `count`, and `notes` explaining the
limits of what the source can say — for example that an absent
LEI is the normal case (only about 28,000 Swiss entities hold
one), or that a company can bid on simap without holding a
directory profile.

The nine tools:

- `swissco_lookup` — everything the commercial register
  publishes about one company, by UID; optionally adds its
  FINMA licence fields and its LEI with consolidating parents.
- `swissco_search` — companies whose legal name or statutory
  purpose contains a term, with canton and legal-form filters
  on the LINDAS path.
- `swissco_publications` — Gazette publications in a date
  range, filtered client-side by canton, sub-rubric, title
  text, or event type.
- `swissco_events` — one company's registry events, each kept
  only when the publication's own UID matches the one asked
  for.
- `swissco_tenders` — public-procurement projects published on
  simap, by date range, canton, and publication type.
- `swissco_vendor` — whether a company holds a simap vendor
  profile, and what that profile says.
- `swissco_finma` — institutions on FINMA's authorised banks
  and securities-firms list, filterable by name, UID, licence
  type, and supervisory category.
- `swissco_lei` — a company's LEI, the entity that
  consolidates it, the top of that chain, and optionally its
  consolidated children.
- `swissco_research` — federally funded research projects
  (Innosuisse and SNSF money included) naming a company, by
  text or by a participant's UID.

Swiss UIDs are taken seriously: a UID is normalised
(`CHE444420929`, `CHE-444.420.929` and lower-case variants all
work), its modulo-11 check digit is verified before any
request is made, and output UIDs are always punctuated
`CHE-XXX.XXX.XXX`. Dates are `YYYY-MM-DD`; date ranges that
the Gazette cannot serve are trimmed to their newest days,
with a note saying so.

## Configuration

No credential is required. Two things are optional:

```bash
export ZEFIX_USER="..."        # Zefix PublicREST account
export ZEFIX_PASSWORD="..."
```

With those set, `swissco_search` can run with
`via: "rest"` (a name-prefix search with richer fields);
without them that path fails honestly, naming the two
variables. Register lookups otherwise run over LINDAS and
note what credentials would add: capital, status, former
names, and corporate relations.

## CLI

Each tool is a subcommand taking one JSON argument string:

```bash
npx @reneturcios/swissreg swissco_lookup '{"uid":"CHE-444.420.929","lei":true}'
npx @reneturcios/swissreg swissco_search '{"term":"pharma","canton":"BS"}'
npx @reneturcios/swissreg swissco_tenders '{"pub_types":["award"],"cantons":["ZH"]}'
npx @reneturcios/swissreg --version
```

Output is the tool's envelope as JSON. Exit codes: `0` on
success, `1` on a runtime error (including a validation or
upstream failure), `2` on a usage error.

## MCP server

```bash
npx -y @reneturcios/swissreg mcp
```

MCP client config:

```json
{
  "mcpServers": {
    "swissreg": {
      "command": "npx",
      "args": ["-y", "@reneturcios/swissreg", "mcp"]
    }
  }
}
```

## Docker

```bash
docker run -i ghcr.io/cloudcorprecords/swissreg
docker run --rm ghcr.io/cloudcorprecords/swissreg swissco_finma '{"licence_type":"Bank"}'
```

## Development

```bash
npm install
npm run build   # tsc -> dist/
npm test        # tsx --test test/*.test.ts (fake fetch + fake clock, no network)
npm run dev     # run the CLI from source
```

## License

MIT — Copyright (c) 2026 Rene Turcios
