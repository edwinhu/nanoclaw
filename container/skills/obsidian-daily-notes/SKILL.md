---
name: obsidian-daily-notes
description: Take daily notes in Obsidian. Use when user asks to add to daily note, create a daily note, or work with today's note.
---

# Obsidian Daily Notes (Container)

## Read Today's Daily Note

```bash
obsidian vault=Vault daily:read
```

## Add to Today's Daily Note

```bash
# Append content
obsidian vault=Vault daily:append content="- New item under last section"

# Prepend content
obsidian vault=Vault daily:prepend content="# Morning Notes"
```

## Edit Specific Sections

For targeted edits (inserting under a specific heading), read then edit the file directly:

```bash
TODAY=$(date +%Y-%m-%d)
NOTE="/workspace/extra/Notes/Vault/3. Resources/Daily Notes/${TODAY}.md"
```

1. **Read the note** with the Read tool
2. **Edit** with the Edit tool to insert content under the right section

## Template Sections

- `# To-Dos` - Task items
- `# Reading` - Reading notes
- `# Meetings` - Meeting notes
- `# Work` - Work logs and project notes

## Key Details

- Vault path: `/workspace/extra/Notes/Vault`
- Daily notes path: `3. Resources/Daily Notes/`
- File naming: `YYYY-MM-DD.md` (e.g., `2026-02-11.md`)
- Obsidian picks up file changes automatically
