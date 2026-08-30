<p align="center">
  <img src="https://raw.githubusercontent.com/alexkarpandrus/pi-session-minimap/main/assets/logo.svg" width="112" alt="pi-session-minimap logo">
</p>

<h1 align="center">pi-session-minimap</h1>

<p align="center"><strong>Never lose the plot in a long pi session.</strong></p>

<p align="center">
  <a href="https://github.com/alexkarpandrus/pi-session-minimap/actions/workflows/ci.yml"><img src="https://github.com/alexkarpandrus/pi-session-minimap/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-667eea" alt="MIT license"></a>
  <a href="https://pi.dev/packages"><img src="https://img.shields.io/badge/pi-package-cad3f5" alt="pi package"></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/alexkarpandrus/pi-session-minimap/main/assets/overview.png" alt="Compact pi session minimap beside the expanded dashboard, showing semantic goals, context pressure, cost, tool activity, failure recovery, decisions, and compaction history">
</p>

`pi-session-minimap` turns a long [pi](https://pi.dev) transcript into a live semantic map. See the current goal, completed milestones, context pressure, cost, tool activity, and failures without leaving the conversation.

## Install

```bash
pi install npm:pi-session-minimap
```

The compact pane opens automatically in interactive terminals at least 110 columns wide. Use `/minimap` to show or hide it at any time.

## What you get

- **Semantic milestones** instead of a wall of turns
- **Live context pressure** with compaction and overflow markers
- **Token and cost totals** for the session, agent, and minimap
- **Tool, skill, and failure diagnostics** with recovered errors separated
- **Compact and expanded views** that never take terminal focus

## Two views

### Compact

The current goal, session totals, context state, and recent history stay beside the conversation.

<p align="center">
  <img src="https://raw.githubusercontent.com/alexkarpandrus/pi-session-minimap/main/assets/compact.png" width="600" alt="Compact pi session minimap showing the current goal, context history, session cost, and completed goals">
</p>

### Expanded

The dashboard adds a five-column timeline, nested tool tokens, invoked skill totals, failure analysis, and up to three consequential decisions.


<p align="center">
  <img src="https://raw.githubusercontent.com/alexkarpandrus/pi-session-minimap/main/assets/expanded.png" alt="Expanded pi session minimap showing semantic history, context resets, cost, tool activity, failure analysis, and decisions">
</p>

## Controls

| Action | Key |
| --- | --- |
| Hide or show | `/minimap` |
| Switch compact/expanded | `Ctrl+Shift+M` |
| Scroll up | `Ctrl+Shift+K` |
| Scroll down | `Ctrl+Shift+J` |

`↻` marks compaction. `▲` marks overflow.

## How semantic history works

Related follow-ups, retries, and refinements stay in one milestone. A new milestone starts when the deliverable or phase changes materially.

After each settled run, the extension re-reviews the latest five completed milestones, the open milestone, and the new activity. It can rename or merge adjacent milestones while older history stays fixed. Revised metrics are recomputed from their original session entries.

The extension uses your selected pi model and stores compact revision metadata in the pi session file. It needs no separate account or API key. Its summary calls use tokens from your active model provider; the minimap reports that spend separately.

## Try from source

```bash
git clone https://github.com/alexkarpandrus/pi-session-minimap.git
cd pi-session-minimap
npm install
npm run check
pi -e ./extensions/minimap.ts
```

## Development

`npm run check` runs strict TypeScript checks and model-free prompt-evaluator tests. Known-good outputs must pass, and negative controls must fail for source IDs, grouping, title length, rejected approaches, and decisions.

<details>
<summary>Run the opt-in live prompt evaluation</summary>

Load the API key without putting it in shell history:

```bash
read -rsp "OpenAI API key: " OPENAI_API_KEY && export OPENAI_API_KEY
echo
EVAL_ATTEMPTS=3 npm run eval:prompt
unset OPENAI_API_KEY
```

Each attempt makes six paid API calls with `gpt-4o-mini`. `EVAL_ATTEMPTS` accepts 1–5 and defaults to 1. Set `OPENAI_MODEL` to test another model.

</details>

## License

[MIT](LICENSE) © pi-session-minimap contributors
