/**
 * Shared utilities for transcript parsing adapters
 */

import type { TranscriptStats, UnifiedEntry } from "../types";

/**
 * File size threshold for switching from simple full-file read to streaming.
 * Files smaller than this are read entirely into memory for parsing.
 */
export const SMALL_FILE_THRESHOLD = 1024 * 1024; // 1MB

export type StatsAccumulator = {
  tokens: { input: number; output: number; cached: number; total: number };
  entryTypes: Record<string, number>;
  tools: Record<string, number>;
  models: Record<string, number>;
};

export type TextBlockRule = {
  type: string;
  key: string;
};

export function createStatsAccumulator(): StatsAccumulator {
  return {
    tokens: { input: 0, output: 0, cached: 0, total: 0 },
    entryTypes: {},
    tools: {},
    models: {}
  };
}

export function accumulateEntryStats(
  acc: StatsAccumulator,
  entry: UnifiedEntry
): void {
  if (entry.tokens) {
    acc.tokens.input += entry.tokens.input ?? 0;
    acc.tokens.output += entry.tokens.output ?? 0;
    acc.tokens.cached += entry.tokens.cached ?? 0;
    acc.tokens.total += entry.tokens.total ?? 0;
  }
  acc.entryTypes[entry.type] = (acc.entryTypes[entry.type] ?? 0) + 1;
  if (entry.toolName) {
    acc.tools[entry.toolName] = (acc.tools[entry.toolName] ?? 0) + 1;
  }
  if (entry.model) {
    acc.models[entry.model] = (acc.models[entry.model] ?? 0) + 1;
  }
}

export function finalizeStats(
  acc: StatsAccumulator,
  startTime: number | null,
  endTime: number | null
): TranscriptStats {
  return {
    tokens: acc.tokens,
    entryTypes: acc.entryTypes,
    tools: acc.tools,
    models: acc.models,
    durationMs: startTime && endTime ? endTime - startTime : null
  };
}

export function extractTextContent(
  content: unknown,
  rules: TextBlockRule[]
): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter(
      (block): block is Record<string, unknown> =>
        typeof block === "object" && block !== null
    )
    .map((block) => {
      if (typeof block.type !== "string") return "";
      const rule = rules.find((item) => item.type === block.type);
      if (!rule) return "";
      const value = block[rule.key];
      return typeof value === "string" ? value : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Expand ~ to home directory
 */
export function expandHome(path: string): string {
  if (path.startsWith("~/")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    return path.replace("~", home);
  }
  return path;
}

/**
 * Generate a unique ID with prefix
 */
export function createId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${timestamp}_${random}`;
}
