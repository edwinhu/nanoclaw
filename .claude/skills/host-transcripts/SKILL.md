---
name: host-transcripts
description: Search host Claude Code session transcripts. Use when user asks 'what did we work on', 'find that session where', 'search past sessions', 'recent Claude sessions', or needs to find context from previous Claude Code work on the host machine.
---

# Host Claude Code Transcripts

The host's `~/.claude` is mounted at `/workspace/extra/claude-config` (readonly). This contains Claude Code session transcripts from ALL projects on the host machine — not just NanoClaw.

## Finding Sessions

**Session indexes**: `/workspace/extra/claude-config/projects/*/sessions-index.json`

Each entry has: `sessionId`, `summary`, `modified`, `projectPath`, `gitBranch`

**Transcript files**: `/workspace/extra/claude-config/projects/*/<sessionId>.jsonl`

To find recent sessions across all projects:
```bash
find /workspace/extra/claude-config/projects/ -name "sessions-index.json" -exec cat {} \; | jq -s '[.[].entries[] | select(.modified > "YYYY-MM-DD")] | sort_by(.modified) | reverse'
```

**Note**: `/home/node/.claude` is the container's own session data — NOT the host transcripts.
