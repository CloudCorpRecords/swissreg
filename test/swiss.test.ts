import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeUid,
  swisscoEvents,
  swisscoFinma,
  swisscoLei,
  swisscoLookup,
  swisscoPublications,
  swisscoResearch,
  swisscoSearch,
  swisscoTenders,
  swisscoVendor,
} from "../src/swiss.js";
import type { FetchFn, SwissDeps } from "../src/types.js";

/**
 * Every test runs against an injected fake fetch and a fixed
 * fake clock (2026-10-27 UTC): no live network, no live call.
 */

const NOW = () => new Date(Date.UTC(2026, 9, 27, 12, 0, 0));
const UID = "CHE-444.420.929";
const UID_COMPACT = "CHE444420929";
const LEI = "529900BEISPIEL000001";

type Reply = { status?: number; body: unknown };
type Handler = (url: string, init?: { body?: string; headers?: Record<string, string> }) => Reply | null;

interface Captured {
  url: string;
  init?: { method?: string; headers?: Record<string, string>; body?: string };
}

function makeFetch(handlers: Handler[], captured: Captured[] = []): FetchFn {
  return async (url, init) => {
    captured.push({ url, init });
    for (const h of handlers) {
      const r = h(url, init);
      if (r) {
        const status = r.status ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
        };
      }
    }
    return { ok: false, status: 404, text: async () => "no fake route" };
  };
}

function deps(fetchFn: FetchFn, extra: Partial<SwissDeps> = {}): SwissDeps {
  return { fetchFn, now: NOW, env: {}, ...extra };
}

function bindings(rows: Array<Record<string, unknown>>): Reply {
  return {
    body: {
      results: {
        bindings: rows.map((r) =>
          Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { value: v }])),
        ),
      },
    },
  };
}

const LOOKUP_ROW = {
  legal_name: "Beispiel AG",
  uid: UID_COMPACT,
  chid: "CH-020-3000000-1",
  ehra_id: "1234567",
  legal_form_code: "0106",
  legal_form: "AG",
  municipality: "Zürich",
  canton: "ZH",
  address: "Bahnhofstrasse 1, 8001 Zürich",
  purpose: "Handel mit Beispielen",
  zefix_uri: "https://www.zefix.admin.ch/en/search/entity/list/firm/1",
  undocumented_field: "must be dropped",
};

const lindasLookup: Handler = (url, init) =>
  url === "https://ld.admin.ch/query" && init?.body?.includes(UID_COMPACT) && !init.body.includes("CONTAINS")
    ? bindings([LOOKUP_ROW])
    : null;

const lindasEmpty: Handler = (url) =>
  url === "https://ld.admin.ch/query" ? bindings([]) : null;

const FINMA_BANK = {
  name: "Beispiel Bank AG",
  city: "Zürich",
  licence_type: "Bank",
  supervisory_category: "3",
  uid: UID_COMPACT,
  foreign_control: true,
  no_securities_firm_activity: false,
  non_account_holding_securities_firm: false,
  about_to_cease_operations: false,
  internal_code: "dropped",
};
const FINMA_FIRM = {
  name: "Alpen Securities AG",
  city: "Bern",
  licence_type: "Securities firm",
  supervisory_category: "5",
  uid: "CHE-116.281.277",
  foreign_control: false,
  no_securities_firm_activity: true,
  non_account_holding_securities_firm: false,
  about_to_cease_operations: false,
};

const finmaFiles: Handler = (url) => {
  if (url === "https://www.finma.ch/api/institutions/banks") return { body: { rows: [FINMA_BANK] } };
  if (url === "https://www.finma.ch/api/institutions/securities-firms")
    return { body: { rows: [FINMA_FIRM] } };
  return null;
};

function gleifRecord(name: string, lei: string, registeredAs: string): Record<string, unknown> {
  return {
    id: lei,
    attributes: {
      entity: {
        legalName: { name },
        registeredAs,
        jurisdiction: "CH",
        status: "ACTIVE",
        legalForm: { other: "AG" },
        legalAddress: { city: "Zürich", country: "CH" },
        otherEntityNames: [{ name: "Beispiel Group" }],
      },
      registration: {
        registrationStatus: "ISSUED",
        initialRegistrationDate: "2020-01-15",
        lastUpdateDate: "2026-01-15",
        nextRenewalDate: "2027-01-15",
      },
      bic: ["BEISCHZZXXX"],
    },
  };
}

const CHILD = gleifRecord("Beispiel Tochter AG", "529900TOCHTER0000002", "CHE-999.999.996");

const gleifRoutes: Handler = (url) => {
  if (url.startsWith("https://api.gleif.org/api/v1/lei-records?")) {
    if (url.includes("registeredAs=CHE-000")) return { body: { data: [] } };
    return { body: { data: [gleifRecord("Beispiel AG", LEI, UID)] } };
  }
  if (url.endsWith("/direct-parent"))
    return { body: { data: gleifRecord("Beispiel Holding AG", "529900HOLDING0000003", "CHE-111.111.114") } };
  if (url.endsWith("/ultimate-parent")) return { status: 404, body: {} };
  if (url.endsWith("/direct-children")) return { body: { data: [CHILD] } };
  return null;
};

/* ------------------------------------------------------------------ */

describe("UID normalisation and check digit", () => {
  it("accepts punctuated, compact, lower-case and spaced forms", () => {
    assert.equal(normalizeUid("CHE-444.420.929"), UID);
    assert.equal(normalizeUid("CHE444420929"), UID);
    assert.equal(normalizeUid("che-444.420.929"), UID);
    assert.equal(normalizeUid("CHE 444 420 929"), UID);
  });

  it("rejects non-UID forms with the pinned error", () => {
    assert.throws(() => normalizeUid("444420929"), {
      message: "invalid UID: 444420929 (expected form CHE-XXX.XXX.XXX)",
    });
    assert.throws(() => normalizeUid("CHE-444.420.92"), /invalid UID:/);
  });

  it("rejects a bad check digit with the pinned error", () => {
    assert.throws(() => normalizeUid("CHE-444.420.920"), {
      message: "invalid UID check digit: CHE-444.420.920",
    });
  });
});

describe("swissco_lookup", () => {
  it("projects the base row in documented order and drops extra fields", async () => {
    const out = await swisscoLookup({ uid: "che444420929" }, deps(makeFetch([lindasLookup])));
    assert.deepEqual(Object.keys(out), ["rows", "count", "notes"]);
    assert.equal(out.count, 1);
    assert.deepEqual(Object.keys(out.rows[0]), [
      "legal_name", "uid", "chid", "ehra_id", "legal_form_code", "legal_form",
      "municipality", "canton", "address", "purpose", "zefix_uri",
    ]);
    assert.equal(out.rows[0].uid, UID);
    assert.deepEqual(out.notes, [
      "LINDAS only. Zefix PublicREST credentials add capital, status, former names and corporate relations.",
    ]);
  });

  it("merges FINMA licence fields and LEI parents when asked", async () => {
    const out = await swisscoLookup(
      { uid: UID, finma_licence: true, lei: true },
      deps(makeFetch([lindasLookup, finmaFiles, gleifRoutes])),
    );
    const row = out.rows[0];
    assert.equal(row.finma_licence, "Bank");
    assert.equal(row.finma_category, "3");
    assert.equal(row.finma_city, "Zürich");
    assert.deepEqual(row.finma_flags, ["foreign_control"]);
    assert.equal(row.lei, LEI);
    assert.equal(row.lei_status, "ACTIVE");
    assert.equal(row.direct_parent, "Beispiel Holding AG");
    assert.equal(row.ultimate_parent, null);
    assert.equal(out.notes.length, 3);
  });

  it("returns empty rows when the register has no such company", async () => {
    const out = await swisscoLookup({ uid: UID }, deps(makeFetch([lindasEmpty])));
    assert.deepEqual(out.rows, []);
    assert.equal(out.count, 0);
  });
});

describe("swissco_search", () => {
  const lindasSearch: Handler = (url, init) =>
    url === "https://ld.admin.ch/query" && init?.body?.includes("CONTAINS")
      ? bindings([
          { legal_name: "Pharma Beispiel AG", uid: UID_COMPACT, legal_form: "AG", municipality: "Basel", canton: "BS", purpose: "Pharma" },
          { legal_name: "Pharma Zürich GmbH", uid: "CHE-116.281.277", legal_form: "GmbH", municipality: "Zürich", canton: "ZH", purpose: "Pharma" },
        ])
      : null;

  it("filters by canton client-side and projects the LINDAS row shape", async () => {
    const out = await swisscoSearch({ term: "pharma", canton: "bs" }, deps(makeFetch([lindasSearch])));
    assert.equal(out.count, 1);
    assert.deepEqual(Object.keys(out.rows[0]), ["legal_name", "uid", "legal_form", "municipality", "canton", "purpose"]);
    assert.deepEqual(out.notes, ["LINDAS matches a substring of the legal name or the statutory purpose."]);
  });

  it("rejects a malformed canton", async () => {
    await assert.rejects(
      () => swisscoSearch({ term: "x", canton: "ZRH" }, deps(makeFetch([lindasSearch]))),
      { message: "invalid canton: ZRH" },
    );
  });

  it("errors honestly when via=rest has no credentials", async () => {
    await assert.rejects(
      () => swisscoSearch({ term: "x", via: "rest" }, deps(makeFetch([]))),
      { message: 'via "rest" needs Zefix PublicREST credentials: set ZEFIX_USER and ZEFIX_PASSWORD' },
    );
  });

  it("runs the rest path with credentials and notes ignored filters", async () => {
    const captured: Captured[] = [];
    const rest: Handler = (url) =>
      url.startsWith("https://www.zefix.admin.ch/api/search.json")
        ? { body: { rows: [{ legal_name: "Pharma AG", uid: UID_COMPACT, chid: "CH-1", ehra_id: "9", canton: "BS", status: "active", junk: 1 }] } }
        : null;
    const out = await swisscoSearch(
      { term: "Pharma", via: "rest", canton: "BS" },
      deps(makeFetch([rest], captured), { env: { ZEFIX_USER: "u", ZEFIX_PASSWORD: "p" } }),
    );
    assert.deepEqual(Object.keys(out.rows[0]), ["legal_name", "uid", "chid", "ehra_id", "canton", "status"]);
    assert.ok(out.notes.includes("canton and legal_form filter the LINDAS path only and were ignored."));
    assert.ok(captured[0].init?.headers?.Authorization?.startsWith("Basic "));
    assert.ok(captured[0].url.includes("name=Pharma*"));
  });
});

describe("swissco_publications", () => {
  const LIST = [
    { publication_date: "2026-10-27", canton: "ZH", sub_rubric: "HR01", title: "Neueintragung Beispiel AG", language: "de", state: "published", id: "p1", url: "https://example.test/p1", secret: "drop" },
    { publication_date: "2026-10-26", canton: "BE", sub_rubric: "HR02", title: "Mutation Alpen AG", language: "de", state: "published", id: "p2", url: "https://example.test/p2" },
  ];
  const gazetteList = (captured: Captured[] = []): Handler => (url) =>
    url.startsWith("https://www.amtsblattportal.ch/api/publications?") ? { body: { rows: LIST } } : null;

  it("defaults to yesterday..today from the clock and filters client-side", async () => {
    const captured: Captured[] = [];
    const out = await swisscoPublications({ cantons: ["ZH"] }, deps(makeFetch([gazetteList()], captured)));
    assert.ok(captured[0].url.includes("since=2026-10-26&until=2026-10-27"));
    assert.equal(out.count, 1);
    assert.deepEqual(Object.keys(out.rows[0]), ["publication_date", "canton", "sub_rubric", "title", "language", "state", "id", "url"]);
  });

  it("trims a wide range to its newest 7 days with the pinned note", async () => {
    const captured: Captured[] = [];
    const out = await swisscoPublications(
      { since: "2026-10-01", until: "2026-10-27" },
      deps(makeFetch([gazetteList()], captured)),
    );
    assert.ok(captured[0].url.includes("since=2026-10-20&until=2026-10-27"));
    assert.equal(out.notes[0], "Range trimmed to the newest 7 days.");
  });

  it("rejects an invalid date with the pinned error", async () => {
    await assert.rejects(
      () => swisscoPublications({ since: "2026-02-30" }, deps(makeFetch([gazetteList()]))),
      { message: "invalid date: 2026-02-30 (expected YYYY-MM-DD)" },
    );
  });

  it("fetches bodies for event_types and keeps only intersecting rows", async () => {
    const bodies: Handler = (url) => {
      if (url.endsWith("/p1"))
        return { body: { company_name: "Beispiel AG", uid: UID_COMPACT, events: ["registration"], effective_date: "2026-10-27" } };
      if (url.endsWith("/p2"))
        return { body: { company_name: "Alpen AG", uid: "CHE-116.281.277", events: ["deletion"], effective_date: "2026-10-26" } };
      return null;
    };
    const out = await swisscoPublications(
      { event_types: ["registration"] },
      deps(makeFetch([gazetteList(), bodies])),
    );
    assert.equal(out.count, 1);
    assert.deepEqual(Object.keys(out.rows[0]), [
      "publication_date", "canton", "sub_rubric", "company_name", "uid", "events", "effective_date", "state", "id", "url",
    ]);
    assert.equal(out.rows[0].uid, UID);
    assert.ok(out.notes.includes("event_types costs one request per publication in range."));
  });
});

describe("swissco_events", () => {
  const list: Handler = (url) =>
    url.startsWith("https://www.amtsblattportal.ch/api/publications?")
      ? { body: { rows: [
          { publication_date: "2026-03-01", canton: "ZH", sub_rubric: "HR02", id: "e1", url: "https://example.test/e1" },
          { publication_date: "2026-09-01", canton: "ZH", sub_rubric: "HR01", id: "e2", url: "https://example.test/e2" },
          { publication_date: "2026-10-01", canton: "BE", sub_rubric: "HR01", id: "e3", url: "https://example.test/e3" },
        ] } }
      : null;
  const bodies: Handler = (url) => {
    if (url.endsWith("/e1")) return { body: { uid: UID_COMPACT, event_type: "mutation", effective_date: "2026-03-02", company_name: "Beispiel AG" } };
    if (url.endsWith("/e2")) return { body: { uid: UID, events: ["registration"], effective_date: "2026-09-02", company_name: "Beispiel AG" } };
    if (url.endsWith("/e3")) return { body: { uid: "CHE-116.281.277", event_type: "registration", effective_date: "2026-10-02", company_name: "Andere AG" } };
    return null;
  };

  it("keeps only publications whose own UID matches, newest first", async () => {
    const out = await swisscoEvents({ uid: UID }, deps(makeFetch([lindasLookup, list, bodies])));
    assert.equal(out.count, 2);
    assert.equal(out.rows[0].id, "e2");
    assert.equal(out.rows[0].event_type, "registration");
    assert.deepEqual(Object.keys(out.rows[0]), [
      "publication_date", "event_type", "effective_date", "company_name", "uid", "canton", "sub_rubric", "id", "url",
    ]);
    assert.deepEqual(out.notes, ["A publication is kept only when its own UID matches the one asked for."]);
  });

  it("reports no company for an unknown UID", async () => {
    const out = await swisscoEvents({ uid: UID }, deps(makeFetch([lindasEmpty])));
    assert.deepEqual(out.rows, []);
    assert.ok(out.notes.includes("No company found for that UID in the commercial register."));
  });
});

describe("swissco_tenders", () => {
  const projects: Handler = (url) =>
    url.startsWith("https://www.simap.ch/api/projects")
      ? { body: { rows: [
          { title: "Brücke", project_number: "P1", buyer: "Kanton ZH", canton: "ZH", city: "Zürich", project_type: "construction", process_type: "open", publication_date: "2026-10-25", publication_type: "tender", project_id: "1", publication_id: "11", junk: true },
          { title: "Schule", project_number: "P2", buyer: "Stadt Bern", canton: "BE", city: "Bern", project_type: "service", process_type: "selective", publication_date: "2026-10-24", publication_type: "award", project_id: "2", publication_id: "12" },
        ] } }
      : null;

  it("defaults to 7 days ago and filters by canton and pub_types", async () => {
    const captured: Captured[] = [];
    const out = await swisscoTenders(
      { cantons: ["BE"], pub_types: ["award"] },
      deps(makeFetch([projects], captured)),
    );
    assert.ok(captured[0].url.includes("since=2026-10-20&until=2026-10-27"));
    assert.equal(out.count, 1);
    assert.equal(out.rows[0].title, "Schule");
    assert.deepEqual(Object.keys(out.rows[0]), [
      "title", "project_number", "buyer", "canton", "city", "project_type", "process_type", "publication_date", "publication_type", "project_id", "publication_id",
    ]);
  });

  it("rejects an unknown pub_types value with the pinned error", async () => {
    await assert.rejects(
      () => swisscoTenders({ pub_types: ["nope"] }, deps(makeFetch([projects]))),
      { message: "invalid pub_types value: nope" },
    );
  });
});

describe("swissco_vendor", () => {
  const vendors: Handler = (url) => {
    if (!url.startsWith("https://www.simap.ch/api/vendors")) return null;
    if (url.includes("query=Beispiel%20AG")) {
      return { body: { rows: [
        { name: "Beispiel AG", uid_no: UID_COMPACT, additional_name: "", street: "Bahnhofstrasse 1", postal_code: "8001", city: "Zürich", canton: "ZH", url: "https://example.test", company_size: "SME", type_of_services: "IT", cpv_codes: ["72000000"], bkp_codes: [], npk_codes: [], business_purpose: "IT services", is_bidding_consortium: false, leading_vendor_name: "", vendor_id: "v1", extra: 1 },
        { name: "Beispiel AG Filiale", uid_no: "CHE-116.281.277", vendor_id: "v2" },
      ] } };
    }
    return { body: { rows: [
      { name: "Beispiel AG", uid_no: UID_COMPACT, canton: "ZH", city: "Zürich", postal_code: "8001", active: true, is_bidding_consortium: false, vendor_id: "v1", street: "not in text shape" },
    ] } };
  };

  it("UID path resolves the name and keeps only the exact uid_no match", async () => {
    const out = await swisscoVendor({ query: UID }, deps(makeFetch([lindasLookup, vendors])));
    assert.equal(out.count, 1);
    assert.equal(out.rows[0].vendor_id, "v1");
    assert.equal(out.rows[0].uid_no, UID);
    assert.ok("business_purpose" in out.rows[0]);
  });

  it("text path projects the short profile shape", async () => {
    const out = await swisscoVendor({ query: "Beispiel" }, deps(makeFetch([vendors])));
    assert.equal(out.count, 1);
    assert.deepEqual(Object.keys(out.rows[0]), [
      "name", "uid_no", "canton", "city", "postal_code", "active", "is_bidding_consortium", "vendor_id",
    ]);
    assert.deepEqual(out.notes, [
      "A company can bid without holding a directory profile; an absent profile says nothing about whether it has bid.",
    ]);
  });
});

describe("swissco_finma", () => {
  it("merges both files and filters by query, licence_type and category", async () => {
    const all = await swisscoFinma({}, deps(makeFetch([finmaFiles])));
    assert.equal(all.count, 2);
    const banks = await swisscoFinma(
      { licence_type: "Bank", category: "3" },
      deps(makeFetch([finmaFiles])),
    );
    assert.equal(banks.count, 1);
    assert.equal(banks.rows[0].name, "Beispiel Bank AG");
    assert.equal(banks.rows[0].uid, UID);
    const byUid = await swisscoFinma({ uid: UID }, deps(makeFetch([finmaFiles])));
    assert.equal(byUid.count, 1);
    assert.deepEqual(all.notes, [
      "This list covers banks and securities firms only; insurers, portfolio managers and fund managers are authorised on other FINMA lists.",
    ]);
  });

  it("rejects an out-of-range category with the pinned error", async () => {
    await assert.rejects(
      () => swisscoFinma({ category: "9" }, deps(makeFetch([finmaFiles]))),
      { message: "invalid category: 9 (expected 1 to 5)" },
    );
  });
});

describe("swissco_lei", () => {
  it("returns the entity row with parents (404 = null) and children count", async () => {
    const out = await swisscoLei({ uid: UID }, deps(makeFetch([gleifRoutes])));
    assert.equal(out.count, 1);
    const row = out.rows[0];
    assert.equal(row.legal_name, "Beispiel AG");
    assert.equal(row.lei, LEI);
    assert.equal(row.registered_as, UID);
    assert.equal(row.direct_parent, "Beispiel Holding AG");
    assert.equal(row.ultimate_parent, null);
    assert.equal(row.direct_children, 1);
    assert.deepEqual(Object.keys(row), [
      "legal_name", "lei", "registered_as", "jurisdiction", "status", "registration_status", "legal_form", "city", "country", "other_names", "bic", "initial_registration_date", "last_update_date", "next_renewal_date", "direct_parent", "ultimate_parent", "direct_children",
    ]);
  });

  it("returns one row per child when children is true", async () => {
    const out = await swisscoLei({ uid: UID, children: true }, deps(makeFetch([gleifRoutes])));
    assert.equal(out.count, 1);
    assert.deepEqual(Object.keys(out.rows[0]), ["legal_name", "lei", "jurisdiction", "registered_as", "status", "city", "country"]);
    assert.equal(out.rows[0].legal_name, "Beispiel Tochter AG");
  });

  it("returns empty rows and the pinned note when no LEI record exists", async () => {
    // CHE-000.000.001 is not a real UID; use a valid-check-digit UID with no record:
    // the gleif route above returns data: [] only for registeredAs=CHE-000, so use a
    // dedicated empty route instead.
    const empty: Handler = (url) =>
      url.startsWith("https://api.gleif.org/api/v1/lei-records?") ? { body: { data: [] } } : null;
    const out = await swisscoLei({ uid: UID }, deps(makeFetch([empty])));
    assert.deepEqual(out.rows, []);
    assert.ok(out.notes.includes("No LEI record for that UID; about 28,000 Swiss entities hold an LEI."));
  });
});

describe("swissco_research", () => {
  const projects: Handler = (url) => {
    if (!url.startsWith("https://www.aramis.admin.ch/api/projects")) return null;
    return { body: { rows: [
      { title: "Beispiel Forschung", project_number: "R1", office: "Innosuisse", status: "running", start_date: "2025-01-01", end_date: "2027-01-01", granted_total_costs: 500000, participants: [{ name: "Beispiel AG", uid: UID_COMPACT, role: "partner" }], aramis_id: "a1", researcher_email: "secret@example.test" },
      { title: "Andere Forschung", project_number: "R2", office: "SNSF", status: "done", start_date: "2020-01-01", end_date: "2022-01-01", granted_total_costs: 1000, participants: [{ name: "Andere AG", uid: "CHE-116.281.277", role: "lead" }], aramis_id: "a2" },
    ] } };
  };

  it("rejects a lower-case language (case-sensitive) with the pinned error", async () => {
    await assert.rejects(
      () => swisscoResearch({ query: "x", language: "en" }, deps(makeFetch([projects]))),
      { message: "invalid language: en (expected DE, EN, FR or IT)" },
    );
  });

  it("text path projects documented fields only (no researcher contacts)", async () => {
    const out = await swisscoResearch({ query: "Forschung" }, deps(makeFetch([projects])));
    assert.equal(out.count, 2);
    assert.deepEqual(Object.keys(out.rows[0]), [
      "title", "project_number", "office", "status", "start_date", "end_date", "granted_total_costs", "participants", "aramis_id",
    ]);
    assert.ok(!JSON.stringify(out).includes("researcher_email"));
  });

  it("UID path keeps only projects whose participant UID matches, with role+uid", async () => {
    const out = await swisscoResearch({ query: UID }, deps(makeFetch([lindasLookup, projects])));
    assert.equal(out.count, 1);
    assert.equal(out.rows[0].role, "partner");
    assert.equal(out.rows[0].uid, UID);
    assert.ok(!("participants" in out.rows[0]));
  });
});

describe("envelope, limits and upstream errors", () => {
  it("clamps limit at 100 and counts rows", async () => {
    const many = Array.from({ length: 105 }, (_, i) => ({
      publication_date: "2026-10-27", canton: "ZH", sub_rubric: "HR01", title: `T${i}`, language: "de", state: "published", id: `p${i}`, url: "https://example.test",
    }));
    const list: Handler = (url) =>
      url.startsWith("https://www.amtsblattportal.ch/api/publications?") ? { body: { rows: many } } : null;
    const out = await swisscoPublications({ limit: 500 }, deps(makeFetch([list])));
    assert.equal(out.count, 100);
  });

  it("rejects limit below 1 with the pinned error", async () => {
    await assert.rejects(
      () => swisscoTenders({ limit: 0 }, deps(makeFetch([]))),
      { message: "limit must be an integer >= 1" },
    );
  });

  it("maps a non-2xx upstream response to the pinned error form", async () => {
    const failing: FetchFn = async () => ({ ok: false, status: 503, text: async () => "down" });
    await assert.rejects(
      () => swisscoPublications({}, deps(failing)),
      { message: "upstream error: HTTP 503 from gazette" },
    );
  });

  it("maps a throwing fetch to upstream unreachable", async () => {
    const throwing: FetchFn = async () => {
      throw new Error("socket hang up");
    };
    await assert.rejects(
      () => swisscoTenders({}, deps(throwing)),
      { message: "upstream unreachable: simap" },
    );
  });
});
