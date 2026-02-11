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

The `nlm` binary is at `/usr/local/bin/nlm`. Auth is at `~/.nlm/env`.

### Notebook Commands

```bash
nlm list                              # List all notebooks (alias: ls)
nlm --json list                       # JSON output for parsing
nlm create "Title"                    # Create a new notebook
nlm rm <notebook-id>                  # Delete a notebook
nlm analytics <notebook-id>           # Show notebook analytics
```

### Source Commands

```bash
nlm sources <notebook-id>             # List sources
nlm --json sources <notebook-id>      # JSON output
nlm add <notebook-id> <url>           # Add URL source
nlm add <notebook-id> <file-path>     # Add local file (PDF, etc.)
nlm add <notebook-id> <youtube-url>   # Add YouTube video
echo "text" | nlm add <notebook-id> - # Add from stdin
cat data.json | nlm add <notebook-id> - -mime="application/json"  # Stdin with MIME type
nlm rename-source <source-id> "New Title"
nlm rm-source <notebook-id> <source-id>
nlm refresh-source <source-id>        # Refresh source content
nlm check-source <source-id>          # Check source freshness
```

### Note Commands

```bash
nlm notes <notebook-id>               # List notes
nlm new-note <notebook-id> "Title"    # Create note
nlm edit-note <notebook-id> <note-id> "Content"  # Edit note
nlm rm-note <note-id>                 # Remove note
```

### Chat & Generation

```bash
nlm generate-chat <notebook-id> "What are the key findings?"  # One-shot Q&A
nlm chat <notebook-id>                # Interactive chat session
nlm generate-guide <notebook-id>      # Short summary guide
nlm generate-outline <notebook-id>    # Comprehensive outline
nlm generate-section <notebook-id>    # New content section
nlm generate-magic <notebook-id> <source-id-1> <source-id-2>  # Cross-source synthesis
```

### Content Transformation

All take `<notebook-id> <source-ids...>`:

```bash
nlm summarize <id> <source-id>        # Summarize
nlm study-guide <id> <source-id>      # Study guide with questions
nlm faq <id> <source-id>              # FAQ
nlm briefing-doc <id> <source-id>     # Briefing document
nlm outline <id> <source-id>          # Structured outline
nlm timeline <id> <source-id>         # Timeline of events
nlm mindmap <id> <source-id>          # Text-based mindmap
nlm toc <id> <source-id>              # Table of contents
nlm explain <id> <source-id>          # Explain concepts
nlm critique <id> <source-id>         # Critique content
nlm brainstorm <id> <source-id>       # Brainstorm ideas
nlm expand <id> <source-id>           # Expand with detail
nlm rephrase <id> <source-id>         # Rephrase
nlm verify <id> <source-id>           # Verify facts
```

### Audio Overviews

```bash
nlm audio-create <notebook-id> "Focus on X"  # Create audio
nlm audio-get <notebook-id>           # Get status/content
nlm audio-share <notebook-id>         # Share (private)
nlm audio-share <notebook-id> --public # Share (public)
nlm audio-rm <notebook-id>            # Delete audio
```

### Research

```bash
nlm research --notebook <id> "topic"           # Web research + auto-import
nlm research --notebook <id> --deep "topic"    # Deep research mode
nlm research --notebook <id> --source drive "topic"  # Search Google Drive
```

### Batch Mode

```bash
nlm batch "create 'Research'" "add NOTEBOOK_ID https://example.com" "add NOTEBOOK_ID paper.pdf"
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
nlm audio-get <notebook-id>  # Check status
```

### Deep Research

```bash
# Web research (searches web, adds sources to notebook)
nlm research --notebook <notebook-id> --deep "topic"

# Drive research (searches Google Drive)
nlm research --notebook <notebook-id> --source drive "topic"
```
