/**
 * swissreg core: nine read-only queries over Swiss public
 * open-data sources.
 *
 * Every function returns the documented envelope — an object
 * whose keys are, in order, `rows` (row objects carrying
 * exactly the documented fields for the tool, in the
 * documented order; fields an upstream response lacks are
 * omitted and undocumented fields are dropped), `count`
 * (rows.length) and `notes` (the documented notes strings).
 *
 * Shared rules, as documented:
 * - `limit` defaults to 100, values above 100 are clamped to
 *   100, and values below 1 are an error.
 * - Dates are `YYYY-MM-DD` strings validated against the real
 *   calendar; "today"-relative defaults come from the
 *   injectable clock in deps.
 * - A UID is normalised by removing spaces, dots and dashes
 *   and upper-casing, must read CHE + 9 digits, and its
 *   modulo-11 check digit is verified before any request.
 *   Output UIDs are punctuated CHE-XXX.XXX.XXX.
 * - Upstream access goes through the injectable fetch. Wire
 *   shapes per source are documented reconstructions: LINDAS
 *   answers SPARQL POSTs with JSON bindings, the gazette /
 *   simap / FINMA / ARAMIS endpoints answer `{rows: [...]}`
 *   JSON, and GLEIF answers JSON:API. A non-2xx upstream
 *   response is an error naming the source and status; a
 *   throwing fetch is an "upstream unreachable" error.
 */
import type {
  Envelope,
  EventsArgs,
  FetchFn,
  FetchResponseLike,
  FinmaArgs,
  LeiArgs,
  LookupArgs,
  PublicationsArgs,
  ResearchArgs,
  SearchArgs,
  SwissDeps,
  TendersArgs,
  VendorArgs,
} from "./types.js";

export const VERSION = "0.1.0";

export const LINDAS_URL = "https://ld.admin.ch/query";
export const GAZETTE_URL = "https://www.amtsblattportal.ch/api/publications";
export const SIMAP_PROJECTS_URL = "https://www.simap.ch/api/projects";
export const SIMAP_VENDORS_URL = "https://www.simap.ch/api/vendors";
export const FINMA_BANKS_URL = "https://www.finma.ch/api/institutions/banks";
export const FINMA_SECURITIES_URL =
  "https://www.finma.ch/api/institutions/securities-firms";
export const GLEIF_URL = "https://api.gleif.org/api/v1/lei-records";
export const ARAMIS_URL = "https://www.aramis.admin.ch/api/projects";
export const ZEFIX_SEARCH_URL = "https://www.zefix.admin.ch/api/search.json";

type Row = Record<string, unknown>;

/* ------------------------------------------------------------------ */
/* Envelope, limits, dates, UIDs                                       */
/* ------------------------------------------------------------------ */

function envelope(rows: Row[], notes: string[]): Envelope {
  return { rows, count: rows.length, notes };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return 100;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
    throw new Error("limit must be an integer >= 1");
  }
  return Math.min(limit, 100);
}

function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function validateDate(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m || !isRealDate(Number(m[1]), Number(m[2]), Number(m[3]))) {
    throw new Error(`invalid date: ${value} (expected YYYY-MM-DD)`);
  }
  return value;
}

function fmtDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return fmtDate(new Date(Date.UTC(y, m - 1, d + days)));
}

function diffDays(since: string, until: string): number {
  const a = Date.parse(`${since}T00:00:00Z`);
  const b = Date.parse(`${until}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

interface Range {
  since: string;
  until: string;
  notes: string[];
}

/**
 * Resolve a since/until range: validate supplied dates, fill
 * defaults from the clock, and — when `trimDays` is given and
 * the range is wider — trim it to its newest `trimDays` days.
 */
function resolveRange(
  deps: SwissDeps,
  sinceIn: string | undefined,
  untilIn: string | undefined,
  defaultSinceDaysAgo: number,
  trimDays: number | null,
  trimNote: string | null,
): Range {
  const now = (deps.now ?? (() => new Date()))();
  const today = fmtDate(now);
  const until = untilIn !== undefined ? validateDate(untilIn) : today;
  let since =
    sinceIn !== undefined ? validateDate(sinceIn) : addDays(until, -defaultSinceDaysAgo);
  const notes: string[] = [];
  if (trimDays !== null && diffDays(since, until) > trimDays) {
    since = addDays(until, -trimDays);
    if (trimNote) notes.push(trimNote);
  }
  return { since, until, notes };
}

const UID_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4];

/** Strip spaces, dots and dashes and upper-case a UID candidate. */
export function compactUid(value: string): string {
  return value.replace(/[\s.\-]+/g, "").toUpperCase();
}

function punctuate(compact: string): string {
  const digits = compact.slice(3);
  return `CHE-${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}`;
}

/**
 * Normalise and fully validate a UID argument (form + check
 * digit), returning the punctuated CHE-XXX.XXX.XXX form.
 */
export function normalizeUid(value: string): string {
  const compact = compactUid(value);
  if (!/^CHE\d{9}$/.test(compact)) {
    throw new Error(`invalid UID: ${value} (expected form CHE-XXX.XXX.XXX)`);
  }
  const digits = compact.slice(3).split("").map(Number);
  let s = 0;
  for (let i = 0; i < 8; i++) s += digits[i] * UID_WEIGHTS[i];
  let expected = 11 - (s % 11);
  if (expected === 11) expected = 0;
  if (expected === 10 || expected !== digits[8]) {
    throw new Error(`invalid UID check digit: ${value}`);
  }
  return punctuate(compact);
}

/**
 * Parse a query string as a UID when it has UID form (used by
 * the query-taking tools). Returns the punctuated UID, or null
 * when the query is not UID-shaped; a UID-shaped query with a
 * bad check digit is an error, as for UID arguments.
 */
export function tryParseUid(value: string): string | null {
  if (!/^CHE\d{9}$/.test(compactUid(value))) return null;
  return normalizeUid(value);
}

/** Punctuate a UID value from upstream when it parses; else keep it. */
function formatUidValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const compact = compactUid(value);
  return /^CHE\d{9}$/.test(compact) ? punctuate(compact) : value;
}

function sameUid(a: unknown, bCompact: string): boolean {
  return typeof a === "string" && compactUid(a) === bCompact;
}

/* ------------------------------------------------------------------ */
/* Projection + fetch helpers                                          */
/* ------------------------------------------------------------------ */

/** Project a source row onto the documented fields, in order. */
function project(source: Row, fields: string[]): Row {
  const out: Row = {};
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(source, f) && source[f] !== undefined) {
      out[f] = source[f];
    }
  }
  return out;
}

async function defaultFetch(
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<FetchResponseLike> {
  return fetch(url, init);
}

function fetchFn(deps: SwissDeps): FetchFn {
  return deps.fetchFn ?? defaultFetch;
}

/** Fetch and JSON-parse, mapping failures onto the pinned error forms. */
async function fetchJson(
  deps: SwissDeps,
  source: string,
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<unknown> {
  let res: FetchResponseLike;
  try {
    res = await fetchFn(deps)(url, init);
  } catch {
    throw new Error(`upstream unreachable: ${source}`);
  }
  if (!res.ok) throw new Error(`upstream error: HTTP ${res.status} from ${source}`);
  const body = await res.text();
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`upstream error: invalid JSON from ${source}`);
  }
}

/** Fetch a `{rows: [...]}` JSON payload and return its rows. */
async function fetchRows(
  deps: SwissDeps,
  source: string,
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<Row[]> {
  const data = (await fetchJson(deps, source, url, init)) as { rows?: unknown };
  return Array.isArray(data?.rows) ? (data.rows as Row[]) : [];
}

/** Run a SPARQL query against LINDAS and flatten the JSON bindings. */
async function sparql(deps: SwissDeps, query: string): Promise<Row[]> {
  const data = (await fetchJson(deps, "LINDAS", LINDAS_URL, {
    method: "POST",
    headers: {
      Accept: "application/sparql-results+json",
      "Content-Type": "application/sparql-query",
    },
    body: query,
  })) as { results?: { bindings?: Array<Record<string, { value?: unknown }>> } };
  const bindings = data?.results?.bindings;
  if (!Array.isArray(bindings)) return [];
  return bindings.map((b) => {
    const row: Row = {};
    for (const [k, v] of Object.entries(b)) row[k] = v?.value;
    return row;
  });
}

function sparqlEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/* ------------------------------------------------------------------ */
/* Shared source helpers                                               */
/* ------------------------------------------------------------------ */

const LOOKUP_FIELDS = [
  "legal_name",
  "uid",
  "chid",
  "ehra_id",
  "legal_form_code",
  "legal_form",
  "municipality",
  "canton",
  "address",
  "purpose",
  "zefix_uri",
];

/** Resolve a punctuated UID to its base commercial-register row, if any. */
async function lookupBaseRow(deps: SwissDeps, uidPunctuated: string): Promise<Row | null> {
  const compact = compactUid(uidPunctuated);
  const rows = await sparql(
    deps,
    `SELECT ?legal_name ?uid ?chid ?ehra_id ?legal_form_code ?legal_form ?municipality ?canton ?address ?purpose ?zefix_uri WHERE { ?s <https://schema.org/identifier> "${compact}" ; <https://schema.org/name> ?legal_name . OPTIONAL { ?s <https://schema.org/identifier> ?uid } }`,
  );
  if (rows.length === 0) return null;
  const row = project(rows[0], LOOKUP_FIELDS);
  row.uid = uidPunctuated;
  // Keep the documented field order after overriding uid.
  return project({ ...row, uid: uidPunctuated }, LOOKUP_FIELDS);
}

const FINMA_FIELDS = [
  "name",
  "city",
  "licence_type",
  "supervisory_category",
  "uid",
  "foreign_control",
  "no_securities_firm_activity",
  "non_account_holding_securities_firm",
  "about_to_cease_operations",
];

/** The merged FINMA bank + securities-firm institution rows. */
async function finmaRows(deps: SwissDeps): Promise<Row[]> {
  const banks = await fetchRows(deps, "FINMA", FINMA_BANKS_URL);
  const firms = await fetchRows(deps, "FINMA", FINMA_SECURITIES_URL);
  return [...banks, ...firms].map((r) => {
    const row = project(r, FINMA_FIELDS);
    if (row.uid !== undefined) row.uid = formatUidValue(row.uid);
    return project(row, FINMA_FIELDS);
  });
}

/* GLEIF JSON:API record -> flat field bag (nested + flat shapes). */
function gleifFlat(record: Row): Row {
  const attrs = (record.attributes ?? record) as Row;
  const entity = (attrs.entity ?? {}) as Row;
  const registration = (attrs.registration ?? {}) as Row;
  const legalName = (entity.legalName ?? {}) as Row;
  const legalAddress = (entity.legalAddress ?? {}) as Row;
  const legalForm = entity.legalForm as Row | string | undefined;
  const flat: Row = { ...attrs };
  flat.legal_name = legalName.name ?? attrs.legal_name;
  flat.lei = record.id ?? attrs.lei;
  flat.registered_as = entity.registeredAs ?? attrs.registered_as;
  flat.jurisdiction = entity.jurisdiction ?? attrs.jurisdiction;
  flat.status = entity.status ?? attrs.status;
  flat.registration_status = registration.registrationStatus ?? attrs.registration_status;
  flat.legal_form =
    (typeof legalForm === "object" && legalForm !== null
      ? (legalForm.other ?? legalForm.id)
      : legalForm) ?? attrs.legal_form;
  flat.city = legalAddress.city ?? attrs.city;
  flat.country = legalAddress.country ?? attrs.country;
  flat.other_names = entity.otherEntityNames ?? attrs.other_names;
  flat.bic = attrs.bic;
  flat.initial_registration_date =
    registration.initialRegistrationDate ?? attrs.initial_registration_date;
  flat.last_update_date = registration.lastUpdateDate ?? attrs.last_update_date;
  flat.next_renewal_date = registration.nextRenewalDate ?? attrs.next_renewal_date;
  return flat;
}

async function gleifFindByUid(deps: SwissDeps, uidPunctuated: string): Promise<Row | null> {
  const url = `${GLEIF_URL}?filter[entity.registeredAt]=CH&filter[entity.registeredAs]=${encodeURIComponent(uidPunctuated)}`;
  const data = (await fetchJson(deps, "GLEIF", url)) as { data?: unknown };
  const list = Array.isArray(data?.data) ? (data.data as Row[]) : data?.data ? [data.data as Row] : [];
  if (list.length === 0) return null;
  return gleifFlat(list[0]);
}

/** A GLEIF relationship name, or null (a 404 reads as "no parent"). */
async function gleifRelationshipName(
  deps: SwissDeps,
  lei: string,
  relationship: string,
): Promise<string | null> {
  let res: FetchResponseLike;
  try {
    res = await fetchFn(deps)(`${GLEIF_URL}/${encodeURIComponent(lei)}/${relationship}`);
  } catch {
    throw new Error("upstream unreachable: GLEIF");
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`upstream error: HTTP ${res.status} from GLEIF`);
  const data = JSON.parse(await res.text()) as { data?: Row };
  if (!data?.data) return null;
  const flat = gleifFlat(data.data);
  return typeof flat.legal_name === "string" ? flat.legal_name : null;
}

/** Direct-children records for a LEI; a 404 reads as no children. */
async function gleifChildren(deps: SwissDeps, lei: string): Promise<Row[]> {
  let res: FetchResponseLike;
  try {
    res = await fetchFn(deps)(`${GLEIF_URL}/${encodeURIComponent(lei)}/direct-children`);
  } catch {
    throw new Error("upstream unreachable: GLEIF");
  }
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`upstream error: HTTP ${res.status} from GLEIF`);
  const data = JSON.parse(await res.text()) as { data?: unknown };
  const list = Array.isArray(data?.data) ? (data.data as Row[]) : [];
  return list.map(gleifFlat);
}

async function gleifParents(
  deps: SwissDeps,
  lei: string,
): Promise<{ direct: string | null; ultimate: string | null }> {
  return {
    direct: await gleifRelationshipName(deps, lei, "direct-parent"),
    ultimate: await gleifRelationshipName(deps, lei, "ultimate-parent"),
  };
}

/* ------------------------------------------------------------------ */
/* 1. swissco_lookup                                                   */
/* ------------------------------------------------------------------ */

export async function swisscoLookup(
  args: LookupArgs,
  deps: SwissDeps = {},
): Promise<Envelope> {
  const uid = normalizeUid(args.uid);
  const notes = [
    "LINDAS only. Zefix PublicREST credentials add capital, status, former names and corporate relations.",
  ];
  const base = await lookupBaseRow(deps, uid);
  if (!base) return envelope([], notes);
  const row: Row = { ...base };

  if (args.finma_licence) {
    notes.push("FINMA's list covers banks and securities firms only.");
    const match = (await finmaRows(deps)).find((r) => sameUid(r.uid, compactUid(uid)));
    if (match) {
      const extra: Row = {};
      const licence = match.licence_type ?? match.finma_licence;
      if (licence !== undefined) extra.finma_licence = licence;
      const category = match.supervisory_category ?? match.finma_category;
      if (category !== undefined) extra.finma_category = category;
      const city = match.city ?? match.finma_city;
      if (city !== undefined) extra.finma_city = city;
      if (match.finma_flags !== undefined) {
        extra.finma_flags = match.finma_flags;
      } else {
        const flags = [
          "foreign_control",
          "no_securities_firm_activity",
          "non_account_holding_securities_firm",
          "about_to_cease_operations",
        ].filter((f) => match[f] === true);
        if (flags.length > 0) extra.finma_flags = flags;
      }
      Object.assign(row, extra);
    }
  }

  if (args.lei) {
    notes.push("About 28,000 Swiss entities hold an LEI; an absent LEI is the normal case.");
    const rec = await gleifFindByUid(deps, uid);
    if (rec && typeof rec.lei === "string") {
      row.lei = rec.lei;
      if (rec.status !== undefined) row.lei_status = rec.status;
      const parents = await gleifParents(deps, rec.lei);
      row.direct_parent = parents.direct;
      row.ultimate_parent = parents.ultimate;
    }
  }

  const order = [
    ...LOOKUP_FIELDS,
    "finma_licence",
    "finma_category",
    "finma_city",
    "finma_flags",
    "lei",
    "lei_status",
    "direct_parent",
    "ultimate_parent",
  ];
  const ordered = project(row, order);
  // Parent keys are names-or-null and stay present on the LEI path.
  if (args.lei && "lei" in ordered) {
    if (!("direct_parent" in ordered)) ordered.direct_parent = null;
    if (!("ultimate_parent" in ordered)) ordered.ultimate_parent = null;
  }
  return envelope([ordered], notes);
}

/* ------------------------------------------------------------------ */
/* 2. swissco_search                                                   */
/* ------------------------------------------------------------------ */

const SEARCH_LINDAS_FIELDS = ["legal_name", "uid", "legal_form", "municipality", "canton", "purpose"];
const SEARCH_REST_FIELDS = ["legal_name", "uid", "chid", "ehra_id", "canton", "status"];

export async function swisscoSearch(
  args: SearchArgs,
  deps: SwissDeps = {},
): Promise<Envelope> {
  const limit = clampLimit(args.limit);
  const via = args.via ?? "lindas";
  if (via !== "lindas" && via !== "rest") throw new Error(`invalid via: ${via}`);

  if (via === "rest") {
    const env = deps.env ?? process.env;
    const user = env.ZEFIX_USER;
    const password = env.ZEFIX_PASSWORD;
    if (!user || !password) {
      throw new Error(
        'via "rest" needs Zefix PublicREST credentials: set ZEFIX_USER and ZEFIX_PASSWORD',
      );
    }
    const notes = ["PublicREST matches a name prefix and needs credentials."];
    if (args.canton !== undefined || args.legal_form !== undefined) {
      notes.push("canton and legal_form filter the LINDAS path only and were ignored.");
    }
    const auth = Buffer.from(`${user}:${password}`).toString("base64");
    const url = `${ZEFIX_SEARCH_URL}?name=${encodeURIComponent(args.term)}*`;
    const rows = await fetchRows(deps, "Zefix", url, {
      headers: { Authorization: `Basic ${auth}` },
    });
    const out = rows.slice(0, limit).map((r) => {
      const row = project(r, SEARCH_REST_FIELDS);
      if (row.uid !== undefined) row.uid = formatUidValue(row.uid);
      return project(row, SEARCH_REST_FIELDS);
    });
    return envelope(out, notes);
  }

  let canton: string | undefined;
  if (args.canton !== undefined) {
    canton = args.canton.toUpperCase();
    if (!/^[A-Z]{2}$/.test(canton)) throw new Error(`invalid canton: ${args.canton}`);
  }
  const rows = await sparql(
    deps,
    `SELECT ?legal_name ?uid ?legal_form ?municipality ?canton ?purpose WHERE { ?s <https://schema.org/name> ?legal_name . FILTER(CONTAINS(LCASE(?legal_name), LCASE("${sparqlEscape(args.term)}")) || CONTAINS(LCASE(?purpose), LCASE("${sparqlEscape(args.term)}"))) }`,
  );
  const notes = ["LINDAS matches a substring of the legal name or the statutory purpose."];
  const out: Row[] = [];
  for (const r of rows) {
    if (canton !== undefined && r.canton !== canton) continue;
    if (
      args.legal_form !== undefined &&
      r.legal_form !== undefined &&
      r.legal_form !== args.legal_form &&
      r.legal_form_code !== undefined &&
      r.legal_form_code !== args.legal_form
    ) {
      continue;
    }
    if (
      args.legal_form !== undefined &&
      r.legal_form !== undefined &&
      r.legal_form !== args.legal_form &&
      r.legal_form_code === undefined
    ) {
      continue;
    }
    const row = project(r, SEARCH_LINDAS_FIELDS);
    if (row.uid !== undefined) row.uid = formatUidValue(row.uid);
    out.push(project(row, SEARCH_LINDAS_FIELDS));
    if (out.length >= limit) break;
  }
  return envelope(out, notes);
}

/* ------------------------------------------------------------------ */
/* 3. swissco_publications                                             */
/* ------------------------------------------------------------------ */

const PUBLICATION_FIELDS = [
  "publication_date",
  "canton",
  "sub_rubric",
  "title",
  "language",
  "state",
  "id",
  "url",
];
const PUBLICATION_EVENT_FIELDS = [
  "publication_date",
  "canton",
  "sub_rubric",
  "company_name",
  "uid",
  "events",
  "effective_date",
  "state",
  "id",
  "url",
];

export async function swisscoPublications(
  args: PublicationsArgs,
  deps: SwissDeps = {},
): Promise<Envelope> {
  const limit = clampLimit(args.limit);
  const range = resolveRange(deps, args.since, args.until, 1, 7, "Range trimmed to the newest 7 days.");
  const notes = [
    ...range.notes,
    "Filters run client-side over the listed publications; the anonymous gazette API ignores its own filter parameters.",
  ];
  const listed = await fetchRows(
    deps,
    "gazette",
    `${GAZETTE_URL}?since=${range.since}&until=${range.until}`,
  );
  const filtered = listed.filter((r) => {
    if (args.cantons !== undefined && !args.cantons.includes(String(r.canton))) return false;
    if (args.sub_rubrics !== undefined && !args.sub_rubrics.includes(String(r.sub_rubric)))
      return false;
    if (
      args.query !== undefined &&
      !(typeof r.title === "string" &&
        r.title.toLowerCase().includes(args.query.toLowerCase()))
    ) {
      return false;
    }
    return true;
  });

  if (args.event_types !== undefined) {
    notes.push("event_types costs one request per publication in range.");
    const wanted = args.event_types;
    const out: Row[] = [];
    for (const item of filtered) {
      const body = (await fetchJson(
        deps,
        "gazette",
        `${GAZETTE_URL}/${encodeURIComponent(String(item.id))}`,
      )) as Row;
      const merged: Row = { ...item, ...body };
      const events = merged.events;
      if (!Array.isArray(events) || !events.some((e) => wanted.includes(String(e)))) continue;
      const row = project(merged, PUBLICATION_EVENT_FIELDS);
      if (row.uid !== undefined) row.uid = formatUidValue(row.uid);
      out.push(project(row, PUBLICATION_EVENT_FIELDS));
      if (out.length >= limit) break;
    }
    return envelope(out, notes);
  }

  const out = filtered.slice(0, limit).map((r) => project(r, PUBLICATION_FIELDS));
  return envelope(out, notes);
}

/* ------------------------------------------------------------------ */
/* 4. swissco_events                                                   */
/* ------------------------------------------------------------------ */

const EVENT_FIELDS = [
  "publication_date",
  "event_type",
  "effective_date",
  "company_name",
  "uid",
  "canton",
  "sub_rubric",
  "id",
  "url",
];

export async function swisscoEvents(args: EventsArgs, deps: SwissDeps = {}): Promise<Envelope> {
  const limit = clampLimit(args.limit);
  const uid = normalizeUid(args.uid);
  const range = resolveRange(
    deps,
    args.since,
    args.until,
    365,
    365,
    "Range trimmed to the newest 365 days.",
  );
  const notes = [...range.notes, "A publication is kept only when its own UID matches the one asked for."];
  const base = await lookupBaseRow(deps, uid);
  if (!base) {
    notes.push("No company found for that UID in the commercial register.");
    return envelope([], notes);
  }
  const listed = await fetchRows(
    deps,
    "gazette",
    `${GAZETTE_URL}?since=${range.since}&until=${range.until}`,
  );
  const compact = compactUid(uid);
  const out: Row[] = [];
  for (const item of listed) {
    const body = (await fetchJson(
      deps,
      "gazette",
      `${GAZETTE_URL}/${encodeURIComponent(String(item.id))}`,
    )) as Row;
    if (!sameUid(body.uid, compact)) continue;
    const merged: Row = { ...item, ...body };
    if (merged.event_type === undefined && Array.isArray(body.events) && body.events.length > 0) {
      merged.event_type = body.events[0];
    }
    if (merged.company_name === undefined) merged.company_name = base.legal_name;
    merged.uid = uid;
    out.push(project(merged, EVENT_FIELDS));
  }
  out.sort((a, b) => String(b.publication_date ?? "").localeCompare(String(a.publication_date ?? "")));
  return envelope(out.slice(0, limit), notes);
}

/* ------------------------------------------------------------------ */
/* 5. swissco_tenders                                                  */
/* ------------------------------------------------------------------ */

export const PUB_TYPES = [
  "abandonment",
  "advance_notice",
  "award",
  "competition",
  "direct_award",
  "participant_selection",
  "request_for_information",
  "revocation",
  "selective_offering_phase",
  "study_contract",
  "tender",
];

const TENDER_FIELDS = [
  "title",
  "project_number",
  "buyer",
  "canton",
  "city",
  "project_type",
  "process_type",
  "publication_date",
  "publication_type",
  "project_id",
  "publication_id",
];

export async function swisscoTenders(args: TendersArgs, deps: SwissDeps = {}): Promise<Envelope> {
  const limit = clampLimit(args.limit);
  if (args.pub_types !== undefined) {
    for (const v of args.pub_types) {
      if (!PUB_TYPES.includes(v)) throw new Error(`invalid pub_types value: ${v}`);
    }
  }
  if (args.lang !== undefined && !["de", "fr", "it", "en"].includes(args.lang)) {
    throw new Error(`invalid lang: ${args.lang}`);
  }
  const range = resolveRange(deps, args.since, args.until, 7, null, null);
  const rows = await fetchRows(
    deps,
    "simap",
    `${SIMAP_PROJECTS_URL}?since=${range.since}&until=${range.until}`,
  );
  const out: Row[] = [];
  for (const r of rows) {
    if (args.cantons !== undefined && !args.cantons.includes(String(r.canton))) continue;
    if (args.pub_types !== undefined && !args.pub_types.includes(String(r.publication_type)))
      continue;
    const rowLang = r.lang ?? r.language;
    if (args.lang !== undefined && rowLang !== undefined && rowLang !== args.lang) continue;
    out.push(project(r, TENDER_FIELDS));
    if (out.length >= limit) break;
  }
  return envelope(out, ["The date matches each project's newest publication; pub_types narrows it."]);
}

/* ------------------------------------------------------------------ */
/* 6. swissco_vendor                                                   */
/* ------------------------------------------------------------------ */

const VENDOR_UID_FIELDS = [
  "name",
  "uid_no",
  "additional_name",
  "street",
  "postal_code",
  "city",
  "canton",
  "url",
  "company_size",
  "type_of_services",
  "cpv_codes",
  "bkp_codes",
  "npk_codes",
  "business_purpose",
  "is_bidding_consortium",
  "leading_vendor_name",
  "vendor_id",
];
const VENDOR_TEXT_FIELDS = [
  "name",
  "uid_no",
  "canton",
  "city",
  "postal_code",
  "active",
  "is_bidding_consortium",
  "vendor_id",
];

export async function swisscoVendor(args: VendorArgs, deps: SwissDeps = {}): Promise<Envelope> {
  const limit = clampLimit(args.limit);
  const notes = [
    "A company can bid without holding a directory profile; an absent profile says nothing about whether it has bid.",
  ];
  const uid = tryParseUid(args.query);

  if (uid) {
    const base = await lookupBaseRow(deps, uid);
    if (!base || typeof base.legal_name !== "string") return envelope([], notes);
    const rows = await fetchRows(
      deps,
      "simap",
      `${SIMAP_VENDORS_URL}?query=${encodeURIComponent(base.legal_name)}`,
    );
    const compact = compactUid(uid);
    const out: Row[] = [];
    for (const r of rows) {
      if (!sameUid(r.uid_no, compact)) continue;
      const row = project(r, VENDOR_UID_FIELDS);
      if (row.uid_no !== undefined) row.uid_no = formatUidValue(row.uid_no);
      out.push(project(row, VENDOR_UID_FIELDS));
      if (out.length >= limit) break;
    }
    return envelope(out, notes);
  }

  const rows = await fetchRows(
    deps,
    "simap",
    `${SIMAP_VENDORS_URL}?query=${encodeURIComponent(args.query)}`,
  );
  const out = rows.slice(0, limit).map((r) => {
    const row = project(r, VENDOR_TEXT_FIELDS);
    if (row.uid_no !== undefined) row.uid_no = formatUidValue(row.uid_no);
    return project(row, VENDOR_TEXT_FIELDS);
  });
  return envelope(out, notes);
}

/* ------------------------------------------------------------------ */
/* 7. swissco_finma                                                    */
/* ------------------------------------------------------------------ */

export const LICENCE_TYPES = [
  "Bank",
  "Securities firm",
  "Foreign bank branch office",
  "Foreign securities firm branch office",
];

export async function swisscoFinma(args: FinmaArgs, deps: SwissDeps = {}): Promise<Envelope> {
  const limit = clampLimit(args.limit);
  if (args.category !== undefined && !["1", "2", "3", "4", "5"].includes(args.category)) {
    throw new Error(`invalid category: ${args.category} (expected 1 to 5)`);
  }
  if (args.licence_type !== undefined && !LICENCE_TYPES.includes(args.licence_type)) {
    throw new Error(`invalid licence_type: ${args.licence_type}`);
  }
  const uid = args.uid !== undefined ? normalizeUid(args.uid) : undefined;
  const rows = await finmaRows(deps);
  const q = args.query?.toLowerCase();
  const out: Row[] = [];
  for (const r of rows) {
    if (
      q !== undefined &&
      !(
        (typeof r.name === "string" && r.name.toLowerCase().includes(q)) ||
        (typeof r.city === "string" && r.city.toLowerCase().includes(q))
      )
    ) {
      continue;
    }
    if (uid !== undefined && !sameUid(r.uid, compactUid(uid))) continue;
    if (args.licence_type !== undefined && r.licence_type !== args.licence_type) continue;
    if (
      args.category !== undefined &&
      String(r.supervisory_category) !== args.category
    ) {
      continue;
    }
    out.push(project(r, FINMA_FIELDS));
    if (out.length >= limit) break;
  }
  return envelope(out, [
    "This list covers banks and securities firms only; insurers, portfolio managers and fund managers are authorised on other FINMA lists.",
  ]);
}

/* ------------------------------------------------------------------ */
/* 8. swissco_lei                                                      */
/* ------------------------------------------------------------------ */

const LEI_FIELDS = [
  "legal_name",
  "lei",
  "registered_as",
  "jurisdiction",
  "status",
  "registration_status",
  "legal_form",
  "city",
  "country",
  "other_names",
  "bic",
  "initial_registration_date",
  "last_update_date",
  "next_renewal_date",
  "direct_parent",
  "ultimate_parent",
  "direct_children",
];
const LEI_CHILD_FIELDS = ["legal_name", "lei", "jurisdiction", "registered_as", "status", "city", "country"];

export async function swisscoLei(args: LeiArgs, deps: SwissDeps = {}): Promise<Envelope> {
  const limit = clampLimit(args.limit);
  const uid = normalizeUid(args.uid);
  const notes = [
    "GLEIF Level 2 records accounting consolidation; a parent here is the entity that consolidates this one.",
  ];
  const rec = await gleifFindByUid(deps, uid);
  if (!rec || typeof rec.lei !== "string") {
    notes.push("No LEI record for that UID; about 28,000 Swiss entities hold an LEI.");
    return envelope([], notes);
  }
  const children = await gleifChildren(deps, rec.lei);

  if (args.children) {
    const out = children.slice(0, limit).map((c) => project(c, LEI_CHILD_FIELDS));
    return envelope(out, notes);
  }

  const parents = await gleifParents(deps, rec.lei);
  const bag: Row = {
    ...rec,
    direct_parent: parents.direct,
    ultimate_parent: parents.ultimate,
    direct_children: children.length,
  };
  return envelope([project(bag, LEI_FIELDS)], notes);
}

/* ------------------------------------------------------------------ */
/* 9. swissco_research                                                 */
/* ------------------------------------------------------------------ */

const RESEARCH_TEXT_FIELDS = [
  "title",
  "project_number",
  "office",
  "status",
  "start_date",
  "end_date",
  "granted_total_costs",
  "participants",
  "aramis_id",
];
const RESEARCH_UID_FIELDS = [
  "title",
  "project_number",
  "office",
  "status",
  "start_date",
  "end_date",
  "granted_total_costs",
  "role",
  "uid",
  "aramis_id",
];
export const RESEARCH_LANGUAGES = ["DE", "EN", "FR", "IT"];

export async function swisscoResearch(
  args: ResearchArgs,
  deps: SwissDeps = {},
): Promise<Envelope> {
  const limit = clampLimit(args.limit);
  const language = args.language ?? "DE";
  if (!RESEARCH_LANGUAGES.includes(language)) {
    throw new Error(`invalid language: ${language} (expected DE, EN, FR or IT)`);
  }
  const notes = [
    "An empty result means no project mentions the company by name; it is not evidence the company took no federal research money.",
  ];
  const uid = tryParseUid(args.query);

  if (uid) {
    const base = await lookupBaseRow(deps, uid);
    const queryText =
      base && typeof base.legal_name === "string" ? base.legal_name : uid;
    const rows = await fetchRows(
      deps,
      "ARAMIS",
      `${ARAMIS_URL}?query=${encodeURIComponent(queryText)}&language=${language}`,
    );
    const compact = compactUid(uid);
    const out: Row[] = [];
    for (const r of rows) {
      const participants = Array.isArray(r.participants) ? (r.participants as Row[]) : [];
      const match = participants.find(
        (p) => p !== null && typeof p === "object" && sameUid(p.uid, compact),
      );
      if (!match) continue;
      const bag: Row = { ...r, role: match.role, uid };
      out.push(project(bag, RESEARCH_UID_FIELDS));
      if (out.length >= limit) break;
    }
    return envelope(out, notes);
  }

  const rows = await fetchRows(
    deps,
    "ARAMIS",
    `${ARAMIS_URL}?query=${encodeURIComponent(args.query)}&language=${language}`,
  );
  const out = rows.slice(0, limit).map((r) => project(r, RESEARCH_TEXT_FIELDS));
  return envelope(out, notes);
}

/** Render an envelope as the JSON text block MCP clients show. */
export function formatEnvelope(env: Envelope): string {
  return JSON.stringify(env, null, 2);
}
