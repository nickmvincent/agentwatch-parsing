/**
 * Node.js smoke test - verifies the library works without Bun
 * Run with: node test/node-smoke.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures");

// Dynamic import of the built library
const lib = await import("../dist/index.js");

describe("Node.js Smoke Tests", () => {
  test("exports core parsing functions", () => {
    assert.strictEqual(typeof lib.parseEntries, "function");
    assert.strictEqual(typeof lib.parseTranscript, "function");
    assert.strictEqual(typeof lib.scanTranscripts, "function");
    assert.strictEqual(typeof lib.detectAgentFromPath, "function");
    assert.strictEqual(typeof lib.detectAgentFromContent, "function");
  });

  test("exports adapter-specific functions", () => {
    assert.strictEqual(typeof lib.parseClaudeEntries, "function");
    assert.strictEqual(typeof lib.parseCodexEntries, "function");
    assert.strictEqual(typeof lib.parseGeminiEntries, "function");
  });

  test("exports utility functions", () => {
    assert.strictEqual(typeof lib.createSchemaLogger, "function");
    assert.strictEqual(typeof lib.createStatsAccumulator, "function");
    assert.strictEqual(typeof lib.expandHome, "function");
  });

  test("exports schemas", () => {
    assert.ok(lib.AgentTypeSchema);
    assert.ok(lib.EntryTypeSchema);
    assert.ok(lib.UnifiedEntrySchema);
    assert.ok(lib.UnifiedTranscriptSchema);
  });

  test("AGENT_INFO has expected structure", () => {
    assert.ok(lib.AGENT_INFO.claude);
    assert.ok(lib.AGENT_INFO.codex);
    assert.ok(lib.AGENT_INFO.gemini);
    assert.strictEqual(lib.AGENT_INFO.claude.name, "Claude Code");
  });

  test("parseClaudeEntries parses fixture", async () => {
    const fixture = join(FIXTURES_DIR, "claude-session.jsonl");
    const { entries, total } = await lib.parseClaudeEntries(fixture);

    assert.strictEqual(total, 9);
    assert.strictEqual(entries.length, 9);
    assert.strictEqual(entries[0].agent, "claude");
  });

  test("parseCodexEntries parses fixture", async () => {
    const fixture = join(FIXTURES_DIR, "codex-session.jsonl");
    const { entries, total } = await lib.parseCodexEntries(fixture);

    assert.strictEqual(total, 12);
    assert.strictEqual(entries.length, 12);
    assert.strictEqual(entries[0].agent, "codex");
  });

  test("parseGeminiEntries parses fixture", async () => {
    const fixture = join(FIXTURES_DIR, "gemini-session.json");
    const { entries } = await lib.parseGeminiEntries(fixture);

    assert.ok(entries.length > 0);
    assert.strictEqual(entries[0].agent, "gemini");
  });

  test("detectAgentFromPath works correctly", () => {
    assert.strictEqual(lib.detectAgentFromPath("/home/user/.claude/projects/foo.jsonl"), "claude");
    assert.strictEqual(lib.detectAgentFromPath("/home/user/.codex/sessions/bar.jsonl"), "codex");
    assert.strictEqual(lib.detectAgentFromPath("/home/user/.gemini/tmp/baz.json"), "gemini");
    assert.strictEqual(lib.detectAgentFromPath("/random/path.jsonl"), null);
  });

  test("expandHome expands tilde", () => {
    const home = process.env.HOME ?? "/home/user";
    assert.strictEqual(lib.expandHome("~/projects"), `${home}/projects`);
    assert.strictEqual(lib.expandHome("/absolute"), "/absolute");
  });

  test("schema validation works", () => {
    const result = lib.UnifiedEntrySchema.safeParse({
      id: "test_1",
      timestamp: "2024-01-15T10:00:00.000Z",
      type: "user",
      agent: "claude",
    });
    assert.strictEqual(result.success, true);
  });
});
