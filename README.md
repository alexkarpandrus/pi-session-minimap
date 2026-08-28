# pi-session-minimap

A non-capturing side pane for [pi](https://pi.dev). It shows:

- the current semantic goal and append-only goal history
- input/output tokens, cost, and context-window usage
- agent and minimap-summary token spend
- tool calls, invoked skills, resets, nested tool tokens, and errors
- context growth, compactions, and overflow

Related follow-ups, questions, retries, and refinements stay in one broad semantic step. Only an unrelated objective closes the step and opens another.

Completed steps are append-only. The open step is checkpointed for resume. Later factual title corrections are stored as overlays, so the original history stays unchanged.

Legacy sessions recover display-only steps from compaction boundaries. Recovered steps are marked `≈`. The dashboard condenses consequential decisions and skill invocation totals.

## Install

```bash
pi install npm:pi-session-minimap
```

Or try the extension directly from this checkout:

```bash
pi -e ./extensions/minimap.ts
```

## Use

- Use `/minimap` to hide or show the pane.
- Press `Ctrl+Shift+M` to switch between compact and expanded views.
- Scroll with `Ctrl+Shift+K` and `Ctrl+Shift+J`.
- `↻` marks compaction. `▲` marks overflow.

The compact view shows the current goal first. Session totals and recent history follow it. The expanded dashboard adds the five-column timeline, nested tool tokens, skill totals, failure analysis, and up to three recent decisions.

The compact pane opens automatically in interactive terminals that are at least 110 columns wide.

## Development

```bash
npm install
npm run check
```
