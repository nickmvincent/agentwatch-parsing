/**
 * Example and documentation tests.
 *
 * These tests serve two purposes:
 * 1. Verify README code examples work correctly
 * 2. Demonstrate real-world use cases for the library
 *
 * If any test here fails, the README likely needs updating.
 */

import { expect, test, describe } from "bun:test";
import { join } from "path";
import { readFile } from "fs/promises";
import {
  parseEntries,
  parseTranscript,
  parseClaudeEntries,
  parseCodexEntries,
  parseGeminiEntries,
  detectAgentFromPath,
  detectAgentFromId,
  detectAgentFromContent,
  createSchemaLogger,
  AGENT_INFO,
  UnifiedEntrySchema,
  AgentTypeSchema
} from "../src";
import type { UnifiedEntry, AgentType } from "../src";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");

// ============================================================================
// README Example Tests
// ============================================================================

describe("README Examples", () => {
  describe("Quick Start example", () => {
    test("parseEntries returns entries with unified structure", async () => {
      const { entries, total } = await parseEntries(
        join(FIXTURES_DIR, "claude-session.jsonl"),
        "claude"
      );

      expect(total).toBeGreaterThan(0);

      // Each entry has unified structure as documented
      for (const entry of entries) {
        expect(entry.id).toBeDefined();
        expect(entry.timestamp).toBeDefined();
        expect(entry.type).toBeDefined();
        expect(entry.agent).toBe("claude");
      }
    });
  });

  describe("Extract Conversation History example", () => {
    test("filters user/assistant messages with text", async () => {
      const { entries } = await parseEntries(
        join(FIXTURES_DIR, "claude-session.jsonl"),
        "claude"
      );

      // Exact code from README
      const conversation = entries
        .filter(e => e.type === "user" || e.type === "assistant")
        .filter(e => e.text)
        .map(e => ({
          role: e.type,
          content: e.text
        }));

      expect(conversation.length).toBeGreaterThan(0);
      expect(conversation[0].role).toMatch(/^(user|assistant)$/);
      expect(conversation[0].content).toBeDefined();
    });
  });

  describe("Calculate Token Usage example", () => {
    test("reduces entries to total tokens", async () => {
      const { entries } = await parseEntries(
        join(FIXTURES_DIR, "claude-session.jsonl"),
        "claude"
      );

      // Exact code from README
      const totalTokens = entries.reduce((acc, entry) => {
        if (entry.tokens) {
          acc.input += entry.tokens.input ?? 0;
          acc.output += entry.tokens.output ?? 0;
        }
        return acc;
      }, { input: 0, output: 0 });

      expect(totalTokens.input).toBeGreaterThan(0);
      expect(totalTokens.output).toBeGreaterThan(0);
    });
  });

  describe("List All Tool Calls example", () => {
    test("extracts tool calls and links to results", async () => {
      const { entries } = await parseEntries(
        join(FIXTURES_DIR, "claude-session.jsonl"),
        "claude"
      );

      // Exact code from README
      const toolCalls = entries
        .filter(e => e.type === "tool_call")
        .map(e => ({
          tool: e.toolName,
          input: e.toolInput,
          id: e.toolCallId
        }));

      expect(toolCalls.length).toBeGreaterThan(0);
      expect(toolCalls[0].tool).toBeDefined();
      expect(toolCalls[0].id).toBeDefined();

      // Link to results
      for (const call of toolCalls) {
        const result = entries.find(
          e => e.type === "tool_result" && e.toolCallId === call.id
        );
        expect(result).toBeDefined();
      }
    });
  });

  describe("Paginate Large Transcripts example", () => {
    test("pagination collects all entries", async () => {
      const transcriptPath = join(FIXTURES_DIR, "claude-session.jsonl");
      const pageSize = 3;
      let offset = 0;
      let hasMore = true;
      const allEntries: UnifiedEntry[] = [];

      while (hasMore) {
        const { entries, total } = await parseClaudeEntries(transcriptPath, {
          offset,
          limit: pageSize
        });

        allEntries.push(...entries);
        offset += pageSize;
        hasMore = offset < total;
      }

      // Should have collected all entries
      const { total } = await parseClaudeEntries(transcriptPath);
      expect(allEntries.length).toBe(total);
    });
  });

  describe("Track Parsing Errors example", () => {
    test("schema logger captures issues", async () => {
      const logger = createSchemaLogger();

      await parseClaudeEntries(
        join(FIXTURES_DIR, "malformed.jsonl"),
        { schemaLogger: logger }
      );

      const issues = logger.getIssues();
      expect(issues.length).toBeGreaterThan(0);

      const stats = logger.getStats();
      expect(stats.total).toBeGreaterThan(0);
      expect(stats.byType).toBeDefined();
    });
  });

  describe("Agent Detection examples", () => {
    test("detectAgentFromPath identifies agents", () => {
      expect(detectAgentFromPath("/Users/dev/.claude/projects/foo/session.jsonl")).toBe("claude");
      expect(detectAgentFromPath("/Users/dev/.codex/sessions/2024/01/session.jsonl")).toBe("codex");
      expect(detectAgentFromPath("/Users/dev/.gemini/tmp/abc/chats/session.json")).toBe("gemini");
      expect(detectAgentFromPath("/random/path.jsonl")).toBe(null);
    });

    test("detectAgentFromId parses prefixed IDs", () => {
      expect(detectAgentFromId("claude:session-abc")).toBe("claude");
      expect(detectAgentFromId("codex:2024/01/session")).toBe("codex");
      expect(detectAgentFromId("gemini:chat-001")).toBe("gemini");
    });

    test("detectAgentFromContent identifies format", async () => {
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
  });
});

// ============================================================================
// Cross-Agent Consistency Tests
// ============================================================================

describe("Cross-Agent Consistency", () => {
  const fixtures = {
    claude: join(FIXTURES_DIR, "claude-session.jsonl"),
    codex: join(FIXTURES_DIR, "codex-session.jsonl"),
    gemini: join(FIXTURES_DIR, "gemini-session.json")
  };

  describe("all agents produce valid UnifiedEntry objects", () => {
    for (const [agent, path] of Object.entries(fixtures)) {
      test(`${agent} entries validate against schema`, async () => {
        const { entries } = await parseEntries(path, agent as AgentType);

        for (const entry of entries) {
          const result = UnifiedEntrySchema.safeParse(entry);
          expect(result.success).toBe(true);
        }
      });
    }
  });

  describe("all agents have consistent entry types", () => {
    test("user and assistant types exist across agents", async () => {
      for (const [agent, path] of Object.entries(fixtures)) {
        const { entries } = await parseEntries(path, agent as AgentType);
        const types = new Set(entries.map(e => e.type));

        // All agents should have user messages
        expect(types.has("user")).toBe(true);
        // All agents should have assistant messages
        expect(types.has("assistant")).toBe(true);
      }
    });

    test("tool calls and results are linkable across agents", async () => {
      for (const [agent, path] of Object.entries(fixtures)) {
        const { entries } = await parseEntries(path, agent as AgentType);

        const toolCalls = entries.filter(e => e.type === "tool_call");
        const toolResults = entries.filter(e => e.type === "tool_result");

        if (toolCalls.length > 0) {
          // All tool calls should have toolCallId
          for (const call of toolCalls) {
            expect(call.toolCallId).toBeDefined();
            expect(call.toolName).toBeDefined();
          }

          // Tool results should be linkable
          for (const call of toolCalls) {
            const result = toolResults.find(r => r.toolCallId === call.toolCallId);
            expect(result).toBeDefined();
          }
        }
      }
    });
  });

  describe("token usage is extractable from all agents", () => {
    test("at least some entries have token data", async () => {
      for (const [agent, path] of Object.entries(fixtures)) {
        const { entries } = await parseEntries(path, agent as AgentType);
        const withTokens = entries.filter(e => e.tokens);

        expect(withTokens.length).toBeGreaterThan(0);
      }
    });
  });

  describe("timestamps are ISO format across agents", () => {
    test("all timestamps parse as valid dates", async () => {
      for (const [agent, path] of Object.entries(fixtures)) {
        const { entries } = await parseEntries(path, agent as AgentType);

        for (const entry of entries) {
          const date = new Date(entry.timestamp);
          expect(isNaN(date.getTime())).toBe(false);
        }
      }
    });
  });
});

// ============================================================================
// Real-World Use Case Tests
// ============================================================================

describe("Real-World Use Cases", () => {
  describe("building a conversation viewer", () => {
    test("can reconstruct chronological conversation", async () => {
      const { entries } = await parseClaudeEntries(
        join(FIXTURES_DIR, "claude-session.jsonl")
      );

      // Sort by timestamp
      const sorted = [...entries].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );

      // Verify chronological order
      for (let i = 1; i < sorted.length; i++) {
        const prev = new Date(sorted[i - 1].timestamp).getTime();
        const curr = new Date(sorted[i].timestamp).getTime();
        expect(curr).toBeGreaterThanOrEqual(prev);
      }
    });

    test("can identify thinking vs text content", async () => {
      const { entries } = await parseClaudeEntries(
        join(FIXTURES_DIR, "claude-session.jsonl")
      );

      const thinkingEntries = entries.filter(e => e.type === "thinking");
      const textEntries = entries.filter(e => e.type === "assistant" && e.text);

      // Should be able to distinguish between them
      expect(thinkingEntries.length + textEntries.length).toBeGreaterThan(0);
    });
  });

  describe("building a token usage dashboard", () => {
    test("can calculate per-model token breakdown", async () => {
      const { entries } = await parseClaudeEntries(
        join(FIXTURES_DIR, "claude-session.jsonl")
      );

      const byModel: Record<string, { input: number; output: number }> = {};

      for (const entry of entries) {
        if (entry.model && entry.tokens) {
          if (!byModel[entry.model]) {
            byModel[entry.model] = { input: 0, output: 0 };
          }
          byModel[entry.model].input += entry.tokens.input ?? 0;
          byModel[entry.model].output += entry.tokens.output ?? 0;
        }
      }

      expect(Object.keys(byModel).length).toBeGreaterThan(0);
    });

    test("can calculate tool usage statistics", async () => {
      const { entries } = await parseClaudeEntries(
        join(FIXTURES_DIR, "claude-session.jsonl")
      );

      const toolUsage: Record<string, number> = {};

      for (const entry of entries) {
        if (entry.type === "tool_call" && entry.toolName) {
          toolUsage[entry.toolName] = (toolUsage[entry.toolName] ?? 0) + 1;
        }
      }

      expect(Object.keys(toolUsage).length).toBeGreaterThan(0);
      expect(toolUsage["Write"]).toBeGreaterThan(0);
    });
  });

  describe("building a transcript search", () => {
    test("can search text content across entries", async () => {
      const { entries } = await parseClaudeEntries(
        join(FIXTURES_DIR, "claude-session.jsonl")
      );

      const searchTerm = "email";
      const matches = entries.filter(e =>
        e.text?.toLowerCase().includes(searchTerm)
      );

      expect(matches.length).toBeGreaterThan(0);
    });

    test("can filter by entry type", async () => {
      const { entries } = await parseClaudeEntries(
        join(FIXTURES_DIR, "claude-session.jsonl")
      );

      const userMessages = entries.filter(e => e.type === "user");
      const toolCalls = entries.filter(e => e.type === "tool_call");

      expect(userMessages.length).toBeGreaterThan(0);
      expect(toolCalls.length).toBeGreaterThan(0);
      expect(userMessages.length + toolCalls.length).toBeLessThan(entries.length);
    });
  });

  describe("transcript comparison across agents", () => {
    test("can aggregate stats from multiple agents", async () => {
      const stats = {
        totalEntries: 0,
        totalTokens: 0,
        byAgent: {} as Record<string, number>
      };

      const agents: { type: AgentType; path: string }[] = [
        { type: "claude", path: join(FIXTURES_DIR, "claude-session.jsonl") },
        { type: "codex", path: join(FIXTURES_DIR, "codex-session.jsonl") },
        { type: "gemini", path: join(FIXTURES_DIR, "gemini-session.json") }
      ];

      for (const { type, path } of agents) {
        const { entries, total } = await parseEntries(path, type);

        stats.totalEntries += total;
        stats.byAgent[type] = total;

        for (const entry of entries) {
          if (entry.tokens?.total) {
            stats.totalTokens += entry.tokens.total;
          }
        }
      }

      expect(stats.totalEntries).toBeGreaterThan(0);
      expect(Object.keys(stats.byAgent).length).toBe(3);
    });
  });
});

// ============================================================================
// AGENT_INFO Tests
// ============================================================================

describe("AGENT_INFO completeness", () => {
  test("all agent types have info", () => {
    const agentTypes = AgentTypeSchema.options;

    for (const agent of agentTypes) {
      expect(AGENT_INFO[agent]).toBeDefined();
      expect(AGENT_INFO[agent].id).toBe(agent);
      expect(AGENT_INFO[agent].name).toBeDefined();
      expect(AGENT_INFO[agent].format).toMatch(/^(json|jsonl)$/);
    }
  });

  test("info matches actual behavior", async () => {
    // Claude uses JSONL
    expect(AGENT_INFO.claude.format).toBe("jsonl");
    // Gemini uses JSON
    expect(AGENT_INFO.gemini.format).toBe("json");
    // Codex uses JSONL
    expect(AGENT_INFO.codex.format).toBe("jsonl");
  });
});

// ============================================================================
// parseTranscript Metadata Tests
// ============================================================================

describe("parseTranscript metadata extraction", () => {
  test("extracts session name from Claude summary", async () => {
    const transcript = await parseTranscript(
      join(FIXTURES_DIR, "claude-session.jsonl"),
      "claude"
    );

    expect(transcript.name).toBeDefined();
    expect(transcript.name.length).toBeGreaterThan(0);
  });

  test("calculates stats correctly", async () => {
    const transcript = await parseTranscript(
      join(FIXTURES_DIR, "claude-session.jsonl"),
      "claude"
    );

    expect(transcript.stats).toBeDefined();
    expect(transcript.stats?.tokens.input).toBeGreaterThan(0);
    expect(transcript.stats?.tokens.output).toBeGreaterThan(0);
    expect(transcript.stats?.entryTypes).toBeDefined();
    expect(transcript.stats?.tools).toBeDefined();
  });

  test("includes timing information", async () => {
    const transcript = await parseTranscript(
      join(FIXTURES_DIR, "claude-session.jsonl"),
      "claude"
    );

    expect(transcript.startTime).toBeDefined();
    expect(transcript.endTime).toBeDefined();
    expect(transcript.stats?.durationMs).toBeDefined();
  });
});
