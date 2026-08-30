import type {
  ExtensionContext,
  SessionEntry,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type OverlayOptions,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  addUsage,
  emptyCounts,
  emptyUsage,
  entriesAfter,
  type ContextReset,
  type ContextSnapshot,
  type SessionStats,
  type UsageSnapshot,
  type ViewState,
} from "./state.ts";
import {
  collectContextResets,
  collectStats,
  collectStepStats,
  conciseStep,
  failureReview,
  isConsequentialDecision,
  oneLine,
  readableGoal,
} from "./diagnostics.ts";

export const scrollWindow = (
  length: number,
  viewport: number,
  offset: number,
): { start: number; end: number; max: number } => {
  const size = Math.max(1, Math.floor(viewport));
  const max = Math.max(0, length - size);
  const start = Math.max(0, Math.min(max, Math.floor(offset)));
  return { start, end: Math.min(length, start + size), max };
};

export const alignScrollStart = (
  offset: number,
  cardStarts: number[],
): number => {
  let aligned = offset;
  for (const start of cardStarts) {
    if (start > offset) break;
    aligned = start;
  }
  return aligned;
};

export const minimapHeight = (
  terminalRows: number,
  chromeRows: number,
  expanded = false,
): number =>
  expanded
    ? Math.min(
        Math.max(1, Math.floor(terminalRows * 0.9)),
        Math.max(12, chromeRows),
      )
    : Math.min(Math.max(1, terminalRows - 2), Math.max(24, chromeRows + 10));

export const minimapOverlayOptions = (expanded: boolean): OverlayOptions => ({
  anchor: expanded ? "center" : "top-right",
  width: expanded ? "85%" : 60,
  maxHeight: expanded ? "90%" : "100%",
  margin: expanded ? 1 : 0,
  nonCapturing: true,
  visible: (terminalWidth) => terminalWidth >= (expanded ? 80 : 110),
});

const fmt = (value: number): string => {
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000)
    return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
};

export const elapsedLabel = (elapsedMs: number): string => {
  const minutes = Math.floor(Math.max(0, elapsedMs) / 60_000);
  if (minutes < 1) return `${Math.round(Math.max(0, elapsedMs) / 1_000)}s`;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  return `${Math.floor(hours / 24)}d${hours % 24 ? ` ${hours % 24}h` : ""}`;
};

export const sessionEfficiency = (
  entries: SessionEntry[],
  stats: Pick<
    SessionStats,
    "input" | "cacheRead" | "errors" | "tools" | "agentTokens" | "summaryTokens"
  >,
) => {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    const timestamp = Date.parse(entry.timestamp);
    if (!Number.isFinite(timestamp)) continue;
    first = Math.min(first, timestamp);
    last = Math.max(last, timestamp);
  }
  const calls = Object.values(stats.tools).reduce(
    (sum, count) => sum + count,
    0,
  );
  const modelCalls = entries.filter(
    (entry) => entry.type === "message" && entry.message.role === "assistant",
  ).length;
  const attempts = calls + modelCalls;
  const cacheTokens = stats.input + stats.cacheRead;
  const mappedTokens = stats.agentTokens + stats.summaryTokens;
  return {
    elapsedMs:
      Number.isFinite(first) && Number.isFinite(last) ? last - first : 0,
    calls,
    attempts,
    cacheShare: cacheTokens ? (stats.cacheRead / cacheTokens) * 100 : 0,
    failureRate: attempts ? (stats.errors / attempts) * 100 : 0,
    mapOverhead: mappedTokens ? (stats.summaryTokens / mappedTokens) * 100 : 0,
  };
};

export const trailingFailureStreak = (
  entries: SessionEntry[],
): { source: string; count: number } | undefined => {
  let source = "";
  let count = 0;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    if (entry.message.role === "toolResult") {
      if (!entry.message.isError) {
        source = "";
        count = 0;
        continue;
      }
      const next = oneLine(entry.message.toolName, 24) || "tool";
      if (count === 0) source = next;
      else if (source !== next) source = "agent";
      count++;
    } else if (entry.message.role === "assistant") {
      if (entry.message.stopReason === "toolUse") continue;
      if (entry.message.stopReason === "error") {
        if (count === 0) source = "model";
        else if (source !== "model") source = "agent";
        count++;
      } else {
        source = "";
        count = 0;
      }
    }
  }
  return count >= 2 ? { source, count } : undefined;
};

export const contextRangeLabel = (
  start?: string,
  end?: string,
  suffix = "",
  hasReset = false,
  endLabel: "end" | "now" = "end",
): string => {
  if (!start && !end) return "";
  if (!start) return `ctx ${endLabel} ${end}${suffix}`;
  if (!end) return `ctx start ${start}${suffix}`;
  if (hasReset)
    return `ctx start ${start}${suffix} · ${endLabel} ${end}${suffix}`;
  return `ctx ${start}→${end}${suffix}`;
};

export const minimapStatus = (
  hasCurrent: boolean,
  hasOpen: boolean,
): "active" | "settled" | "idle" => {
  if (hasCurrent) return "active";
  return hasOpen ? "settled" : "idle";
};

export const compactMetrics = (
  stats: Pick<
    SessionStats,
    | "input"
    | "output"
    | "cost"
    | "agentTokens"
    | "summaryTokens"
    | "tools"
    | "skills"
    | "errors"
    | "errorKinds"
  >,
  contextPercent?: number | null,
  resetCount = 0,
): string[] => {
  const calls = Object.values(stats.tools).reduce(
    (total, count) => total + count,
    0,
  );
  const skills = Object.values(stats.skills).reduce(
    (total, count) => total + count,
    0,
  );
  const errors = topCounts(stats.errorKinds, 2, 18);
  const resetMetric = resetCount > 0 ? ` · ↻${resetCount}` : "";
  const percent =
    contextPercent == null
      ? null
      : Math.max(0, Math.min(100, Math.round(contextPercent)));
  const filled = percent == null ? 0 : Math.round((percent / 100) * 6);
  const contextMeter = `${"▓".repeat(filled)}${"░".repeat(6 - filled)}`;
  return [
    `tok ${fmt(stats.input)}→${fmt(stats.output)} · $${stats.cost.toFixed(2)} · ctx now${percent == null ? "?" : `${percent}%`} ${contextMeter}`,
    `agent${fmt(stats.agentTokens)} · map${fmt(stats.summaryTokens)} · calls${fmt(calls)} · skills${fmt(skills)} · err${stats.errors}${resetMetric}`,
    ...(errors ? [`errors ${errors}`] : []),
  ];
};

const resetCountLabel = (resets: ContextReset[]): string => {
  if (!resets.length) return "";
  const overflow = resets.some((reset) => (reset.beforePercent ?? 0) > 100);
  return `↻${resets.length}${overflow ? "▲" : ""}`;
};

const topCounts = (
  counts: Record<string, number>,
  limit = 3,
  nameLength = 24,
): string =>
  Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => `${oneLine(name, nameLength)}×${count}`)
    .join(" ");

export const wrapStepSummary = (summary: string, width: number): string[] =>
  wrapTextWithAnsi(summary, Math.max(1, width));

export const meterBar = (
  value: number | null | undefined,
  max: number,
  width: number,
): string => {
  const size = Math.max(1, Math.floor(width));
  const filled =
    value == null || max <= 0
      ? 0
      : Math.round(Math.max(0, Math.min(1, value / max)) * size);
  return `${"█".repeat(filled)}${"░".repeat(size - filled)}`;
};

export const dashboardContextLabel = (
  start: number | null | undefined,
  end: number | null | undefined,
  resets: ContextReset[],
): string => {
  const from = start == null ? undefined : Math.round(start);
  const to = end == null ? undefined : Math.round(end);
  if (resets.length === 1) {
    const reset = resets[0];
    const before = reset?.beforePercent;
    const after = reset?.afterPercent;
    if (before != null) {
      const afterValue = after == null ? undefined : Math.round(after);
      const current = to != null && to !== afterValue ? `→${to}` : "";
      return `↻${before > 100 ? "▲" : ""}${Math.round(before)}↘${afterValue ?? "?"}${current}%`;
    }
  }
  if (resets.length > 1) {
    const overflow = resets.some((reset) => (reset.beforePercent ?? 0) > 100);
    return `↻${resets.length}${overflow ? "▲" : ""} ${from ?? "?"}→${to ?? "?"}%`;
  }
  if (from != null && to != null)
    return from === to ? `${to}%` : `${from}→${to}%`;
  if (to != null) return `${to}%`;
  if (from != null) return `${from}→?%`;
  return "?";
};

const paneFrame = (theme: Theme, width: number) => {
  const inner = Math.max(12, width) - 2;
  const paint = (line: string) => theme.bg("customMessageBg", line);
  const border = (left: string, fill: string, right: string) =>
    paint(theme.fg("border", `${left}${fill.repeat(inner)}${right}`));
  const row = (content = "") => {
    const clipped = truncateToWidth(content, inner, "");
    return paint(
      theme.fg("border", "│") +
        clipped +
        " ".repeat(Math.max(0, inner - visibleWidth(clipped))) +
        theme.fg("border", "│"),
    );
  };
  const wrappedRows = (
    prefix: string,
    value: string,
    prefixStyle: (text: string) => string,
    valueStyle: (text: string) => string,
  ) =>
    wrapStepSummary(value, inner - visibleWidth(prefix)).map((line, index) =>
      row(
        `${index === 0 ? prefixStyle(prefix) : " ".repeat(visibleWidth(prefix))}${valueStyle(line)}`,
      ),
    );
  return { inner, border, row, wrappedRows };
};

export class MinimapPane implements Component {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly state: ViewState;
  private readonly getEntries: () => SessionEntry[];
  private readonly getContextUsage: ExtensionContext["getContextUsage"];
  private readonly expanded: boolean;
  private historyLength = 0;
  private viewportRows = 1;
  private scrollOffset = 0;
  private followEnd = true;

  constructor(
    tui: TUI,
    theme: Theme,
    state: ViewState,
    getEntries: () => SessionEntry[],
    getContextUsage: ExtensionContext["getContextUsage"],
    expanded = false,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.state = state;
    this.getEntries = getEntries;
    this.getContextUsage = getContextUsage;
    this.expanded = expanded;
  }

  scrollBy(lines: number): void {
    const current = scrollWindow(
      this.historyLength,
      this.viewportRows,
      this.followEnd ? Number.MAX_SAFE_INTEGER : this.scrollOffset,
    );
    const next = scrollWindow(
      this.historyLength,
      this.viewportRows,
      current.start + lines,
    );
    this.scrollOffset = next.start;
    this.followEnd = next.start === next.max;
    this.tui.requestRender();
  }

  private sessionData() {
    const entries = this.getEntries();
    const stats = collectStats(entries);
    const context = this.getContextUsage();
    const resets = collectContextResets(
      entries,
      context?.contextWindow ?? 0,
      context?.tokens,
    );
    const entryIndexes = new Map(
      entries.map((entry, index) => [entry.id, index]),
    );
    return { entries, stats, context, resets, entryIndexes };
  }

  private renderExpanded(width: number): string[] {
    const th = this.theme;
    const { inner, border, row, wrappedRows } = paneFrame(th, width);
    const cell = (value: string, size: number, right = false) => {
      const clipped = truncateToWidth(value, size, "");
      const padding = " ".repeat(Math.max(0, size - visibleWidth(clipped)));
      return right ? `${padding}${clipped}` : `${clipped}${padding}`;
    };
    const distribution = (counts: Record<string, number>, limit = 3) => {
      const ranked = Object.entries(counts).sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
      );
      const shown = ranked.slice(0, limit);
      const other = ranked
        .slice(limit)
        .reduce((sum, [, count]) => sum + count, 0);
      if (other) shown.push(["other", other]);
      const max = Math.max(1, ...shown.map(([, count]) => count));
      return shown
        .map(
          ([name, count]) =>
            `${oneLine(name, 24)}·${meterBar(count, max, 4)}·${fmt(count)}`,
        )
        .join("  ");
    };

    const { entries, stats, context, resets, entryIndexes } =
      this.sessionData();
    const efficiency = sessionEfficiency(entries, stats);
    const review = failureReview(entries, stats.tools);
    const lastBoundary =
      entryIndexes.get(this.state.steps.at(-1)?.throughEntryId ?? "") ?? -1;
    const liveEntries = entries.slice(lastBoundary + 1);
    const failureStreak = trailingFailureStreak(liveEntries);
    const liveSummary = this.state.current?.label ?? this.state.open?.summary;
    const previousThrough =
      this.state.open?.throughEntryId ??
      this.state.steps.at(-1)?.throughEntryId;
    const pendingStats = collectStepStats(
      liveSummary ? entriesAfter(entries, previousThrough) : [],
    );
    const liveTools = Object.assign(emptyCounts(), this.state.open?.tools);
    for (const [name, count] of Object.entries(pendingStats.tools))
      liveTools[name] = (liveTools[name] ?? 0) + count;
    const liveUsage = { ...(this.state.open?.usage ?? emptyUsage()) };
    addUsage(liveUsage, pendingStats.usage);
    const liveErrors = (this.state.open?.errors ?? 0) + pendingStats.errors;
    const liveCalls = Object.values(liveTools).reduce(
      (sum, count) => sum + count,
      0,
    );
    const openStartedAt =
      this.state.open?.createdAt ?? Date.parse(liveEntries[0]?.timestamp ?? "");
    const openElapsed = Number.isFinite(openStartedAt)
      ? Math.max(0, Date.now() - openStartedAt)
      : 0;
    const liveCostShare = stats.cost ? (liveUsage.cost / stats.cost) * 100 : 0;
    const liveCallShare = efficiency.calls
      ? (liveCalls / efficiency.calls) * 100
      : 0;
    const liveEnd =
      this.state.current && context
        ? {
            tokens: context.tokens,
            percent: context.percent,
            contextWindow: context.contextWindow,
          }
        : this.state.open?.contextEnd;
    const liveResets = resets.filter(
      (reset) => reset.entryIndex > lastBoundary,
    );
    const liveContext = dashboardContextLabel(
      this.state.open?.contextStart?.percent,
      liveEnd?.percent,
      liveResets,
    );
    const percent =
      context?.percent == null ? undefined : Math.round(context.percent);
    const contextTokens = context?.tokens == null ? "?" : fmt(context.tokens);
    const contextWindow = context?.contextWindow
      ? fmt(context.contextWindow)
      : "?";
    const contextColor = (percent ?? 0) >= 85 ? "warning" : "accent";

    const header = [
      border("╭", "─", "╮"),
      row(` ${th.bold(th.fg("accent", "Session minimap"))}`),
    ];
    if (liveSummary) {
      const status = minimapStatus(
        Boolean(this.state.current),
        Boolean(this.state.open),
      );
      header.push(
        ...wrappedRows(
          ` ${status === "active" ? "●" : "✓"} Current ${this.state.steps.length + 1} · `,
          readableGoal(liveSummary),
          (value) => th.fg(status === "active" ? "accent" : "success", value),
          (value) => th.bold(th.fg("text", value)),
        ),
      );
      const currentDetails = [
        `Context ${liveContext}`,
        `Open ${elapsedLabel(openElapsed)}`,
        stats.cost ? `${liveCostShare.toFixed(0)}% session cost` : "",
        efficiency.calls ? `${liveCallShare.toFixed(0)}% calls` : "",
        liveErrors ? `${liveErrors} current failures` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      header.push(
        ...wrappedRows(
          "   ",
          currentDetails,
          (value) => value,
          (value) => th.fg("muted", value),
        ),
      );
      if (failureStreak)
        header.push(
          ...wrappedRows(
            "   Attention · ",
            `${failureStreak.source} failures ×${failureStreak.count} consecutive`,
            (value) => th.fg("warning", value),
            (value) => th.fg("warning", value),
          ),
        );
    } else {
      header.push(row(` ○ ${th.fg("muted", "Idle")}`));
    }
    header.push(
      row(
        ` ${th.fg("muted", "Context")} ${th.fg(contextColor, meterBar(percent, 100, 12))} ${th.fg("text", `${percent ?? "?"}% · ${contextTokens}/${contextWindow}`)} · ${th.fg("muted", `${resets.length} resets`)}`,
      ),
      border("├", "─", "┤"),
    );

    const indexWidth = 4;
    const contextWidth = 18;
    const costWidth = 9;
    const activityWidth = 20;
    const goalWidth = Math.max(
      8,
      inner - indexWidth - contextWidth - costWidth - activityWidth - 3,
    );
    header.push(
      row(
        th.fg(
          "muted",
          `${cell("#", indexWidth)}${cell("Goal", goalWidth)} ${cell("Context", contextWidth)} ${cell("Cost", costWidth, true)} ${cell("Activity", activityWidth, true)}`,
        ),
      ),
    );

    const history: string[] = [];
    const cardStarts: number[] = [];
    const pushStep = (
      indexLabel: string,
      summary: string,
      start: ContextSnapshot | undefined,
      end: ContextSnapshot | undefined,
      stepResets: ContextReset[],
      tools: Record<string, number>,
      usage: UsageSnapshot,
      errors: number,
    ) => {
      cardStarts.push(history.length);
      const lines = wrapStepSummary(conciseStep(summary), goalWidth);
      const contextLabel = `${meterBar(end?.percent, 100, 6)} ${dashboardContextLabel(start?.percent, end?.percent, stepResets)}`;
      const stepCalls = Object.values(tools).reduce(
        (sum, count) => sum + count,
        0,
      );
      const health = [
        stepCalls ? `${fmt(stepCalls)} calls` : "—",
        errors ? `${errors} errors` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      for (let line = 0; line < lines.length; line++)
        history.push(
          row(
            `${th.fg("accent", cell(line === 0 ? indexLabel : "", indexWidth))}${th.bold(th.fg("text", cell(lines[line] ?? "", goalWidth)))} ${
              line === 0
                ? `${th.fg("muted", cell(contextLabel, contextWidth))} ${th.fg("text", cell(usage.cost ? usage.cost.toFixed(2) : "—", costWidth, true))} ${th.fg("muted", cell(health, activityWidth, true))}`
                : " ".repeat(contextWidth + costWidth + activityWidth + 2)
            }`,
          ),
        );
    };

    let previousBoundary = -1;
    for (let index = 0; index < this.state.steps.length; index++) {
      const step = this.state.steps[index];
      if (!step) continue;
      const endBoundary =
        entryIndexes.get(step.throughEntryId) ?? previousBoundary;
      const stepResets = resets.filter(
        (reset) =>
          reset.entryIndex > previousBoundary &&
          reset.entryIndex <= endBoundary,
      );
      pushStep(
        `${index + 1}.`,
        step.summary,
        step.contextStart,
        step.contextEnd,
        stepResets,
        step.tools,
        step.usage,
        step.errors,
      );
      previousBoundary = Math.max(previousBoundary, endBoundary);
    }
    if (!history.length) {
      cardStarts.push(0);
      history.push(row(` ${th.fg("muted", "No completed steps yet")}`));
    }

    cardStarts.push(history.length);
    history.push(
      border("├", "─", "┤"),
      ...wrappedRows(
        " Session ",
        `${elapsedLabel(efficiency.elapsedMs)} elapsed · $${stats.cost.toFixed(2)} session · ${fmt(stats.input)}→${fmt(stats.output)} tok · ${fmt(stats.agentTokens)} agent · ${fmt(stats.summaryTokens)} map (${efficiency.mapOverhead.toFixed(2)}%) · ${efficiency.cacheShare.toFixed(0)}% cache`,
        (value) => th.fg("muted", value),
        (value) => th.fg("text", value),
      ),
    );
    const nestedTokens = Object.entries(stats.toolTokens)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([name, tokens]) => `${oneLine(name, 24)} ${fmt(tokens)}`)
      .join(" · ");
    if (nestedTokens)
      history.push(
        ...wrappedRows(
          " Nested tokens ",
          nestedTokens,
          (value) => th.fg("muted", value),
          (value) => th.fg("text", value),
        ),
      );
    const skillCounts = topCounts(stats.skills, 3);
    if (skillCounts)
      history.push(
        ...wrappedRows(
          " Skills ",
          skillCounts,
          (value) => th.fg("muted", value),
          (value) => th.fg("text", value),
        ),
      );
    if (review.total) {
      history.push(
        ...wrappedRows(
          " Failure review ",
          `${review.total}/${efficiency.attempts} (${efficiency.failureRate.toFixed(1)}%) · ${review.runs} runs · max streak ×${review.maxStreak} · ${review.recovered} recovered${review.unresolved ? " · 1 unresolved" : ""}`,
          (value) => th.fg("muted", value),
          (value) => th.fg("text", value),
        ),
      );
      const failingTools = review.byTool
        .slice(0, 3)
        .map(
          ({ name, failures, calls, rate }) =>
            `${oneLine(name, 24)} ${failures}/${calls} (${rate.toFixed(1)}%)`,
        )
        .join(" · ");
      if (failingTools)
        history.push(
          ...wrappedRows(
            " By tool ",
            failingTools,
            (value) => th.fg("muted", value),
            (value) => th.fg("text", value),
          ),
        );
      const typeGraphic = distribution(review.byType);
      if (typeGraphic)
        history.push(
          ...wrappedRows(
            " By type ",
            typeGraphic,
            (value) => th.fg("muted", value),
            (value) => th.fg("muted", value),
          ),
        );
      const patterns = review.patterns
        .slice(0, 3)
        .map(({ label, count }) => `${label} ×${count}`)
        .join(" · ");
      if (patterns)
        history.push(
          ...wrappedRows(
            " Patterns ",
            patterns,
            (value) => th.fg("muted", value),
            (value) => th.fg("muted", value),
          ),
        );
    }

    const recentDecisions = [
      ...this.state.steps.flatMap((step, index) =>
        step.decisions.filter(isConsequentialDecision).map((decision) => ({
          label: `${index + 1}.`,
          decision,
        })),
      ),
      ...(this.state.open?.decisions ?? [])
        .filter(isConsequentialDecision)
        .map((decision) => ({
          label: `${this.state.steps.length + 1}.`,
          decision,
        })),
    ].slice(-3);
    if (recentDecisions.length) {
      cardStarts.push(history.length);
      history.push(
        border("├", "─", "┤"),
        row(` ${th.fg("muted", "Recent decisions")}`),
      );
      let previousLabel = "";
      for (const { label, decision } of recentDecisions) {
        const labelText = ` ${label} `;
        history.push(
          ...wrappedRows(
            label === previousLabel
              ? " ".repeat(visibleWidth(labelText))
              : labelText,
            conciseStep(decision, 14),
            (value) => th.fg("accent", value),
            (value) => th.fg("text", value),
          ),
        );
        previousLabel = label;
      }
    }

    const targetHeight = minimapHeight(
      this.tui.terminal.rows,
      header.length + history.length + 3,
      true,
    );
    this.viewportRows = Math.max(1, targetHeight - header.length - 3);
    this.historyLength = history.length;
    const rawWindow = scrollWindow(
      history.length,
      this.viewportRows,
      this.followEnd ? Number.MAX_SAFE_INTEGER : this.scrollOffset,
    );
    const start = alignScrollStart(rawWindow.start, cardStarts);
    const end = Math.min(history.length, start + this.viewportRows);
    this.scrollOffset = start;
    const visibleHistory = history.slice(start, end);
    while (visibleHistory.length < this.viewportRows)
      visibleHistory.push(row());
    const scrollLabel = rawWindow.max
      ? `Ctrl+Shift+K/J scroll · ${start + 1}–${end}/${history.length} · Ctrl+Shift+M compact`
      : "Ctrl+Shift+K/J scroll · Ctrl+Shift+M compact";
    return [
      ...header,
      ...visibleHistory,
      border("├", "─", "┤"),
      row(` ${th.fg("muted", scrollLabel)}`),
      border("╰", "─", "╯"),
    ];
  }

  render(width: number): string[] {
    if (this.expanded) return this.renderExpanded(width);
    const th = this.theme;
    const { inner, border, row, wrappedRows } = paneFrame(th, width);
    const contextLabel = (
      start?: ContextSnapshot,
      end?: ContextSnapshot,
      hasReset = false,
      endLabel: "end" | "now" = "end",
    ) => {
      if (start?.percent != null || end?.percent != null)
        return contextRangeLabel(
          start?.percent == null
            ? undefined
            : String(Math.round(start.percent)),
          end?.percent == null ? undefined : String(Math.round(end.percent)),
          "%",
          hasReset,
          endLabel,
        );
      if (start?.tokens != null || end?.tokens != null)
        return contextRangeLabel(
          start?.tokens == null ? undefined : fmt(start.tokens),
          end?.tokens == null ? undefined : fmt(end.tokens),
          "",
          hasReset,
          endLabel,
        );
      return "";
    };

    const { stats, context, resets, entryIndexes } = this.sessionData();
    const history: string[] = [];
    const cardStarts: number[] = [];
    let previousBoundary = -1;
    for (let index = 0; index < this.state.steps.length; index++) {
      const step = this.state.steps[index];
      if (!step) continue;
      cardStarts.push(history.length);
      const prefix = ` ${index + 1}. `;
      const wrapped = wrapStepSummary(
        conciseStep(step.summary),
        inner - prefix.length,
      );
      for (let line = 0; line < wrapped.length; line++)
        history.push(
          row(
            `${line === 0 ? th.fg("accent", prefix) : " ".repeat(prefix.length)}${th.bold(th.fg("text", wrapped[line] ?? ""))}`,
          ),
        );
      const endBoundary =
        entryIndexes.get(step.throughEntryId) ?? previousBoundary;
      const stepResets = resets.filter(
        (reset) =>
          reset.entryIndex > previousBoundary &&
          reset.entryIndex <= endBoundary,
      );
      const range = contextLabel(
        step.contextStart,
        step.contextEnd,
        stepResets.length > 0,
      );
      const resetLabel = resetCountLabel(stepResets);
      if (range || resetLabel)
        history.push(
          row(
            `    ${range ? th.fg("muted", range) : ""}${range && resetLabel ? " · " : ""}${resetLabel ? th.fg("muted", resetLabel) : ""}`,
          ),
        );
      previousBoundary = Math.max(previousBoundary, endBoundary);
    }
    if (!history.length) {
      cardStarts.push(0);
      history.push(row(` ${th.fg("muted", "No completed steps yet")}`));
    }

    const activity = this.state.current
      ? topCounts(this.state.current.tools, 2)
      : "";
    const openResets = resets.filter(
      (reset) => reset.entryIndex > previousBoundary,
    );
    const rangeEndLabel = this.state.current ? "now" : "end";
    let rangeEnd = this.state.open?.contextEnd;
    if (this.state.current && context)
      rangeEnd = {
        tokens: context.tokens,
        percent: context.percent,
      };
    const range = this.state.open
      ? contextLabel(
          this.state.open.contextStart,
          rangeEnd,
          openResets.length > 0,
          rangeEndLabel,
        )
      : "";
    const status = minimapStatus(
      Boolean(this.state.current),
      Boolean(this.state.open),
    );
    const liveSummary = this.state.current?.label ?? this.state.open?.summary;
    const header = [
      border("╭", "─", "╮"),
      row(` ${th.bold(th.fg("accent", "Session minimap"))}`),
    ];
    if (liveSummary) {
      header.push(
        ...wrappedRows(
          status === "active" ? " ● Current · " : " ✓ Current · ",
          readableGoal(liveSummary),
          (value) => th.fg(status === "active" ? "accent" : "success", value),
          (value) => th.bold(th.fg("text", value)),
        ),
      );
      const detail = [
        range,
        resetCountLabel(openResets),
        activity ? `working · ${activity}` : "",
        this.state.current?.errors
          ? `${this.state.current.errors} step failures`
          : "",
      ]
        .filter(Boolean)
        .join(" · ");
      if (detail)
        header.push(
          ...wrappedRows(
            "   ",
            detail,
            (value) => value,
            (value) => th.fg("muted", value),
          ),
        );
    } else {
      header.push(row(` ○ ${th.fg("muted", "Idle")}`));
    }
    for (const metric of compactMetrics(stats, context?.percent, resets.length))
      header.push(
        ...wrappedRows(
          " ",
          metric,
          (value) => value,
          (value) => th.fg("muted", value),
        ),
      );
    header.push(border("├", "─", "┤"));

    const footerRows = 3;
    const targetHeight = minimapHeight(
      this.tui.terminal.rows,
      header.length + footerRows,
    );
    this.viewportRows = Math.max(1, targetHeight - header.length - footerRows);
    this.historyLength = history.length;
    const rawWindow = scrollWindow(
      history.length,
      this.viewportRows,
      this.followEnd ? Number.MAX_SAFE_INTEGER : this.scrollOffset,
    );
    const start = alignScrollStart(rawWindow.start, cardStarts);
    const window = {
      ...rawWindow,
      start,
      end: Math.min(history.length, start + this.viewportRows),
    };
    this.scrollOffset = window.start;
    const visibleHistory = history.slice(window.start, window.end);
    while (visibleHistory.length < this.viewportRows)
      visibleHistory.push(row());
    const scrollLabel = `${
      window.max
        ? `Ctrl+Shift+K/J scroll · ${window.start + 1}–${window.end}/${history.length}`
        : "Ctrl+Shift+K/J scroll"
    } · Ctrl+Shift+M expand`;
    return [
      ...header,
      ...visibleHistory,
      border("├", "─", "┤"),
      row(` ${th.fg("muted", scrollLabel)}`),
      border("╰", "─", "╯"),
    ];
  }

  invalidate(): void {}
}
