/**
 * End-to-end tests using real transcript files.
 *
 * These tests read from actual agent transcript directories on the local machine.
 * They will be skipped if the directories don't exist or are empty.
 *
 * Purpose:
 * - Catch format drift if agents change their transcript schemas
 * - Validate parsing works on real-world data, not just synthetic fixtures
 * - Ensure the library handles the full variety of real transcripts
 */

import { expect, test, describe } from "bun:test";
import { stat, readdir } from "fs/promises";
import { join } from "path";
import {
  parseClaudeEntries,
  parseCodexEntries,
  parseGeminiEntries,
  parseTranscript,
  scanTranscripts,
  expandHome,
  UnifiedEntrySchema,
  UnifiedTranscriptSchema,
  createSchemaLogger
} from "../src";
import type { UnifiedEntry } from "../src";

// Real transcript directories
const CLAUDE_DIR = expandHome("~/.claude/projects");
const CODEX_DIR = expandHome("~/.codex/sessions");
const GEMINI_DIR = expandHome("~/.gemini/tmp");

async function directoryExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function findFirstJsonl(dir: string, maxDepth = 5): Promise<string | null> {
  if (maxDepth <= 0) return null;

  try {
    const entries = await readdir(dir, { withFileTypes: true });

    // First look for .jsonl files in current directory
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        return join(dir, entry.name);
      }
    }

    // Then recurse into subdirectories
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        const found = await findFirstJsonl(join(dir, entry.name), maxDepth - 1);
        if (found) return found;
      }
    }
  } catch {
    // Directory not readable
  }

  return null;
}

async function findFirstJson(dir: string, maxDepth = 5): Promise<string | null> {
  if (maxDepth <= 0) return null;

  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        return join(dir, entry.name);
      }
    }

    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        const found = await findFirstJson(join(dir, entry.name), maxDepth - 1);
        if (found) return found;
      }
    }
  } catch {
    // Directory not readable
  }

  return null;
}

// ============================================================================
// Claude E2E Tests
// ============================================================================

describe("E2E: Claude Code", () => {
  test("parses real Claude transcripts", async () => {
    if (!(await directoryExists(CLAUDE_DIR))) {
      console.log(`  ⏭ Skipped: ${CLAUDE_DIR} not found`);
      return;
    }

    const transcriptPath = await findFirstJsonl(CLAUDE_DIR);
    if (!transcriptPath) {
      console.log(`  ⏭ Skipped: No .jsonl files found in ${CLAUDE_DIR}`);
      return;
    }

    console.log(`  📄 Testing: ${transcriptPath}`);

    const logger = createSchemaLogger();
    const { entries, total } = await parseClaudeEntries(transcriptPath, {
      schemaLogger: logger,
      limit: 100 // Limit for speed
    });

    // Basic sanity checks
    expect(total).toBeGreaterThan(0);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThanOrEqual(100);

    // All entries should validate against schema
    for (const entry of entries) {
      const result = UnifiedEntrySchema.safeParse(entry);
      if (!result.success) {
        console.log(`  ❌ Invalid entry: ${JSON.stringify(entry, null, 2)}`);
        console.log(`  Error: ${result.error.message}`);
      }
      expect(result.success).toBe(true);
      expect(entry.agent).toBe("claude");
    }

    // Should have mix of entry types
    const types = new Set(entries.map(e => e.type));
    expect(types.size).toBeGreaterThan(1);

    // Log any schema issues for visibility
    const issues = logger.getIssues();
    if (issues.length > 0) {
      console.log(`  ⚠️ ${issues.length} schema issues found (may be expected)`);
    }

    console.log(`  ✅ Parsed ${entries.length}/${total} entries, ${types.size} types`);
  });

  test("scans Claude directory", async () => {
    if (!(await directoryExists(CLAUDE_DIR))) {
      console.log(`  ⏭ Skipped: ${CLAUDE_DIR} not found`);
      return;
    }

    // Scan can be slow with many transcripts, so we just verify it works
    // by checking the first project directory
    const entries = await readdir(CLAUDE_DIR, { withFileTypes: true });
    const firstProjectDir = entries.find(e => e.isDirectory());
    if (!firstProjectDir) {
      console.log(`  ⏭ Skipped: No project directories found`);
      return;
    }

    const projectPath = join(CLAUDE_DIR, firstProjectDir.name);
    const transcripts = await scanTranscripts(projectPath, "claude");

    if (transcripts.length === 0) {
      console.log(`  ⏭ Skipped: No transcripts in first project`);
      return;
    }

    // Validate transcript metadata
    for (const transcript of transcripts.slice(0, 5)) {
      const result = UnifiedTranscriptSchema.safeParse(transcript);
      expect(result.success).toBe(true);
      expect(transcript.agent).toBe("claude");
      expect(transcript.entryCount).toBeGreaterThanOrEqual(0);
    }

    console.log(`  ✅ Found ${transcripts.length} Claude transcripts in first project`);
  }, { timeout: 30000 });
});

// ============================================================================
// Codex E2E Tests
// ============================================================================

describe("E2E: Codex CLI", () => {
  test("parses real Codex transcripts", async () => {
    if (!(await directoryExists(CODEX_DIR))) {
      console.log(`  ⏭ Skipped: ${CODEX_DIR} not found`);
      return;
    }

    const transcriptPath = await findFirstJsonl(CODEX_DIR);
    if (!transcriptPath) {
      console.log(`  ⏭ Skipped: No .jsonl files found in ${CODEX_DIR}`);
      return;
    }

    console.log(`  📄 Testing: ${transcriptPath}`);

    const logger = createSchemaLogger();
    const { entries, total } = await parseCodexEntries(transcriptPath, {
      schemaLogger: logger,
      limit: 100
    });

    expect(total).toBeGreaterThan(0);
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      const result = UnifiedEntrySchema.safeParse(entry);
      expect(result.success).toBe(true);
      expect(entry.agent).toBe("codex");
    }

    const types = new Set(entries.map(e => e.type));
    console.log(`  ✅ Parsed ${entries.length}/${total} entries, ${types.size} types`);
  });

  test("scans Codex directory", async () => {
    if (!(await directoryExists(CODEX_DIR))) {
      console.log(`  ⏭ Skipped: ${CODEX_DIR} not found`);
      return;
    }

    const transcripts = await scanTranscripts(CODEX_DIR, "codex");

    if (transcripts.length === 0) {
      console.log(`  ⏭ Skipped: No transcripts found`);
      return;
    }

    for (const transcript of transcripts.slice(0, 5)) {
      const result = UnifiedTranscriptSchema.safeParse(transcript);
      expect(result.success).toBe(true);
      expect(transcript.agent).toBe("codex");
    }

    console.log(`  ✅ Found ${transcripts.length} Codex transcripts`);
  });
});

// ============================================================================
// Gemini E2E Tests
// ============================================================================

describe("E2E: Gemini CLI", () => {
  test("parses real Gemini transcripts", async () => {
    if (!(await directoryExists(GEMINI_DIR))) {
      console.log(`  ⏭ Skipped: ${GEMINI_DIR} not found`);
      return;
    }

    const transcriptPath = await findFirstJson(GEMINI_DIR);
    if (!transcriptPath) {
      console.log(`  ⏭ Skipped: No .json files found in ${GEMINI_DIR}`);
      return;
    }

    console.log(`  📄 Testing: ${transcriptPath}`);

    const logger = createSchemaLogger();
    const { entries, total } = await parseGeminiEntries(transcriptPath, {
      schemaLogger: logger,
      limit: 100
    });

    // Gemini files might be empty sessions
    if (total === 0) {
      console.log(`  ⏭ Skipped: Empty session`);
      return;
    }

    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      const result = UnifiedEntrySchema.safeParse(entry);
      expect(result.success).toBe(true);
      expect(entry.agent).toBe("gemini");
    }

    const types = new Set(entries.map(e => e.type));
    console.log(`  ✅ Parsed ${entries.length}/${total} entries, ${types.size} types`);
  });

  test("scans Gemini directory", async () => {
    if (!(await directoryExists(GEMINI_DIR))) {
      console.log(`  ⏭ Skipped: ${GEMINI_DIR} not found`);
      return;
    }

    const transcripts = await scanTranscripts(GEMINI_DIR, "gemini");

    if (transcripts.length === 0) {
      console.log(`  ⏭ Skipped: No transcripts found`);
      return;
    }

    for (const transcript of transcripts.slice(0, 5)) {
      const result = UnifiedTranscriptSchema.safeParse(transcript);
      expect(result.success).toBe(true);
      expect(transcript.agent).toBe("gemini");
    }

    console.log(`  ✅ Found ${transcripts.length} Gemini transcripts`);
  });
});

// ============================================================================
// Cross-Agent E2E Tests
// ============================================================================

describe("E2E: Cross-Agent Validation", () => {
  test("unified format is consistent across real transcripts", async () => {
    const allEntries: UnifiedEntry[] = [];

    // Collect entries from each agent
    if (await directoryExists(CLAUDE_DIR)) {
      const path = await findFirstJsonl(CLAUDE_DIR);
      if (path) {
        const { entries } = await parseClaudeEntries(path, { limit: 20 });
        allEntries.push(...entries);
      }
    }

    if (await directoryExists(CODEX_DIR)) {
      const path = await findFirstJsonl(CODEX_DIR);
      if (path) {
        const { entries } = await parseCodexEntries(path, { limit: 20 });
        allEntries.push(...entries);
      }
    }

    if (await directoryExists(GEMINI_DIR)) {
      const path = await findFirstJson(GEMINI_DIR);
      if (path) {
        const { entries } = await parseGeminiEntries(path, { limit: 20 });
        allEntries.push(...entries);
      }
    }

    if (allEntries.length === 0) {
      console.log(`  ⏭ Skipped: No transcripts found on this machine`);
      return;
    }

    // Verify all entries have consistent structure
    for (const entry of allEntries) {
      expect(entry.id).toBeDefined();
      expect(typeof entry.id).toBe("string");

      expect(entry.timestamp).toBeDefined();
      expect(new Date(entry.timestamp).getTime()).not.toBeNaN();

      expect(entry.type).toBeDefined();
      expect(["user", "assistant", "tool_call", "tool_result", "thinking", "system", "summary", "unknown"]).toContain(entry.type);

      expect(entry.agent).toBeDefined();
      expect(["claude", "codex", "gemini", "custom"]).toContain(entry.agent);
    }

    const agents = new Set(allEntries.map(e => e.agent));
    console.log(`  ✅ Validated ${allEntries.length} entries from ${agents.size} agent(s)`);
  });
});
