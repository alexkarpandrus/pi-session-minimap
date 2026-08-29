# pi-session-minimap

**Stay oriented in long-running [pi](https://pi.dev) sessions.**

`pi-session-minimap` turns a long agent transcript into a live semantic map. It keeps the current goal, prior goals, context pressure, cost, tool activity, and failures visible without taking focus from the editor.

## Screenshots

### Compact view

![Compact pi session minimap showing the current goal, context history, session cost, and completed goals](https://raw.githubusercontent.com/alexkarpandrus/pi-session-minimap/main/assets/compact.png)

### Expanded dashboard

![Expanded pi session minimap showing semantic history, context resets, cost, tool activity, failure analysis, and decisions](https://raw.githubusercontent.com/alexkarpandrus/pi-session-minimap/main/assets/expanded.png)

## Why

Long sessions make it hard to answer basic questions:

- What is the agent working on now?
- Which goals are complete?
- How close is the context window to overflow?
- Where did the time, tokens, and cost go?
- Which failures recovered, and which still need attention?

The minimap answers these questions in a glanceable, non-capturing pane.

## Views

**Compact view** keeps the current semantic goal, session totals, context state, and recent history beside the conversation.

**Expanded view** adds a five-column timeline, nested tool tokens, invoked skill totals, failure analysis, and up to three consequential decisions.

Both views show:

- input/output tokens, cost, and context-window usage
- agent and minimap-summary token spend
- tool calls, compactions, overflow, and categorized errors
- semantic steps that can be renamed or merged as recent work develops

## Install

```bash
pi install npm:pi-session-minimap
```

Or run it directly from this checkout:

```bash
pi -e ./extensions/minimap.ts
```

## Controls

| Action | Key |
| --- | --- |
| Hide or show | `/minimap` |
| Switch compact/expanded | `Ctrl+Shift+M` |
| Scroll up | `Ctrl+Shift+K` |
| Scroll down | `Ctrl+Shift+J` |

`↻` marks compaction. `▲` marks overflow.

The compact pane opens automatically in interactive terminals that are at least 110 columns wide.

## Semantic history

Related follow-ups, questions, retries, and refinements stay in one milestone. A new step starts when the deliverable or phase changes materially, even within the same project.

After each settled run, the extension re-reviews the latest five completed steps, the open step, and the new activity. It can rename or merge adjacent steps while older history stays fixed. Revised step metrics are recomputed from their original session entries.

The extension uses the currently selected model, stores compact revision metadata in the pi session file, and never takes terminal focus.

## Development

```bash
npm install
npm run check
```

MIT licensed.
