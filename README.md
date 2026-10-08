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

Current starts with a readable local label. A background check summarizes the consumed user request into a concise task title, even before the agent acts. Checks after completed assistant turns, with or without tools, can refine that title without adding a row. A significant public direction change adds a milestone; routine progress, retries, and phase changes do not. Only the latest title can settle at handback; previous rows stay visible. Checks use the selected pi model, add to minimap token costs, and coalesce new activity while a check is in flight. They do not read private reasoning or run per token.

Title badges show inference evidence: `👤` user request, `🤖` public agent activity, `🔗` both. Rephrasing a user request remains `👤`; agent-informed refinement becomes `🔗`. Older records without stored evidence show no badge.

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

Each consumed user prompt starts an entry, including steering inside an active run. The entry settles when control returns to the user. The agent can add intermediate milestones for significant pivots; routine work phases and retries do not add entries.

Image-only and screenshot-path-only prompts start with the title `User request`. The summarizer can refine that title after observing public activity.

After each settled run, the extension compares the latest milestone with new activity. The summarizer can refine its title or add distinct outcomes, but it cannot merge away previous entries. A confident Jev merge extends the latest milestone directly and keeps its title. Metrics are recomputed from their original session entries.

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
