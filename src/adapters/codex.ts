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

import { readFile, stat, readdir } from "fs/promises";
import { join, basename } from "path";
import type {
  UnifiedEntry,
  UnifiedTranscript,
  AgentType
} from "../types.js";
import type { SchemaLogger } from "../schema-logger.js";
import {
  accumulateEntryStats,
  createStatsAccumulator,
  expandHome,
  extractTextContent,
  finalizeStats,
  readJsonlLines,
  SMALL_FILE_THRESHOLD,
  type TextBlockRule
} from "./shared.js";

const AGENT: AgentType = "codex";

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
 * Prefers last_token_usage (incremental) over total_token_usage (running total)
 * to avoid double-counting when accumulating stats.
 * Falls back to total_token_usage for older transcripts that don't have last_token_usage.
 */
function extractTokenUsage(
  entryType: string,
  payload: Record<string, unknown>
): UnifiedEntry["tokens"] {
  if (entryType !== "event_msg") return undefined;
  if (payload.type !== "token_count") return undefined;

  const info = payload.info as Record<string, unknown> | undefined;
  // Prefer last_token_usage (incremental), fall back to total_token_usage for older transcripts
  const usage = (info?.last_token_usage ?? info?.total_token_usage) as
    | Record<string, unknown>
    | undefined;

  if (!usage) return undefined;

  return {
    input: usage.input_tokens as number | undefined,
    output: usage.output_tokens as number | undefined,
    cached: usage.cached_input_tokens as number | undefined,
    total: usage.total_tokens as number | undefined
  };
}

/**
 * Parse a Codex JSON object into a UnifiedEntry.
 */
function parseCodexEntryObject(
  obj: Record<string, unknown>,
  index: number,
  transcriptPath: string,
  schemaLogger?: SchemaLogger
): UnifiedEntry | null {
  try {
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
      rawEntry: obj
    });
    return null;
  }
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
    return parseCodexEntryObject(obj, index, transcriptPath, schemaLogger);
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
    maxFileSizeBytes?: number;
  } = {}
): Promise<{ entries: UnifiedEntry[]; total: number }> {
  const {
    offset = 0,
    limit = Number.POSITIVE_INFINITY,
    includeRaw = false,
    schemaLogger,
    maxFileSizeBytes
  } = options;
  const safeOffset = Math.max(0, offset);
  const safeLimit = Number.isFinite(limit)
    ? Math.max(0, limit)
    : Number.POSITIVE_INFINITY;

  const fileStats = await stat(filePath);
  const fileSize = fileStats.size;

  if (maxFileSizeBytes !== undefined && fileSize > maxFileSizeBytes) {
    throw new Error(
      `Codex transcript exceeds maxFileSizeBytes (${fileSize} > ${maxFileSizeBytes}).`
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
      const entry = parseCodexEntry(
        slicedLines[i],
        safeOffset + i,
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

  const entries: UnifiedEntry[] = [];
  const { total } = await readJsonlLines(
    filePath,
    (line, lineIndex) => {
      if (lineIndex < safeOffset || lineIndex >= safeOffset + safeLimit) {
        return;
      }

      const entry = parseCodexEntry(line, lineIndex, filePath, schemaLogger);
      if (entry) {
        if (!includeRaw) {
          delete entry._raw;
        } else {
          try {
            entry._raw = JSON.parse(line);
          } catch {
            // Already parsed successfully in parseCodexEntry, but protect against edge cases
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
 * Parse Codex transcript metadata.
 */
export async function parseCodexTranscript(
  filePath: string,
  options: {
    schemaLogger?: SchemaLogger;
    maxFileSizeBytes?: number;
  } = {}
): Promise<UnifiedTranscript | null> {
  const { schemaLogger, maxFileSizeBytes } = options;

  try {
    const fileStats = await stat(filePath);
    const fileName = basename(filePath, ".jsonl");

    if (maxFileSizeBytes !== undefined && fileStats.size > maxFileSizeBytes) {
      throw new Error(
        `Codex transcript exceeds maxFileSizeBytes (${fileStats.size} > ${maxFileSizeBytes}).`
      );
    }

    let startTime: number | null = null;
    let endTime: number | null = null;
    let name = fileName;
    let projectDir: string | null = null;
    let entryCount = 0;

    // Stats accumulator
    const statsAcc = createStatsAccumulator();

    // Track last seen token total to deduplicate streaming updates
    let lastSeenTokenTotal = 0;

    // Parse date from filename (rollout-YYYY-MM-DDTHH-mm-ss-...)
    const dateMatch = fileName.match(
      /rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/
    );
    if (dateMatch) {
      const normalized = dateMatch[1].replace(
        /(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/,
        "$1-$2-$3T$4:$5:$6"
      );
      const parsed = new Date(normalized);
      if (!Number.isNaN(parsed.getTime())) startTime = parsed.getTime();
    }

    await readJsonlLines(filePath, (line, lineIndex) => {
      entryCount++;

      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }

      if (obj.type === "session_meta" && obj.payload) {
        const cwd = (obj.payload as Record<string, unknown>).cwd as
          | string
          | undefined;
        if (cwd) {
          projectDir = cwd;
          name = basename(cwd);
        }
      }

      const ts = obj.timestamp as string | undefined;
      if (ts) {
        const time = new Date(ts).getTime();
        if (!Number.isNaN(time)) {
          if (!startTime || time < startTime) startTime = time;
          if (!endTime || time > endTime) endTime = time;
        }
      }

      const entry = parseCodexEntryObject(
        obj,
        lineIndex,
        filePath,
        schemaLogger
      );
      if (entry) {
        // Deduplicate token counts - Codex emits duplicate events during streaming
        // Only count tokens when the total changes
        if (entry.tokens?.total) {
          if (entry.tokens.total === lastSeenTokenTotal) {
            // Skip duplicate - don't count tokens for this entry
            const entryWithoutTokens = { ...entry, tokens: undefined };
            accumulateEntryStats(statsAcc, entryWithoutTokens);
          } else {
            lastSeenTokenTotal = entry.tokens.total;
            accumulateEntryStats(statsAcc, entry);
          }
        } else {
          accumulateEntryStats(statsAcc, entry);
        }
      }
    });

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
    maxFileSizeBytes?: number;
  } = {}
): Promise<UnifiedTranscript[]> {
  const { schemaLogger, maxFileSizeBytes } = options;
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
            schemaLogger,
            maxFileSizeBytes
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
