/**
 * @agentwatch/parsing - Standalone transcript parsing library
 *
 * Parse Claude, Codex, and Gemini agent transcripts into a unified format.
 *
 * @example
 * ```typescript
 * import { parseEntries, scanAllTranscripts } from "@agentwatch/parsing";
 *
 * // Parse a single transcript
 * const { entries, total } = await parseEntries("/path/to/transcript.jsonl", "claude");
 *
 * // Scan all agent directories
 * const { transcripts, stats } = await scanAllTranscripts({
 *   claude: "~/.claude/projects",
 *   codex: "~/.codex/sessions",
 *   gemini: "~/.gemini/tmp"
 * });
 * ```
 */

// Types
export * from "./types.js";

// Schema logger
export { createSchemaLogger } from "./schema-logger.js";
export type { SchemaLoggerOptions } from "./schema-logger.js";

// Adapters - unified API
export {
  parseEntries,
  parseTranscript,
  scanTranscripts,
  scanAllTranscripts,
  detectAgentFromPath,
  detectAgentFromId,
  detectAgentFromContent,
  AGENT_INFO
} from "./adapters/index.js";

// Individual adapters for direct use
export {
  parseClaudeEntry,
  parseClaudeEntries,
  parseClaudeTranscript,
  scanClaudeTranscripts
} from "./adapters/claude.js";

export {
  parseCodexEntry,
  parseCodexEntries,
  parseCodexTranscript,
  scanCodexTranscripts
} from "./adapters/codex.js";

export {
  parseGeminiEntries,
  parseGeminiTranscript,
  scanGeminiTranscripts
} from "./adapters/gemini.js";

// Shared utilities
export {
  createStatsAccumulator,
  accumulateEntryStats,
  finalizeStats,
  extractTextContent,
  expandHome,
  createId
} from "./adapters/shared.js";
