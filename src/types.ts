/**
 * swissreg types.
 *
 * Nine read-only tools over six Swiss public open-data
 * sources (LINDAS/Zefix, the Official Gazette, simap, FINMA,
 * GLEIF, ARAMIS). Every tool answers with the same envelope:
 * an ordered `{rows, count, notes}` object whose rows carry
 * exactly the documented fields for that tool, in the
 * documented order.
 */

/** The envelope every tool returns: rows, then count, then notes. */
export interface Envelope {
  rows: Array<Record<string, unknown>>;
  count: number;
  notes: string[];
}

export interface LookupArgs {
  uid: string;
  finma_licence?: boolean;
  lei?: boolean;
}

export interface SearchArgs {
  term: string;
  canton?: string;
  legal_form?: string;
  via?: string;
  limit?: number;
}

export interface PublicationsArgs {
  since?: string;
  until?: string;
  cantons?: string[];
  sub_rubrics?: string[];
  event_types?: string[];
  query?: string;
  limit?: number;
}

export interface EventsArgs {
  uid: string;
  since?: string;
  until?: string;
  limit?: number;
}

export interface TendersArgs {
  since?: string;
  until?: string;
  cantons?: string[];
  pub_types?: string[];
  lang?: string;
  limit?: number;
}

export interface VendorArgs {
  query: string;
  limit?: number;
}

export interface FinmaArgs {
  query?: string;
  uid?: string;
  licence_type?: string;
  category?: string;
  limit?: number;
}

export interface LeiArgs {
  uid: string;
  children?: boolean;
  limit?: number;
}

export interface ResearchArgs {
  query: string;
  language?: string;
  limit?: number;
}

/** The minimal slice of a fetch Response this client relies on. */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

/** Injectable fetch, so tests never touch the live network. */
export type FetchFn = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<FetchResponseLike>;

/** Runtime dependencies for the core, all injectable in tests. */
export interface SwissDeps {
  /** Fetch implementation. Defaults to the global fetch. */
  fetchFn?: FetchFn;
  /** Clock used to resolve "today"-relative defaults. */
  now?: () => Date;
  /** Environment (Zefix credentials). Defaults to process.env. */
  env?: Record<string, string | undefined>;
}
