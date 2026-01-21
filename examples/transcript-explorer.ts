#!/usr/bin/env bun
/**
 * Transcript Explorer - Example consumer of @agentwatch/parsing
 *
 * This is a sample application demonstrating how to use the parsing library
 * to build useful tools. It provides several views into your agent transcripts.
 *
 * NOTE: This overlaps with the full agentwatch-review service, but serves as
 * a standalone example of consuming the parsing library.
 *
 * Usage:
 *   bun examples/transcript-explorer.ts [command]
 *
 * Commands:
 *   stats       - Show aggregate statistics across all transcripts
 *   tokens      - Token usage breakdown by model and time
 *   tools       - Tool usage analysis
 *   search      - Search transcript content
 *   timeline    - Show activity timeline
 *   export      - Export conversations to markdown
 */

import {
  scanTranscripts,
  parseEntries,
  expandHome,
  AGENT_INFO
} from "../src/index.js";
import type { UnifiedTranscript, UnifiedEntry, AgentType } from "../src/index.js";

// ============================================================================
// Data Loading
// ============================================================================

async function loadAllTranscripts(): Promise<UnifiedTranscript[]> {
  const allTranscripts: UnifiedTranscript[] = [];

  const paths: Record<string, string> = {
    claude: expandHome("~/.claude/projects"),
    codex: expandHome("~/.codex/sessions"),
    gemini: expandHome("~/.gemini/tmp")
  };

  for (const [agent, path] of Object.entries(paths)) {
    try {
      const transcripts = await scanTranscripts(path, agent as AgentType);
      allTranscripts.push(...transcripts);
    } catch {
      // Directory doesn't exist
    }
  }

  return allTranscripts.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

// ============================================================================
// Commands
// ============================================================================

async function cmdStats() {
  console.log("📊 Aggregate Statistics\n");

  const transcripts = await loadAllTranscripts();

  if (transcripts.length === 0) {
    console.log("No transcripts found.");
    return;
  }

  // By agent
  const byAgent: Record<string, { count: number; entries: number; tokens: number }> = {};

  for (const t of transcripts) {
    if (!byAgent[t.agent]) {
      byAgent[t.agent] = { count: 0, entries: 0, tokens: 0 };
    }
    byAgent[t.agent].count++;
    byAgent[t.agent].entries += t.entryCount;
    byAgent[t.agent].tokens += t.stats?.tokens.total ?? 0;
  }

  console.log("By Agent:");
  console.log("─".repeat(60));
  for (const [agent, stats] of Object.entries(byAgent)) {
    const name = AGENT_INFO[agent as AgentType].name.padEnd(15);
    console.log(`  ${name} ${stats.count.toLocaleString().padStart(6)} sessions | ${stats.entries.toLocaleString().padStart(8)} entries | ${stats.tokens.toLocaleString().padStart(10)} tokens`);
  }

  // Time distribution
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const week = 7 * day;
  const month = 30 * day;

  const today = transcripts.filter(t => now - t.modifiedAt < day).length;
  const thisWeek = transcripts.filter(t => now - t.modifiedAt < week).length;
  const thisMonth = transcripts.filter(t => now - t.modifiedAt < month).length;

  console.log("\nActivity:");
  console.log("─".repeat(60));
  console.log(`  Today:      ${today} sessions`);
  console.log(`  This week:  ${thisWeek} sessions`);
  console.log(`  This month: ${thisMonth} sessions`);
  console.log(`  All time:   ${transcripts.length} sessions`);

  // Total tokens
  const totalTokens = Object.values(byAgent).reduce((a, b) => a + b.tokens, 0);
  const totalEntries = Object.values(byAgent).reduce((a, b) => a + b.entries, 0);

  console.log("\nTotals:");
  console.log("─".repeat(60));
  console.log(`  Total sessions: ${transcripts.length.toLocaleString()}`);
  console.log(`  Total entries:  ${totalEntries.toLocaleString()}`);
  console.log(`  Total tokens:   ${totalTokens.toLocaleString()}`);
}

async function cmdTokens() {
  console.log("🪙 Token Usage Analysis\n");

  const transcripts = await loadAllTranscripts();
  const recentTranscripts = transcripts.slice(0, 100); // Analyze recent 100

  const byModel: Record<string, { input: number; output: number; sessions: number }> = {};
  const byDay: Record<string, { input: number; output: number }> = {};

  for (const t of recentTranscripts) {
    // By model
    if (t.stats?.models) {
      for (const model of Object.keys(t.stats.models)) {
        if (!byModel[model]) {
          byModel[model] = { input: 0, output: 0, sessions: 0 };
        }
        byModel[model].sessions++;
      }
    }

    // Aggregate tokens
    if (t.stats?.tokens) {
      // By model (approximate - assign to first model)
      const firstModel = Object.keys(t.stats?.models ?? {})[0] ?? "unknown";
      if (!byModel[firstModel]) {
        byModel[firstModel] = { input: 0, output: 0, sessions: 0 };
      }
      byModel[firstModel].input += t.stats.tokens.input;
      byModel[firstModel].output += t.stats.tokens.output;

      // By day
      const day = new Date(t.modifiedAt).toISOString().split("T")[0];
      if (!byDay[day]) {
        byDay[day] = { input: 0, output: 0 };
      }
      byDay[day].input += t.stats.tokens.input;
      byDay[day].output += t.stats.tokens.output;
    }
  }

  console.log("By Model (last 100 sessions):");
  console.log("─".repeat(70));
  const sortedModels = Object.entries(byModel).sort((a, b) => (b[1].input + b[1].output) - (a[1].input + a[1].output));
  for (const [model, stats] of sortedModels.slice(0, 10)) {
    const total = stats.input + stats.output;
    console.log(`  ${model.padEnd(30)} ${stats.input.toLocaleString().padStart(10)} in | ${stats.output.toLocaleString().padStart(10)} out | ${total.toLocaleString().padStart(10)} total`);
  }

  console.log("\nBy Day (last 7 days):");
  console.log("─".repeat(50));
  const sortedDays = Object.entries(byDay).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 7);
  for (const [day, stats] of sortedDays) {
    const total = stats.input + stats.output;
    console.log(`  ${day}  ${total.toLocaleString().padStart(10)} tokens`);
  }
}

async function cmdTools() {
  console.log("🔧 Tool Usage Analysis\n");

  const transcripts = await loadAllTranscripts();
  const recentTranscripts = transcripts.slice(0, 50);

  const toolCounts: Record<string, { count: number; agents: Set<string> }> = {};

  for (const t of recentTranscripts) {
    if (t.stats?.tools) {
      for (const [tool, count] of Object.entries(t.stats.tools)) {
        if (!toolCounts[tool]) {
          toolCounts[tool] = { count: 0, agents: new Set() };
        }
        toolCounts[tool].count += count;
        toolCounts[tool].agents.add(t.agent);
      }
    }
  }

  console.log("Most Used Tools (last 50 sessions):");
  console.log("─".repeat(60));

  const sorted = Object.entries(toolCounts).sort((a, b) => b[1].count - a[1].count);
  for (const [tool, stats] of sorted.slice(0, 20)) {
    const agents = [...stats.agents].map(a => AGENT_INFO[a as AgentType].name.split(" ")[0]).join(", ");
    console.log(`  ${tool.padEnd(25)} ${stats.count.toLocaleString().padStart(6)} calls  (${agents})`);
  }

  // Tool categories
  const categories: Record<string, string[]> = {
    "File Operations": ["Read", "Write", "Edit", "Glob", "Grep"],
    "Execution": ["Bash", "shell", "execute_command"],
    "Search": ["WebSearch", "web_search", "Grep", "Glob"],
    "Communication": ["AskUserQuestion", "TodoWrite"]
  };

  console.log("\nBy Category:");
  console.log("─".repeat(40));
  for (const [category, tools] of Object.entries(categories)) {
    const count = tools.reduce((sum, tool) => sum + (toolCounts[tool]?.count ?? 0), 0);
    if (count > 0) {
      console.log(`  ${category.padEnd(20)} ${count.toLocaleString().padStart(6)} calls`);
    }
  }
}

async function cmdSearch(query: string) {
  if (!query) {
    console.log("Usage: transcript-explorer search <query>");
    return;
  }

  console.log(`🔍 Searching for: "${query}"\n`);

  const transcripts = await loadAllTranscripts();
  const results: Array<{ transcript: UnifiedTranscript; entry: UnifiedEntry; snippet: string }> = [];

  const queryLower = query.toLowerCase();

  for (const t of transcripts.slice(0, 50)) {
    try {
      const { entries } = await parseEntries(t.path, t.agent, { limit: 100 });

      for (const entry of entries) {
        if (entry.text?.toLowerCase().includes(queryLower)) {
          const idx = entry.text.toLowerCase().indexOf(queryLower);
          const start = Math.max(0, idx - 40);
          const end = Math.min(entry.text.length, idx + query.length + 40);
          const snippet = (start > 0 ? "..." : "") +
                         entry.text.slice(start, end).replace(/\n/g, " ") +
                         (end < entry.text.length ? "..." : "");

          results.push({ transcript: t, entry, snippet });

          if (results.length >= 20) break;
        }
      }
    } catch {
      // Skip unreadable transcripts
    }

    if (results.length >= 20) break;
  }

  if (results.length === 0) {
    console.log("No results found.");
    return;
  }

  console.log(`Found ${results.length} results:\n`);
  for (const r of results) {
    const date = new Date(r.transcript.modifiedAt).toLocaleDateString();
    const agent = AGENT_INFO[r.transcript.agent].name;
    console.log(`[${date}] ${agent} - ${r.entry.type}`);
    console.log(`  "${r.snippet}"`);
    console.log();
  }
}

async function cmdTimeline() {
  console.log("📅 Activity Timeline\n");

  const transcripts = await loadAllTranscripts();

  // Group by day
  const byDay: Record<string, UnifiedTranscript[]> = {};

  for (const t of transcripts.slice(0, 200)) {
    const day = new Date(t.modifiedAt).toISOString().split("T")[0];
    if (!byDay[day]) {
      byDay[day] = [];
    }
    byDay[day].push(t);
  }

  const sortedDays = Object.entries(byDay).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 14);

  for (const [day, dayTranscripts] of sortedDays) {
    const weekday = new Date(day).toLocaleDateString("en-US", { weekday: "short" });
    console.log(`\n${day} (${weekday}) - ${dayTranscripts.length} sessions`);
    console.log("─".repeat(50));

    for (const t of dayTranscripts.slice(0, 5)) {
      const time = new Date(t.modifiedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
      const agent = AGENT_INFO[t.agent].name.split(" ")[0].padEnd(8);
      const name = t.name.slice(0, 40) + (t.name.length > 40 ? "..." : "");
      console.log(`  ${time} ${agent} "${name}"`);
    }

    if (dayTranscripts.length > 5) {
      console.log(`  ... and ${dayTranscripts.length - 5} more`);
    }
  }
}

async function cmdExport(outputPath?: string) {
  console.log("📄 Export Conversations\n");

  const transcripts = await loadAllTranscripts();
  const recent = transcripts[0];

  if (!recent) {
    console.log("No transcripts found.");
    return;
  }

  console.log(`Exporting most recent session: ${recent.name}\n`);

  const { entries } = await parseEntries(recent.path, recent.agent);

  const lines: string[] = [
    `# ${recent.name}`,
    "",
    `**Agent:** ${AGENT_INFO[recent.agent].name}`,
    `**Date:** ${new Date(recent.modifiedAt).toLocaleString()}`,
    `**Entries:** ${recent.entryCount}`,
    "",
    "---",
    ""
  ];

  for (const entry of entries) {
    if (entry.type === "user" && entry.text) {
      lines.push(`## 👤 User\n`);
      lines.push(entry.text);
      lines.push("");
    } else if (entry.type === "assistant" && entry.text) {
      lines.push(`## 🤖 Assistant\n`);
      lines.push(entry.text);
      lines.push("");
    } else if (entry.type === "tool_call") {
      lines.push(`### 🔧 Tool: ${entry.toolName}\n`);
      if (entry.toolInput) {
        lines.push("```json");
        lines.push(JSON.stringify(entry.toolInput, null, 2).slice(0, 500));
        lines.push("```");
      }
      lines.push("");
    } else if (entry.type === "tool_result" && entry.text) {
      lines.push(`### 📤 Result\n`);
      lines.push("```");
      lines.push(entry.text.slice(0, 500) + (entry.text.length > 500 ? "\n..." : ""));
      lines.push("```");
      lines.push("");
    }
  }

  const markdown = lines.join("\n");

  if (outputPath) {
    await Bun.write(outputPath, markdown);
    console.log(`Written to: ${outputPath}`);
  } else {
    console.log(markdown);
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command) {
    console.log(`
Transcript Explorer - Example consumer of @agentwatch/parsing

Usage: bun examples/transcript-explorer.ts <command>

Commands:
  stats       Show aggregate statistics
  tokens      Token usage breakdown
  tools       Tool usage analysis
  search <q>  Search transcript content
  timeline    Show activity timeline
  export      Export conversation to markdown

Examples:
  bun examples/transcript-explorer.ts stats
  bun examples/transcript-explorer.ts search "authentication"
  bun examples/transcript-explorer.ts export > session.md
`);
    return;
  }

  switch (command) {
    case "stats":
      await cmdStats();
      break;
    case "tokens":
      await cmdTokens();
      break;
    case "tools":
      await cmdTools();
      break;
    case "search":
      await cmdSearch(args.join(" "));
      break;
    case "timeline":
      await cmdTimeline();
      break;
    case "export":
      await cmdExport(args[0]);
      break;
    default:
      console.log(`Unknown command: ${command}`);
      console.log("Run without arguments for help.");
  }
}

main().catch(console.error);
