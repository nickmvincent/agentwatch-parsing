/**
 * Edge case tests - boundary conditions and unusual inputs.
 *
 * These tests verify the library handles edge cases gracefully:
 * - Empty files
 * - Single entry files
 * - Unicode content
 * - Large entries
 * - Missing optional fields
 */

import { expect, test, describe } from "bun:test";
import { join } from "path";
import {
  parseClaudeEntries,
  parseCodexEntries,
  parseGeminiEntries,
  parseEntries,
  parseTranscript,
  detectAgentFromContent,
  createSchemaLogger
} from "../src";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");

// ============================================================================
// Empty File Handling
// ============================================================================

describe("Empty Files", () => {
  test("parseClaudeEntries handles empty file", async () => {
    const { entries, total } = await parseClaudeEntries(
      join(FIXTURES_DIR, "empty.jsonl")
    );

    expect(entries).toEqual([]);
    expect(total).toBe(0);
  });

  test("parseTranscript handles empty file gracefully", async () => {
    const transcript = await parseTranscript(
      join(FIXTURES_DIR, "empty.jsonl"),
      "claude"
    );

    expect(transcript.entryCount).toBe(0);
    expect(transcript.name).toBeDefined(); // Should have fallback name
  });
});

// ============================================================================
// Single Entry Files
// ============================================================================

describe("Single Entry Files", () => {
  test("parses single entry correctly", async () => {
    const { entries, total } = await parseClaudeEntries(
      join(FIXTURES_DIR, "single-entry.jsonl")
    );

    expect(total).toBe(1);
    expect(entries.length).toBe(1);
    expect(entries[0].type).toBe("user");
    expect(entries[0].text).toBe("Hello world");
  });

  test("pagination works with single entry", async () => {
    const fixture = join(FIXTURES_DIR, "single-entry.jsonl");

    // Page 1 of 1
    const { entries: page1 } = await parseClaudeEntries(fixture, {
      offset: 0,
      limit: 1
    });
    expect(page1.length).toBe(1);

    // Page 2 (empty)
    const { entries: page2 } = await parseClaudeEntries(fixture, {
      offset: 1,
      limit: 1
    });
    expect(page2.length).toBe(0);
  });
});

// ============================================================================
// Unicode Content
// ============================================================================

describe("Unicode Content", () => {
  test("preserves Unicode in text content", async () => {
    const { entries } = await parseClaudeEntries(
      join(FIXTURES_DIR, "unicode-content.jsonl")
    );

    const userMsg = entries.find(e => e.type === "user");
    expect(userMsg?.text).toContain("Bonjour");
    expect(userMsg?.text).toContain("你好世界");
    expect(userMsg?.text).toContain("🎉");
    expect(userMsg?.text).toContain("Привет");

    const assistantMsg = entries.find(e => e.type === "assistant");
    expect(assistantMsg?.text).toContain("français");
    expect(assistantMsg?.text).toContain("中文");
    expect(assistantMsg?.text).toContain("🚀");
  });

  test("Unicode in session detection", async () => {
    const unicodeJson = JSON.stringify({
      uuid: "msg_unicode",
      type: "user",
      sessionId: "日本語セッション",
      message: { role: "user", content: "こんにちは" }
    });

    expect(detectAgentFromContent(unicodeJson)).toBe("claude");
  });
});

// ============================================================================
// Boundary Conditions
// ============================================================================

describe("Boundary Conditions", () => {
  test("offset equals total returns empty", async () => {
    const fixture = join(FIXTURES_DIR, "claude-session.jsonl");
    const { total } = await parseClaudeEntries(fixture);

    const { entries } = await parseClaudeEntries(fixture, {
      offset: total,
      limit: 10
    });

    expect(entries.length).toBe(0);
  });

  test("limit of 0 returns empty array but correct total", async () => {
    const fixture = join(FIXTURES_DIR, "claude-session.jsonl");
    const { entries, total } = await parseClaudeEntries(fixture, {
      offset: 0,
      limit: 0
    });

    expect(entries.length).toBe(0);
    expect(total).toBeGreaterThan(0);
  });

  test("very large limit is capped to available entries", async () => {
    const fixture = join(FIXTURES_DIR, "claude-session.jsonl");
    const { entries, total } = await parseClaudeEntries(fixture, {
      offset: 0,
      limit: 1000000
    });

    expect(entries.length).toBe(total);
  });
});

// ============================================================================
// includeRaw Option
// ============================================================================

describe("includeRaw Option", () => {
  test("_raw contains original data when enabled", async () => {
    const { entries } = await parseClaudeEntries(
      join(FIXTURES_DIR, "claude-session.jsonl"),
      { includeRaw: true }
    );

    for (const entry of entries) {
      expect(entry._raw).toBeDefined();
      expect(typeof entry._raw).toBe("object");
    }

    // Raw should have original uuid
    const raw = entries[0]._raw as Record<string, unknown>;
    expect(raw.uuid).toBe(entries[0].id);
  });

  test("_raw is undefined when disabled (default)", async () => {
    const { entries } = await parseClaudeEntries(
      join(FIXTURES_DIR, "claude-session.jsonl"),
      { includeRaw: false }
    );

    for (const entry of entries) {
      expect(entry._raw).toBeUndefined();
    }
  });
});

// ============================================================================
// Schema Logger Integration
// ============================================================================

describe("Schema Logger Integration", () => {
  test("logs parse errors with helpful context", async () => {
    const logger = createSchemaLogger();

    await parseClaudeEntries(
      join(FIXTURES_DIR, "malformed.jsonl"),
      { schemaLogger: logger }
    );

    const issues = logger.getIssues();
    expect(issues.length).toBeGreaterThan(0);

    // Issues should have all required fields
    for (const issue of issues) {
      expect(issue.id).toBeDefined();
      expect(issue.timestamp).toBeDefined();
      expect(issue.agent).toBe("claude");
      expect(issue.issueType).toBeDefined();
      expect(issue.description).toBeDefined();
    }
  });

  test("logger can be reused across multiple parses", async () => {
    const logger = createSchemaLogger();

    await parseClaudeEntries(
      join(FIXTURES_DIR, "malformed.jsonl"),
      { schemaLogger: logger }
    );

    const firstCount = logger.getIssues().length;

    await parseClaudeEntries(
      join(FIXTURES_DIR, "malformed.jsonl"),
      { schemaLogger: logger }
    );

    // Issues should accumulate
    expect(logger.getIssues().length).toBe(firstCount * 2);
  });

  test("logger.clear() resets state", async () => {
    const logger = createSchemaLogger();

    await parseClaudeEntries(
      join(FIXTURES_DIR, "malformed.jsonl"),
      { schemaLogger: logger }
    );

    expect(logger.getIssues().length).toBeGreaterThan(0);

    logger.clear();

    expect(logger.getIssues().length).toBe(0);
    expect(logger.getStats().total).toBe(0);
  });
});

// ============================================================================
// Content Detection Edge Cases
// ============================================================================

describe("Content Detection Edge Cases", () => {
  test("detectAgentFromContent handles invalid JSON", () => {
    expect(detectAgentFromContent("not json at all")).toBe(null);
    expect(detectAgentFromContent("{invalid json}")).toBe(null);
    expect(detectAgentFromContent("")).toBe(null);
  });

  test("detectAgentFromContent handles empty object", () => {
    expect(detectAgentFromContent("{}")).toBe(null);
  });

  test("detectAgentFromContent handles partial matches", () => {
    // Has uuid but not type - not Claude
    const partial1 = JSON.stringify({ uuid: "test" });
    expect(detectAgentFromContent(partial1)).toBe(null);

    // Has timestamp and type but no payload - not Codex
    const partial2 = JSON.stringify({ timestamp: "2024-01-01", type: "test" });
    expect(detectAgentFromContent(partial2)).toBe(null);
  });
});

// ============================================================================
// Error Messages
// ============================================================================

describe("Error Messages", () => {
  test("file not found error is descriptive", async () => {
    const badPath = "/definitely/not/a/real/path/transcript.jsonl";

    await expect(parseClaudeEntries(badPath)).rejects.toThrow();
  });

  test("unknown agent error suggests alternatives", async () => {
    try {
      await parseEntries(
        join(FIXTURES_DIR, "claude-session.jsonl"),
        null
      );
      expect(true).toBe(false); // Should not reach
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("Could not detect");
      expect(msg).toContain("claude");
      expect(msg).toContain("codex");
      expect(msg).toContain("gemini");
    }
  });
});

// ============================================================================
// Entry Type Coverage
// ============================================================================

describe("Entry Type Coverage", () => {
  test("Claude: all documented entry types are handled", async () => {
    const { entries } = await parseClaudeEntries(
      join(FIXTURES_DIR, "claude-session.jsonl")
    );

    const types = new Set(entries.map(e => e.type));

    // Core types from Claude
    expect(types.has("user")).toBe(true);
    expect(types.has("assistant")).toBe(true);
    expect(types.has("summary")).toBe(true);
    expect(types.has("tool_call")).toBe(true);
    expect(types.has("tool_result")).toBe(true);
  });

  test("Codex: all documented entry types are handled", async () => {
    const { entries } = await parseCodexEntries(
      join(FIXTURES_DIR, "codex-session.jsonl")
    );

    const types = new Set(entries.map(e => e.type));

    // Core types from Codex
    expect(types.has("user")).toBe(true);
    expect(types.has("assistant")).toBe(true);
    expect(types.has("system")).toBe(true);
    expect(types.has("tool_call")).toBe(true);
    expect(types.has("tool_result")).toBe(true);
  });

  test("Gemini: all documented entry types are handled", async () => {
    const { entries } = await parseGeminiEntries(
      join(FIXTURES_DIR, "gemini-session.json")
    );

    const types = new Set(entries.map(e => e.type));

    // Core types from Gemini
    expect(types.has("user")).toBe(true);
    expect(types.has("assistant")).toBe(true);
    expect(types.has("thinking")).toBe(true);
    expect(types.has("tool_call")).toBe(true);
    expect(types.has("tool_result")).toBe(true);
  });
});
