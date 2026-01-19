import { expect, test, describe, beforeAll } from "bun:test";
import { join } from "path";
import {
  // Core API
  parseEntries,
  parseTranscript,
  scanTranscripts,

  // Detection
  detectAgentFromPath,
  detectAgentFromId,
  detectAgentFromContent,

  // Types and schemas
  AgentTypeSchema,
  EntryTypeSchema,
  UnifiedEntrySchema,
  UnifiedTranscriptSchema,
  AGENT_INFO,

  // Utilities
  createSchemaLogger,
  createStatsAccumulator,
  accumulateEntryStats,
  finalizeStats,
  expandHome,

  // Direct adapter access (for advanced users)
  parseClaudeEntries,
  parseCodexEntries,
  parseGeminiEntries
} from "../src";
import type { UnifiedEntry, UnifiedTranscript, AgentType } from "../src";

// Test fixtures directory
const FIXTURES_DIR = join(import.meta.dir, "fixtures");

// ============================================================================
// Schema Validation Tests
// ============================================================================

describe("Schema Validation", () => {
  describe("AgentTypeSchema", () => {
    test("validates known agent types", () => {
      expect(AgentTypeSchema.safeParse("claude").success).toBe(true);
      expect(AgentTypeSchema.safeParse("codex").success).toBe(true);
      expect(AgentTypeSchema.safeParse("gemini").success).toBe(true);
      expect(AgentTypeSchema.safeParse("custom").success).toBe(true);
    });

    test("rejects unknown agent types", () => {
      expect(AgentTypeSchema.safeParse("gpt4").success).toBe(false);
      expect(AgentTypeSchema.safeParse("").success).toBe(false);
      expect(AgentTypeSchema.safeParse(123).success).toBe(false);
    });
  });

  describe("EntryTypeSchema", () => {
    test("validates all entry types", () => {
      const validTypes = ["user", "assistant", "tool_call", "tool_result", "system", "summary", "thinking", "unknown"];
      for (const type of validTypes) {
        expect(EntryTypeSchema.safeParse(type).success).toBe(true);
      }
    });

    test("rejects invalid entry types", () => {
      expect(EntryTypeSchema.safeParse("message").success).toBe(false);
      expect(EntryTypeSchema.safeParse("response").success).toBe(false);
    });
  });

  describe("UnifiedEntrySchema", () => {
    test("validates minimal valid entry", () => {
      const entry = {
        id: "entry_1",
        timestamp: "2024-01-15T10:00:00.000Z",
        type: "user",
        agent: "claude"
      };
      const result = UnifiedEntrySchema.safeParse(entry);
      expect(result.success).toBe(true);
    });

    test("validates entry with all optional fields", () => {
      const entry = {
        id: "entry_2",
        timestamp: "2024-01-15T10:00:00.000Z",
        type: "tool_call",
        agent: "claude",
        text: "Running command...",
        content: { command: "ls" },
        toolName: "Bash",
        toolInput: { command: "ls -la" },
        toolCallId: "toolu_01",
        model: "claude-sonnet-4",
        tokens: { input: 100, output: 50 },
        parentId: "parent_1",
        sessionId: "session_1",
        isSidechain: false,
        subagentId: "agent_1"
      };
      const result = UnifiedEntrySchema.safeParse(entry);
      expect(result.success).toBe(true);
    });

    test("rejects entry without required fields", () => {
      expect(UnifiedEntrySchema.safeParse({}).success).toBe(false);
      expect(UnifiedEntrySchema.safeParse({ id: "1" }).success).toBe(false);
      expect(UnifiedEntrySchema.safeParse({ id: "1", timestamp: "2024-01-15" }).success).toBe(false);
    });
  });
});

// ============================================================================
// Agent Detection Tests
// ============================================================================

describe("Agent Detection", () => {
  describe("detectAgentFromPath", () => {
    test("detects Claude from standard paths", () => {
      expect(detectAgentFromPath("/Users/dev/.claude/projects/my-project/session.jsonl")).toBe("claude");
      expect(detectAgentFromPath("/home/user/.claude/projects/foo/bar.jsonl")).toBe("claude");
      // Note: Windows paths use forward slashes internally in most JS/TS code
      expect(detectAgentFromPath("C:/Users/dev/.claude/projects/test.jsonl")).toBe("claude");
    });

    test("detects Codex from standard paths", () => {
      expect(detectAgentFromPath("/Users/dev/.codex/sessions/2024/01/15/session.jsonl")).toBe("codex");
      expect(detectAgentFromPath("/home/user/.codex/sessions/rollout.jsonl")).toBe("codex");
    });

    test("detects Gemini from standard paths", () => {
      expect(detectAgentFromPath("/Users/dev/.gemini/tmp/abc123/chats/session.json")).toBe("gemini");
      expect(detectAgentFromPath("/home/user/.gemini/tmp/project/session.json")).toBe("gemini");
    });

    test("returns null for unknown paths", () => {
      expect(detectAgentFromPath("/random/path/file.jsonl")).toBe(null);
      expect(detectAgentFromPath("/Users/dev/projects/transcript.jsonl")).toBe(null);
    });
  });

  describe("detectAgentFromId", () => {
    test("detects agent from prefixed IDs", () => {
      expect(detectAgentFromId("claude:session-abc.jsonl")).toBe("claude");
      expect(detectAgentFromId("codex:2024/01/session.jsonl")).toBe("codex");
      expect(detectAgentFromId("gemini:chat-001.json")).toBe("gemini");
      expect(detectAgentFromId("custom:my-transcript")).toBe("custom");
    });

    test("returns null for unprefixed IDs", () => {
      expect(detectAgentFromId("session-abc")).toBe(null);
      expect(detectAgentFromId("random-id-123")).toBe(null);
    });
  });

  describe("detectAgentFromContent", () => {
    test("detects Claude format from content", () => {
      const claudeContent = JSON.stringify({
        uuid: "msg_001",
        type: "user",
        sessionId: "sess_1",
        message: { role: "user", content: "Hello" }
      });
      expect(detectAgentFromContent(claudeContent)).toBe("claude");
    });

    test("detects Codex format from content", () => {
      const codexContent = JSON.stringify({
        timestamp: "2024-01-15T10:00:00.000Z",
        type: "session_meta",
        payload: { cwd: "/project" }
      });
      expect(detectAgentFromContent(codexContent)).toBe("codex");
    });

    test("detects Gemini format from content", () => {
      const geminiContent = JSON.stringify({
        sessionId: "gemini-001",
        messages: [{ type: "user", content: "Hello" }]
      });
      expect(detectAgentFromContent(geminiContent)).toBe("gemini");
    });

    test("returns null for unrecognized content", () => {
      expect(detectAgentFromContent("not json")).toBe(null);
      expect(detectAgentFromContent(JSON.stringify({ random: "data" }))).toBe(null);
    });
  });
});

// ============================================================================
// Claude Parsing Tests
// ============================================================================

describe("Claude Parsing", () => {
  const claudeFixture = join(FIXTURES_DIR, "claude-session.jsonl");

  describe("parseClaudeEntries", () => {
    test("parses all entries from Claude transcript", async () => {
      const { entries, total } = await parseClaudeEntries(claudeFixture);

      expect(total).toBe(9);
      expect(entries.length).toBe(9);

      // All entries should have required fields
      for (const entry of entries) {
        expect(entry.id).toBeDefined();
        expect(entry.timestamp).toBeDefined();
        expect(entry.type).toBeDefined();
        expect(entry.agent).toBe("claude");
      }
    });

    test("extracts entry types correctly", async () => {
      const { entries } = await parseClaudeEntries(claudeFixture);

      const types = entries.map(e => e.type);
      expect(types).toContain("summary");
      expect(types).toContain("user");
      expect(types).toContain("assistant");
      expect(types).toContain("tool_call");
      expect(types).toContain("tool_result");
    });

    test("extracts tool call information", async () => {
      const { entries } = await parseClaudeEntries(claudeFixture);

      const toolCalls = entries.filter(e => e.type === "tool_call");
      expect(toolCalls.length).toBeGreaterThan(0);

      const firstToolCall = toolCalls[0];
      expect(firstToolCall.toolName).toBe("Write");
      expect(firstToolCall.toolInput).toBeDefined();
      expect(firstToolCall.toolCallId).toBe("toolu_01");
    });

    test("extracts token usage", async () => {
      const { entries } = await parseClaudeEntries(claudeFixture);

      const withTokens = entries.filter(e => e.tokens);
      expect(withTokens.length).toBeGreaterThan(0);

      const entry = withTokens[0];
      expect(entry.tokens?.input).toBeGreaterThan(0);
      expect(entry.tokens?.output).toBeGreaterThan(0);
    });

    test("extracts text content from messages", async () => {
      const { entries } = await parseClaudeEntries(claudeFixture);

      const userMessages = entries.filter(e => e.type === "user" && e.text);
      expect(userMessages.length).toBeGreaterThan(0);
      expect(userMessages[0].text).toContain("validate email");

      const assistantMessages = entries.filter(e => e.type === "assistant" && e.text);
      expect(assistantMessages.length).toBeGreaterThan(0);
    });

    test("respects pagination with offset and limit", async () => {
      const { entries: all } = await parseClaudeEntries(claudeFixture);
      const { entries: page1 } = await parseClaudeEntries(claudeFixture, { offset: 0, limit: 3 });
      const { entries: page2 } = await parseClaudeEntries(claudeFixture, { offset: 3, limit: 3 });

      expect(page1.length).toBe(3);
      expect(page2.length).toBe(3);
      expect(page1[0].id).toBe(all[0].id);
      expect(page2[0].id).toBe(all[3].id);
    });

    test("includes raw data when requested", async () => {
      const { entries } = await parseClaudeEntries(claudeFixture, { includeRaw: true });

      expect(entries[0]._raw).toBeDefined();
      expect((entries[0]._raw as any).uuid).toBe(entries[0].id);
    });
  });

  describe("parseEntries with explicit agent", () => {
    test("parses with explicit agent type", async () => {
      // When the path doesn't match known agent patterns, specify the agent explicitly
      const { entries, agent } = await parseEntries(claudeFixture, "claude");

      expect(agent).toBe("claude");
      expect(entries.length).toBeGreaterThan(0);
    });

    test("throws when agent cannot be detected", async () => {
      // When agent is null and path doesn't match, should throw
      await expect(
        parseEntries(claudeFixture, null)
      ).rejects.toThrow("Could not detect agent type");
    });
  });
});

// ============================================================================
// Codex Parsing Tests
// ============================================================================

describe("Codex Parsing", () => {
  const codexFixture = join(FIXTURES_DIR, "codex-session.jsonl");

  describe("parseCodexEntries", () => {
    test("parses all entries from Codex transcript", async () => {
      const { entries, total } = await parseCodexEntries(codexFixture);

      expect(total).toBe(12);
      expect(entries.length).toBe(12);

      for (const entry of entries) {
        expect(entry.id).toBeDefined();
        expect(entry.timestamp).toBeDefined();
        expect(entry.agent).toBe("codex");
      }
    });

    test("extracts entry types correctly", async () => {
      const { entries } = await parseCodexEntries(codexFixture);

      const types = entries.map(e => e.type);
      expect(types).toContain("system"); // session_meta
      expect(types).toContain("user"); // user_message
      expect(types).toContain("tool_call"); // function_call
      expect(types).toContain("tool_result"); // function_call_output
      expect(types).toContain("assistant"); // message
    });

    test("extracts tool call information", async () => {
      const { entries } = await parseCodexEntries(codexFixture);

      const toolCalls = entries.filter(e => e.type === "tool_call");
      expect(toolCalls.length).toBe(2);

      expect(toolCalls[0].toolName).toBe("shell");
      expect(toolCalls[0].toolCallId).toBe("call_001");
      expect(toolCalls[0].toolInput).toBeDefined();
    });

    test("extracts token usage from token_count events", async () => {
      const { entries } = await parseCodexEntries(codexFixture);

      const withTokens = entries.filter(e => e.tokens);
      expect(withTokens.length).toBeGreaterThan(0);
    });

    test("handles reasoning entries", async () => {
      const { entries } = await parseCodexEntries(codexFixture);

      const thinking = entries.filter(e => e.type === "thinking");
      expect(thinking.length).toBe(1);
      expect(thinking[0].text).toContain("package.json");
    });
  });
});

// ============================================================================
// Gemini Parsing Tests
// ============================================================================

describe("Gemini Parsing", () => {
  const geminiFixture = join(FIXTURES_DIR, "gemini-session.json");

  describe("parseGeminiEntries", () => {
    test("parses messages from Gemini session", async () => {
      const { entries, total } = await parseGeminiEntries(geminiFixture);

      // 6 messages + 2 thinking blocks + 1 tool call + 1 tool result = 10
      expect(total).toBeGreaterThan(6);
      expect(entries.length).toBeGreaterThan(6);

      for (const entry of entries) {
        expect(entry.id).toBeDefined();
        expect(entry.timestamp).toBeDefined();
        expect(entry.agent).toBe("gemini");
      }
    });

    test("extracts user and assistant messages", async () => {
      const { entries } = await parseGeminiEntries(geminiFixture);

      const userMessages = entries.filter(e => e.type === "user");
      expect(userMessages.length).toBe(3);
      expect(userMessages[0].text).toBe("What is the capital of France?");

      const assistantMessages = entries.filter(e => e.type === "assistant");
      expect(assistantMessages.length).toBe(3);
      expect(assistantMessages[0].text).toContain("Paris");
    });

    test("extracts thinking/thought entries", async () => {
      const { entries } = await parseGeminiEntries(geminiFixture);

      const thinking = entries.filter(e => e.type === "thinking");
      expect(thinking.length).toBe(2);
      expect(thinking[0].text).toContain("Search Planning");
    });

    test("extracts tool calls and results", async () => {
      const { entries } = await parseGeminiEntries(geminiFixture);

      const toolCalls = entries.filter(e => e.type === "tool_call");
      expect(toolCalls.length).toBe(1);
      expect(toolCalls[0].toolName).toBe("web_search");

      const toolResults = entries.filter(e => e.type === "tool_result");
      expect(toolResults.length).toBe(1);
    });

    test("extracts token usage", async () => {
      const { entries } = await parseGeminiEntries(geminiFixture);

      const withTokens = entries.filter(e => e.tokens);
      expect(withTokens.length).toBeGreaterThan(0);

      const entry = withTokens.find(e => e.tokens?.total);
      expect(entry?.tokens?.total).toBeGreaterThan(0);
    });
  });
});

// ============================================================================
// Error Handling Tests
// ============================================================================

describe("Error Handling", () => {
  const malformedFixture = join(FIXTURES_DIR, "malformed.jsonl");

  test("handles malformed JSONL gracefully", async () => {
    const logger = createSchemaLogger();
    const { entries, total } = await parseClaudeEntries(malformedFixture, {
      schemaLogger: logger
    });

    // Should still parse valid entries
    expect(entries.length).toBeGreaterThan(0);

    // Should log errors for invalid entries
    const issues = logger.getIssues();
    expect(issues.length).toBeGreaterThan(0);

    // Check that parse errors were logged
    const parseErrors = issues.filter(i => i.issueType === "parse_error");
    expect(parseErrors.length).toBeGreaterThan(0);
  });

  test("handles missing timestamps", async () => {
    const logger = createSchemaLogger();
    const { entries } = await parseClaudeEntries(malformedFixture, {
      schemaLogger: logger
    });

    // Entry without timestamp should still be parsed with current time
    const issues = logger.getIssues();
    const missingTimestamp = issues.filter(i => i.issueType === "missing_required_field");
    expect(missingTimestamp.length).toBeGreaterThan(0);
  });

  test("logs unknown entry types", async () => {
    const logger = createSchemaLogger();
    await parseClaudeEntries(malformedFixture, { schemaLogger: logger });

    const issues = logger.getIssues();
    const unknownTypes = issues.filter(i => i.issueType === "unknown_entry_type");
    expect(unknownTypes.length).toBeGreaterThan(0);
  });

  test("throws for non-existent files", async () => {
    await expect(
      parseClaudeEntries("/non/existent/file.jsonl")
    ).rejects.toThrow();
  });
});

// ============================================================================
// Schema Logger Tests
// ============================================================================

describe("Schema Logger", () => {
  test("logs issues and computes stats", () => {
    const logger = createSchemaLogger();

    logger.log({
      agent: "claude",
      transcriptPath: "/path/a.jsonl",
      issueType: "parse_error",
      description: "Failed to parse"
    });

    logger.log({
      agent: "claude",
      transcriptPath: "/path/b.jsonl",
      issueType: "parse_error",
      description: "Another failure"
    });

    logger.log({
      agent: "codex",
      transcriptPath: "/path/c.jsonl",
      issueType: "unknown_entry_type",
      description: "Unknown type"
    });

    const issues = logger.getIssues();
    expect(issues.length).toBe(3);

    const stats = logger.getStats();
    expect(stats.total).toBe(3);
    expect(stats.byAgent.claude).toBe(2);
    expect(stats.byAgent.codex).toBe(1);
    expect(stats.byType.parse_error).toBe(2);
    expect(stats.byType.unknown_entry_type).toBe(1);
  });

  test("clears issues", () => {
    const logger = createSchemaLogger();
    logger.log({
      agent: "claude",
      transcriptPath: "/a",
      issueType: "parse_error",
      description: "error"
    });

    expect(logger.getIssues().length).toBe(1);
    logger.clear();
    expect(logger.getIssues().length).toBe(0);
  });
});

// ============================================================================
// Stats Accumulator Tests
// ============================================================================

describe("Stats Accumulator", () => {
  test("accumulates token counts", () => {
    const acc = createStatsAccumulator();

    accumulateEntryStats(acc, {
      id: "1",
      timestamp: "2024-01-15T10:00:00Z",
      type: "user",
      agent: "claude",
      tokens: { input: 100, output: 0 }
    });

    accumulateEntryStats(acc, {
      id: "2",
      timestamp: "2024-01-15T10:00:01Z",
      type: "assistant",
      agent: "claude",
      tokens: { input: 50, output: 200, cached: 25 }
    });

    expect(acc.tokens.input).toBe(150);
    expect(acc.tokens.output).toBe(200);
    expect(acc.tokens.cached).toBe(25);
  });

  test("tracks entry type counts", () => {
    const acc = createStatsAccumulator();

    accumulateEntryStats(acc, { id: "1", timestamp: "2024-01-15", type: "user", agent: "claude" });
    accumulateEntryStats(acc, { id: "2", timestamp: "2024-01-15", type: "user", agent: "claude" });
    accumulateEntryStats(acc, { id: "3", timestamp: "2024-01-15", type: "assistant", agent: "claude" });
    accumulateEntryStats(acc, { id: "4", timestamp: "2024-01-15", type: "tool_call", agent: "claude" });

    expect(acc.entryTypes.user).toBe(2);
    expect(acc.entryTypes.assistant).toBe(1);
    expect(acc.entryTypes.tool_call).toBe(1);
  });

  test("tracks tool and model usage", () => {
    const acc = createStatsAccumulator();

    accumulateEntryStats(acc, {
      id: "1",
      timestamp: "2024-01-15",
      type: "tool_call",
      agent: "claude",
      toolName: "Read",
      model: "claude-sonnet-4"
    });

    accumulateEntryStats(acc, {
      id: "2",
      timestamp: "2024-01-15",
      type: "tool_call",
      agent: "claude",
      toolName: "Read",
      model: "claude-sonnet-4"
    });

    accumulateEntryStats(acc, {
      id: "3",
      timestamp: "2024-01-15",
      type: "tool_call",
      agent: "claude",
      toolName: "Write",
      model: "claude-opus-4"
    });

    expect(acc.tools.Read).toBe(2);
    expect(acc.tools.Write).toBe(1);
    expect(acc.models["claude-sonnet-4"]).toBe(2);
    expect(acc.models["claude-opus-4"]).toBe(1);
  });

  test("finalizes stats with duration calculation", () => {
    const acc = createStatsAccumulator();
    acc.tokens = { input: 100, output: 200, cached: 50, total: 350 };
    acc.entryTypes = { user: 5, assistant: 5 };

    const startTime = new Date("2024-01-15T10:00:00Z").getTime();
    const endTime = new Date("2024-01-15T10:05:00Z").getTime();

    const stats = finalizeStats(acc, startTime, endTime);

    expect(stats.durationMs).toBe(5 * 60 * 1000); // 5 minutes
    expect(stats.tokens.input).toBe(100);
    expect(stats.tokens.output).toBe(200);
    expect(stats.entryTypes.user).toBe(5);
  });
});

// ============================================================================
// Utility Tests
// ============================================================================

describe("Utilities", () => {
  test("expandHome expands tilde to home directory", () => {
    const home = process.env.HOME ?? "/home/user";

    expect(expandHome("~/projects")).toBe(`${home}/projects`);
    expect(expandHome("~/.claude/projects")).toBe(`${home}/.claude/projects`);
  });

  test("expandHome leaves absolute paths unchanged", () => {
    expect(expandHome("/absolute/path")).toBe("/absolute/path");
    expect(expandHome("/Users/dev/projects")).toBe("/Users/dev/projects");
  });

  test("expandHome leaves relative paths unchanged", () => {
    expect(expandHome("relative/path")).toBe("relative/path");
    expect(expandHome("./local/path")).toBe("./local/path");
  });
});

// ============================================================================
// AGENT_INFO Tests
// ============================================================================

describe("AGENT_INFO", () => {
  test("contains all supported agents", () => {
    expect(AGENT_INFO.claude).toBeDefined();
    expect(AGENT_INFO.codex).toBeDefined();
    expect(AGENT_INFO.gemini).toBeDefined();
    expect(AGENT_INFO.custom).toBeDefined();
  });

  test("has correct agent properties", () => {
    expect(AGENT_INFO.claude.name).toBe("Claude Code");
    expect(AGENT_INFO.claude.format).toBe("jsonl");
    expect(AGENT_INFO.claude.defaultPath).toBe("~/.claude/projects");
    expect(AGENT_INFO.claude.supportsSubagents).toBe(true);

    expect(AGENT_INFO.codex.name).toBe("Codex CLI");
    expect(AGENT_INFO.codex.format).toBe("jsonl");

    expect(AGENT_INFO.gemini.name).toBe("Gemini CLI");
    expect(AGENT_INFO.gemini.format).toBe("json");
  });
});

// ============================================================================
// Integration Tests - Real User Flows
// ============================================================================

describe("Integration: Real User Flows", () => {
  test("parse transcript and extract conversation", async () => {
    // User flow: Load a transcript and extract the conversation
    const { entries } = await parseEntries(
      join(FIXTURES_DIR, "claude-session.jsonl"),
      "claude"
    );

    // Build conversation from entries
    const conversation: Array<{ role: string; content: string }> = [];
    for (const entry of entries) {
      if (entry.type === "user" && entry.text) {
        conversation.push({ role: "user", content: entry.text });
      } else if (entry.type === "assistant" && entry.text) {
        conversation.push({ role: "assistant", content: entry.text });
      }
    }

    expect(conversation.length).toBeGreaterThan(0);
    expect(conversation[0].role).toBe("user");
    expect(conversation[0].content).toContain("validate email");
  });

  test("calculate total token usage for a session", async () => {
    // User flow: Sum up all token usage in a session
    const { entries } = await parseEntries(
      join(FIXTURES_DIR, "claude-session.jsonl"),
      "claude"
    );

    let totalInput = 0;
    let totalOutput = 0;

    for (const entry of entries) {
      if (entry.tokens) {
        totalInput += entry.tokens.input ?? 0;
        totalOutput += entry.tokens.output ?? 0;
      }
    }

    expect(totalInput).toBeGreaterThan(0);
    expect(totalOutput).toBeGreaterThan(0);
  });

  test("extract all tool calls from a session", async () => {
    // User flow: Get all tools used in a session
    const { entries } = await parseEntries(
      join(FIXTURES_DIR, "claude-session.jsonl"),
      "claude"
    );

    const toolCalls = entries
      .filter(e => e.type === "tool_call")
      .map(e => ({
        tool: e.toolName,
        input: e.toolInput,
        id: e.toolCallId
      }));

    expect(toolCalls.length).toBe(2);
    expect(toolCalls[0].tool).toBe("Write");
    expect(toolCalls[1].tool).toBe("Write");
  });

  test("link tool calls to their results", async () => {
    // User flow: Match tool calls with their results
    const { entries } = await parseEntries(
      join(FIXTURES_DIR, "claude-session.jsonl"),
      "claude"
    );

    const toolCalls = entries.filter(e => e.type === "tool_call");
    const toolResults = entries.filter(e => e.type === "tool_result");

    // Link by toolCallId
    for (const call of toolCalls) {
      const result = toolResults.find(r => r.toolCallId === call.toolCallId);
      expect(result).toBeDefined();
    }
  });

  test("detect agent type for unknown file", async () => {
    // User flow: Identify what agent created a transcript
    const { readFile } = await import("fs/promises");

    const claudeContent = await readFile(
      join(FIXTURES_DIR, "claude-session.jsonl"),
      "utf-8"
    );
    const codexContent = await readFile(
      join(FIXTURES_DIR, "codex-session.jsonl"),
      "utf-8"
    );

    expect(detectAgentFromContent(claudeContent)).toBe("claude");
    expect(detectAgentFromContent(codexContent)).toBe("codex");
  });

  test("paginate through large transcript", async () => {
    // User flow: Read a large transcript in chunks
    const fixture = join(FIXTURES_DIR, "claude-session.jsonl");
    const { total } = await parseClaudeEntries(fixture);

    const pageSize = 3;
    let allEntries: UnifiedEntry[] = [];
    let offset = 0;

    while (offset < total) {
      const { entries } = await parseClaudeEntries(fixture, {
        offset,
        limit: pageSize
      });
      allEntries = allEntries.concat(entries);
      offset += pageSize;
    }

    expect(allEntries.length).toBe(total);
  });
});
