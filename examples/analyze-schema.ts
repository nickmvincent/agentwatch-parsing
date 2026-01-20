#!/usr/bin/env bun
/**
 * Analyze transcripts for schema issues, unknown fields, and format variations.
 *
 * Usage:
 *   bun examples/analyze-schema.ts
 *   bun examples/analyze-schema.ts --verbose
 *   bun examples/analyze-schema.ts --limit 100
 */

import {
  scanTranscripts,
  parseClaudeEntries,
  parseCodexEntries,
  parseGeminiEntries,
  createSchemaLogger,
  expandHome,
  AGENT_INFO
} from "../src/index.js";
import type { UnifiedTranscript, AgentType, UnifiedEntry } from "../src/index.js";

const VERBOSE = process.argv.includes("--verbose");
const LIMIT_ARG = process.argv.find(a => a.startsWith("--limit"));
const TRANSCRIPT_LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split("=")[1] || "50") : 50;

// Track unknown entry types and fields
const unknownEntryTypes = new Map<string, { count: number; agents: Set<string>; examples: string[] }>();
const unknownFields = new Map<string, { count: number; agents: Set<string>; types: Set<string> }>();
const entryTypesByAgent = new Map<string, Map<string, number>>();
const parseErrors: Array<{ agent: string; path: string; error: string }> = [];

// Known fields in UnifiedEntry
const KNOWN_ENTRY_FIELDS = new Set([
  "id", "timestamp", "type", "agent", "text", "content",
  "toolName", "toolInput", "toolCallId", "model", "tokens",
  "parentId", "sessionId", "isSidechain", "subagentId", "_raw"
]);

function trackEntry(entry: UnifiedEntry, agent: AgentType) {
  // Track entry types per agent
  if (!entryTypesByAgent.has(agent)) {
    entryTypesByAgent.set(agent, new Map());
  }
  const typeCounts = entryTypesByAgent.get(agent)!;
  typeCounts.set(entry.type, (typeCounts.get(entry.type) || 0) + 1);

  // Track unknown entry types
  if (entry.type === "unknown") {
    const raw = entry._raw as Record<string, unknown> | undefined;
    const originalType = raw?.type as string || "no-type";

    if (!unknownEntryTypes.has(originalType)) {
      unknownEntryTypes.set(originalType, { count: 0, agents: new Set(), examples: [] });
    }
    const info = unknownEntryTypes.get(originalType)!;
    info.count++;
    info.agents.add(agent);
    if (info.examples.length < 3 && raw) {
      info.examples.push(JSON.stringify(raw).slice(0, 200));
    }
  }

  // Track unknown fields in _raw that aren't in the unified schema
  if (entry._raw && typeof entry._raw === "object") {
    const raw = entry._raw as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      // Skip internal/known fields
      if (key.startsWith("_") || KNOWN_ENTRY_FIELDS.has(key)) continue;

      // These are known source fields that we intentionally don't expose
      const knownSourceFields = new Set([
        "uuid", "message", "summary", "payload", "messages",
        "sessionId", "projectHash", "startTime", "lastUpdated",
        "thoughts", "toolCalls", "cwd", "call_id", "arguments",
        "output", "role", "usage", "encrypted_content"
      ]);
      if (knownSourceFields.has(key)) continue;

      if (!unknownFields.has(key)) {
        unknownFields.set(key, { count: 0, agents: new Set(), types: new Set() });
      }
      const info = unknownFields.get(key)!;
      info.count++;
      info.agents.add(agent);
      info.types.add(entry.type);
    }
  }
}

async function analyzeAgent(
  agent: AgentType,
  transcripts: UnifiedTranscript[]
): Promise<{ totalEntries: number; totalIssues: number }> {
  const logger = createSchemaLogger();
  let totalEntries = 0;

  const toAnalyze = transcripts.slice(0, TRANSCRIPT_LIMIT);
  console.log(`   Analyzing ${toAnalyze.length} of ${transcripts.length} transcripts...`);

  for (let i = 0; i < toAnalyze.length; i++) {
    const t = toAnalyze[i];

    // Progress
    if ((i + 1) % 10 === 0 || i === toAnalyze.length - 1) {
      process.stdout.write(`\r   Progress: ${i + 1}/${toAnalyze.length}`);
    }

    try {
      let entries: UnifiedEntry[];

      switch (agent) {
        case "claude":
          ({ entries } = await parseClaudeEntries(t.path, {
            schemaLogger: logger,
            includeRaw: true
          }));
          break;
        case "codex":
          ({ entries } = await parseCodexEntries(t.path, {
            schemaLogger: logger,
            includeRaw: true
          }));
          break;
        case "gemini":
          ({ entries } = await parseGeminiEntries(t.path, {
            schemaLogger: logger,
            includeRaw: true
          }));
          break;
        default:
          continue;
      }

      totalEntries += entries.length;

      for (const entry of entries) {
        trackEntry(entry, agent);
      }
    } catch (err) {
      parseErrors.push({
        agent,
        path: t.path,
        error: (err as Error).message.slice(0, 100)
      });
    }
  }

  process.stdout.write("\n");

  return {
    totalEntries,
    totalIssues: logger.getIssues().length
  };
}

async function main() {
  console.log("🔬 Schema Analysis - Scanning for issues and unknown fields\n");

  const agentPaths: Record<string, string> = {
    claude: expandHome("~/.claude/projects"),
    codex: expandHome("~/.codex/sessions"),
    gemini: expandHome("~/.gemini/tmp")
  };

  const stats: Record<string, { transcripts: number; entries: number; issues: number }> = {};

  for (const [agent, path] of Object.entries(agentPaths)) {
    console.log(`📂 ${AGENT_INFO[agent as AgentType].name}:`);

    try {
      const transcripts = await scanTranscripts(path, agent as AgentType);

      if (transcripts.length === 0) {
        console.log("   No transcripts found\n");
        stats[agent] = { transcripts: 0, entries: 0, issues: 0 };
        continue;
      }

      const { totalEntries, totalIssues } = await analyzeAgent(
        agent as AgentType,
        transcripts
      );

      stats[agent] = {
        transcripts: transcripts.length,
        entries: totalEntries,
        issues: totalIssues
      };

      console.log(`   ✓ ${totalEntries.toLocaleString()} entries, ${totalIssues} logger issues\n`);
    } catch {
      console.log("   ✗ Directory not accessible\n");
      stats[agent] = { transcripts: 0, entries: 0, issues: 0 };
    }
  }

  // Summary
  console.log("═".repeat(60));
  console.log("📊 ANALYSIS RESULTS");
  console.log("═".repeat(60));

  // Entry types by agent
  console.log("\n📋 Entry Types by Agent:");
  for (const [agent, types] of entryTypesByAgent) {
    console.log(`\n   ${AGENT_INFO[agent as AgentType].name}:`);
    const sorted = [...types.entries()].sort((a, b) => b[1] - a[1]);
    for (const [type, count] of sorted) {
      const pct = ((count / stats[agent].entries) * 100).toFixed(1);
      console.log(`     ${type.padEnd(15)} ${count.toLocaleString().padStart(8)} (${pct}%)`);
    }
  }

  // Unknown entry types
  if (unknownEntryTypes.size > 0) {
    console.log("\n⚠️  Unknown Entry Types (mapped to 'unknown'):");
    for (const [type, info] of unknownEntryTypes) {
      console.log(`\n   "${type}" - ${info.count} occurrences`);
      console.log(`     Agents: ${[...info.agents].join(", ")}`);
      if (VERBOSE && info.examples.length > 0) {
        console.log("     Example:");
        console.log(`       ${info.examples[0]}...`);
      }
    }
  } else {
    console.log("\n✅ No unknown entry types found");
  }

  // Unknown fields
  if (unknownFields.size > 0) {
    console.log("\n⚠️  Unknown Fields in Raw Data:");
    const sorted = [...unknownFields.entries()].sort((a, b) => b[1].count - a[1].count);
    for (const [field, info] of sorted.slice(0, 20)) {
      console.log(`   "${field}" - ${info.count} occurrences (${[...info.agents].join(", ")})`);
    }
    if (sorted.length > 20) {
      console.log(`   ... and ${sorted.length - 20} more fields`);
    }
  } else {
    console.log("\n✅ No unexpected fields found");
  }

  // Parse errors
  if (parseErrors.length > 0) {
    console.log(`\n❌ Parse Errors (${parseErrors.length}):`);
    for (const err of parseErrors.slice(0, 10)) {
      console.log(`   [${err.agent}] ${err.path.split("/").pop()}: ${err.error}`);
    }
    if (parseErrors.length > 10) {
      console.log(`   ... and ${parseErrors.length - 10} more errors`);
    }
  } else {
    console.log("\n✅ No parse errors");
  }

  // Final summary
  console.log("\n" + "═".repeat(60));
  console.log("📈 TOTALS:");
  const totalTranscripts = Object.values(stats).reduce((a, b) => a + b.transcripts, 0);
  const totalEntries = Object.values(stats).reduce((a, b) => a + b.entries, 0);
  const totalIssues = Object.values(stats).reduce((a, b) => a + b.issues, 0);
  console.log(`   Transcripts analyzed: ${TRANSCRIPT_LIMIT} per agent (${TRANSCRIPT_LIMIT * 3} max)`);
  console.log(`   Total entries parsed: ${totalEntries.toLocaleString()}`);
  console.log(`   Unknown entry types:  ${unknownEntryTypes.size}`);
  console.log(`   Unknown fields:       ${unknownFields.size}`);
  console.log(`   Parse errors:         ${parseErrors.length}`);
  console.log("═".repeat(60));

  if (unknownEntryTypes.size > 0 || unknownFields.size > 0) {
    console.log("\n💡 Tip: Run with --verbose for more details");
    console.log("   Run with --limit=N to analyze more transcripts");
  }
}

main().catch(console.error);
