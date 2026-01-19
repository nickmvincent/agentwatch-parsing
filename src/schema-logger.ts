/**
 * Schema issue logger - tracks parsing edge cases and unexpected formats.
 *
 * This helps maintain visibility into schema variations across agents
 * and identify when formats change.
 */

import type { SchemaIssue, SchemaLogger, SchemaLoggerInput } from "./types";

export type { SchemaLogger, SchemaLoggerInput };

export interface SchemaLoggerOptions {
  maxIssues?: number;
  onIssue?: (issue: SchemaIssue) => void;
}

/**
 * Create a schema logger that stores issues in memory.
 */
export function createSchemaLogger(options: SchemaLoggerOptions = {}): SchemaLogger {
  const { maxIssues = 1000, onIssue } = options;
  const issues: SchemaIssue[] = [];
  let issueCounter = 0;

  return {
    log(input: SchemaLoggerInput) {
      const issue: SchemaIssue = {
        id: `schema-issue-${++issueCounter}`,
        timestamp: new Date().toISOString(),
        ...input
      };

      issues.push(issue);

      if (issues.length > maxIssues) {
        issues.shift();
      }

      if (onIssue) {
        onIssue(issue);
      }
    },

    getIssues() {
      return [...issues];
    },

    getStats() {
      const byAgent: Record<string, number> = {};
      const byType: Record<string, number> = {};

      for (const issue of issues) {
        byAgent[issue.agent] = (byAgent[issue.agent] ?? 0) + 1;
        byType[issue.issueType] = (byType[issue.issueType] ?? 0) + 1;
      }

      return {
        total: issues.length,
        byAgent,
        byType
      };
    },

    clear() {
      issues.length = 0;
      issueCounter = 0;
    }
  };
}
