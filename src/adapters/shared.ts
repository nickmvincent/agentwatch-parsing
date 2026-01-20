/**
 * Shared utilities for transcript parsing adapters
 */

import { open } from "fs/promises";
import type { TranscriptStats, UnifiedEntry } from "../types.js";

/**
 * File size threshold for switching from simple full-file read to streaming.
 * Files smaller than this are read entirely into memory for parsing.
 */
export const SMALL_FILE_THRESHOLD = 1024 * 1024; // 1MB
export const JSONL_STREAM_CHUNK_SIZE = 64 * 1024; // 64KB

/**
 * JSON transcripts must be loaded into memory, so cap size by default.
 */
export const DEFAULT_MAX_JSON_FILE_BYTES = 50 * 1024 * 1024; // 50MB

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
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    return `${home}${path.slice(1)}`;
  }
  return path;
}

/**
 * Normalize Windows backslashes to forward slashes for matching.
 */
export function normalizePathSeparators(value: string): string {
  return value.replace(/\\/g, "/");
}

/**
 * Generate a unique ID with prefix
 */
export function createId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${timestamp}_${random}`;
}

/**
 * Stream JSONL lines without loading the full file into memory.
 */
export async function readJsonlLines(
  filePath: string,
  onLine: (line: string, lineIndex: number) => Promise<void> | void,
  options: { chunkSize?: number } = {}
): Promise<{ total: number }> {
  const chunkSize = options.chunkSize ?? JSONL_STREAM_CHUNK_SIZE;
  const handle = await open(filePath, "r");
  let leftover = "";
  let lineIndex = 0;
  let total = 0;
  let position = 0;

  try {
    const buffer = Buffer.allocUnsafe(chunkSize);

    while (true) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position
      );
      if (!bytesRead) break;

      position += bytesRead;
      const chunk = leftover + buffer.toString("utf-8", 0, bytesRead);
      const lines = chunk.split("\n");
      leftover = lines.pop() ?? "";

      for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        await onLine(trimmed, lineIndex);
        lineIndex++;
        total++;
      }
    }

    const finalLine = leftover.trim();
    if (finalLine) {
      await onLine(finalLine, lineIndex);
      lineIndex++;
      total++;
    }
  } finally {
    await handle.close();
  }

  return { total };
}

/**
 * Read a chunk of a file efficiently without loading the entire file.
 * Used for sampling large files (reading first/last chunks for metadata).
 */
export async function readFileChunk(
  filePath: string,
  start: number,
  length: number
): Promise<string> {
  if (length <= 0) {
    return "";
  }

  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf-8");
  } finally {
    await handle.close();
  }
}
