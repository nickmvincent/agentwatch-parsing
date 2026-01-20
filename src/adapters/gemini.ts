/**
 * Gemini CLI transcript parser adapter.
 *
 * Gemini transcripts are JSON files (not JSONL) stored at ~/.gemini/tmp/{project-hash}/chats/
 * Each session is a single JSON object with a messages array.
 *
 * Structure:
 * - sessionId: UUID
 * - projectHash: SHA256-like hash
 * - startTime, lastUpdated: ISO timestamps
 * - messages: Array of message objects with:
 *   - type: "user" | "gemini"
 *   - content: text content
 *   - thoughts: Array of reasoning steps
 *   - toolCalls: Array of tool invocations
 *   - tokens: Detailed token breakdown
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
  finalizeStats,
  DEFAULT_MAX_JSON_FILE_BYTES,
  expandHome,
  normalizePathSeparators
} from "./shared.js";

const AGENT: AgentType = "gemini";

// ============================================================================
// Types for Gemini session format
// ============================================================================

type GeminiThought = {
  subject?: string;
  description?: string;
  timestamp?: string;
};

type GeminiToolCall = {
  id?: string;
  name?: string;
  args?: unknown;
  result?: unknown;
  status?: string;
  timestamp?: string;
  displayName?: string;
  description?: string;
};

type GeminiMessage = {
  id?: string;
  timestamp?: string;
  type?: "user" | "gemini";
  content?: string;
  thoughts?: GeminiThought[];
  toolCalls?: GeminiToolCall[];
  model?: string;
  tokens?: {
    input?: number;
    output?: number;
    cached?: number;
    thoughts?: number;
    tool?: number;
    total?: number;
  };
};

type GeminiSession = {
  sessionId?: string;
  projectHash?: string;
  startTime?: string;
  lastUpdated?: string;
  messages?: GeminiMessage[];
};

// ============================================================================
// Entry Parsing
// ============================================================================

/**
 * Convert a Gemini message to UnifiedEntry format.
 */
function parseGeminiMessage(
  message: GeminiMessage,
  index: number,
  transcriptPath: string,
  schemaLogger?: SchemaLogger
): UnifiedEntry[] {
  const entries: UnifiedEntry[] = [];
  const baseId = message.id ?? `gemini-msg-${index}`;

  // Determine entry type
  let type: UnifiedEntry["type"] = "unknown";
  if (message.type === "user") {
    type = "user";
  } else if (message.type === "gemini") {
    type = "assistant";
  }

  // Main message entry
  if (message.content || type !== "unknown") {
    entries.push({
      id: baseId,
      timestamp: message.timestamp ?? new Date().toISOString(),
      type,
      agent: AGENT,
      text: message.content || undefined,
      model: message.model,
      tokens: message.tokens
        ? {
            input: message.tokens.input,
            output: message.tokens.output,
            cached: message.tokens.cached,
            total: message.tokens.total
          }
        : undefined
    });
  }

  // Add thinking entries for thoughts
  if (message.thoughts && message.thoughts.length > 0) {
    for (let i = 0; i < message.thoughts.length; i++) {
      const thought = message.thoughts[i];
      entries.push({
        id: `${baseId}-thought-${i}`,
        timestamp:
          thought.timestamp ?? message.timestamp ?? new Date().toISOString(),
        type: "thinking",
        agent: AGENT,
        text: [thought.subject, thought.description].filter(Boolean).join(": ")
      });
    }
  }

  // Add tool call entries
  if (message.toolCalls && message.toolCalls.length > 0) {
    for (let i = 0; i < message.toolCalls.length; i++) {
      const tool = message.toolCalls[i];
      const toolCallId = tool.id ?? `${baseId}-tool-${i}`;

      // Tool call entry
      entries.push({
        id: toolCallId,
        timestamp:
          tool.timestamp ?? message.timestamp ?? new Date().toISOString(),
        type: "tool_call",
        agent: AGENT,
        toolName: tool.name ?? tool.displayName,
        toolInput: tool.args,
        toolCallId
      });

      // Tool result entry (if present)
      if (tool.result !== undefined) {
        entries.push({
          id: `${toolCallId}-result`,
          timestamp:
            tool.timestamp ?? message.timestamp ?? new Date().toISOString(),
          type: "tool_result",
          agent: AGENT,
          content: tool.result,
          text:
            typeof tool.result === "string"
              ? tool.result
              : Array.isArray(tool.result)
                ? JSON.stringify(tool.result)
                : undefined,
          toolCallId
        });
      }
    }
  }

  return entries;
}

/**
 * Parse all entries from a Gemini session file.
 */
export async function parseGeminiEntries(
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
  const maxBytes = maxFileSizeBytes ?? DEFAULT_MAX_JSON_FILE_BYTES;
  if (fileStats.size > maxBytes) {
    throw new Error(
      `Gemini transcript exceeds maxFileSizeBytes (${fileStats.size} > ${maxBytes}).`
    );
  }

  const content = await readFile(filePath, "utf-8");
  let session: GeminiSession;

  try {
    session = JSON.parse(content) as GeminiSession;
  } catch (error) {
    schemaLogger?.log({
      agent: AGENT,
      transcriptPath: filePath,
      issueType: "parse_error",
      description: `Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`
    });
    return { entries: [], total: 0 };
  }

  const messages = session.messages ?? [];
  const allEntries: UnifiedEntry[] = [];

  // Parse all messages into entries
  for (let i = 0; i < messages.length; i++) {
    const messageEntries = parseGeminiMessage(
      messages[i],
      i,
      filePath,
      schemaLogger
    );
    allEntries.push(...messageEntries);
  }

  const total = allEntries.length;
  const slicedEntries = allEntries.slice(
    safeOffset,
    safeOffset + safeLimit
  );

  if (includeRaw) {
    // Add raw session data to first entry
    if (slicedEntries.length > 0) {
      slicedEntries[0]._raw = session;
    }
  }

  return { entries: slicedEntries, total };
}

// ============================================================================
// Transcript Metadata Parsing
// ============================================================================

/**
 * Parse Gemini session metadata.
 */
export async function parseGeminiTranscript(
  filePath: string,
  options: {
    schemaLogger?: SchemaLogger;
    maxFileSizeBytes?: number;
  } = {}
): Promise<UnifiedTranscript | null> {
  const { schemaLogger, maxFileSizeBytes } = options;

  try {
    const fileStats = await stat(filePath);
    const fileName = basename(filePath, ".json");

    const maxBytes = maxFileSizeBytes ?? DEFAULT_MAX_JSON_FILE_BYTES;
    if (fileStats.size > maxBytes) {
      throw new Error(
        `Gemini transcript exceeds maxFileSizeBytes (${fileStats.size} > ${maxBytes}).`
      );
    }

    const content = await readFile(filePath, "utf-8");

    let session: GeminiSession;
    try {
      session = JSON.parse(content) as GeminiSession;
    } catch (error) {
      schemaLogger?.log({
        agent: AGENT,
        transcriptPath: filePath,
        issueType: "parse_error",
        description: `Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`
      });
      return null;
    }

    // Extract timestamps
    let startTime: number | null = null;
    let endTime: number | null = null;

    if (session.startTime) {
      const time = new Date(session.startTime).getTime();
      if (!Number.isNaN(time)) startTime = time;
    }

    if (session.lastUpdated) {
      const time = new Date(session.lastUpdated).getTime();
      if (!Number.isNaN(time)) endTime = time;
    }

    // Count entries and accumulate stats
    let entryCount = 0;
    const statsAcc = createStatsAccumulator();
    const messages = session.messages ?? [];

    for (let i = 0; i < messages.length; i++) {
      // Parse entries from each message and accumulate stats
      const messageEntries = parseGeminiMessage(
        messages[i],
        i,
        filePath,
        schemaLogger
      );
      for (const entry of messageEntries) {
        accumulateEntryStats(statsAcc, entry);
        entryCount++;
      }
    }

    // Infer project from path (project hash is in parent directories)
    const normalizedPath = normalizePathSeparators(filePath);
    const pathParts = normalizedPath.split("/");
    const tmpIndex = pathParts.indexOf("tmp");
    let projectDir: string | null = null;
    if (tmpIndex >= 0 && tmpIndex < pathParts.length - 2) {
      projectDir = pathParts[tmpIndex + 1]; // Project hash
    }

    // Use session ID or first message content as name
    let name = session.sessionId ?? fileName;
    if (messages.length > 0) {
      const firstUserMsg = messages.find((m) => m.type === "user");
      if (firstUserMsg?.content) {
        name = firstUserMsg.content.slice(0, 60);
      }
    }

    // Finalize stats
    const transcriptStats = finalizeStats(statsAcc, startTime, endTime);

    return {
      schema_version: "v2" as const,
      id: `gemini:${fileName}`,
      agent: AGENT,
      path: filePath,
      name,
      projectDir,
      modifiedAt: fileStats.mtimeMs,
      sizeBytes: fileStats.size,
      entryCount,
      startTime,
      endTime,
      isSubagent: false, // Gemini doesn't have subagents
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
 * Scan Gemini tmp directory for all transcripts.
 * Structure: ~/.gemini/tmp/{project-hash}/chats/session-*.json
 */
export async function scanGeminiTranscripts(
  basePath: string,
  options: {
    schemaLogger?: SchemaLogger;
    maxFileSizeBytes?: number;
  } = {}
): Promise<UnifiedTranscript[]> {
  const { schemaLogger, maxFileSizeBytes } = options;
  const expandedPath = expandHome(basePath);
  const transcripts: UnifiedTranscript[] = [];

  try {
    // List project hash directories
    const projectDirs = await readdir(expandedPath);

    for (const projectDir of projectDirs) {
      const chatsPath = join(expandedPath, projectDir, "chats");

      try {
        const chatFiles = await readdir(chatsPath);

        for (const file of chatFiles) {
          if (!file.endsWith(".json")) continue;

          const filePath = join(chatsPath, file);
          const transcript = await parseGeminiTranscript(filePath, {
            schemaLogger,
            maxFileSizeBytes
          });

          if (transcript) {
            transcripts.push(transcript);
          }
        }
      } catch {
        // No chats directory for this project
      }
    }
  } catch {
    // Base path doesn't exist
  }

  return transcripts;
}
