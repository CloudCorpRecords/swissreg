#!/usr/bin/env node
/**
 * swissreg CLI.
 *
 *   swissreg swissco_lookup '<json>'      (and the other eight
 *   swissreg swissco_search '<json>'       tool names likewise)
 *   swissreg mcp
 *   swissreg --version
 *
 * Each tool subcommand takes one JSON argument string with the
 * tool's arguments and prints the tool's {rows, count, notes}
 * envelope as JSON. Exit codes: 0 success, 1 runtime error,
 * 2 usage error.
 */
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

const TOOL_NAMES = [
  "swissco_lookup",
  "swissco_search",
  "swissco_publications",
  "swissco_events",
  "swissco_tenders",
  "swissco_vendor",
  "swissco_finma",
  "swissco_lei",
  "swissco_research",
] as const;

function usage(): never {
  console.error(`Usage:
  swissreg <tool> '<json-args>'     one of: ${TOOL_NAMES.join(", ")}
  swissreg mcp
  swissreg --version`);
  process.exit(2);
}

async function runTool(name: string, args: Record<string, unknown>): Promise<Envelope> {
  switch (name) {
    case "swissco_lookup":
      return swisscoLookup(args as never);
    case "swissco_search":
      return swisscoSearch(args as never);
    case "swissco_publications":
      return swisscoPublications(args as never);
    case "swissco_events":
      return swisscoEvents(args as never);
    case "swissco_tenders":
      return swisscoTenders(args as never);
    case "swissco_vendor":
      return swisscoVendor(args as never);
    case "swissco_finma":
      return swisscoFinma(args as never);
    case "swissco_lei":
      return swisscoLei(args as never);
    case "swissco_research":
      return swisscoResearch(args as never);
    default:
      usage();
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return;
  }
  if (cmd === "mcp") {
    if (rest.length !== 0) usage();
    await import("./mcp.js");
    return;
  }
  if (!(TOOL_NAMES as readonly string[]).includes(cmd ?? "")) usage();
  if (rest.length > 1) usage();
  let args: Record<string, unknown> = {};
  if (rest.length === 1) {
    try {
      const parsed: unknown = JSON.parse(rest[0]);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) usage();
      args = parsed as Record<string, unknown>;
    } catch {
      console.error("error: argument must be a JSON object string");
      process.exit(2);
    }
  }
  try {
    const out = await runTool(cmd, args);
    console.log(formatEnvelope(out));
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
