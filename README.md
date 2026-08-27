# pi-session-minimap

A non-capturing side pane for [pi](https://pi.dev) that shows:

- input/output tokens, cost, and context-window usage
- agent vs minimap-summary token spend
- tool-call counts, skill invocation counts, reset totals, nested tool token usage, and categorized errors
- append-only semantic steps that can span multiple user messages
- context growth and reset events, invoked skills, and agent-chosen directions for each semantic step
- an early readable label for current work

Each settled run is compared with the open semantic step. Follow-ups, questions, retries, added requirements, and visual refinements extend that broad task thread; only an unrelated objective closes it and opens another. Completed steps are append-only, while the open step is checkpointed for resume. When later evidence proves a settled title wrong, the semantic model appends a correction that is overlaid at display time, preserving the original history. Older steps without saved context snapshots are displayed with context inferred from their final assistant response. Sessions that predate minimap history recover display-only steps from compaction boundaries without rewriting the session. Recovered steps are marked `≈`; every card renders context, resets, decisions, then skills in the same order.

## Install

```bash
pi install npm:pi-session-minimap
```

Or try the extension directly from this checkout:

```bash
pi -e ./extensions/minimap.ts
```

Use `/minimap` to hide or show the pane. The compact pane puts the current semantic goal first, followed by scoped settled totals, recent semantic history, context ranges, and reset counts. `↻` marks context compactions in both views; `▲` additionally marks overflow. Press `Ctrl+Shift+M` for a content-sized dashboard that prioritizes the current goal and five-column timeline, then shows one condensed session line, an attention banner for unresolved failure streaks, a failure postmortem grouped by run, tool, type, and repeated pattern, and recent consequential decisions. Scroll either view with `Ctrl+Shift+K` and `Ctrl+Shift+J`. The compact pane appears automatically in interactive mode when the terminal is at least 110 columns wide.

## Development

```bash
npm install
npm run check
```
