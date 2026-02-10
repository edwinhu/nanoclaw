---
name: obsidian
description: Work with Obsidian vaults (plain Markdown notes). Use when user asks about notes, vaults, or Obsidian. Vaults are mounted at /workspace/extra/Notes/.
---

# Obsidian (Container)

Obsidian vaults are plain Markdown folders mounted from the host.

## Vault Locations

| Vault | Container Path |
|-------|---------------|
| **Vault** (main) | `/workspace/extra/Notes/Vault` |
| **Writing** | `/workspace/extra/Notes/Writing` |

## Working with Notes

**Always edit files directly** with Read/Edit tools. Obsidian picks up changes automatically.

Do NOT use `obsidian-cli` commands that require Obsidian desktop (create, open, daily) — Obsidian is not installed in the container. The CLI search commands work fine.

### Search

```bash
# Search note names (fuzzy)
obsidian-cli search "query" --vault-path /workspace/extra/Notes/Vault

# Search inside notes (content)
obsidian-cli search-content "query" --vault-path /workspace/extra/Notes/Vault

# Or just use rg/fd directly on the vault folder
rg "search term" /workspace/extra/Notes/Vault/
fd "note name" /workspace/extra/Notes/Vault/
```

### Read & Edit

```bash
# Read a note
cat "/workspace/extra/Notes/Vault/path/to/note.md"

# Or use Read/Edit tools (preferred)
```

### Create Notes

Create files directly — no CLI needed:

```bash
# Create a new note
cat > "/workspace/extra/Notes/Vault/1. Projects/New Note.md" << 'EOF'
# New Note

Content here...
EOF
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

## Daily Notes

Path: `/workspace/extra/Notes/Vault/3. Resources/Daily Notes/YYYY-MM-DD.md`

Template sections:
- `# To-Dos`
- `# Reading`
- `# Meetings`
- `# Work`

To add to today's daily note:

```bash
# Get today's date
TODAY=$(date +%Y-%m-%d)
NOTE="/workspace/extra/Notes/Vault/3. Resources/Daily Notes/${TODAY}.md"

# Create if it doesn't exist (with template)
if [ ! -f "$NOTE" ]; then
  cat > "$NOTE" << 'EOF'
# To-Dos

# Reading

# Meetings

# Work

EOF
fi

# Then use Read/Edit tools to modify
```
