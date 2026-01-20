/**
 * Codex CLI transcript parser adapter.
 *
 * Codex transcripts are JSONL files stored at ~/.codex/sessions/{year}/{month}/{day}/
 * Each line is a JSON object with wrapper structure: { timestamp, type, payload }
 *
 * Entry types:
 * - session_meta: Session initialization metadata
 * - response_item: Container for messages, function calls, reasoning
 * - event_msg: Intermediate events (token counts, user messages)
 * - turn_context: Context snapshot for a turn
 * - custom_tool_call: Custom tool invocation
 * - custom_tool_call_output: Output from custom tools
 */

import { stat, readdir } from "fs/promises";
import { join, basename } from "path";
import type {
  UnifiedEntry,
  UnifiedTranscript,
  AgentType
} from "../types";
import type { SchemaLogger } from "../schema-logger";
import {
  accumulateEntryStats,
  createStatsAccumulator,
  expandHome,
  extractTextContent,
  finalizeStats,
  SMALL_FILE_THRESHOLD,
  type TextBlockRule
} from "./shared";

const AGENT: AgentType = "codex";
const CHUNK_SIZE = 64 * 1024;

// ============================================================================
// Stats Accumulation
// ============================================================================

const TEXT_RULES: TextBlockRule[] = [
  { type: "input_text", key: "text" },
  { type: "output_text", key: "text" }
];

// ============================================================================
// Entry Parsing
// ============================================================================

/**
 * Detect entry type from Codex JSONL entry.
 */
function detectEntryType(
  entryType: string,
  payload: Record<string, unknown>
): UnifiedEntry["type"] {
  // Top-level entry types
  if (entryType === "session_meta") return "system";
  if (entryType === "turn_context") return "system";
  if (entryType === "event_msg") {
    const eventType = payload.type as string | undefined;
    if (eventType === "user_message") return "user";
    if (eventType === "agent_message") return "assistant";
    if (eventType === "agent_reasoning") return "thinking";
    if (eventType === "token_count") return "system";
    return "system";
  }

  // Response items have nested type
  if (entryType === "response_item") {
    const itemType = payload.type as string | undefined;
    if (itemType === "message") {
      const role = payload.role as string | undefined;
      if (role === "user") return "user";
      if (role === "assistant") return "assistant";
      return "assistant";
    }
    if (itemType === "function_call") return "tool_call";
    if (itemType === "function_call_output") return "tool_result";
    if (itemType === "custom_tool_call") return "tool_call";
    if (itemType === "custom_tool_call_output") return "tool_result";
    if (itemType === "reasoning") return "thinking";
    if (itemType === "ghost_snapshot") return "system";
    return "unknown";
  }

  return "unknown";
}

/**
 * Extract tool call info from Codex entry.
 */
function extractToolInfo(
  entryType: string,
  payload: Record<string, unknown>
): {
  toolName?: string;
  toolInput?: unknown;
  toolCallId?: string;
} {
  if (entryType !== "response_item") return {};

  const itemType = payload.type as string | undefined;

  if (itemType === "function_call") {
    // Arguments are JSON stringified
    let input: unknown;
    try {
      input =
        typeof payload.arguments === "string"
          ? JSON.parse(payload.arguments)
          : payload.arguments;
    } catch {
      input = payload.arguments;
    }
    return {
      toolName: payload.name as string | undefined,
      toolInput: input,
      toolCallId: payload.call_id as string | undefined
    };
  }

  if (itemType === "function_call_output") {
    return {
      toolCallId: payload.call_id as string | undefined
    };
  }

  if (itemType === "custom_tool_call") {
    return {
      toolName: payload.name as string | undefined,
      toolInput: payload.input,
      toolCallId: payload.call_id as string | undefined
    };
  }

  if (itemType === "custom_tool_call_output") {
    return {
      toolCallId: payload.call_id as string | undefined
    };
  }

  return {};
}

/**
 * Extract token usage from Codex entry.
 */
function extractTokenUsage(
  entryType: string,
  payload: Record<string, unknown>
): UnifiedEntry["tokens"] {
  if (entryType !== "event_msg") return undefined;
  if (payload.type !== "token_count") return undefined;

  const info = payload.info as Record<string, unknown> | undefined;
  const usage = info?.total_token_usage as Record<string, unknown> | undefined;

  if (!usage) return undefined;

  return {
    input: usage.input_tokens as number | undefined,
    output: usage.output_tokens as number | undefined,
    cached: usage.cached_input_tokens as number | undefined,
    total: usage.total_tokens as number | undefined
  };
}

/**
 * Parse a single Codex JSONL entry into a UnifiedEntry.
 */
export function parseCodexEntry(
  line: string,
  index: number,
  transcriptPath: string,
  schemaLogger?: SchemaLogger
): UnifiedEntry | null {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const timestamp = obj.timestamp as string | undefined;
    const entryType = obj.type as string;
    const payload = (obj.payload ?? {}) as Record<string, unknown>;

    if (!timestamp) {
      schemaLogger?.log({
        agent: AGENT,
        transcriptPath,
        entryIndex: index,
        issueType: "missing_required_field",
        description: "Entry missing timestamp",
        rawEntry: obj
      });
      return null;
    }

    const type = detectEntryType(entryType, payload);

    // Extract content based on entry type
    let text: string | undefined;
    let content: unknown;

    if (entryType === "event_msg") {
      if (payload.type === "user_message") {
        text = payload.message as string | undefined;
      } else if (payload.type === "agent_message") {
        text = payload.message as string | undefined;
      } else if (payload.type === "agent_reasoning") {
        text = payload.text as string | undefined;
      }
    } else if (entryType === "response_item") {
      const itemType = payload.type as string | undefined;
      if (itemType === "message") {
        text = extractTextContent(payload.content, TEXT_RULES);
        content = payload.content;
      } else if (itemType === "reasoning") {
        // Reasoning may be encrypted
        const summary = payload.summary as Array<{ text?: string }> | undefined;
        if (summary) {
          text = summary.map((s) => s.text ?? "").join("\n");
        }
        content = payload.encrypted_content ? "[encrypted]" : payload.content;
      } else if (itemType === "function_call_output") {
        // Output is JSON stringified
        try {
          const output =
            typeof payload.output === "string"
              ? JSON.parse(payload.output)
              : payload.output;
          text = typeof output?.output === "string" ? output.output : undefined;
          content = output;
        } catch {
          text = payload.output as string | undefined;
          content = payload.output;
        }
      } else if (itemType === "custom_tool_call_output") {
        try {
          const output =
            typeof payload.output === "string"
              ? JSON.parse(payload.output)
              : payload.output;
          text = typeof output?.output === "string" ? output.output : undefined;
          content = output;
        } catch {
          text = payload.output as string | undefined;
          content = payload.output;
        }
      }
    } else if (entryType === "session_meta") {
      // Session metadata
      content = payload;
    }

    const entry: UnifiedEntry = {
      id: `codex-${index}`,
      timestamp,
      type,
      agent: AGENT,
      text: text || undefined,
      content,
      ...extractToolInfo(entryType, payload),
      tokens: extractTokenUsage(entryType, payload)
    };

    if (type === "unknown" && schemaLogger) {
      schemaLogger.log({
        agent: AGENT,
        transcriptPath,
        entryIndex: index,
        issueType: "unknown_entry_type",
        description: `Unknown entry type: ${entryType}/${payload.type}`,
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
      rawEntry: line
    });
    return null;
  }
}

/**
 * Parse all entries from a Codex transcript file.
 * Uses efficient single-pass parsing for pagination.
 */
export async function parseCodexEntries(
  filePath: string,
  options: {
    offset?: number;
    limit?: number;
    includeRaw?: boolean;
    schemaLogger?: SchemaLogger;
  } = {}
): Promise<{ entries: UnifiedEntry[]; total: number }> {
  const { offset = 0, limit = 500, includeRaw = false, schemaLogger } = options;

  const file = Bun.file(filePath);
  const fileSize = file.size;

  // For small files, use simple full-file approach
  if (fileSize < SMALL_FILE_THRESHOLD) {
    const content = await file.text();
    const lines = content.split("\n").filter((line) => line.trim());
    const total = lines.length;

    const entries: UnifiedEntry[] = [];
    const slicedLines = lines.slice(offset, offset + limit);

    for (let i = 0; i < slicedLines.length; i++) {
      const entry = parseCodexEntry(
        slicedLines[i],
        offset + i,
        filePath,
        schemaLogger
      );
      if (entry) {
        if (!includeRaw) {
          delete entry._raw;
        } else {
          try {
            entry._raw = JSON.parse(slicedLines[i]);
          } catch {
            // Already parsed successfully in parseCodexEntry, but protect against edge cases
          }
        }
        entries.push(entry);
      }
    }

    return { entries, total };
  }

  // For large files, single pass: count lines and collect only the ones we need
  const content = await file.text();
  const lines: string[] = [];
  let lineStart = 0;
  let lineIndex = 0;
  let total = 0;

  for (let i = 0; i <= content.length; i++) {
    if (i === content.length || content[i] === "\n") {
      const line = content.slice(lineStart, i).trim();
      if (line) {
        // Only store lines within our pagination window
        if (lineIndex >= offset && lineIndex < offset + limit) {
          lines.push(line);
        }
        lineIndex++;
        total++;
      }
      lineStart = i + 1;
    }
  }

  const entries: UnifiedEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const entry = parseCodexEntry(lines[i], offset + i, filePath, schemaLogger);
    if (entry) {
      if (!includeRaw) {
        delete entry._raw;
      } else {
        try {
          entry._raw = JSON.parse(lines[i]);
        } catch {
          // Already parsed successfully in parseCodexEntry, but protect against edge cases
        }
      }
      entries.push(entry);
    }
  }

  return { entries, total };
}

// ============================================================================
// Transcript Metadata Parsing
// ============================================================================

/**
 * Parse Codex transcript metadata.
 */
export async function parseCodexTranscript(
  filePath: string,
  options: {
    schemaLogger?: SchemaLogger;
  } = {}
): Promise<UnifiedTranscript | null> {
  const { schemaLogger } = options;

  try {
    const fileStats = await stat(filePath);
    const fileName = basename(filePath, ".jsonl");

    let startTime: number | null = null;
    let endTime: number | null = null;
    let name = fileName;
    let projectDir: string | null = null;
    let entryCount = 0;

    // Stats accumulator
    const statsAcc = createStatsAccumulator();
    let lineIndex = 0;

    // Parse date from filename (rollout-YYYY-MM-DDTHH-mm-ss-...)
    const dateMatch = fileName.match(
      /rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/
    );
    if (dateMatch) {
      const dateStr = dateMatch[1].replace(/-/g, (m, i) => (i > 9 ? ":" : m));
      const parsed = new Date(dateStr.replace("T", "T").replace(/-/g, ":"));
      if (!Number.isNaN(parsed.getTime())) {
        startTime = parsed.getTime();
      }
    }

    // Read file to extract metadata
    const file = Bun.file(filePath);
    const fileSize = fileStats.size;
    const firstChunkSize = Math.min(CHUNK_SIZE, fileSize);
    const firstChunk = await file.slice(0, firstChunkSize).text();
    const firstLines = firstChunk.split("\n").filter((l) => l.trim());

    for (const line of firstLines.slice(0, 50)) {
      try {
        const obj = JSON.parse(line);
        entryCount++;

        // Parse entry and accumulate stats
        const entry = parseCodexEntry(
          line,
          lineIndex++,
          filePath,
          schemaLogger
        );
        if (entry) {
          accumulateEntryStats(statsAcc, entry);
        }

        // Extract project from session_meta
        if (obj.type === "session_meta" && obj.payload) {
          const cwd = obj.payload.cwd as string | undefined;
          if (cwd) {
            projectDir = cwd;
            name = basename(cwd);
          }
        }

        // Extract timestamps
        const ts = obj.timestamp as string | undefined;
        if (ts) {
          const time = new Date(ts).getTime();
          if (!Number.isNaN(time)) {
            if (!startTime || time < startTime) startTime = time;
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    // Read last chunk for end time
    if (fileSize > CHUNK_SIZE) {
      const lastChunkStart = Math.max(0, fileSize - CHUNK_SIZE);
      const lastChunk = await file.slice(lastChunkStart, fileSize).text();
      const lastLines = lastChunk
        .split("\n")
        .slice(1)
        .filter((l) => l.trim());

      for (const line of lastLines.slice(-50)) {
        try {
          const obj = JSON.parse(line);
          entryCount++;

          // Parse entry and accumulate stats
          const entry = parseCodexEntry(
            line,
            lineIndex++,
            filePath,
            schemaLogger
          );
          if (entry) {
            accumulateEntryStats(statsAcc, entry);
          }

          const ts = obj.timestamp as string | undefined;
          if (ts) {
            const time = new Date(ts).getTime();
            if (!Number.isNaN(time) && (!endTime || time > endTime)) {
              endTime = time;
            }
          }
        } catch {
          // Skip
        }
      }
    } else {
      for (const line of firstLines.slice(-50)) {
        try {
          const obj = JSON.parse(line);
          const ts = obj.timestamp as string | undefined;
          if (ts) {
            const time = new Date(ts).getTime();
            if (!Number.isNaN(time) && (!endTime || time > endTime)) {
              endTime = time;
            }
          }
        } catch {
          // Skip
        }
      }
    }

    // Estimate entry count from file size
    if (entryCount < 100 && fileSize > CHUNK_SIZE * 2) {
      entryCount = Math.round(fileSize / 500);
    }

    // Finalize stats
    const transcriptStats = finalizeStats(statsAcc, startTime, endTime);

    return {
      schema_version: "v2" as const,
      id: `codex:${fileName}`,
      agent: AGENT,
      path: filePath,
      name,
      projectDir,
      modifiedAt: fileStats.mtimeMs,
      sizeBytes: fileStats.size,
      entryCount,
      startTime,
      endTime,
      isSubagent: false, // Codex doesn't have subagents
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
 * Scan Codex sessions directory for all transcripts.
 * Structure: ~/.codex/sessions/{year}/{month}/{day}/rollout-*.jsonl
 */
export async function scanCodexTranscripts(
  basePath: string,
  options: {
    schemaLogger?: SchemaLogger;
  } = {}
): Promise<UnifiedTranscript[]> {
  const { schemaLogger } = options;
  const expandedPath = expandHome(basePath);
  const transcripts: UnifiedTranscript[] = [];

  async function scanDirectory(dirPath: string, depth = 0) {
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dirPath, entry.name);

        if (entry.isDirectory() && depth < 3) {
          // Recurse into year/month/day directories
          await scanDirectory(fullPath, depth + 1);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          const transcript = await parseCodexTranscript(fullPath, {
            schemaLogger
          });
          if (transcript) {
            transcripts.push(transcript);
          }
        }
      }
    } catch {
      // Directory doesn't exist or not accessible
    }
  }

  await scanDirectory(expandedPath);
  return transcripts;
}
