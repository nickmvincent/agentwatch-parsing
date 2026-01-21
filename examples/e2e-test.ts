#!/usr/bin/env bun
/**
 * Real E2E Test for @agentwatch/parsing
 *
 * This test validates the parsing library against real transcripts on the local machine.
 * It's designed to be run by agents to verify the library works correctly.
 *
 * Usage:
 *   bun examples/e2e-test.ts
 *
 * Exit codes:
 *   0 - All tests passed
 *   1 - Some tests failed
 *   2 - No transcripts found (skipped)
 */

import {
  scanTranscripts,
  parseEntries,
  parseTranscript,
  parseClaudeEntries,
  parseCodexEntries,
  parseGeminiEntries,
  detectAgentFromPath,
  detectAgentFromContent,
  expandHome,
  createSchemaLogger,
  UnifiedEntrySchema,
  UnifiedTranscriptSchema,
  AGENT_INFO
} from "../src/index.js";
import type { UnifiedEntry, UnifiedTranscript, AgentType } from "../src/index.js";
import { readFile, stat } from "fs/promises";

// Test results tracking
let passed = 0;
let failed = 0;
let skipped = 0;

function test(name: string, fn: () => boolean | Promise<boolean>) {
  return { name, fn };
}

async function runTest(t: { name: string; fn: () => boolean | Promise<boolean> }) {
  try {
    const result = await t.fn();
    if (result) {
      console.log(`  ✓ ${t.name}`);
      passed++;
    } else {
      console.log(`  ✗ ${t.name}`);
      failed++;
    }
  } catch (err) {
    console.log(`  ✗ ${t.name}: ${(err as Error).message}`);
    failed++;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function findFirstTranscript(dir: string, ext: string): Promise<string | null> {
  try {
    const transcripts = await scanTranscripts(dir,
      ext === ".jsonl" ? "claude" : "gemini"
    );
    return transcripts.length > 0 ? transcripts[0].path : null;
  } catch {
    return null;
  }
}

// ============================================================================
// Test Suites
// ============================================================================

async function testClaudeCode() {
  const dir = expandHome("~/.claude/projects");

  if (!(await pathExists(dir))) {
    console.log("  ⏭ Skipped: ~/.claude/projects not found");
    skipped++;
    return;
  }

  const transcripts = await scanTranscripts(dir, "claude");
  if (transcripts.length === 0) {
    console.log("  ⏭ Skipped: No Claude transcripts found");
    skipped++;
    return;
  }

  const sample = transcripts[0];
  console.log(`  Testing: ${sample.path.split("/").slice(-2).join("/")}`);

  await runTest(test("scanTranscripts returns valid metadata", () => {
    return UnifiedTranscriptSchema.safeParse(sample).success;
  }));

  await runTest(test("transcript has required fields", () => {
    return sample.agent === "claude" &&
           sample.path.length > 0 &&
           sample.entryCount >= 0;
  }));

  const { entries, total } = await parseClaudeEntries(sample.path, { limit: 50 });

  await runTest(test("parseClaudeEntries returns entries", () => {
    return entries.length > 0 && total > 0;
  }));

  await runTest(test("entries validate against schema", () => {
    return entries.every(e => UnifiedEntrySchema.safeParse(e).success);
  }));

  await runTest(test("entries have correct agent", () => {
    return entries.every(e => e.agent === "claude");
  }));

  await runTest(test("entries have valid timestamps", () => {
    return entries.every(e => !isNaN(new Date(e.timestamp).getTime()));
  }));

  await runTest(test("detectAgentFromPath works", () => {
    return detectAgentFromPath(sample.path) === "claude";
  }));

  const content = await readFile(sample.path, "utf-8");
  await runTest(test("detectAgentFromContent works", () => {
    return detectAgentFromContent(content) === "claude";
  }));

  // Test parseEntries unified API
  const { entries: unified, agent } = await parseEntries(sample.path, "claude", { limit: 10 });
  await runTest(test("parseEntries returns correct agent", () => {
    return agent === "claude" && unified.length > 0;
  }));

  // Test parseTranscript
  const transcript = await parseTranscript(sample.path, "claude");
  await runTest(test("parseTranscript returns stats", () => {
    return transcript.stats !== undefined &&
           transcript.stats.tokens !== undefined;
  }));
}

async function testCodexCLI() {
  const dir = expandHome("~/.codex/sessions");

  if (!(await pathExists(dir))) {
    console.log("  ⏭ Skipped: ~/.codex/sessions not found");
    skipped++;
    return;
  }

  const transcripts = await scanTranscripts(dir, "codex");
  if (transcripts.length === 0) {
    console.log("  ⏭ Skipped: No Codex transcripts found");
    skipped++;
    return;
  }

  const sample = transcripts[0];
  console.log(`  Testing: ${sample.path.split("/").slice(-2).join("/")}`);

  await runTest(test("scanTranscripts returns valid metadata", () => {
    return UnifiedTranscriptSchema.safeParse(sample).success;
  }));

  const { entries, total } = await parseCodexEntries(sample.path, { limit: 50 });

  await runTest(test("parseCodexEntries returns entries", () => {
    return entries.length > 0 && total > 0;
  }));

  await runTest(test("entries validate against schema", () => {
    return entries.every(e => UnifiedEntrySchema.safeParse(e).success);
  }));

  await runTest(test("entries have correct agent", () => {
    return entries.every(e => e.agent === "codex");
  }));

  await runTest(test("detectAgentFromPath works", () => {
    return detectAgentFromPath(sample.path) === "codex";
  }));

  const content = await readFile(sample.path, "utf-8");
  await runTest(test("detectAgentFromContent works", () => {
    return detectAgentFromContent(content) === "codex";
  }));
}

async function testGeminiCLI() {
  const dir = expandHome("~/.gemini/tmp");

  if (!(await pathExists(dir))) {
    console.log("  ⏭ Skipped: ~/.gemini/tmp not found");
    skipped++;
    return;
  }

  const transcripts = await scanTranscripts(dir, "gemini");
  if (transcripts.length === 0) {
    console.log("  ⏭ Skipped: No Gemini transcripts found");
    skipped++;
    return;
  }

  // Find a non-empty transcript
  let sample: UnifiedTranscript | null = null;
  for (const t of transcripts) {
    if (t.entryCount > 0) {
      sample = t;
      break;
    }
  }

  if (!sample) {
    console.log("  ⏭ Skipped: All Gemini transcripts are empty");
    skipped++;
    return;
  }

  console.log(`  Testing: ${sample.path.split("/").slice(-3).join("/")}`);

  await runTest(test("scanTranscripts returns valid metadata", () => {
    return UnifiedTranscriptSchema.safeParse(sample).success;
  }));

  const { entries, total } = await parseGeminiEntries(sample.path, { limit: 50 });

  await runTest(test("parseGeminiEntries returns entries", () => {
    return entries.length > 0;
  }));

  await runTest(test("entries validate against schema", () => {
    return entries.every(e => UnifiedEntrySchema.safeParse(e).success);
  }));

  await runTest(test("entries have correct agent", () => {
    return entries.every(e => e.agent === "gemini");
  }));

  await runTest(test("detectAgentFromPath works", () => {
    return detectAgentFromPath(sample!.path) === "gemini";
  }));
}

async function testCrossAgentConsistency() {
  const allEntries: UnifiedEntry[] = [];

  // Collect sample entries from each agent
  const claudeDir = expandHome("~/.claude/projects");
  if (await pathExists(claudeDir)) {
    const transcripts = await scanTranscripts(claudeDir, "claude");
    if (transcripts.length > 0) {
      const { entries } = await parseClaudeEntries(transcripts[0].path, { limit: 10 });
      allEntries.push(...entries);
    }
  }

  const codexDir = expandHome("~/.codex/sessions");
  if (await pathExists(codexDir)) {
    const transcripts = await scanTranscripts(codexDir, "codex");
    if (transcripts.length > 0) {
      const { entries } = await parseCodexEntries(transcripts[0].path, { limit: 10 });
      allEntries.push(...entries);
    }
  }

  const geminiDir = expandHome("~/.gemini/tmp");
  if (await pathExists(geminiDir)) {
    const transcripts = await scanTranscripts(geminiDir, "gemini");
    for (const t of transcripts) {
      if (t.entryCount > 0) {
        const { entries } = await parseGeminiEntries(t.path, { limit: 10 });
        allEntries.push(...entries);
        break;
      }
    }
  }

  if (allEntries.length === 0) {
    console.log("  ⏭ Skipped: No transcripts from any agent");
    skipped++;
    return;
  }

  const agents = new Set(allEntries.map(e => e.agent));
  console.log(`  Testing ${allEntries.length} entries from ${agents.size} agent(s)`);

  await runTest(test("all entries have id", () => {
    return allEntries.every(e => typeof e.id === "string" && e.id.length > 0);
  }));

  await runTest(test("all entries have valid timestamp", () => {
    return allEntries.every(e => !isNaN(new Date(e.timestamp).getTime()));
  }));

  await runTest(test("all entries have known type", () => {
    const validTypes = ["user", "assistant", "tool_call", "tool_result", "thinking", "system", "summary", "unknown"];
    return allEntries.every(e => validTypes.includes(e.type));
  }));

  await runTest(test("all entries have known agent", () => {
    const validAgents = ["claude", "codex", "gemini", "custom"];
    return allEntries.every(e => validAgents.includes(e.agent));
  }));

  await runTest(test("tool_call entries have toolName", () => {
    return allEntries
      .filter(e => e.type === "tool_call")
      .every(e => typeof e.toolName === "string");
  }));
}

async function testErrorHandling() {
  const logger = createSchemaLogger();

  // Test with non-existent file
  await runTest(test("handles non-existent file gracefully", async () => {
    try {
      await parseClaudeEntries("/non/existent/path.jsonl");
      return false; // Should have thrown
    } catch {
      return true; // Expected
    }
  }));

  // Test schema logger
  await runTest(test("schema logger works", () => {
    logger.log({
      agent: "claude",
      transcriptPath: "/test/path",
      issueType: "parse_error",
      description: "Test error"
    });
    return logger.getIssues().length === 1;
  }));

  await runTest(test("schema logger stats work", () => {
    const stats = logger.getStats();
    return stats.total === 1 && stats.byAgent.claude === 1;
  }));
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("🧪 E2E Test Suite for @agentwatch/parsing\n");
  console.log("Testing against real transcripts on this machine.\n");

  console.log("📂 Claude Code:");
  await testClaudeCode();

  console.log("\n📂 Codex CLI:");
  await testCodexCLI();

  console.log("\n📂 Gemini CLI:");
  await testGeminiCLI();

  console.log("\n🔄 Cross-Agent Consistency:");
  await testCrossAgentConsistency();

  console.log("\n⚠️  Error Handling:");
  await testErrorHandling();

  // Summary
  console.log("\n" + "═".repeat(50));
  console.log("📊 RESULTS:");
  console.log(`   Passed:  ${passed}`);
  console.log(`   Failed:  ${failed}`);
  console.log(`   Skipped: ${skipped}`);
  console.log("═".repeat(50));

  if (failed > 0) {
    console.log("\n❌ Some tests failed");
    process.exit(1);
  } else if (passed === 0) {
    console.log("\n⚠️  No tests ran (no transcripts found)");
    process.exit(2);
  } else {
    console.log("\n✅ All tests passed");
    process.exit(0);
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
