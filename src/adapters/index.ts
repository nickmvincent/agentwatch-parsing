/**
 * Adapter registry and auto-detection for transcript formats.
 */

import type {
  UnifiedEntry,
  UnifiedTranscript,
  AgentType,
  AgentInfo
} from "../types.js";
import type { SchemaLogger } from "../schema-logger.js";

// Import adapters
import {
  parseClaudeEntry,
  parseClaudeEntries,
  parseClaudeTranscript,
  scanClaudeTranscripts
} from "./claude.js";
import {
  parseCodexEntry,
  parseCodexEntries,
  parseCodexTranscript,
  scanCodexTranscripts
} from "./codex.js";
import {
  parseGeminiEntries,
  parseGeminiTranscript,
  scanGeminiTranscripts
} from "./gemini.js";
import { normalizePathSeparators } from "./shared.js";

// Re-export individual adapters
export * from "./claude.js";
export * from "./codex.js";
export * from "./gemini.js";

// ============================================================================
// Adapter Registry
// ============================================================================

export const AGENT_INFO: Record<AgentType, AgentInfo> = {
  claude: {
    id: "claude",
    name: "Claude Code",
    format: "jsonl",
    defaultPath: "~/.claude/projects",
    supportsSubagents: true
  },
  codex: {
    id: "codex",
    name: "Codex CLI",
    format: "jsonl",
    defaultPath: "~/.codex/sessions",
    supportsSubagents: false
  },
  gemini: {
    id: "gemini",
    name: "Gemini CLI",
    format: "json",
    defaultPath: "~/.gemini/tmp",
    supportsSubagents: false
  },
  custom: {
    id: "custom",
    name: "Custom",
    format: "jsonl",
    defaultPath: "",
    supportsSubagents: false
  }
};

// ============================================================================
// Auto-Detection
// ============================================================================

/**
 * Detect agent type from file path.
 */
export function detectAgentFromPath(filePath: string): AgentType | null {
  const lowerPath = normalizePathSeparators(filePath).toLowerCase();

  if (
    lowerPath.includes("/.claude/") ||
    lowerPath.includes("/claude/projects/")
  ) {
    return "claude";
  }
  if (
    lowerPath.includes("/.codex/") ||
    lowerPath.includes("/codex/sessions/")
  ) {
    return "codex";
  }
  if (lowerPath.includes("/.gemini/") || lowerPath.includes("/gemini/tmp/")) {
    return "gemini";
  }

  return null;
}

/**
 * Detect agent type from transcript ID.
 */
export function detectAgentFromId(id: string): AgentType | null {
  if (id.startsWith("claude:")) return "claude";
  if (id.startsWith("codex:")) return "codex";
  if (id.startsWith("gemini:")) return "gemini";
  if (id.startsWith("custom:")) return "custom";
  return null;
}

/**
 * Detect agent type from content (first few lines).
 */
export function detectAgentFromContent(content: string): AgentType | null {
  const firstLine = content.split("\n")[0]?.trim();
  if (!firstLine) return null;

  try {
    const obj = JSON.parse(firstLine);

    // Claude has uuid and type at top level
    if (obj.uuid && obj.type && (obj.sessionId || obj.message)) {
      return "claude";
    }

    // Codex has wrapper structure with timestamp, type, payload
    if (obj.timestamp && obj.type && obj.payload !== undefined) {
      return "codex";
    }

    // Gemini has sessionId, projectHash, messages array
    if (obj.sessionId && obj.messages && Array.isArray(obj.messages)) {
      return "gemini";
    }
  } catch {
    // Not valid JSON, might be multi-line JSON (Gemini)
    try {
      const parsed = JSON.parse(content);
      if (parsed.sessionId && parsed.messages) {
        return "gemini";
      }
    } catch {
      // Not parseable
    }
  }

  return null;
}

// ============================================================================
// Unified API
// ============================================================================

export type ParseEntriesOptions = {
  offset?: number;
  limit?: number;
  includeRaw?: boolean;
  schemaLogger?: SchemaLogger;
  maxFileSizeBytes?: number;
};

const SUPPORTED_AGENTS = ["claude", "codex", "gemini"] as const;

/**
 * Parse entries from a transcript file, auto-detecting agent type.
 * @throws Error if agent type cannot be detected and is not specified
 */
export async function parseEntries(
  filePath: string,
  agent: AgentType | null,
  options: ParseEntriesOptions = {}
): Promise<{ entries: UnifiedEntry[]; total: number; agent: AgentType }> {
  // Auto-detect if not specified
  const detectedAgent = agent ?? detectAgentFromPath(filePath);

  if (!detectedAgent) {
    throw new Error(
      `Could not detect agent type for: ${filePath}. ` +
      `Specify agent explicitly as one of: ${SUPPORTED_AGENTS.join(", ")}`
    );
  }

  switch (detectedAgent) {
    case "claude": {
      const claudeResult = await parseClaudeEntries(filePath, options);
      return { ...claudeResult, agent: "claude" };
    }

    case "codex": {
      const codexResult = await parseCodexEntries(filePath, options);
      return { ...codexResult, agent: "codex" };
    }

    case "gemini": {
      const geminiResult = await parseGeminiEntries(filePath, options);
      return { ...geminiResult, agent: "gemini" };
    }

    default:
      throw new Error(
        `Unsupported agent type: "${detectedAgent}". ` +
        `Supported agents: ${SUPPORTED_AGENTS.join(", ")}`
      );
  }
}

/**
 * Parse transcript metadata, auto-detecting agent type.
 * @throws Error if agent type cannot be detected and is not specified
 */
export async function parseTranscript(
  filePath: string,
  agent: AgentType | null,
  options: {
    schemaLogger?: SchemaLogger;
    scanSubagents?: boolean;
    maxFileSizeBytes?: number;
  } = {}
): Promise<UnifiedTranscript> {
  const detectedAgent = agent ?? detectAgentFromPath(filePath);

  if (!detectedAgent) {
    throw new Error(
      `Could not detect agent type for: ${filePath}. ` +
      `Specify agent explicitly as one of: ${SUPPORTED_AGENTS.join(", ")}`
    );
  }

  let result: UnifiedTranscript | null = null;

  switch (detectedAgent) {
    case "claude":
      result = await parseClaudeTranscript(filePath, options);
      break;

    case "codex":
      result = await parseCodexTranscript(filePath, options);
      break;

    case "gemini":
      result = await parseGeminiTranscript(filePath, options);
      break;

    default:
      throw new Error(
        `Unsupported agent type: "${detectedAgent}". ` +
        `Supported agents: ${SUPPORTED_AGENTS.join(", ")}`
      );
  }

  if (!result) {
    throw new Error(`Failed to parse transcript: ${filePath}`);
  }

  return result;
}

/**
 * Scan a directory for transcripts of a specific agent type.
 * @throws Error if agent type is not supported
 */
export async function scanTranscripts(
  basePath: string,
  agent: AgentType,
  options: {
    schemaLogger?: SchemaLogger;
    scanSubagents?: boolean;
    maxFileSizeBytes?: number;
  } = {}
): Promise<UnifiedTranscript[]> {
  switch (agent) {
    case "claude":
      return scanClaudeTranscripts(basePath, options);

    case "codex":
      return scanCodexTranscripts(basePath, options);

    case "gemini":
      return scanGeminiTranscripts(basePath, options);

    case "custom":
      // Custom agent type requires user-provided parsing logic
      return [];

    default:
      throw new Error(
        `Unsupported agent type: "${agent}". ` +
        `Supported agents: ${SUPPORTED_AGENTS.join(", ")}`
      );
  }
}

/**
 * Scan all configured agent directories for transcripts.
 */
export async function scanAllTranscripts(
  agentPaths: Record<string, string>,
  options: {
    schemaLogger?: SchemaLogger;
    scanSubagents?: boolean;
    maxFileSizeBytes?: number;
  } = {}
): Promise<{
  transcripts: UnifiedTranscript[];
  stats: Record<AgentType | "total", number>;
}> {
  const transcripts: UnifiedTranscript[] = [];
  const stats: Record<AgentType | "total", number> = {
    claude: 0,
    codex: 0,
    gemini: 0,
    custom: 0,
    total: 0
  };

  // Scan each agent's directory
  for (const [agent, path] of Object.entries(agentPaths)) {
    if (!path) continue;

    const agentType = agent as AgentType;
    const agentTranscripts = await scanTranscripts(path, agentType, options);

    transcripts.push(...agentTranscripts);
    stats[agentType] = agentTranscripts.length;
    stats.total += agentTranscripts.length;
  }

  return { transcripts, stats };
}
