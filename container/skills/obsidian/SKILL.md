---
name: obsidian
description: Work with Obsidian vaults (plain Markdown notes). Use when user asks about notes, vaults, or Obsidian. Vaults are mounted at /workspace/extra/Notes/.
allowed-tools: Bash(obsidian:*)
---

# Obsidian (Container)

Obsidian vaults are mounted from the host as plain Markdown folders. The `obsidian` CLI proxies to the host's native Obsidian app for search, metadata, and daily notes.

## Vault Locations

| Vault | Container Path | CLI Name |
|-------|---------------|----------|
| **Vault** (main) | `/workspace/extra/Notes/Vault` | `Vault` |
| **Writing** | `/workspace/extra/Notes/Writing` | `Writing` |

## CLI Commands

The `obsidian` binary talks to the host Obsidian app via HTTP proxy. Always specify `vault=Vault` (or `vault=Writing`).

### Search

```bash
# Full-text search (uses Obsidian's index — fast, respects aliases)
obsidian vault=Vault search query="term" limit=20

# Search with match context
obsidian vault=Vault search query="term" matches

# Or use rg/fd directly on the vault folder (content grep, file find)
rg "search term" /workspace/extra/Notes/Vault/
fd "note name" /workspace/extra/Notes/Vault/
```

### Read & Write

```bash
# Read a note via CLI (resolves Obsidian links/aliases)
obsidian vault=Vault read file="Note Name"
obsidian vault=Vault read path="1. Projects/Research/Topic.md"

# Or use Read/Edit tools directly (preferred for editing)
# Files at /workspace/extra/Notes/Vault/...
```

### Daily Notes

```bash
# Read today's daily note
obsidian vault=Vault daily:read

# Append to daily note
obsidian vault=Vault daily:append content="- New item"

# Prepend to daily note
obsidian vault=Vault daily:prepend content="# Morning Notes"
```

### Metadata & Structure

```bash
# List all files
obsidian vault=Vault files
obsidian vault=Vault files folder="1. Projects"

# Tags
obsidian vault=Vault tags
obsidian vault=Vault tags file="Note Name"

# Tasks
obsidian vault=Vault tasks
obsidian vault=Vault tasks todo          # Only incomplete tasks
obsidian vault=Vault tasks done          # Only completed tasks
obsidian vault=Vault tasks daily         # Tasks in today's daily note

# Links and backlinks
obsidian vault=Vault links file="Note"
obsidian vault=Vault backlinks file="Note"

# Properties (YAML frontmatter)
obsidian vault=Vault properties file="Note"
obsidian vault=Vault property:read name="status" file="Note"
obsidian vault=Vault property:set name="status" value="done" file="Note"

# File info
obsidian vault=Vault file file="Note"
obsidian vault=Vault outline file="Note"
obsidian vault=Vault wordcount file="Note"
```

### Create & Modify

```bash
# Create a new note
obsidian vault=Vault create name="New Note" path="1. Projects/" content="# Title"

# Create from template
obsidian vault=Vault create name="New Note" template="Meeting Notes"

# Append/prepend to any file
obsidian vault=Vault append file="Note" content="New content"
obsidian vault=Vault prepend file="Note" content="Top content"

# Move/rename
obsidian vault=Vault move file="Old Name" to="2. Areas/New Name.md"
```

## Vault Structure (PARA Method)

```
Vault/
├── 0. Boards/
├── 1. Projects/
├── 2. Areas/
├── 3. Resources/
│   ├── Daily Notes/     ← YYYY-MM-DD.md
│   └── Templates/
└── 4. Archive/
```

## Tips

- **Editing**: Always use Read/Edit tools for file modifications — Obsidian picks up changes automatically
- **Searching content**: `rg` on the vault folder is fastest for grep-style content search
- **Searching notes**: `obsidian vault=Vault search` uses Obsidian's index (respects aliases, links)
- **Daily notes**: `daily:read` and `daily:append` are the most common operations
