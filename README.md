# @agentwatch/parsing

Parse AI agent transcripts into a unified format. Supports Claude Code, Codex CLI, and Gemini CLI transcripts.

## Status

**Version**: 0.1.0 (initial release)
**Users**: 1 (author only, not yet published to npm)

This library is in early development. The core parsing functionality works and is well-tested, but the API may change before 1.0.

**Testing**:
- 166 unit tests, 917 assertions, all passing
- 95% line coverage enforced by CI
- E2E tests run against real local transcripts (Claude, Codex, Gemini) to catch format drift
- CI runs on every push and PR (GitHub Actions)

**What works**:
- Parsing transcripts from all three agents into a unified format
- Token counting, tool call extraction, thinking block parsing
- Directory scanning and metadata extraction
- Pagination for large transcripts

**Known gaps**:
- Transcript formats change frequently; new entry types may appear as agents evolve
- Gemini CLI support is more limited (fewer transcripts to test against)
- No browser support yet (Node.js/Bun only)

## Try It

Scan your own transcripts to see what the library does:

```bash
# Clone and run the example
git clone https://github.com/nmvg/agentwatch-parsing.git
cd agentwatch-parsing
bun install
bun examples/scan-my-transcripts.ts
```

Example output:
```
🔍 Scanning for AI agent transcripts...

📊 Summary:
   Claude Code: 42 transcripts
   Codex CLI:   12 transcripts
   Gemini CLI:  3 transcripts
   Total:       57 transcripts

📝 Recent transcripts:
   [1/20/2026] Claude Code: "Help me refactor the authentication module" (156 entries)
   [1/19/2026] Codex CLI: "Debug the API timeout issue" (89 entries)
   ...
```

## Installation

```bash
bun add @agentwatch/parsing
# or
npm install @agentwatch/parsing
```

This package is ESM-only. Use `import` in Node 18+ and bundlers.

## Quick Start

```typescript
import { parseEntries, detectAgentFromPath } from "@agentwatch/parsing";

// Parse a transcript file
const { entries, total } = await parseEntries(
  "/path/to/transcript.jsonl",
  "claude" // or "codex" or "gemini"
);

// Each entry has a unified structure
for (const entry of entries) {
  console.log(`[${entry.type}] ${entry.text}`);
}
```

Prefer to learn by example? The tests in `test/` are written to be readable and serve as real usage samples.

## Core Concepts

### Unified Entry Format

All agent transcripts are normalized into `UnifiedEntry` objects:

```typescript
interface UnifiedEntry {
  id: string;              // Unique identifier
  timestamp: string;       // ISO timestamp
  type: EntryType;         // "user" | "assistant" | "tool_call" | "tool_result" | "thinking" | "system" | "summary"
  agent: AgentType;        // "claude" | "codex" | "gemini" | "custom"
  text?: string;           // Extracted text content
  content?: unknown;       // Raw content (arrays, objects)
  toolName?: string;       // For tool_call entries
  toolInput?: unknown;     // Tool input parameters
  toolCallId?: string;     // Links tool_call to tool_result
  model?: string;          // Model used (e.g., "claude-sonnet-4")
  tokens?: TokenUsage;     // Token counts
  sessionId?: string;      // Session identifier
}
```

### Supported Agents

| Agent | Format | Default Path | Subagents |
|-------|--------|--------------|-----------|
| Claude Code | JSONL | `~/.claude/projects/` | Yes |
| Codex CLI | JSONL | `~/.codex/sessions/` | No |
| Gemini CLI | JSON | `~/.gemini/tmp/` | No |

The built-in parsers support Claude, Codex, and Gemini. Use `custom` when you map your own transcript format into the unified types.

## API Reference

### Parsing Entries

```typescript
import { parseEntries, parseClaudeEntries, parseCodexEntries, parseGeminiEntries } from "@agentwatch/parsing";

// Auto-detect or specify agent
const { entries, total, agent } = await parseEntries(filePath, "claude");

// Or use agent-specific parsers directly
const { entries, total } = await parseClaudeEntries(filePath, {
  offset: 0,      // Skip first N entries
  limit: 100,     // Max entries to return
  includeRaw: false,  // Include original JSON in _raw field
  maxFileSizeBytes: 20 * 1024 * 1024 // Optional safety cap
});
```

Notes:
- JSONL parsers (Claude/Codex) only enforce `maxFileSizeBytes` when you provide it.
- Gemini JSON parsing defaults to a 50MB cap unless you override `maxFileSizeBytes`.
- `limit` defaults to returning all entries; set it for pagination or very large files.

### Parsing Transcript Metadata

```typescript
import { parseTranscript } from "@agentwatch/parsing";

const transcript = await parseTranscript("/path/to/session.jsonl", "claude", {
  maxFileSizeBytes: 20 * 1024 * 1024
});

console.log(transcript);
// {
//   id: "claude:session-abc",
//   agent: "claude",
//   path: "/path/to/session.jsonl",
//   name: "Help me write a function...",
//   projectDir: "/Users/dev/my-project",
//   entryCount: 45,
//   startTime: 1705312800000,
//   endTime: 1705313400000,
//   stats: {
//     tokens: { input: 5000, output: 2000, cached: 500, total: 7000 },
//     entryTypes: { user: 10, assistant: 10, tool_call: 15, tool_result: 10 },
//     tools: { Read: 5, Write: 3, Bash: 7 },
//     models: { "claude-sonnet-4": 10 },
//     durationMs: 600000
//   }
// }
```

### Scanning Directories

```typescript
import { scanTranscripts, scanAllTranscripts } from "@agentwatch/parsing";

// Scan a single agent's directory
const transcripts = await scanTranscripts("~/.claude/projects", "claude");

// Scan all agent directories
const { transcripts, stats } = await scanAllTranscripts({
  claude: "~/.claude/projects",
  codex: "~/.codex/sessions",
  gemini: "~/.gemini/tmp"
});

console.log(stats);
// { claude: 45, codex: 12, gemini: 3, total: 60 }
```

You can also pass `{ maxFileSizeBytes }` to `scanTranscripts` or `scanAllTranscripts` to cap transcript size during scanning.

### Agent Detection

```typescript
import { detectAgentFromPath, detectAgentFromId, detectAgentFromContent } from "@agentwatch/parsing";

// Detect from file path
detectAgentFromPath("/Users/dev/.claude/projects/foo/session.jsonl"); // "claude"
detectAgentFromPath("/Users/dev/.codex/sessions/2024/01/session.jsonl"); // "codex"

// Detect from transcript ID
detectAgentFromId("claude:session-abc"); // "claude"
detectAgentFromId("codex:2024/01/session"); // "codex"

// Detect from file content (reads first line)
const content = await readFile(filePath, "utf-8");
detectAgentFromContent(content); // "claude" | "codex" | "gemini" | null
```

## Common Use Cases

### Extract Conversation History

```typescript
const { entries } = await parseEntries(transcriptPath, "claude");

const conversation = entries
  .filter(e => e.type === "user" || e.type === "assistant")
  .filter(e => e.text)
  .map(e => ({
    role: e.type,
    content: e.text
  }));
```

### Calculate Token Usage

```typescript
const { entries } = await parseEntries(transcriptPath, "claude");

const totalTokens = entries.reduce((acc, entry) => {
  if (entry.tokens) {
    acc.input += entry.tokens.input ?? 0;
    acc.output += entry.tokens.output ?? 0;
  }
  return acc;
}, { input: 0, output: 0 });

console.log(`Input: ${totalTokens.input}, Output: ${totalTokens.output}`);
```

### List All Tool Calls

```typescript
const { entries } = await parseEntries(transcriptPath, "claude");

const toolCalls = entries
  .filter(e => e.type === "tool_call")
  .map(e => ({
    tool: e.toolName,
    input: e.toolInput,
    id: e.toolCallId
  }));

// Link to results
for (const call of toolCalls) {
  const result = entries.find(
    e => e.type === "tool_result" && e.toolCallId === call.id
  );
  console.log(`${call.tool}: ${result?.text ?? "(no result)"}`);
}
```

### Paginate Large Transcripts

```typescript
const pageSize = 50;
let offset = 0;
let hasMore = true;

while (hasMore) {
  const { entries, total } = await parseClaudeEntries(transcriptPath, {
    offset,
    limit: pageSize
  });

  processEntries(entries);

  offset += pageSize;
  hasMore = offset < total;
}
```

### Track Parsing Errors

```typescript
import { createSchemaLogger, parseClaudeEntries } from "@agentwatch/parsing";

const logger = createSchemaLogger();

const { entries } = await parseClaudeEntries(transcriptPath, {
  schemaLogger: logger
});

// Check for parsing issues
const issues = logger.getIssues();
if (issues.length > 0) {
  console.warn(`Found ${issues.length} parsing issues:`);
  for (const issue of issues) {
    console.warn(`  [${issue.issueType}] ${issue.description}`);
  }
}

// Get aggregated stats
const stats = logger.getStats();
console.log(`Total issues: ${stats.total}`);
console.log(`By type:`, stats.byType);
```

## Types

### Entry Types

```typescript
type EntryType =
  | "user"        // User message
  | "assistant"   // Assistant response
  | "tool_call"   // Tool invocation
  | "tool_result" // Tool output
  | "thinking"    // Reasoning/thinking content
  | "system"      // System metadata
  | "summary"     // Session summary
  | "unknown";    // Unrecognized entry type
```

### Agent Types

```typescript
type AgentType = "claude" | "codex" | "gemini" | "custom";
```

### Token Usage

```typescript
interface TokenUsage {
  input?: number;   // Input tokens
  output?: number;  // Output tokens
  cached?: number;  // Cached tokens
  total?: number;   // Total tokens
}
```

## Limitations

### Entry Count Estimation for Large Files

For transcripts larger than 1MB, the `entryCount` field in `UnifiedTranscript` is estimated from file size rather than counting every line. This estimation assumes average line lengths (~800 bytes for Claude, ~500 bytes for Codex) and may be inaccurate for transcripts with unusually long or short entries (e.g., large tool outputs or minimal content).

To get an exact count, use `parseEntries()` which returns the precise `total`:

```typescript
const { total } = await parseEntries(transcriptPath, "claude", { limit: 0 });
console.log(`Exact entry count: ${total}`);
```

### Pagination Performance

Pagination uses offset-based iteration, meaning accessing page N requires scanning all previous lines. For very large transcripts, later pages may be slower to retrieve. Consider caching parsed entries if you need random access.

## Agent-Specific Notes

### Claude Code

- Stores transcripts as JSONL in `~/.claude/projects/{project-path}/`
- Supports subagents (nested transcripts in `subagents/` directory)
- Entry types include: user, assistant, summary, system, file-history-snapshot
- Assistant messages may contain multiple content blocks (text, tool_use, thinking)

### Codex CLI

- Stores transcripts as JSONL in `~/.codex/sessions/{year}/{month}/{day}/`
- Uses wrapper structure: `{ timestamp, type, payload }`
- Entry types: session_meta, response_item, event_msg, turn_context
- Token counts are in event_msg entries with type "token_count"

### Gemini CLI

- Stores sessions as single JSON files in `~/.gemini/tmp/{project-hash}/chats/`
- Not JSONL - entire session is one JSON object with `messages` array
- Includes thoughts array and toolCalls array per message

## Development

Manual setup and run:

```bash
bun install
bun run typecheck
bun test
bun run build
bun run test:node
bun run test:coverage
```

Coverage output is written to `coverage/lcov.info`. CI enforces 95% line coverage on `src/` (override with `COVERAGE_LINES`).

If you are integrating this into another project, reading the tests is the quickest way to see real-world usage patterns.

## License

MIT
