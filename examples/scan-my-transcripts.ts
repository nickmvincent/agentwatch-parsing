#!/usr/bin/env bun
/**
 * Scan your local AI agent transcripts and print a summary.
 *
 * Usage:
 *   bun examples/scan-my-transcripts.ts
 */

import {
  scanTranscripts,
  parseEntries,
  expandHome,
  AGENT_INFO
} from "../src/index.js";
import type { UnifiedTranscript, AgentType } from "../src/index.js";

// Simple progress bar
function progressBar(current: number, total: number, width = 30): string {
  const percent = total > 0 ? current / total : 0;
  const filled = Math.round(width * percent);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  return `[${bar}] ${Math.round(percent * 100)}%`;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString();
}

function formatDateRange(transcripts: UnifiedTranscript[]): string {
  if (transcripts.length === 0) return "N/A";

  const times = transcripts
    .map(t => t.startTime ?? t.modifiedAt)
    .filter(t => t > 0);

  if (times.length === 0) return "N/A";

  const earliest = Math.min(...times);
  const latest = Math.max(...times);

  return `${formatDate(earliest)} → ${formatDate(latest)}`;
}

async function scanWithProgress(
  agentType: AgentType,
  path: string
): Promise<UnifiedTranscript[]> {
  process.stdout.write(`   Scanning ${AGENT_INFO[agentType].name}... `);

  try {
    const transcripts = await scanTranscripts(path, agentType);
    process.stdout.write(`\r   ${AGENT_INFO[agentType].name}: ${transcripts.length} transcripts\n`);
    return transcripts;
  } catch {
    process.stdout.write(`\r   ${AGENT_INFO[agentType].name}: not found\n`);
    return [];
  }
}

async function main() {
  console.log("🔍 Scanning for AI agent transcripts...\n");

  // Default paths for each agent
  const agentPaths: Record<AgentType, string> = {
    claude: expandHome("~/.claude/projects"),
    codex: expandHome("~/.codex/sessions"),
    gemini: expandHome("~/.gemini/tmp"),
    custom: ""
  };

  // Scan each agent with progress
  const byAgent: Record<AgentType, UnifiedTranscript[]> = {
    claude: [],
    codex: [],
    gemini: [],
    custom: []
  };

  for (const agent of ["claude", "codex", "gemini"] as AgentType[]) {
    byAgent[agent] = await scanWithProgress(agent, agentPaths[agent]);
  }

  const allTranscripts = [...byAgent.claude, ...byAgent.codex, ...byAgent.gemini];
  const total = allTranscripts.length;

  // Summary with date ranges
  console.log("\n📊 Summary:");
  console.log(`   ${"Agent".padEnd(15)} ${"Count".padEnd(10)} Date Range`);
  console.log(`   ${"-".repeat(50)}`);

  for (const agent of ["claude", "codex", "gemini"] as AgentType[]) {
    const transcripts = byAgent[agent];
    const name = AGENT_INFO[agent].name.padEnd(15);
    const count = String(transcripts.length).padEnd(10);
    const range = formatDateRange(transcripts);
    console.log(`   ${name} ${count} ${range}`);
  }

  console.log(`   ${"-".repeat(50)}`);
  console.log(`   ${"Total".padEnd(15)} ${total}`);

  if (total === 0) {
    console.log("\nNo transcripts found. Make sure you have used one of the supported agents.");
    return;
  }

  // Sort by most recent
  const sorted = allTranscripts.sort((a, b) => b.modifiedAt - a.modifiedAt);

  // Show recent transcripts with progress
  console.log("\n📝 Recent transcripts:");
  const recentCount = Math.min(10, sorted.length);
  for (let i = 0; i < recentCount; i++) {
    const t = sorted[i];
    const date = new Date(t.modifiedAt).toLocaleDateString();
    const name = t.name.slice(0, 45) + (t.name.length > 45 ? "..." : "");
    const agent = AGENT_INFO[t.agent].name;
    console.log(`   [${date}] ${agent}: "${name}" (${t.entryCount} entries)`);
  }

  // Pick one and show details
  const sample = sorted[0];
  console.log(`\n🔎 Sample transcript: ${sample.path}`);

  process.stdout.write("   Loading entries... ");
  const { entries } = await parseEntries(sample.path, sample.agent, { limit: 50 });
  process.stdout.write(`${entries.length} loaded\n`);

  // Count entry types
  const typeCounts: Record<string, number> = {};
  for (const entry of entries) {
    typeCounts[entry.type] = (typeCounts[entry.type] || 0) + 1;
  }

  console.log("   Entry types:");
  for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`     ${type}: ${count}`);
  }

  // Show conversation preview
  const messages = entries
    .filter(e => e.type === "user" || e.type === "assistant")
    .filter(e => e.text)
    .slice(0, 4);

  if (messages.length > 0) {
    console.log("\n   Conversation preview:");
    for (const msg of messages) {
      const role = msg.type === "user" ? "👤 User" : "🤖 Assistant";
      const text = msg.text!.slice(0, 70).replace(/\n/g, " ");
      console.log(`     ${role}: ${text}${msg.text!.length > 70 ? "..." : ""}`);
    }
  }

  // Token usage
  if (sample.stats?.tokens) {
    const { input, output, total } = sample.stats.tokens;
    console.log(`\n   Token usage: ${input.toLocaleString()} in / ${output.toLocaleString()} out (${total.toLocaleString()} total)`);
  }

  // Tool usage
  if (sample.stats?.tools && Object.keys(sample.stats.tools).length > 0) {
    const tools = Object.entries(sample.stats.tools)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => `${name}(${count})`)
      .join(", ");
    console.log(`   Top tools: ${tools}`);
  }
}

main().catch(console.error);
