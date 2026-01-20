import { describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, mkdir, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  createId,
  createSchemaLogger,
  detectAgentFromContent,
  detectAgentFromPath,
  parseClaudeEntries,
  parseClaudeTranscript,
  parseCodexEntries,
  parseCodexTranscript,
  parseGeminiEntries,
  parseGeminiTranscript,
  scanAllTranscripts,
  scanTranscripts
} from "../src";
import { parseClaudeTranscriptFull } from "../src/adapters/claude";
import {
  normalizePathSeparators,
  readFileChunk,
  readJsonlLines
} from "../src/adapters/shared";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");
const CLAUDE_FIXTURE = join(FIXTURES_DIR, "claude-session.jsonl");
const CLAUDE_LARGE_FIXTURE = join(FIXTURES_DIR, "claude-session-large.jsonl");
const CODEX_FIXTURE = join(FIXTURES_DIR, "codex-session.jsonl");
const GEMINI_FIXTURE = join(FIXTURES_DIR, "gemini-session.json");

async function withTempDir<T>(
  prefix: string,
  fn: (dir: string) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeJsonl(
  filePath: string,
  lines: Array<Record<string, unknown> | string>
): Promise<void> {
  const content = lines
    .map((line) => (typeof line === "string" ? line : JSON.stringify(line)))
    .join("\n");
  await writeFile(filePath, content);
}

describe("Shared utilities", () => {
  test("createId returns prefixed unique ids", () => {
    const first = createId("session");
    const second = createId("session");

    expect(first).not.toBe(second);
    expect(first.startsWith("session_")).toBe(true);
  });

  test("normalizePathSeparators converts backslashes", () => {
    expect(
      normalizePathSeparators("C:\\Users\\dev\\.claude\\projects\\a.jsonl")
    ).toBe("C:/Users/dev/.claude/projects/a.jsonl");
  });

  test("readJsonlLines streams and counts lines", async () => {
    await withTempDir("agentwatch-jsonl-", async (dir) => {
      const filePath = join(dir, "sample.jsonl");
      const rawLines = [
        "{\"a\":1}",
        "",
        " {\"b\":2} ",
        "{\"c\":3}"
      ];

      await writeFile(filePath, rawLines.join("\n"));

      const seen: string[] = [];
      const { total } = await readJsonlLines(
        filePath,
        (line) => {
          seen.push(line);
        },
        { chunkSize: 8 }
      );

      expect(total).toBe(3);
      expect(seen).toEqual([
        "{\"a\":1}",
        "{\"b\":2}",
        "{\"c\":3}"
      ]);
    });
  });

  test("readFileChunk reads slices and handles empty length", async () => {
    await withTempDir("agentwatch-chunk-", async (dir) => {
      const filePath = join(dir, "chunk.txt");
      await writeFile(filePath, "abcdef");

      const slice = await readFileChunk(filePath, 2, 3);
      expect(slice).toBe("cde");

      const empty = await readFileChunk(filePath, 0, 0);
      expect(empty).toBe("");
    });
  });
});

describe("Agent detection edge cases", () => {
  test("detectAgentFromContent parses multi-line JSON", () => {
    const content = JSON.stringify(
      {
        sessionId: "gemini-session",
        messages: []
      },
      null,
      2
    );

    expect(detectAgentFromContent(content)).toBe("gemini");
  });

  test("detectAgentFromPath handles Windows-style separators", () => {
    expect(
      detectAgentFromPath("C:\\Users\\dev\\.codex\\sessions\\a.jsonl")
    ).toBe("codex");
  });
});

describe("Claude advanced parsing", () => {
  test("parses ts timestamps and thinking-only entries", async () => {
    await withTempDir("agentwatch-claude-ts-", async (dir) => {
      const filePath = join(dir, "session.jsonl");
      const tsSeconds = 1705312800;

      await writeJsonl(filePath, [
        {
          uuid: "msg_ts_num",
          type: "user",
          ts: tsSeconds,
          sessionId: "session_ts",
          message: {
            role: "user",
            content: "Hello"
          }
        },
        {
          uuid: "msg_ts_str",
          type: "assistant",
          ts: "2024-01-15T10:00:01.000Z",
          sessionId: "session_ts",
          message: {
            role: "assistant",
            content: [{ type: "thinking", thinking: "Only thinking here." }]
          }
        },
        {
          uuid: "msg_snapshot",
          type: "file-history-snapshot",
          timestamp: "2024-01-15T10:00:02.000Z",
          sessionId: "session_ts",
          content: []
        }
      ]);

      const { entries } = await parseClaudeEntries(filePath);
      expect(entries[0].timestamp).toBe(
        new Date(tsSeconds * 1000).toISOString()
      );
      expect(entries[1].type).toBe("thinking");
      expect(entries[2].type).toBe("system");
    });
  });

  test("returns all entries by default for large files", async () => {
    const { entries, total } = await parseClaudeEntries(CLAUDE_LARGE_FIXTURE);
    expect(entries.length).toBe(total);
  });

  test("includes raw data in streaming mode", async () => {
    const { entries } = await parseClaudeEntries(CLAUDE_LARGE_FIXTURE, {
      limit: 1,
      includeRaw: true
    });

    expect(entries[0]._raw).toBeDefined();
  });

  test("rejects oversized files", async () => {
    await expect(
      parseClaudeEntries(CLAUDE_FIXTURE, { maxFileSizeBytes: 1 })
    ).rejects.toThrow();
  });

  test("handles subagents and subagent paths", async () => {
    await withTempDir("agentwatch-claude-sub-", async (dir) => {
      const projectDir = join(dir, "project-alpha");
      await mkdir(projectDir, { recursive: true });

      const sessionPath = join(projectDir, "session.jsonl");
      await copyFile(CLAUDE_FIXTURE, sessionPath);

      const subagentsDir = join(projectDir, "session", "subagents");
      await mkdir(subagentsDir, { recursive: true });
      const subagentPath = join(subagentsDir, "agent-1.jsonl");
      await copyFile(CLAUDE_FIXTURE, subagentPath);

      const transcript = await parseClaudeTranscript(sessionPath, {
        scanSubagents: true
      });
      expect(transcript?.subagents?.length).toBe(1);
      expect(transcript?.subagents?.[0].parentTranscriptId).toBe(
        "claude:session"
      );

      const subTranscript = await parseClaudeTranscript(subagentPath, {
        scanSubagents: false
      });
      expect(subTranscript?.isSubagent).toBe(true);
      expect(subTranscript?.parentTranscriptId).toBe("claude:session");
    });
  });

  test("logs errors for missing transcripts", async () => {
    const logger = createSchemaLogger();
    const transcript = await parseClaudeTranscript(
      "/does/not/exist.jsonl",
      { schemaLogger: logger }
    );

    expect(transcript).toBeNull();
    expect(logger.getIssues().length).toBeGreaterThan(0);
  });

  test("full transcript parsing returns thinking blocks and tool calls", async () => {
    const result = await parseClaudeTranscriptFull(CLAUDE_FIXTURE);

    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.thinkingBlocks.length).toBeGreaterThan(0);
    expect(result.toolCalls.length).toBeGreaterThan(0);
    expect(result.toolCalls.some((call) => call.resultEntryId)).toBe(true);
  });

  test("handles dashed project dirs and empty subagent folders", async () => {
    await withTempDir("agentwatch-claude-dash-", async (dir) => {
      const projectDir = join(dir, "-Users-dev-myproject");
      await mkdir(projectDir, { recursive: true });
      const sessionPath = join(projectDir, "session.jsonl");

      const lines = [
        {
          uuid: "msg_summary",
          type: "summary",
          summary: "Session title",
          timestamp: "2024-01-15T10:00:00.000Z",
          sessionId: "session_dash"
        },
        "{bad json"
      ];

      await writeJsonl(sessionPath, lines);

      const subagentsDir = join(projectDir, "session", "subagents");
      await mkdir(subagentsDir, { recursive: true });

      const transcript = await parseClaudeTranscript(sessionPath);
      expect(transcript?.projectDir).toBe("/Users/dev/myproject");
      expect(transcript?.name).toBe("Session title");
      expect(transcript?.subagents).toBeUndefined();
    });
  });

  test("logs errors for oversized transcripts in metadata parsing", async () => {
    await withTempDir("agentwatch-claude-meta-", async (dir) => {
      const sessionPath = join(dir, "session.jsonl");
      await copyFile(CLAUDE_FIXTURE, sessionPath);

      const logger = createSchemaLogger();
      const transcript = await parseClaudeTranscript(sessionPath, {
        schemaLogger: logger,
        maxFileSizeBytes: 1
      });

      expect(transcript).toBeNull();
      expect(logger.getIssues().length).toBeGreaterThan(0);
    });
  });

  test("full transcript parsing skips invalid lines", async () => {
    await withTempDir("agentwatch-claude-full-", async (dir) => {
      const sessionPath = join(dir, "session.jsonl");
      const lines = [
        {
          uuid: "msg_ts_num",
          type: "user",
          ts: 1705312800,
          sessionId: "session_full",
          message: { role: "user", content: "Hello" }
        },
        "{bad json"
      ];

      await writeJsonl(sessionPath, lines);

      const logger = createSchemaLogger();
      const result = await parseClaudeTranscriptFull(sessionPath, {
        schemaLogger: logger
      });

      expect(result.entries.length).toBe(1);
      expect(result.stats.skippedEntries).toBe(1);
      expect(logger.getIssues().length).toBeGreaterThan(0);
    });
  });

  test("full transcript parsing reports missing files", async () => {
    const result = await parseClaudeTranscriptFull("/does/not/exist.jsonl");
    expect(result.schemaIssues.length).toBeGreaterThan(0);
  });
});

describe("Codex advanced parsing", () => {
  test("parses extended Codex entry types", async () => {
    await withTempDir("agentwatch-codex-", async (dir) => {
      const filePath = join(
        dir,
        "rollout-2024-01-15T10-00-00-test.jsonl"
      );

      const lines = [
        {
          timestamp: "2024-01-15T10:00:00.000Z",
          type: "session_meta",
          payload: { cwd: "/project" }
        },
        {
          timestamp: "2024-01-15T10:00:00.500Z",
          type: "event_msg",
          payload: { type: "other_event", message: "ignored" }
        },
        {
          timestamp: "2024-01-15T10:00:01.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "hello" }
        },
        {
          timestamp: "2024-01-15T10:00:02.000Z",
          type: "event_msg",
          payload: { type: "agent_message", message: "hi there" }
        },
        {
          timestamp: "2024-01-15T10:00:03.000Z",
          type: "event_msg",
          payload: { type: "agent_reasoning", text: "reasoning text" }
        },
        {
          timestamp: "2024-01-15T10:00:04.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 1,
                output_tokens: 2,
                cached_input_tokens: 1,
                total_tokens: 3
              }
            }
          }
        },
        {
          timestamp: "2024-01-15T10:00:05.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "input" }]
          }
        },
        {
          timestamp: "2024-01-15T10:00:05.500Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "system",
            content: [{ type: "output_text", text: "system" }]
          }
        },
        {
          timestamp: "2024-01-15T10:00:05.750Z",
          type: "response_item",
          payload: {
            type: "unknown_type"
          }
        },
        {
          timestamp: "2024-01-15T10:00:05.900Z",
          type: "mystery_type",
          payload: { note: "unknown entry type" }
        },
        {
          timestamp: "2024-01-15T10:00:06.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "response" }]
          }
        },
        {
          timestamp: "2024-01-15T10:00:06.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "shell",
            arguments: "{\"command\":\"ls\"}",
            call_id: "call_1"
          }
        },
        {
          timestamp: "2024-01-15T10:00:06.500Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "shell",
            arguments: "{bad",
            call_id: "call_bad_args"
          }
        },
        {
          timestamp: "2024-01-15T10:00:07.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            output: "{\"output\":\"ok\"}",
            call_id: "call_1"
          }
        },
        {
          timestamp: "2024-01-15T10:00:08.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            output: "{invalid}",
            call_id: "call_bad"
          }
        },
        {
          timestamp: "2024-01-15T10:00:09.000Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "custom",
            input: { foo: "bar" },
            call_id: "custom_1"
          }
        },
        {
          timestamp: "2024-01-15T10:00:10.000Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            output: "{\"output\":\"custom ok\"}",
            call_id: "custom_1"
          }
        },
        {
          timestamp: "2024-01-15T10:00:10.500Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            output: "{bad",
            call_id: "custom_bad"
          }
        },
        {
          timestamp: "2024-01-15T10:00:11.000Z",
          type: "response_item",
          payload: {
            type: "reasoning",
            summary: [{ text: "summary" }],
            encrypted_content: "encrypted"
          }
        },
        {
          timestamp: "2024-01-15T10:00:12.000Z",
          type: "response_item",
          payload: { type: "ghost_snapshot" }
        },
        {
          timestamp: "2024-01-15T10:00:13.000Z",
          type: "turn_context",
          payload: { turn: 1 }
        },
        {
          type: "event_msg",
          payload: { type: "user_message", message: "missing timestamp" }
        },
        "{bad json"
      ];

      await writeJsonl(filePath, lines);

      const logger = createSchemaLogger();
      const { entries, total } = await parseCodexEntries(filePath, {
        includeRaw: true,
        schemaLogger: logger
      });

      expect(total).toBe(lines.length);
      expect(entries.length).toBe(lines.length - 2);
      expect(entries[0]._raw).toBeDefined();

      const customCall = entries.find(
        (entry) => entry.type === "tool_call" && entry.toolName === "custom"
      );
      expect(customCall?.toolInput).toEqual({ foo: "bar" });

      const customResult = entries.find(
        (entry) =>
          entry.type === "tool_result" && entry.toolCallId === "custom_1"
      );
      expect(customResult?.text).toBe("custom ok");

      const reasoning = entries.find(
        (entry) => entry.type === "thinking" && entry.text?.includes("summary")
      );
      expect(reasoning).toBeDefined();

      const invalidOutput = entries.find(
        (entry) => entry.toolCallId === "call_bad"
      );
      expect(invalidOutput?.text).toBe("{invalid}");

      expect(
        logger
          .getIssues()
          .some((issue) => issue.issueType === "missing_required_field")
      ).toBe(true);
      expect(
        logger
          .getIssues()
          .some((issue) => issue.issueType === "unknown_entry_type")
      ).toBe(true);
      expect(
        logger.getIssues().some((issue) => issue.issueType === "parse_error")
      ).toBe(true);

      const transcript = await parseCodexTranscript(filePath);
      expect(transcript?.projectDir).toBe("/project");
      expect(transcript?.name).toBe("project");
      expect(transcript?.startTime).not.toBeNull();
    });
  });

  test("streams large Codex transcripts", async () => {
    await withTempDir("agentwatch-codex-large-", async (dir) => {
      const filePath = join(dir, "rollout-2024-01-15T10-00-00.jsonl");
      const longMessage = "x".repeat(2048);
      const lines = Array.from({ length: 600 }, (_, index) => ({
        timestamp: new Date(1705312800000 + index).toISOString(),
        type: "event_msg",
        payload: { type: "user_message", message: longMessage }
      }));

      await writeJsonl(filePath, lines);

      const { entries, total } = await parseCodexEntries(filePath, {
        limit: 5,
        includeRaw: true
      });

      expect(total).toBe(lines.length);
      expect(entries.length).toBe(5);
      expect(entries[0]._raw).toBeDefined();
    });
  });

  test("rejects oversized Codex transcripts", async () => {
    await withTempDir("agentwatch-codex-size-", async (dir) => {
      const filePath = join(dir, "rollout-2024-01-15T10-00-00.jsonl");
      await copyFile(CODEX_FIXTURE, filePath);

      await expect(
        parseCodexEntries(filePath, { maxFileSizeBytes: 1 })
      ).rejects.toThrow();
    });
  });

  test("logs errors for oversized transcripts in metadata parsing", async () => {
    await withTempDir("agentwatch-codex-meta-", async (dir) => {
      const filePath = join(dir, "rollout-2024-01-15T10-00-00.jsonl");
      await copyFile(CODEX_FIXTURE, filePath);

      const logger = createSchemaLogger();
      const transcript = await parseCodexTranscript(filePath, {
        schemaLogger: logger,
        maxFileSizeBytes: 1
      });

      expect(transcript).toBeNull();
      expect(logger.getIssues().length).toBeGreaterThan(0);
    });
  });

  test("logs errors for missing transcripts in metadata parsing", async () => {
    const logger = createSchemaLogger();
    const transcript = await parseCodexTranscript("/does/not/exist.jsonl", {
      schemaLogger: logger
    });

    expect(transcript).toBeNull();
    expect(logger.getIssues().length).toBeGreaterThan(0);
  });
});

describe("Gemini advanced parsing", () => {
  test("parses tool results and includes raw session data", async () => {
    await withTempDir("agentwatch-gemini-", async (dir) => {
      const chatsDir = join(dir, "tmp", "project-hash", "chats");
      await mkdir(chatsDir, { recursive: true });
      const filePath = join(chatsDir, "session.json");

      const session = {
        sessionId: "gemini-001",
        projectHash: "project-hash",
        startTime: "2024-01-15T10:00:00.000Z",
        lastUpdated: "2024-01-15T10:00:10.000Z",
        messages: [
          {
            id: "msg_user",
            timestamp: "2024-01-15T10:00:00.000Z",
            type: "user",
            content: "Hello"
          },
          {
            id: "msg_assistant",
            timestamp: "2024-01-15T10:00:05.000Z",
            type: "gemini",
            content: "Hi!",
            thoughts: [
              {
                subject: "Plan",
                description: "Answer the question"
              }
            ],
            toolCalls: [
              {
                id: "tool-1",
                name: "web_search",
                args: { q: "agentwatch" },
                result: [{ title: "Result" }]
              }
            ],
            tokens: { input: 5, output: 7, total: 12 }
          }
        ]
      };

      await writeFile(filePath, JSON.stringify(session, null, 2));

      const { entries } = await parseGeminiEntries(filePath, {
        includeRaw: true
      });

      const toolResult = entries.find((entry) => entry.type === "tool_result");
      expect(toolResult?.text).toBe(JSON.stringify([{ title: "Result" }]));
      expect(entries[0]._raw).toBeDefined();

      const transcript = await parseGeminiTranscript(filePath);
      expect(transcript?.projectDir).toBe("project-hash");
      expect(transcript?.name).toBe("Hello");
    });
  });

  test("logs errors for invalid JSON", async () => {
    await withTempDir("agentwatch-gemini-bad-", async (dir) => {
      const filePath = join(dir, "bad.json");
      await writeFile(filePath, "{not json");

      const logger = createSchemaLogger();
      const { entries, total } = await parseGeminiEntries(filePath, {
        schemaLogger: logger
      });

      expect(entries).toEqual([]);
      expect(total).toBe(0);
      expect(logger.getIssues().length).toBeGreaterThan(0);

      const transcript = await parseGeminiTranscript(filePath, {
        schemaLogger: logger
      });
      expect(transcript).toBeNull();
    });
  });

  test("rejects oversized Gemini transcripts", async () => {
    await withTempDir("agentwatch-gemini-size-", async (dir) => {
      const filePath = join(dir, "session.json");
      await copyFile(GEMINI_FIXTURE, filePath);

      await expect(
        parseGeminiEntries(filePath, { maxFileSizeBytes: 1 })
      ).rejects.toThrow();
    });
  });
});

describe("Directory scanning", () => {
  test("scans all agent directories with real structures", async () => {
    await withTempDir("agentwatch-scan-", async (dir) => {
      const claudeRoot = join(dir, "claude");
      const codexRoot = join(dir, "codex");
      const geminiRoot = join(dir, "gemini");

      const claudeProjectDir = join(claudeRoot, "project-one");
      await mkdir(claudeProjectDir, { recursive: true });
      const claudeSessionPath = join(claudeProjectDir, "session.jsonl");
      await copyFile(CLAUDE_FIXTURE, claudeSessionPath);

      const claudeSubDir = join(claudeProjectDir, "session", "subagents");
      await mkdir(claudeSubDir, { recursive: true });
      await copyFile(
        CLAUDE_FIXTURE,
        join(claudeSubDir, "agent-1.jsonl")
      );

      const codexSessionDir = join(codexRoot, "2024", "01", "15");
      await mkdir(codexSessionDir, { recursive: true });
      const codexSessionPath = join(
        codexSessionDir,
        "rollout-2024-01-15T10-00-00.jsonl"
      );
      await copyFile(CODEX_FIXTURE, codexSessionPath);

      const geminiChatsDir = join(geminiRoot, "project-hash", "chats");
      await mkdir(geminiChatsDir, { recursive: true });
      await copyFile(GEMINI_FIXTURE, join(geminiChatsDir, "session.json"));

      const claudeTranscripts = await scanTranscripts(claudeRoot, "claude");
      const codexTranscripts = await scanTranscripts(codexRoot, "codex");
      const geminiTranscripts = await scanTranscripts(geminiRoot, "gemini");

      expect(claudeTranscripts.length).toBe(2);
      expect(codexTranscripts.length).toBe(1);
      expect(geminiTranscripts.length).toBe(1);

      const { transcripts, stats } = await scanAllTranscripts({
        claude: claudeRoot,
        codex: codexRoot,
        gemini: geminiRoot
      });

      expect(transcripts.length).toBe(4);
      expect(stats.claude).toBe(2);
      expect(stats.codex).toBe(1);
      expect(stats.gemini).toBe(1);
      expect(stats.total).toBe(4);

      const sizeCheck = await stat(claudeSessionPath);
      expect(sizeCheck.size).toBeGreaterThan(0);
    });
  });
});
