# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2024-01-19

### Added

- Initial release of @agentwatch/parsing
- Unified transcript parsing for Claude Code, Codex CLI, and Gemini CLI
- `parseEntries()` - Parse transcript entries with pagination support
- `parseTranscript()` - Extract transcript metadata without loading all entries
- `scanTranscripts()` - Scan directories for transcript files
- `scanAllTranscripts()` - Scan multiple agent directories at once
- Agent auto-detection from file paths, transcript IDs, and content
- Schema validation with Zod for all core types
- `SchemaLogger` for tracking parsing issues without failing
- Stats accumulation for token usage, entry types, tools, and models
- Full parsing mode with thinking blocks and tool call extraction
- Support for Claude Code subagents (nested transcripts)
- Efficient large file handling (chunked reading for files >1MB)

### Supported Agents

- **Claude Code** - JSONL format, `~/.claude/projects/`
- **Codex CLI** - JSONL format, `~/.codex/sessions/`
- **Gemini CLI** - JSON format, `~/.gemini/tmp/`
