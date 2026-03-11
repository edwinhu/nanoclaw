---
name: date-safety
description: Date arithmetic safety rules for container agents. Use when creating calendar events, scheduling tasks, computing dates, or any operation involving days of the week. Triggers on 'schedule', 'calendar', 'create event', 'next Friday', 'this week', 'date', 'day of week'.
---

# Date & Time Safety

The container runs in **UTC**. The user is in **America/New_York (ET)**.

## The Iron Law of Dates

**NEVER do mental date arithmetic. This is not negotiable.**

LLMs cannot reliably compute dates, days of the week, or day offsets. Every mental calculation WILL eventually produce wrong dates, wrong events, and angry users.

**Always use the `date` utility:**
1. Get today: `TZ=America/New_York date +"%Y-%m-%d %A"` (includes day-of-week!)
2. Get day of week: `TZ=America/New_York date -d "2026-02-21" +"%A"`
3. Relative dates: `TZ=America/New_York date -d "next Friday" +"%Y-%m-%d %A"`
4. Offsets: `TZ=America/New_York date -d "today + 3 days" +"%Y-%m-%d %A"`
5. **Pre-flight check**: Before ANY calendar create/schedule, run `date -d "<date>" +"%A"` and verify the day matches what the user asked for

## Rationalization Table

| Excuse | Reality | Do Instead |
|---|---|---|
| "I know Feb 21 is a Friday" | You don't. You guessed 16+5=21 and it was Saturday. | Run `date -d "2026-02-21" +"%A"` |
| "It's simple arithmetic" | Date math is NOT simple (month lengths, leap years, day-of-week) | Use `date -d` for ALL calculations |
| "I'll just check afterward" | You won't catch your own error — confirmation bias | Verify BEFORE creating the event |
| "The user said Friday so I'll use the date I computed" | If your date isn't Friday, you computed wrong | Always verify day-of-week matches |
| "Morgen/the tool will catch it" | Tools accept any valid date — they don't check day-of-week intent | YOU must verify before calling the tool |
| "The `--timezone` flag handles the conversion" | Only for plain text output. `--json` always returns UTC regardless of `--timezone`. | Convert with `TZ=America/New_York date -d "2026-02-10T16:00:00Z"` (handles DST automatically) |

## Red Flags — STOP If You Catch Yourself:

- **Counting days in your head** (e.g., "Monday is the 16th, so Friday is 16+4=20") → STOP. Run `date -d "next Friday"`.
- **Assuming a date's day-of-week without running `date`** → STOP. Verify it.
- **A tool returned a different date than you expected** → STOP. Re-derive from scratch using `date`. Don't ignore the discrepancy.
- **About to create a calendar event without verifying the date** → STOP. Run the pre-flight check first.
- **Morgen `--json` returned a time and you are treating it as ET** → STOP. JSON is always UTC. Convert with `TZ=America/New_York date -d "<utc_time>"`.

**Claiming a date is correct without running `date` to verify is LYING to the user.**
