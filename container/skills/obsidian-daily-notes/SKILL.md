---
name: obsidian-daily-notes
description: Take daily notes in Obsidian. Edit vault files directly — no Obsidian desktop needed. Use when user asks to add to daily note, create a daily note, or work with today's note.
---

# Obsidian Daily Notes (Container)

## Add to Today's Daily Note

```bash
TODAY=$(date +%Y-%m-%d)
NOTE="/workspace/extra/Notes/Vault/3. Resources/Daily Notes/${TODAY}.md"
```

1. **Read the note** to see current content and find the right section
2. **Edit the note** with the Edit tool to append content under the appropriate section

If the note doesn't exist yet, create it with the template:

```bash
cat > "$NOTE" << 'EOF'
# To-Dos

# Reading

# Meetings

# Work

EOF
```

## Template Sections

- `# To-Dos` - Task items
- `# Reading` - Reading notes
- `# Meetings` - Meeting notes
- `# Work` - Work logs and project notes

## Key Details

- Vault path: `/workspace/extra/Notes/Vault`
- Daily notes path: `3. Resources/Daily Notes/`
- File naming: `YYYY-MM-DD.md` (e.g., `2026-02-09.md`)
- Edit files directly; Obsidian picks up changes automatically
