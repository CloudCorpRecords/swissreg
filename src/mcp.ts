/**
 * swissreg MCP server. Tools: swissco_lookup, swissco_search,
 * swissco_publications, swissco_events, swissco_tenders,
 * swissco_vendor, swissco_finma, swissco_lei, swissco_research.
 *
 * Why the low-level Server instead of McpServer: the
 * high-level helper converts zod schemas to JSON Schema and
 * injects keys that are not in this tool set's documented
 * spec ("$schema" and "additionalProperties"), which breaks
 * exact tool-list/schema parity with the spec. This file
 * serves tools/list with the spec's exact input schemas as
 * explicit literals, and the core validates every tools/call
 * argument set itself.
 *
 * Every tool returns a text item carrying the documented
 * {rows, count, notes} envelope as JSON; validation and
 * upstream failures come back as isError results carrying the
 * documented error strings.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import {
  formatEnvelope,
  swisscoEvents,
  swisscoFinma,
  swisscoLei,
  swisscoLookup,
  swisscoPublications,
  swisscoResearch,
  swisscoSearch,
  swisscoTenders,
  swisscoVendor,
  VERSION,
} from "./swiss.js";
import type { Envelope } from "./types.js";

const LIMIT_PROP = {
  type: "integer",
  description: "Maximum rows to return. Defaults to 100; values above 100 are clamped to 100.",
} as const;

const UID_PROP = {
  type: "string",
  description:
    "The company's Swiss UID, in the form CHE-XXX.XXX.XXX (spaces, dots and dashes are stripped and the check digit is verified).",
} as const;

const TOOLS = [
  {
    name: "swissco_lookup",
    description:
      "Everything the commercial register publishes about one company, optionally with its FINMA licence and its LEI.",
    inputSchema: {
      type: "object" as const,
      properties: {
        uid: UID_PROP,
        finma_licence: {
          type: "boolean",
          description:
            "Add FINMA licence fields (finma_licence, finma_category, finma_city, finma_flags). Defaults to false.",
        },
        lei: {
          type: "boolean",
          description:
            "Add LEI fields (lei, lei_status, direct_parent, ultimate_parent). Defaults to false.",
        },
      },
      required: ["uid"],
    },
  },
  {
    name: "swissco_search",
    description: "Companies whose legal name or statutory purpose contains a term.",
    inputSchema: {
      type: "object" as const,
      properties: {
        term: {
          type: "string",
          description:
            "Term matched as a substring of the legal name or the statutory purpose (LINDAS), or as a name prefix (PublicREST).",
        },
        canton: {
          type: "string",
          description: "Two-letter canton code, e.g. ZH. Filters the LINDAS path only.",
        },
        legal_form: {
          type: "string",
          description: "eCH-0097 legal form code, e.g. 0106. Filters the LINDAS path only.",
        },
        via: {
          type: "string",
          enum: ["lindas", "rest"],
          description:
            "Data source: lindas (default) or rest (Zefix PublicREST, needs ZEFIX_USER and ZEFIX_PASSWORD).",
        },
        limit: LIMIT_PROP,
      },
      required: ["term"],
    },
  },
  {
    name: "swissco_publications",
    description:
      "Commercial-register publications from the Swiss Official Gazette of Commerce in a date range.",
    inputSchema: {
      type: "object" as const,
      properties: {
        since: {
          type: "string",
          description:
            "Start of the date range, YYYY-MM-DD. Defaults to yesterday; ranges wider than 7 days are trimmed to the newest 7 days.",
        },
        until: {
          type: "string",
          description: "End of the date range, YYYY-MM-DD. Defaults to today.",
        },
        cantons: {
          type: "array",
          items: { type: "string" },
          description: "Canton codes to keep; filtering runs client-side.",
        },
        sub_rubrics: {
          type: "array",
          items: { type: "string" },
          description:
            "Sub-rubrics to keep, e.g. HR01 (registrations), HR02 (mutations), HR03 (deletions).",
        },
        event_types: {
          type: "array",
          items: { type: "string" },
          description:
            "Event types to keep; each listed publication's body is fetched and only rows whose events intersect are kept.",
        },
        query: {
          type: "string",
          description: "Title text to match, in any language.",
        },
        limit: LIMIT_PROP,
      },
    },
  },
  {
    name: "swissco_events",
    description: "One company's registry events, each confirmed against the publication's own UID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        uid: UID_PROP,
        since: {
          type: "string",
          description:
            "Start of the date range, YYYY-MM-DD. Defaults to 365 days ago; ranges wider than 365 days are trimmed to the newest 365 days.",
        },
        until: {
          type: "string",
          description: "End of the date range, YYYY-MM-DD. Defaults to today.",
        },
        limit: LIMIT_PROP,
      },
      required: ["uid"],
    },
  },
  {
    name: "swissco_tenders",
    description: "Public-procurement projects published on simap.",
    inputSchema: {
      type: "object" as const,
      properties: {
        since: {
          type: "string",
          description: "Start of the date range, YYYY-MM-DD. Defaults to 7 days ago.",
        },
        until: {
          type: "string",
          description: "End of the date range, YYYY-MM-DD. Defaults to today.",
        },
        cantons: {
          type: "array",
          items: { type: "string" },
          description: "Canton codes to keep.",
        },
        pub_types: {
          type: "array",
          items: {
            type: "string",
            enum: [
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
            ],
          },
          description: "Publication types to keep; the date matched is each project's newest publication.",
        },
        lang: {
          type: "string",
          enum: ["de", "fr", "it", "en"],
          description: "Publication language: de, fr, it or en.",
        },
        limit: LIMIT_PROP,
      },
    },
  },
  {
    name: "swissco_vendor",
    description: "Whether a company holds a simap vendor profile, and what it says.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "A UID (CHE-XXX.XXX.XXX) or company name text.",
        },
        limit: LIMIT_PROP,
      },
      required: ["query"],
    },
  },
  {
    name: "swissco_finma",
    description: "Institutions on FINMA's list of authorised banks and securities firms.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Name or city text to match.",
        },
        uid: UID_PROP,
        licence_type: {
          type: "string",
          enum: [
            "Bank",
            "Securities firm",
            "Foreign bank branch office",
            "Foreign securities firm branch office",
          ],
          description: "Licence type to keep.",
        },
        category: {
          type: "string",
          description: "Supervisory category, 1 to 5.",
        },
        limit: LIMIT_PROP,
      },
    },
  },
  {
    name: "swissco_lei",
    description:
      "A company's Legal Entity Identifier, the entity that consolidates it, and the entity at the top of that chain.",
    inputSchema: {
      type: "object" as const,
      properties: {
        uid: UID_PROP,
        children: {
          type: "boolean",
          description:
            "Return one row per consolidated entity instead of the single entity row. Defaults to false.",
        },
        limit: {
          type: "integer",
          description:
            "Maximum children to return when children is true. Defaults to 100; values above 100 are clamped to 100.",
        },
      },
      required: ["uid"],
    },
  },
  {
    name: "swissco_research",
    description: "Federally funded research projects, Innosuisse and SNSF money included.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "A UID (CHE-XXX.XXX.XXX) or text matched against project data.",
        },
        language: {
          type: "string",
          enum: ["DE", "EN", "FR", "IT"],
          description: "Result language: DE, EN, FR or IT (case-sensitive).",
        },
        limit: LIMIT_PROP,
      },
      required: ["query"],
    },
  },
];

function textResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function errorResult(err: unknown) {
  return {
    content: [
      { type: "text" as const, text: err instanceof Error ? err.message : String(err) },
    ],
    isError: true,
  };
}

const server = new Server(
  { name: "swissreg", version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;
  try {
    let out: Envelope;
    switch (name) {
      case "swissco_lookup":
        out = await swisscoLookup(a as never);
        break;
      case "swissco_search":
        out = await swisscoSearch(a as never);
        break;
      case "swissco_publications":
        out = await swisscoPublications(a as never);
        break;
      case "swissco_events":
        out = await swisscoEvents(a as never);
        break;
      case "swissco_tenders":
        out = await swisscoTenders(a as never);
        break;
      case "swissco_vendor":
        out = await swisscoVendor(a as never);
        break;
      case "swissco_finma":
        out = await swisscoFinma(a as never);
        break;
      case "swissco_lei":
        out = await swisscoLei(a as never);
        break;
      case "swissco_research":
        out = await swisscoResearch(a as never);
        break;
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    return textResult(formatEnvelope(out));
  } catch (err) {
    if (err instanceof McpError) throw err;
    return errorResult(err);
  }
});

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

void main();
