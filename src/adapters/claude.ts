/**
 * Claude Code transcript parser adapter.
 *
 * Claude transcripts are JSONL files stored at ~/.claude/projects/{project-path}/
 * Each line is a JSON object with these main types:
 * - user: User messages
 * - assistant: Assistant responses (may contain tool_use, thinking, text blocks)
 * - summary: Session title/summary
 * - system: Metadata entries (turn duration, hook summaries)
 * - file-history-snapshot: File state snapshots
 *
 * Subagent transcripts are stored in {session}/subagents/agent-{id}.jsonl
 */

import { readFile, stat, readdir } from "fs/promises";
import { join, basename, dirname } from "path";
import type {
  UnifiedEntry,
  UnifiedTranscript,
  SchemaIssue,
  AgentType,
  ExtendedUnifiedEntry,
  ThinkingBlock,
  ExtendedToolCall,
  FullParseResult,
  ExtendedTokenUsage
} from "../types.js";
import type { SchemaLogger } from "../schema-logger.js";
import {
  accumulateEntryStats,
  createStatsAccumulator,
  expandHome,
  extractTextContent,
  finalizeStats,
  normalizePathSeparators,
  readJsonlLines,
  SMALL_FILE_THRESHOLD,
  type TextBlockRule
} from "./shared.js";

const AGENT: AgentType = "claude";

// ============================================================================
// Stats Accumulation
// ============================================================================

const TEXT_RULES: TextBlockRule[] = [
  { type: "text", key: "text" },
  { type: "thinking", key: "thinking" }
];

// ============================================================================
// Entry Parsing
// ============================================================================

/**
 * Detect entry type from Claude JSONL entry.
 */
function detectEntryType(obj: Record<string, unknown>): UnifiedEntry["type"] {
  const entryType = obj.type as string | undefined;
  const message = obj.message as Record<string, unknown> | undefined;
  const role =
    (obj.role as string | undefined) ?? (message?.role as string | undefined);

  // System entries
  if (entryType === "system") return "system";
  if (entryType === "summary") return "summary";
  if (entryType === "file-history-snapshot") return "system";

  // Check for tool results in user messages
  if (entryType === "user" || role === "user") {
    const content = message?.content ?? obj.content;
    if (Array.isArray(content)) {
      const hasToolResult = content.some(
        (block: unknown) =>
          typeof block === "object" &&
          block !== null &&
          (block as Record<string, unknown>).type === "tool_result"
      );
      if (hasToolResult) return "tool_result";
    }
    return "user";
  }

  // Check assistant messages for tool use or thinking
  if (entryType === "assistant" || role === "assistant") {
    const content = message?.content ?? obj.content;
    if (Array.isArray(content)) {
      // Check for tool_use blocks
      const hasToolUse = content.some(
        (block: unknown) =>
          typeof block === "object" &&
          block !== null &&
          (block as Record<string, unknown>).type === "tool_use"
      );
      if (hasToolUse) return "tool_call";

      // Check for thinking blocks (if that's the only content)
      const hasOnlyThinking = content.every(
        (block: unknown) =>
          typeof block === "object" &&
          block !== null &&
          (block as Record<string, unknown>).type === "thinking"
      );
      if (hasOnlyThinking) return "thinking";
    }
    return "assistant";
  }

  return "unknown";
}

/**
 * Extract tool call info from Claude entry.
 */
function extractToolInfo(obj: Record<string, unknown>): {
  toolName?: string;
  toolInput?: unknown;
  toolCallId?: string;
} {
  const message = obj.message as Record<string, unknown> | undefined;
  const content = (message?.content ?? obj.content) as unknown[];

  if (!Array.isArray(content)) return {};

  // Find tool_use block
  const toolUse = content.find(
    (block): block is Record<string, unknown> =>
      typeof block === "object" &&
      block !== null &&
      (block as Record<string, unknown>).type === "tool_use"
  );

  if (toolUse) {
    return {
      toolName: toolUse.name as string | undefined,
      toolInput: toolUse.input,
      toolCallId: toolUse.id as string | undefined
    };
  }

  // Find tool_result block (in user messages)
  const toolResult = content.find(
    (block): block is Record<string, unknown> =>
      typeof block === "object" &&
      block !== null &&
      (block as Record<string, unknown>).type === "tool_result"
  );

  if (toolResult) {
    return {
      toolCallId: toolResult.tool_use_id as string | undefined
    };
  }

  return {};
}

/**
 * Extract token usage from Claude entry.
 */
function extractTokenUsage(
  obj: Record<string, unknown>
): UnifiedEntry["tokens"] {
  const message = obj.message as Record<string, unknown> | undefined;
  const usage = message?.usage as Record<string, unknown> | undefined;

  if (!usage) return undefined;

  return {
    input: usage.input_tokens as number | undefined,
    output: usage.output_tokens as number | undefined,
    cached:
      ((usage.cache_read_input_tokens as number | undefined) ?? 0) +
        ((usage.cache_creation_input_tokens as number | undefined) ?? 0) ||
      undefined,
    total:
      ((usage.input_tokens as number | undefined) ?? 0) +
        ((usage.output_tokens as number | undefined) ?? 0) || undefined
  };
}

/**
 * Parse a Claude JSON object into a UnifiedEntry.
 */
function parseClaudeEntryObject(
  obj: Record<string, unknown>,
  index: number,
  transcriptPath: string,
  schemaLogger?: SchemaLogger
): UnifiedEntry | null {
  try {
    const entryType = detectEntryType(obj);
    const message = obj.message as Record<string, unknown> | undefined;

    // Extract timestamp
    let timestamp = obj.timestamp as string | undefined;
    if (!timestamp) {
      const ts = obj.ts as number | string | undefined;
      if (typeof ts === "number") {
        timestamp = new Date(ts * 1000).toISOString();
      } else if (typeof ts === "string") {
        timestamp = ts;
      }
    }

    if (!timestamp) {
      schemaLogger?.log({
        agent: AGENT,
        transcriptPath,
        entryIndex: index,
        issueType: "missing_required_field",
        description: "Entry missing timestamp",
        rawEntry: obj
      });
      timestamp = new Date().toISOString();
    }

    // Extract content
    let text: string | undefined;
    let content: unknown;

    if (obj.type === "summary") {
      text = obj.summary as string;
    } else {
      const rawContent = message?.content ?? obj.content;
      text = extractTextContent(rawContent, TEXT_RULES);
      content = rawContent;
    }

    // Build unified entry
    const entry: UnifiedEntry = {
      id: (obj.uuid as string) ?? `claude-${index}`,
      timestamp,
      type: entryType,
      agent: AGENT,
      text: text || undefined,
      content,
      ...extractToolInfo(obj),
      model: message?.model as string | undefined,
      tokens: extractTokenUsage(obj),
      parentId: obj.parentUuid as string | undefined,
      sessionId: obj.sessionId as string | undefined,
      isSidechain: obj.isSidechain as boolean | undefined,
      subagentId: obj.agentId as string | undefined
    };

    // Log unknown entry types
    if (entryType === "unknown" && schemaLogger) {
      schemaLogger.log({
        agent: AGENT,
        transcriptPath,
        entryIndex: index,
        issueType: "unknown_entry_type",
        description: `Unknown entry type: ${obj.type}`,
        rawEntry: obj
      });
    }

    return entry;
  } catch (error) {
    schemaLogger?.log({
      agent: AGENT,
      transcriptPath,
      entryIndex: index,
      issueType: "parse_error",
      description: `Failed to parse JSONL line: ${error instanceof Error ? error.message : String(error)}`,
      rawEntry: obj
    });
    return null;
  }
}

/**
 * Parse a single Claude JSONL entry into a UnifiedEntry.
 */
export function parseClaudeEntry(
  line: string,
  index: number,
  transcriptPath: string,
  schemaLogger?: SchemaLogger
): UnifiedEntry | null {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    return parseClaudeEntryObject(obj, index, transcriptPath, schemaLogger);
  } catch (error) {
    schemaLogger?.log({
      agent: AGENT,
      transcriptPath,
      entryIndex: index,
      issueType: "parse_error",
      description: `Failed to parse JSONL line: ${error instanceof Error ? error.message : String(error)}`,
      rawEntry: line
    });
    return null;
  }
}

/**
 * Parse all entries from a Claude transcript file.
 * Uses streaming for large files to avoid loading entire file into memory.
 */
export async function parseClaudeEntries(
  filePath: string,
  options: {
    offset?: number;
    limit?: number;
    includeRaw?: boolean;
    schemaLogger?: SchemaLogger;
    maxFileSizeBytes?: number;
  } = {}
): Promise<{ entries: UnifiedEntry[]; total: number }> {
  const {
    offset = 0,
    limit = 500,
    includeRaw = false,
    schemaLogger,
    maxFileSizeBytes
  } = options;
  const safeOffset = Math.max(0, offset);
  const safeLimit = Math.max(0, limit);

  const fileStats = await stat(filePath);
  const fileSize = fileStats.size;

  if (maxFileSizeBytes !== undefined && fileSize > maxFileSizeBytes) {
    throw new Error(
      `Claude transcript exceeds maxFileSizeBytes (${fileSize} > ${maxFileSizeBytes}).`
    );
  }

  // For small files, use simple full-file approach
  if (fileSize < SMALL_FILE_THRESHOLD) {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim());
    const total = lines.length;

    const entries: UnifiedEntry[] = [];
    const slicedLines = lines.slice(safeOffset, safeOffset + safeLimit);

    for (let i = 0; i < slicedLines.length; i++) {
      const entry = parseClaudeEntry(
        slicedLines[i],
        safeOffset + i,
        filePath,
        schemaLogger
      );
      if (entry) {
        if (!includeRaw) {
          delete entry._raw;
        } else {
          entry._raw = JSON.parse(slicedLines[i]);
        }
        entries.push(entry);
      }
    }

    return { entries, total };
  }

  const entries: UnifiedEntry[] = [];
  const { total } = await readJsonlLines(
    filePath,
    (line, lineIndex) => {
      if (lineIndex < safeOffset || lineIndex >= safeOffset + safeLimit) {
        return;
      }

      const entry = parseClaudeEntry(line, lineIndex, filePath, schemaLogger);
      if (entry) {
        if (!includeRaw) {
          delete entry._raw;
        } else {
          try {
            entry._raw = JSON.parse(line);
          } catch {
            // Ignore raw parse failures for already-parsed entries
          }
        }
        entries.push(entry);
      }
    }
  );

  return { entries, total };
}

// ============================================================================
// Transcript Metadata Parsing
// ============================================================================

/**
 * Parse Claude transcript metadata (without loading all entries).
 */
export async function parseClaudeTranscript(
  filePath: string,
  options: {
    schemaLogger?: SchemaLogger;
    scanSubagents?: boolean;
    maxFileSizeBytes?: number;
  } = {}
): Promise<UnifiedTranscript | null> {
  const { schemaLogger, scanSubagents = true, maxFileSizeBytes } = options;

  try {
    const fileStats = await stat(filePath);
    const fileName = basename(filePath, ".jsonl");

    if (maxFileSizeBytes !== undefined && fileStats.size > maxFileSizeBytes) {
      throw new Error(
        `Claude transcript exceeds maxFileSizeBytes (${fileStats.size} > ${maxFileSizeBytes}).`
      );
    }

    let startTime: number | null = null;
    let endTime: number | null = null;
    let name = fileName;
    let projectDir: string | null = null;
    let entryCount = 0;
    const schemaIssues: string[] = [];

    // Stats accumulator
    const statsAcc = createStatsAccumulator();

    // Infer project directory from path
    const parentDir = basename(dirname(filePath));
    if (parentDir.startsWith("-")) {
      projectDir = parentDir.replace(/-/g, "/");
      name = basename(projectDir);
    }

    await readJsonlLines(filePath, (line, lineIndex) => {
      entryCount++;

      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }

      if (obj.type === "summary" && obj.summary) {
        name = String(obj.summary).slice(0, 60);
      }

      const ts = obj.timestamp ?? obj.ts;
      if (ts) {
        const time =
          typeof ts === "number" ? ts * 1000 : new Date(ts as string).getTime();
        if (!Number.isNaN(time)) {
          if (!startTime || time < startTime) startTime = time;
          if (!endTime || time > endTime) endTime = time;
        }
      }

      const entry = parseClaudeEntryObject(
        obj,
        lineIndex,
        filePath,
        schemaLogger
      );
      if (entry) {
        accumulateEntryStats(statsAcc, entry);
      }
    });

    // Finalize stats
    const transcriptStats = finalizeStats(statsAcc, startTime, endTime);

    // Check for subagents
    let subagents: UnifiedTranscript[] | undefined;
    const normalizedPath = normalizePathSeparators(filePath);
    const isSubagent = normalizedPath.includes("/subagents/");
    let parentTranscriptId: string | undefined;

    if (isSubagent) {
      // Extract parent transcript ID from path
      const pathParts = normalizedPath.split("/");
      const subagentsIndex = pathParts.indexOf("subagents");
      if (subagentsIndex > 0) {
        const parentFileName = pathParts[subagentsIndex - 1];
        parentTranscriptId = `claude:${parentFileName}`;
      }
    } else if (scanSubagents) {
      // Look for subagent directory
      const subagentsDir = join(dirname(filePath), fileName, "subagents");
      try {
        const subagentFiles = await readdir(subagentsDir);
        subagents = [];
        for (const subFile of subagentFiles) {
          if (subFile.endsWith(".jsonl")) {
            const subPath = join(subagentsDir, subFile);
            const subTranscript = await parseClaudeTranscript(subPath, {
              schemaLogger,
              scanSubagents: false,
              maxFileSizeBytes
            });
            if (subTranscript) {
              subTranscript.parentTranscriptId = `claude:${fileName}`;
              subagents.push(subTranscript);
            }
          }
        }
        if (subagents.length === 0) {
          subagents = undefined;
        }
      } catch {
        // No subagents directory
      }
    }

    return {
      schema_version: "v2" as const,
      id: `claude:${fileName}`,
      agent: AGENT,
      path: filePath,
      name,
      projectDir,
      modifiedAt: fileStats.mtimeMs,
      sizeBytes: fileStats.size,
      entryCount,
      startTime,
      endTime,
      isSubagent,
      parentTranscriptId,
      subagents,
      schemaIssues: schemaIssues.length > 0 ? schemaIssues : undefined,
      stats: transcriptStats
    };
  } catch (error) {
    schemaLogger?.log({
      agent: AGENT,
      transcriptPath: filePath,
      issueType: "parse_error",
      description: `Failed to parse transcript: ${error instanceof Error ? error.message : String(error)}`
    });
    return null;
  }
}

// ============================================================================
// Directory Scanning
// ============================================================================

/**
 * Scan Claude projects directory for all transcripts.
 */
export async function scanClaudeTranscripts(
  basePath: string,
  options: {
    schemaLogger?: SchemaLogger;
    scanSubagents?: boolean;
    maxFileSizeBytes?: number;
  } = {}
): Promise<UnifiedTranscript[]> {
  const { schemaLogger, scanSubagents = true, maxFileSizeBytes } = options;
  const expandedPath = expandHome(basePath);
  const transcripts: UnifiedTranscript[] = [];

  try {
    const projectDirs = await readdir(expandedPath);

    for (const projectDir of projectDirs) {
      const projectPath = join(expandedPath, projectDir);
      const projectStat = await stat(projectPath).catch(() => null);

      if (!projectStat?.isDirectory()) continue;

      // List transcript files in project directory
      const files = await readdir(projectPath).catch(() => []);

      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;

        const filePath = join(projectPath, file);
        const transcript = await parseClaudeTranscript(filePath, {
          schemaLogger,
          scanSubagents,
          maxFileSizeBytes
        });

        if (transcript) {
          transcripts.push(transcript);

          // Add subagents to list (flattened)
          if (transcript.subagents) {
            transcripts.push(...transcript.subagents);
          }
        }
      }
    }
  } catch (error) {
    schemaLogger?.log({
      agent: AGENT,
      transcriptPath: basePath,
      issueType: "parse_error",
      description: `Failed to scan directory: ${error instanceof Error ? error.message : String(error)}`
    });
  }

  return transcripts;
}

// ============================================================================
// Full Parsing (V2)
// ============================================================================

/**
 * Extract extended token usage with Claude-specific fields.
 */
function extractExtendedTokenUsage(
  obj: Record<string, unknown>
): ExtendedTokenUsage | undefined {
  const message = obj.message as Record<string, unknown> | undefined;
  const usage = message?.usage as Record<string, unknown> | undefined;

  if (!usage) return undefined;

  const input = usage.input_tokens as number | undefined;
  const output = usage.output_tokens as number | undefined;
  const cacheRead = usage.cache_read_input_tokens as number | undefined;
  const cacheCreation = usage.cache_creation_input_tokens as number | undefined;

  return {
    input,
    output,
    cache_read: cacheRead,
    cache_creation: cacheCreation,
    cached: (cacheRead ?? 0) + (cacheCreation ?? 0) || undefined,
    total: (input ?? 0) + (output ?? 0) || undefined
  };
}

/**
 * Extract thinking blocks from Claude content array.
 */
function extractThinkingBlocks(
  content: unknown[],
  entryId: string,
  transcriptId: string,
  timestamp: string
): ThinkingBlock[] {
  const blocks: ThinkingBlock[] = [];

  content.forEach((block, index) => {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as Record<string, unknown>).type === "thinking"
    ) {
      const thinkingBlock = block as { type: string; thinking?: string };
      blocks.push({
        id: `${entryId}-thinking-${index}`,
        entryId,
        transcriptId,
        type: "thinking",
        text: thinkingBlock.thinking,
        sequenceIndex: index,
        timestamp
      });
    }
  });

  return blocks;
}

/**
 * Extract tool calls from Claude content array.
 */
function extractExtendedToolCalls(
  content: unknown[],
  entryId: string,
  transcriptId: string,
  timestamp: string
): ExtendedToolCall[] {
  const calls: ExtendedToolCall[] = [];

  content.forEach((block) => {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as Record<string, unknown>).type === "tool_use"
    ) {
      const toolBlock = block as {
        id?: string;
        name?: string;
        input?: unknown;
      };
      calls.push({
        id: toolBlock.id ?? `${entryId}-tool`,
        entryId,
        transcriptId,
        name: toolBlock.name ?? "unknown",
        input: toolBlock.input,
        status: "unknown",
        timestamp
      });
    }
  });

  return calls;
}

/**
 * Parse a single Claude entry into ExtendedUnifiedEntry format.
 */
function parseClaudeEntryExtended(
  line: string,
  index: number,
  transcriptId: string,
  transcriptPath: string,
  schemaLogger?: SchemaLogger
): {
  entry: ExtendedUnifiedEntry | null;
  thinkingBlocks: ThinkingBlock[];
  toolCalls: ExtendedToolCall[];
} {
  const thinkingBlocks: ThinkingBlock[] = [];
  const toolCalls: ExtendedToolCall[] = [];

  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const entryType = detectEntryType(obj);
    const message = obj.message as Record<string, unknown> | undefined;

    // Extract timestamp
    let timestamp = obj.timestamp as string | undefined;
    if (!timestamp) {
      const ts = obj.ts as number | string | undefined;
      if (typeof ts === "number") {
        timestamp = new Date(ts * 1000).toISOString();
      } else if (typeof ts === "string") {
        timestamp = ts;
      }
    }
    timestamp = timestamp ?? new Date().toISOString();

    // Generate entry ID
    const entryId = (obj.uuid as string) ?? `claude-${index}`;

    // Extract content
    let text: string | undefined;
    let content: unknown;
    const rawContent = message?.content ?? obj.content;

    if (obj.type === "summary") {
      text = obj.summary as string;
    } else {
      text = extractTextContent(rawContent, TEXT_RULES);
      content = rawContent;
    }

    // Extract thinking blocks and tool calls from content array
    if (Array.isArray(rawContent)) {
      thinkingBlocks.push(
        ...extractThinkingBlocks(rawContent, entryId, transcriptId, timestamp)
      );
      toolCalls.push(
        ...extractExtendedToolCalls(
          rawContent,
          entryId,
          transcriptId,
          timestamp
        )
      );
    }

    // Build extended entry
    const entry: ExtendedUnifiedEntry = {
      id: entryId,
      transcriptId,
      sequenceIndex: index,
      timestamp,
      type: entryType,
      agent: AGENT,
      text: text || undefined,
      content,
      ...extractToolInfo(obj),
      model: message?.model as string | undefined,
      tokens: extractExtendedTokenUsage(obj),
      parentUuid: obj.parentUuid as string | undefined,
      sessionId: obj.sessionId as string | undefined,
      isSidechain: obj.isSidechain as boolean | undefined,
      parentId: obj.parentUuid as string | undefined,
      subagentId: obj.agentId as string | undefined
    };

    return { entry, thinkingBlocks, toolCalls };
  } catch (error) {
    schemaLogger?.log({
      agent: AGENT,
      transcriptPath,
      entryIndex: index,
      issueType: "parse_error",
      description: `Failed to parse JSONL line: ${error instanceof Error ? error.message : String(error)}`,
      rawEntry: line
    });
    return { entry: null, thinkingBlocks: [], toolCalls: [] };
  }
}

/**
 * Full parse of a Claude transcript - reads ALL entries.
 * Returns entries, thinking blocks, tool calls for normalized storage.
 */
export async function parseClaudeTranscriptFull(
  filePath: string,
  options: {
    schemaLogger?: SchemaLogger;
  } = {}
): Promise<FullParseResult> {
  const { schemaLogger } = options;
  const fileName = basename(filePath, ".jsonl");
  const transcriptId = `claude:${fileName}`;

  const entries: ExtendedUnifiedEntry[] = [];
  const thinkingBlocks: ThinkingBlock[] = [];
  const toolCalls: ExtendedToolCall[] = [];
  const schemaIssues: SchemaIssue[] = [];

  const stats = {
    totalEntries: 0,
    parsedEntries: 0,
    skippedEntries: 0,
    thinkingBlockCount: 0,
    toolCallCount: 0,
    byType: {} as Record<string, number>
  };

  // Track tool_use IDs to link with tool_results
  const toolCallById = new Map<string, ExtendedToolCall>();

  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim());
    stats.totalEntries = lines.length;

    for (let i = 0; i < lines.length; i++) {
      const result = parseClaudeEntryExtended(
        lines[i],
        i,
        transcriptId,
        filePath,
        schemaLogger
      );

      if (result.entry) {
        entries.push(result.entry);
        stats.parsedEntries++;
        stats.byType[result.entry.type] =
          (stats.byType[result.entry.type] ?? 0) + 1;
      } else {
        stats.skippedEntries++;
      }

      // Collect thinking blocks and tool calls
      thinkingBlocks.push(...result.thinkingBlocks);
      toolCalls.push(...result.toolCalls);
      for (const toolCall of result.toolCalls) {
        toolCallById.set(toolCall.id, toolCall);
      }
    }

    // Link tool_results back to tool_calls
    for (const entry of entries) {
      if (entry.type === "tool_result" && entry.toolCallId) {
        const toolCall = toolCallById.get(entry.toolCallId);
        if (toolCall) {
          toolCall.resultEntryId = entry.id;
          toolCall.status = "success";
        }
      }
    }

    stats.thinkingBlockCount = thinkingBlocks.length;
    stats.toolCallCount = toolCalls.length;
  } catch (error) {
    const issue: SchemaIssue = {
      id: `parse-error-${Date.now()}`,
      timestamp: new Date().toISOString(),
      agent: AGENT,
      transcriptPath: filePath,
      issueType: "parse_error",
      description: `Failed to read transcript: ${error instanceof Error ? error.message : String(error)}`
    };
    schemaIssues.push(issue);
  }

  return {
    transcriptId,
    entries,
    thinkingBlocks,
    toolCalls,
    schemaIssues,
    stats
  };
}
