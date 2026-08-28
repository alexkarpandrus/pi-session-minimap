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
- append-only semantic steps that span related follow-ups and retries
- display-only recovery for sessions created before the extension was installed

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

`↻` marks compaction. `▲` marks overflow. `≈` marks recovered legacy history.

The compact pane opens automatically in interactive terminals that are at least 110 columns wide.

## Semantic history

Related follow-ups, questions, retries, and refinements stay in one broad semantic step. Only an unrelated objective closes the step and opens another.

Completed steps are append-only. The open step is checkpointed for resume. Later factual title corrections are stored as overlays, so the original history stays unchanged.

The extension re-evaluates the map when each agent run becomes idle and again when the agent fully settles. It uses the currently selected model to classify semantic boundaries, stores compact metadata in the pi session file, and never takes terminal focus.

## Development

```bash
npm install
npm run check
```

MIT licensed.
