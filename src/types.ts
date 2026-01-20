/**
 * @agentwatch/parsing - Type definitions
 *
 * Unified transcript schemas - common data model for all agent transcript formats.
 * Supports Claude, Codex, and Gemini transcripts with normalized entry/transcript types.
 */

import { z } from "zod";

// ============================================================================
// Agent Types
// ============================================================================

export const AgentTypeSchema = z.enum(["claude", "codex", "gemini", "custom"]);
export type AgentType = z.infer<typeof AgentTypeSchema>;

// ============================================================================
// Entry Types
// ============================================================================

export const EntryTypeSchema = z.enum([
  "user",
  "assistant",
  "tool_call",
  "tool_result",
  "system",
  "summary",
  "thinking",
  "unknown"
]);
export type EntryType = z.infer<typeof EntryTypeSchema>;

// ============================================================================
// Token Usage
// ============================================================================

export const TokenUsageSchema = z.object({
  input: z.number().optional(),
  output: z.number().optional(),
  cached: z.number().optional(),
  total: z.number().optional()
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const ExtendedTokenUsageSchema = z.object({
  input: z.number().optional(),
  output: z.number().optional(),
  cached: z.number().optional(),
  cache_read: z.number().optional(),
  cache_creation: z.number().optional(),
  thoughts: z.number().optional(),
  tool: z.number().optional(),
  reasoning: z.number().optional(),
  total: z.number().optional()
});
export type ExtendedTokenUsage = z.infer<typeof ExtendedTokenUsageSchema>;

// ============================================================================
// Transcript Stats
// ============================================================================

export const TranscriptStatsSchema = z.object({
  tokens: z.object({
    input: z.number(),
    output: z.number(),
    cached: z.number(),
    total: z.number()
  }),
  entryTypes: z.record(z.number()),
  tools: z.record(z.number()),
  models: z.record(z.number()),
  durationMs: z.number().nullable()
});
export type TranscriptStats = z.infer<typeof TranscriptStatsSchema>;

// ============================================================================
// Unified Entry
// ============================================================================

export const UnifiedEntrySchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  type: EntryTypeSchema,
  agent: AgentTypeSchema,
  text: z.string().optional(),
  content: z.unknown().optional(),
  toolName: z.string().optional(),
  toolInput: z.unknown().optional(),
  toolCallId: z.string().optional(),
  model: z.string().optional(),
  tokens: TokenUsageSchema.optional(),
  parentId: z.string().optional(),
  sessionId: z.string().optional(),
  isSidechain: z.boolean().optional(),
  subagentId: z.string().optional(),
  _raw: z.unknown().optional()
});
export type UnifiedEntry = z.infer<typeof UnifiedEntrySchema>;

// ============================================================================
// Unified Transcript
// ============================================================================

export type UnifiedTranscript = {
  schema_version?: "v2";
  id: string;
  agent: AgentType;
  path: string;
  name: string;
  projectDir: string | null;
  modifiedAt: number;
  sizeBytes: number;
  entryCount: number;
  startTime: number | null;
  endTime: number | null;
  isSubagent: boolean;
  parentTranscriptId?: string;
  subagents?: UnifiedTranscript[];
  schemaIssues?: string[];
  stats?: TranscriptStats;
};

export const UnifiedTranscriptSchema: z.ZodType<UnifiedTranscript> = z.object({
  schema_version: z.literal("v2").optional(),
  id: z.string(),
  agent: AgentTypeSchema,
  path: z.string(),
  name: z.string(),
  projectDir: z.string().nullable(),
  modifiedAt: z.number(),
  sizeBytes: z.number(),
  entryCount: z.number(),
  startTime: z.number().nullable(),
  endTime: z.number().nullable(),
  isSubagent: z.boolean(),
  parentTranscriptId: z.string().optional(),
  subagents: z.lazy(() => z.array(UnifiedTranscriptSchema)).optional(),
  schemaIssues: z.array(z.string()).optional(),
  stats: TranscriptStatsSchema.optional()
});

// ============================================================================
// Schema Issues
// ============================================================================

export const SchemaIssueTypeSchema = z.enum([
  "unknown_entry_type",
  "missing_required_field",
  "invalid_timestamp",
  "malformed_content",
  "unexpected_structure",
  "parse_error"
]);
export type SchemaIssueType = z.infer<typeof SchemaIssueTypeSchema>;

export const SchemaIssueSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  agent: AgentTypeSchema,
  transcriptPath: z.string(),
  entryIndex: z.number().optional(),
  issueType: SchemaIssueTypeSchema,
  description: z.string(),
  rawEntry: z.unknown().optional()
});
export type SchemaIssue = z.infer<typeof SchemaIssueSchema>;

// ============================================================================
// Agent Info
// ============================================================================

export const AgentInfoSchema = z.object({
  id: AgentTypeSchema,
  name: z.string(),
  format: z.enum(["jsonl", "json"]),
  defaultPath: z.string(),
  supportsSubagents: z.boolean()
});
export type AgentInfo = z.infer<typeof AgentInfoSchema>;

// ============================================================================
// Parse Options and Results
// ============================================================================

export interface ParseOptions {
  offset?: number;
  limit?: number;
  includeRaw?: boolean;
}

export interface ScanOptions {
  includeSubagents?: boolean;
  computeStats?: boolean;
}

export const ParseResultSchema = z.object({
  entries: z.array(UnifiedEntrySchema),
  schemaIssues: z.array(SchemaIssueSchema),
  stats: z.object({
    totalEntries: z.number(),
    parsedEntries: z.number(),
    skippedEntries: z.number(),
    byType: z.record(z.number())
  })
});
export type ParseResult = z.infer<typeof ParseResultSchema>;

// ============================================================================
// Schema Logger Interface
// ============================================================================

export interface SchemaLoggerInput {
  agent: AgentType;
  transcriptPath: string;
  entryIndex?: number;
  issueType: SchemaIssueType;
  description: string;
  rawEntry?: unknown;
}

export interface SchemaLogger {
  log(issue: SchemaLoggerInput): void;
  getIssues(): SchemaIssue[];
  getStats(): { total: number; byAgent: Record<string, number>; byType: Record<string, number> };
  clear(): void;
}

// ============================================================================
// Extended Types (for full parsing mode)
// ============================================================================

export const ExtendedUnifiedEntrySchema = z.object({
  id: z.string(),
  transcriptId: z.string(),
  sequenceIndex: z.number(),
  timestamp: z.string(),
  type: EntryTypeSchema,
  agent: AgentTypeSchema,
  text: z.string().optional(),
  content: z.unknown().optional(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  toolInput: z.unknown().optional(),
  model: z.string().optional(),
  tokens: ExtendedTokenUsageSchema.optional(),
  parentUuid: z.string().optional(),
  sessionId: z.string().optional(),
  isSidechain: z.boolean().optional(),
  turnContext: z.unknown().optional(),
  isEncrypted: z.boolean().optional(),
  parentId: z.string().optional(),
  subagentId: z.string().optional(),
  schemaVersion: z.string().optional(),
  _raw: z.unknown().optional()
});
export type ExtendedUnifiedEntry = z.infer<typeof ExtendedUnifiedEntrySchema>;

export const ThinkingBlockSchema = z.object({
  id: z.string(),
  entryId: z.string(),
  transcriptId: z.string(),
  type: z.enum(["thinking", "reasoning", "thought"]),
  text: z.string().optional(),
  subject: z.string().optional(),
  description: z.string().optional(),
  summary: z.string().optional(),
  isEncrypted: z.boolean().optional(),
  sequenceIndex: z.number().optional(),
  timestamp: z.string().optional()
});
export type ThinkingBlock = z.infer<typeof ThinkingBlockSchema>;

export const ExtendedToolCallSchema = z.object({
  id: z.string(),
  entryId: z.string(),
  transcriptId: z.string(),
  name: z.string(),
  displayName: z.string().optional(),
  input: z.unknown().optional(),
  inputRaw: z.string().optional(),
  status: z.enum(["pending", "success", "error", "unknown"]).optional(),
  resultEntryId: z.string().optional(),
  description: z.string().optional(),
  timestamp: z.string()
});
export type ExtendedToolCall = z.infer<typeof ExtendedToolCallSchema>;

export const FullParseResultSchema = z.object({
  transcriptId: z.string(),
  entries: z.array(ExtendedUnifiedEntrySchema),
  thinkingBlocks: z.array(ThinkingBlockSchema),
  toolCalls: z.array(ExtendedToolCallSchema),
  schemaIssues: z.array(SchemaIssueSchema),
  stats: z.object({
    totalEntries: z.number(),
    parsedEntries: z.number(),
    skippedEntries: z.number(),
    thinkingBlockCount: z.number(),
    toolCallCount: z.number(),
    byType: z.record(z.number())
  })
});
export type FullParseResult = z.infer<typeof FullParseResultSchema>;

// ============================================================================
// Constants
// ============================================================================

export const TRANSCRIPT_SCHEMA_VERSION = "v2" as const;
