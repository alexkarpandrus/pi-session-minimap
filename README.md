<p align="center">
  <img src="https://raw.githubusercontent.com/alexkarpandrus/pi-session-minimap/main/assets/logo.svg" width="112" alt="pi-session-minimap logo">
</p>

<h1 align="center">pi-session-minimap</h1>

<p align="center"><strong>A live minimap for long pi sessions.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-session-minimap"><img src="https://img.shields.io/npm/v/pi-session-minimap?color=8bd5ca" alt="npm version"></a>
  <a href="https://github.com/alexkarpandrus/pi-session-minimap/actions/workflows/ci.yml"><img src="https://github.com/alexkarpandrus/pi-session-minimap/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-667eea" alt="MIT license"></a>
  <a href="https://pi.dev/packages/pi-session-minimap"><img src="https://img.shields.io/badge/pi-package-cad3f5" alt="pi package"></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/alexkarpandrus/pi-session-minimap/main/assets/demo.gif" alt="pi-session-minimap switching from the compact session pane to the expanded diagnostics dashboard">
</p>

`pi-session-minimap` keeps the current task, completed steps, context use, cost, tools, and failures visible beside a long [pi](https://pi.dev) session.

## Install

```bash
pi install npm:pi-session-minimap
```

The compact pane opens automatically in interactive terminals at least 110 columns wide. Start a new session or run `/reload` after installing. Use `/minimap` to show or hide it.

## Features

- Groups related turns into semantic milestones
- Updates a live activity trail during thinking, assistant text, and tool execution
- Shows context use, compactions, and overflow
- Reports session, agent, and minimap token costs separately
- Breaks down tools, skills, failures, and recovered errors
- Provides compact and expanded views without taking terminal focus

## Two views

### Compact

The current goal, session totals, context state, and recent history stay beside the conversation.

The live trail shows the current activity and its elapsed time, plus the latest three public assistant updates or tool events. It updates as the agent streams, without extra model calls. Thinking shows status, not private reasoning text.

During an active run, a background check after completed tool turns can refresh the current milestone when public activity shows a significant direction change. Routine progress, retries, and phase changes keep the title stable. The title is provisional; semantic history still settles when the run ends. Checks use the selected pi model, add to minimap token costs, and coalesce new activity while a check is in flight. They do not read private reasoning or run per token.

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

Related follow-ups, retries, and routine work phases stay in one milestone. A new milestone starts only for a distinct outcome worth remembering after the surrounding conversation is gone.

After each settled run, the extension compares the open milestone with new activity. The normal summarizer can rename or merge the latest five completed milestones while older history stays fixed. A confident Jev merge extends the open milestone directly and keeps its title. Revised metrics are recomputed from their original session entries.

The extension uses your selected pi model and stores compact revision metadata in the pi session file. Its summary calls use tokens from your active model provider; the minimap reports that spend separately.

## Optional Jev boundary gate

Set `PI_MINIMAP_JEV=1` and `TYPESAFE_API_KEY` in the environment before starting pi. Jev then classifies whether new activity merges into the current milestone. A confident merge skips the pi model call. A separate, uncertain, or failed Jev result uses the normal pi model summarizer, which still creates milestone titles and decisions.

Jev requests send the current milestone title and new activity transcript to TypeSafe AI. TypeSafe bills those requests separately, and their usage is not included in minimap totals.

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

Each attempt makes six paid API calls with `gpt-5-mini` at low reasoning effort. `EVAL_ATTEMPTS` accepts 1–5 and defaults to 1. Set `OPENAI_MODEL` to test another model.

</details>

## License

[MIT](LICENSE) © pi-session-minimap contributors
