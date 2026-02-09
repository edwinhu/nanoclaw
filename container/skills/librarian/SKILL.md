---
name: librarian
description: This skill should be used when the user asks to "search my notes", "find highlights", "check NotebookLM", "search Readwise", "what did I read about", "find in my library", "add to notebook", "create audio overview", "research a topic", "summarize my reading on", "what are my highlights about", or needs to search the user's personal knowledge library (NotebookLM, Readwise).
allowed-tools: Bash(nlm:*), Bash(python3:*), Bash(curl:*), Read, Write
---

# Librarian - Personal Knowledge Library

Search and manage the user's personal knowledge library across NotebookLM and Readwise.

## Search Order (MANDATORY)

Always follow this order. Never skip NLM.

1. **NLM first** (curated knowledge — notebooks with sources, notes, audio)
2. **Readwise second** (raw highlights and saved articles)
3. **Add to NLM** (curate findings for future use)

## NLM (NotebookLM CLI)

The `nlm` binary is available at `/usr/local/bin/nlm`. Auth is at `~/.nlm/env`.

```bash
# List all notebooks (use --json for parseable output)
nlm --json list

# Chat with a notebook (interactive Q&A against its sources)
nlm chat <notebook-id>

# Generate content from a notebook
nlm generate-chat <notebook-id> "What are the key findings?"
nlm summary <notebook-id> <source-id>
nlm study-guide <notebook-id> <source-id>
nlm faq <notebook-id> <source-id>
nlm briefing-doc <notebook-id> <source-id>
nlm outline <notebook-id> <source-id>
nlm timeline <notebook-id> <source-id>
nlm mindmap <notebook-id> <source-id>

# Add sources to a notebook
nlm add <notebook-id> <url>           # Add URL
nlm add <notebook-id> <file-path>     # Add local file
echo "content" | nlm add <notebook-id> -  # Add from stdin

# Research (auto-imports web sources)
nlm research "topic" --notebook <notebook-id>
nlm research "topic" --notebook <notebook-id> --deep

# Audio overviews
nlm audio-create <notebook-id> "Focus on X"
nlm audio-download <notebook-id>

# Source management (use --json for parseable output)
nlm --json sources <notebook-id>
nlm source-rename <notebook-id> <source-id> "New Title"
```

## Readwise

Two access methods, depending on what you need:

### Highlight Search (semantic/keyword)

Use the Readwise API directly with `$READWISE_TOKEN`:

```bash
# Search highlights by keyword
curl -s -H "Authorization: Token $READWISE_TOKEN" \
  "https://readwise.io/api/v3/highlights/?search=proxy+advisors&page_size=20" | jq '.results[] | {text: .text, title: .book.title, author: .book.author}'

# Get highlights from a specific book/article
curl -s -H "Authorization: Token $READWISE_TOKEN" \
  "https://readwise.io/api/v3/highlights/?book_id=<id>&page_size=50" | jq '.results[].text'

# List books/articles
curl -s -H "Authorization: Token $READWISE_TOKEN" \
  "https://readwise.io/api/v3/books/?search=<query>" | jq '.results[] | {id, title, author, category}'
```

### Full Document Retrieval (by tag)

Use the Readwise-to-NLM script to fetch full article text and add to a notebook:

```bash
# Preview what would be added (dry run)
python3 /home/node/.claude/skills/readwise/scripts/readwise_to_nlm.py \
  --tag "proxy advisors" \
  --notebook <notebook-id> \
  --dry-run

# Fetch and add documents by tag
python3 /home/node/.claude/skills/readwise/scripts/readwise_to_nlm.py \
  --tag "proxy advisors" \
  --notebook <notebook-id>

# Multiple tags (deduplicates)
python3 /home/node/.claude/skills/readwise/scripts/readwise_to_nlm.py \
  --tag "Corps" --tag "proxy" \
  --notebook <notebook-id>
```

## Common Workflows

### "What do I know about X?"

```bash
# 1. Check NLM notebooks first
nlm --json list
nlm generate-chat <relevant-notebook-id> "What do I know about X?"

# 2. If not in NLM, search Readwise highlights
curl -s -H "Authorization: Token $READWISE_TOKEN" \
  "https://readwise.io/api/v3/highlights/?search=X&page_size=20" | jq '.results[] | {text, title: .book.title}'
```

### "Add my reading on X to a notebook"

```bash
# Find or create notebook
nlm list
# Then fetch tagged articles and add
python3 /home/node/.claude/skills/readwise/scripts/readwise_to_nlm.py \
  --tag "X" --notebook <id>
```

### "Create an audio overview of X"

```bash
nlm list  # Find the notebook
nlm audio-create <notebook-id> "Focus on key arguments about X"
nlm audio-download <notebook-id>
```

### Deep Research

```bash
# Uses NLM's built-in research tool (searches web, adds to notebook)
nlm research "topic" --notebook <notebook-id> --deep
```
