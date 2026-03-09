---
name: companion-launch
description: This skill should be used when the user asks to "launch companion", "start companion session", "companion with dev-debug", "companion with workflows skill", "run in companion", or needs to launch a long-running task in a companion session with proper validation and formatting.
version: 1.0.0
---

# Companion Launch

Launch a Claude Code companion session with proper validation and workflows skill invocation formatting.

<EXTREMELY-IMPORTANT>
## The Iron Law of Workflows Skill Invocation

**NEVER launch a companion for a workflows task without explicit Skill tool syntax. This is not negotiable.**

If the task requires a workflows skill (dev, dev-debug, ds, nlm, etc.), the companion prompt MUST include the exact Skill tool call:

```
Skill(skill="workflows:skill-name")
```

Narrative instructions like "Use the dev-debug skill" or "Invoke dev" are IGNORED. The companion has no conversation context and won't know to use the Skill tool unless you provide the exact syntax.

**Launching a companion without Skill tool syntax when workflows skills are needed is LYING to the user about what the companion will do.**
</EXTREMELY-IMPORTANT>

## Rationalization Table

| Excuse | Reality | Do Instead |
|---|---|---|
| "The companion is smart, it'll figure out to use Skill tool" | The companion has zero conversation context. It won't infer tool usage from narrative. | Provide explicit Skill tool syntax in the prompt. |
| "I'll just say 'use dev-debug' and it'll work" | Narrative instructions are ignored. The companion will try to do the work directly. | Write out the complete Skill(skill="workflows:...") call. |
| "This is a small fix, doesn't need a workflows skill" | If you mentioned a workflows skill, the user expects it used. | Either use the skill properly or explain why it's not needed. |
| "I can use container paths, companion will resolve them" | Companion runs on host with NO access to container filesystem. | Convert all paths to host paths (/Users/...). |
| "The task is self-explanatory from context" | Companion has ZERO conversation history. All context must be in prompt. | Include all relevant details in the prompt itself. |

## Red Flags - STOP If You Catch Yourself:

- **About to call launch_companion with "use workflows:dev-debug" in narrative text** -> STOP. Add explicit Skill tool syntax.
- **Using /workspace/ or relative paths in companion prompt** -> STOP. Convert to host paths (/Users/...).
- **Referencing "our conversation" or "the file we discussed"** -> STOP. Include full context in prompt.
- **User mentioned a workflows skill but your prompt doesn't have Skill(...) syntax** -> STOP. Add the Skill tool invocation.
- **About to launch without verifying project_dir is a host path** -> STOP. Check it starts with /Users/.

## Gate: Pre-Launch Validation

**Before calling launch_companion, verify ALL of these:**

1. **CHECK project_dir**: Does it start with `/Users/`? (Must be host path, NOT `/workspace/`)
2. **CHECK context**: Does the prompt contain ALL necessary details? (No "as we discussed", "the file mentioned earlier")
3. **CHECK paths**: Are ALL file paths in the prompt host paths? (No `/workspace/`, no relative paths)
4. **CHECK workflows skill syntax**: If task needs workflows skill, does prompt have explicit `Skill(skill="workflows:...")`?
5. **VERIFY**: Read the prompt aloud. Would someone with ZERO context understand the task?

**If ANY check fails, STOP and fix before launching.**

## Workflow

### Step 1: Parse User Request

Extract:
- **Task description**: What should the companion do?
- **Workflows skill** (if any): dev, dev-debug, ds, nlm, etc.
- **Project directory**: Which host project folder?
- **Model preference**: opus (default), sonnet, haiku

### Step 2: Format Prompt

**If NO workflows skill needed:**
```
[Full task description with all context]

When complete, run `/exit` to end the session.
```

**If workflows skill needed:**
```
Skill(skill="workflows:[skill-name]")

[Any additional context the skill needs]

When complete, run `/exit` to end the session.
```

**CRITICAL**: The Skill tool syntax MUST be verbatim in the prompt. Don't paraphrase. Don't say "invoke the skill". Show the exact tool call.

### Step 3: Verify Host Paths

**Common mappings:**
- Container: `/workspace/group/` -> Host: `/Users/vwh7mb/projects/nanoclaw/groups/main/`
- Container: `/workspace/project/` -> Host: `/Users/vwh7mb/projects/nanoclaw/`
- Container: `/workspace/extra/projects/workflows/` -> Host: `/Users/vwh7mb/projects/workflows/`
- Container: `/workspace/extra/projects/nlm/` -> Host: `/Users/vwh7mb/projects/nlm/`

If you're unsure of the mapping, ASK THE USER for the correct host path.

### Step 4: Run Gate Validation

Execute the 5-step gate check from above. If any check fails, fix it before proceeding.

### Step 5: Launch Companion

```
launch_companion(
  prompt: [formatted prompt with Skill syntax if needed],
  project_dir: [host path],
  task_title: [short description],
  model: [opus/sonnet/haiku]
)
```

### Step 6: Report Launch

```
Companion launched: "[task title]"
Session: [session-id]
Project: [project_dir]
Model: [model]

Monitor: https://mac-vwh7mb-pro.tailc143b.ts.net
```

## Honesty Framing

**Claiming you launched a companion with workflows skill support when you only provided narrative instructions is FRAUD.**

The companion will attempt the task directly instead of using the specialized skill. This produces lower-quality results and wastes the user's time.

## Common Workflows Skills

| Skill | Usage | Use For |
|-------|-------|---------|
| dev | `Skill(skill="workflows:dev")` | Full 7-phase feature development with TDD |
| dev-debug | `Skill(skill="workflows:dev-debug")` | Debug and fix bugs systematically |
| ds | `Skill(skill="workflows:ds")` | Data science analysis workflow |
| ds-fix | `Skill(skill="workflows:ds-fix")` | Fix wrong results in data analysis |
| writing | `Skill(skill="workflows:writing")` | Start writing workflow |
| writing-review | `Skill(skill="workflows:writing-review")` | Review writing structure |
| writing-revise | `Skill(skill="workflows:writing-revise")` | Revise and polish writing |
| nlm | `Skill(skill="workflows:nlm")` | NotebookLM operations reference |

## Examples

### Example 1: Simple task, no workflows skill

**User:** "Launch companion to refactor the auth module"

**Prompt:**
```
Refactor the authentication module in /Users/vwh7mb/projects/nanoclaw/src/auth/ to use JWT tokens instead of session cookies.

Requirements:
- Replace session-based auth with JWT
- Update all API endpoints to use Bearer token authentication
- Maintain backward compatibility for existing sessions during migration
- Add tests for JWT token generation and validation

When complete, run `/exit` to end the session.
```

### Example 2: Task requiring workflows skill

**User:** "Launch companion with dev-debug to fix the nlm share command"

**Prompt:**
```
Skill(skill="workflows:dev-debug")

Debug and fix the `nlm share` and `nlm share-private` commands in the nlm CLI located at /Users/vwh7mb/projects/nlm.

## Problem
Both commands fail with "unexpected end of JSON input" error:
- nlm share <notebook-id>
- nlm share-private <notebook-id>

## Context
- Other nlm commands work fine (list, create, add)
- Authentication is valid
- Go-based CLI

## Expected Outcome
- Both share commands return valid share URLs
- No JSON parsing errors
- Error handling added for malformed responses

When complete, run `/exit` to end the session.
```

## No Pause Between Steps

After validating the prompt and paths, IMMEDIATELY call launch_companion. Do NOT:
- Ask "should I proceed?"
- Summarize what you're about to do
- Wait for confirmation

The user asked you to launch the companion. Launch it. Report the session ID afterward.
