#!/usr/bin/env bun
/**
 * Scan your local AI agent transcripts and print a summary.
 *
 * Usage:
 *   bun examples/scan-my-transcripts.ts
 *   # or with Node.js (after building):
 *   node examples/scan-my-transcripts.mjs
 */

import {
  scanAllTranscripts,
  parseEntries,
  expandHome,
  AGENT_INFO
} from "../src/index.js";

async function main() {
  console.log("🔍 Scanning for AI agent transcripts...\n");

  // Default paths for each agent
  const agentPaths = {
    claude: expandHome("~/.claude/projects"),
    codex: expandHome("~/.codex/sessions"),
    gemini: expandHome("~/.gemini/tmp")
  };

  const { transcripts, stats } = await scanAllTranscripts(agentPaths);

  // Summary
  console.log("📊 Summary:");
  console.log(`   Claude Code: ${stats.claude} transcripts`);
  console.log(`   Codex CLI:   ${stats.codex} transcripts`);
  console.log(`   Gemini CLI:  ${stats.gemini} transcripts`);
  console.log(`   Total:       ${stats.total} transcripts\n`);

  if (transcripts.length === 0) {
    console.log("No transcripts found. Make sure you have used one of the supported agents.");
    return;
  }

  // Sort by most recent
  const sorted = transcripts.sort((a, b) => b.modifiedAt - a.modifiedAt);

  // Show recent transcripts
  console.log("📝 Recent transcripts:");
  for (const t of sorted.slice(0, 10)) {
    const date = new Date(t.modifiedAt).toLocaleDateString();
    const name = t.name.slice(0, 50) + (t.name.length > 50 ? "..." : "");
    const agent = AGENT_INFO[t.agent].name;
    console.log(`   [${date}] ${agent}: "${name}" (${t.entryCount} entries)`);
  }

  // Pick one and show details
  const sample = sorted[0];
  console.log(`\n🔎 Sample transcript: ${sample.path}`);

  const { entries } = await parseEntries(sample.path, sample.agent, { limit: 50 });

  // Count entry types
  const typeCounts: Record<string, number> = {};
  for (const entry of entries) {
    typeCounts[entry.type] = (typeCounts[entry.type] || 0) + 1;
  }

  console.log("   Entry types:");
  for (const [type, count] of Object.entries(typeCounts)) {
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
      const text = msg.text!.slice(0, 80).replace(/\n/g, " ");
      console.log(`     ${role}: ${text}${msg.text!.length > 80 ? "..." : ""}`);
    }
  }

  // Token usage
  if (sample.stats?.tokens) {
    const { input, output, total } = sample.stats.tokens;
    console.log(`\n   Token usage: ${input} in / ${output} out (${total} total)`);
  }

  // Tool usage
  if (sample.stats?.tools && Object.keys(sample.stats.tools).length > 0) {
    console.log("   Tools used:", Object.keys(sample.stats.tools).join(", "));
  }
}

main().catch(console.error);
