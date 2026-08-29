import type {
  AssistantMessage,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";
import { stripVTControlCharacters } from "node:util";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type OverlayHandle,
  type OverlayOptions,
  type TUI,
} from "@earendil-works/pi-tui";

const ENTRY_TYPE = "session-minimap-step";
const STATE_ENTRY_TYPE = "session-minimap-open-step";
const STEP_VERSION = 1;
const SUMMARY_TIMEOUT_MS = 60_000;
const SUMMARY_SYSTEM_PROMPT = `Maintain a semantic minimap of an AI coding session.
A step is one meaningful milestone. Related retries, corrections, questions, and refinements stay in that step.
Use NEW when the deliverable or phase changes materially, even inside the same project: research to implementation, local verification to deployment, adding a new data source, redesigning the UI, or localization. Use CONTINUE only when the activity directly advances the current milestone. When uncertain, prefer NEW if the expected user-visible outcome changed.
Standalone skill/resource injection is not a new step unless work is requested.
Reply with:
CONTINUE or NEW
A title-like 6-10 word summary of the current semantic step.
Then zero to two lines formatted as DECISION: <agent-chosen direction>.
Decisions are consequential directions or trade-offs chosen by the agent, not user requests, tool calls, routine implementation actions, or repeated prior decisions.
Most turns should emit no DECISION lines. Do not record wording, layout, labels, icons, tests, refactors, or deferred follow-up work unless they preserve a consequential trade-off the user would need later.
For CONTINUE, rewrite the title to reflect the currently accepted outcome across the existing step and new activity. Remove rejected, declined, corrected, or superseded approaches instead of preserving them in the title. For NEW, summarize only the new activity.
Never claim an approach was used, integrated, or implemented when it was only evaluated, compared, or rejected.
Omit tool names, file names, commands, token stats, reload instructions, and implementation trivia.`;

type UsageSnapshot = Pick<
  Usage,
  "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens"
> & {
  cost: number;
};

interface ContextSnapshot {
  tokens: number | null;
  percent: number | null;
  contextWindow: number;
}

export interface ContextReset {
  entryIndex: number;
  beforeTokens: number;
  afterTokens?: number;
  beforePercent: number | null;
  afterPercent: number | null;
}

export interface MinimapStep {
  version: 1;
  throughEntryId: string;
  summary: string;
  tools: Record<string, number>;
  skills?: Record<string, number>;
  decisions?: string[];
  errors: number;
  usage: UsageSnapshot;
  contextStart?: ContextSnapshot;
  contextEnd?: ContextSnapshot;
  createdAt: number;
  recovered?: true;
}

interface OpenStep {
  summary: string;
  throughEntryId: string;
  tools: Record<string, number>;
  skills: Record<string, number>;
  decisions?: string[];
  errors: number;
  usage: UsageSnapshot;
  contextStart: ContextSnapshot;
  contextEnd: ContextSnapshot;
  createdAt: number;
}

interface OpenStateData {
  version: 1;
  open?: OpenStep;
  closed?: true;
  usageOnly?: true;
  callUsage: UsageSnapshot;
}

interface SessionStats extends UsageSnapshot {
  tools: Record<string, number>;
  skills: Record<string, number>;
  errors: number;
  errorKinds: Record<string, number>;
  agentTokens: number;
  summaryTokens: number;
  toolTokens: Record<string, number>;
}

interface CurrentStep {
  label: string;
  tools: Record<string, number>;
  errors: number;
}

interface ViewState {
  steps: MinimapStep[];
  open?: OpenStep;
  current?: CurrentStep;
}

const emptyUsage = (): UsageSnapshot => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: 0,
});

const emptyCounts = (): Record<string, number> =>
  Object.create(null) as Record<string, number>;

const usageSnapshot = (usage?: Usage): UsageSnapshot =>
  usage
    ? {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        totalTokens: usage.totalTokens,
        cost: usage.cost.total,
      }
    : emptyUsage();

const addUsage = (
  target: UsageSnapshot,
  usage?: Usage | UsageSnapshot,
): void => {
  if (!usage) return;
  target.input += usage.input;
  target.output += usage.output;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
  target.totalTokens += usage.totalTokens;
  target.cost += typeof usage.cost === "number" ? usage.cost : usage.cost.total;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isUsageSnapshot = (value: unknown): value is UsageSnapshot =>
  isRecord(value) &&
  isFiniteNumber(value.input) &&
  isFiniteNumber(value.output) &&
  isFiniteNumber(value.cacheRead) &&
  isFiniteNumber(value.cacheWrite) &&
  isFiniteNumber(value.totalTokens) &&
  isFiniteNumber(value.cost);

const isCounts = (value: unknown): value is Record<string, number> =>
  isRecord(value) && Object.values(value).every(isFiniteNumber);

const isContextSnapshot = (value: unknown): value is ContextSnapshot =>
  isRecord(value) &&
  (value.tokens === null || isFiniteNumber(value.tokens)) &&
  (value.percent === null || isFiniteNumber(value.percent)) &&
  isFiniteNumber(value.contextWindow);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isOpenStep = (value: unknown): value is OpenStep =>
  isRecord(value) &&
  typeof value.summary === "string" &&
  typeof value.throughEntryId === "string" &&
  isCounts(value.tools) &&
  isCounts(value.skills) &&
  (value.decisions === undefined || isStringArray(value.decisions)) &&
  isFiniteNumber(value.errors) &&
  isUsageSnapshot(value.usage) &&
  isContextSnapshot(value.contextStart) &&
  isContextSnapshot(value.contextEnd) &&
  isFiniteNumber(value.createdAt);

const isMinimapStep = (value: unknown): value is MinimapStep =>
  isRecord(value) &&
  value.version === STEP_VERSION &&
  typeof value.throughEntryId === "string" &&
  typeof value.summary === "string" &&
  isCounts(value.tools) &&
  (value.skills === undefined || isCounts(value.skills)) &&
  (value.decisions === undefined || isStringArray(value.decisions)) &&
  isFiniteNumber(value.errors) &&
  isUsageSnapshot(value.usage) &&
  (value.contextStart === undefined || isContextSnapshot(value.contextStart)) &&
  (value.contextEnd === undefined || isContextSnapshot(value.contextEnd)) &&
  isFiniteNumber(value.createdAt) &&
  (value.recovered === undefined || value.recovered === true);

const stepFromEntry = (entry: SessionEntry): MinimapStep | undefined =>
  entry.type === "custom" &&
  entry.customType === ENTRY_TYPE &&
  isMinimapStep(entry.data)
    ? entry.data
    : undefined;

const isOpenStateData = (value: unknown): value is OpenStateData =>
  isRecord(value) &&
  value.version === STEP_VERSION &&
  isUsageSnapshot(value.callUsage) &&
  (value.open === undefined || isOpenStep(value.open)) &&
  (value.open !== undefined ||
    value.closed === true ||
    value.usageOnly === true);

const openStateFromEntry = (entry: SessionEntry): OpenStateData | undefined =>
  entry.type === "custom" &&
  entry.customType === STATE_ENTRY_TYPE &&
  isOpenStateData(entry.data)
    ? entry.data
    : undefined;

export const restoreSavedState = (
  branch: SessionEntry[],
  contextWindow = 0,
): Pick<ViewState, "steps" | "open"> => {
  const persisted: MinimapStep[] = [];
  let open: OpenStep | undefined;
  for (const entry of branch) {
    const step = stepFromEntry(entry);
    if (step) {
      persisted.push(step);
      if (open?.throughEntryId === step.throughEntryId) open = undefined;
    }
    const checkpoint = openStateFromEntry(entry);
    if (checkpoint && !checkpoint.usageOnly)
      open = checkpoint.closed ? undefined : checkpoint.open;
  }

  const entryIndexes = new Map(branch.map((entry, index) => [entry.id, index]));
  const persistedIds = new Set(persisted.map((step) => step.throughEntryId));
  const firstPersistedIndex = persisted.length
    ? Math.min(
        ...persisted.map(
          (step) =>
            entryIndexes.get(step.throughEntryId) ?? Number.MAX_SAFE_INTEGER,
        ),
      )
    : Number.MAX_SAFE_INTEGER;
  const firstCheckpointIndex = branch.findIndex((entry) => {
    const checkpoint = openStateFromEntry(entry);
    return Boolean(checkpoint && !checkpoint.usageOnly);
  });
  const recoveryBoundary = Math.min(
    firstPersistedIndex,
    firstCheckpointIndex < 0 ? Number.MAX_SAFE_INTEGER : firstCheckpointIndex,
  );
  const recoveredPrefix = recoverHistoricalSteps(branch, contextWindow).filter(
    (step) =>
      !persistedIds.has(step.throughEntryId) &&
      (entryIndexes.get(step.throughEntryId) ?? Number.MAX_SAFE_INTEGER) <
        recoveryBoundary,
  );
  const steps = inferStepContexts(
    [...recoveredPrefix, ...persisted],
    branch,
    contextWindow,
  );
  return { steps, open };
};

export const entriesAfter = (
  entries: SessionEntry[],
  entryId?: string,
): SessionEntry[] => {
  if (!entryId) return entries;
  const index = entries.findIndex((entry) => entry.id === entryId);
  return index < 0 ? entries : entries.slice(index + 1);
};

export const categorizeError = (
  message: Pick<ToolResultMessage, "toolName" | "content">,
): string => {
  const text = message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
  if (/(?:✖|not ok|# fail [1-9]|tests?[\s\S]{0,40}failed)/i.test(text))
    return "test";
  if (/error TS\d+/.test(text)) return "typecheck";
  if (/SyntaxError|triggerUncaughtException|ERR_[A-Z_]+/.test(text))
    return "runtime";
  if (/Command exited|fatal:/i.test(text)) return "command";
  return message.toolName;
};

export const inferStepContexts = (
  steps: MinimapStep[],
  entries: SessionEntry[],
  contextWindow: number,
): MinimapStep[] => {
  const endByEntry = new Map<string, ContextSnapshot>();
  let latest: ContextSnapshot | undefined;
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      const message = entry.message as AssistantMessage;
      if (message.stopReason !== "aborted" && message.stopReason !== "error") {
        const tokens = message.usage.totalTokens;
        if (tokens > 0) {
          latest = {
            tokens,
            percent: contextWindow > 0 ? (tokens / contextWindow) * 100 : null,
            contextWindow,
          };
        }
      }
    }
    if (latest) endByEntry.set(entry.id, latest);
  }

  let previousEnd: ContextSnapshot | undefined;
  return steps.map((step) => {
    const contextEnd = step.contextEnd ?? endByEntry.get(step.throughEntryId);
    const contextStart = step.contextStart ?? previousEnd;
    if (contextEnd) previousEnd = contextEnd;
    return { ...step, contextStart, contextEnd };
  });
};

export const collectContextResets = (
  entries: SessionEntry[],
  contextWindow: number,
  currentTokens?: number | null,
): ContextReset[] => {
  const resets: ContextReset[] = [];
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
    const entry = entries[entryIndex];
    if (entry?.type !== "compaction") continue;
    let afterTokens: number | undefined;
    let followedByCompaction = false;
    for (
      let nextIndex = entryIndex + 1;
      nextIndex < entries.length;
      nextIndex++
    ) {
      const next = entries[nextIndex];
      if (next?.type === "compaction") {
        followedByCompaction = true;
        break;
      }
      if (next?.type !== "message" || next.message.role !== "assistant")
        continue;
      const message = next.message as AssistantMessage;
      if (message.stopReason === "aborted" || message.stopReason === "error")
        continue;
      if (message.usage.totalTokens > 0) {
        afterTokens = message.usage.totalTokens;
        break;
      }
    }
    if (!followedByCompaction && afterTokens == null && currentTokens != null)
      afterTokens = currentTokens;
    resets.push({
      entryIndex,
      beforeTokens: entry.tokensBefore,
      afterTokens,
      beforePercent:
        contextWindow > 0 ? (entry.tokensBefore / contextWindow) * 100 : null,
      afterPercent:
        contextWindow > 0 && afterTokens != null
          ? (afterTokens / contextWindow) * 100
          : null,
    });
  }
  return resets;
};

export const collectStats = (entries: SessionEntry[]): SessionStats => {
  const stats: SessionStats = {
    ...emptyUsage(),
    tools: emptyCounts(),
    skills: extractSkills(entries),
    errors: 0,
    errorKinds: emptyCounts(),
    agentTokens: 0,
    summaryTokens: 0,
    toolTokens: emptyCounts(),
  };

  for (const entry of entries) {
    const openState = openStateFromEntry(entry);
    if (openState) {
      addUsage(stats, openState.callUsage);
      stats.summaryTokens += openState.callUsage.totalTokens;
      continue;
    }
    const step = stepFromEntry(entry);
    if (step) continue;
    if (entry.type !== "message") continue;

    if (entry.message.role === "assistant") {
      const message = entry.message as AssistantMessage;
      addUsage(stats, message.usage);
      stats.agentTokens += message.usage.totalTokens;
      for (const content of message.content) {
        if (content.type === "toolCall") {
          stats.tools[content.name] = (stats.tools[content.name] ?? 0) + 1;
        }
      }
    } else if (entry.message.role === "toolResult") {
      const message = entry.message as ToolResultMessage;
      addUsage(stats, message.usage);
      if (message.usage) {
        const tokens = message.usage.totalTokens;
        stats.agentTokens += tokens;
        stats.toolTokens[message.toolName] =
          (stats.toolTokens[message.toolName] ?? 0) + tokens;
      }
      if (message.isError) {
        stats.errors++;
        const kind = categorizeError(message);
        stats.errorKinds[kind] = (stats.errorKinds[kind] ?? 0) + 1;
      }
    }
  }

  return stats;
};

const collectStepStats = (entries: SessionEntry[]) => {
  const stats = collectStats(
    entries.filter(
      (entry) => !stepFromEntry(entry) && !openStateFromEntry(entry),
    ),
  );
  return {
    tools: stats.tools,
    skills: extractSkills(entries),
    errors: stats.errors,
    usage: {
      input: stats.input,
      output: stats.output,
      cacheRead: stats.cacheRead,
      cacheWrite: stats.cacheWrite,
      totalTokens: stats.agentTokens,
      cost: stats.cost,
    },
  };
};

const textContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (item): item is { type: "text"; text: string } =>
        !!item &&
        typeof item === "object" &&
        item.type === "text" &&
        typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n");
};

export const extractSkills = (
  entries: SessionEntry[],
): Record<string, number> => {
  const skills = emptyCounts();
  const count = (name: string) => {
    skills[name] = (skills[name] ?? 0) + 1;
  };

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    if (entry.message.role === "user") {
      const text = textContent(entry.message.content);
      for (const match of text.matchAll(/<skill\s+name=["']([^"']+)["']/gi)) {
        if (match[1]) count(match[1]);
      }
    } else if (entry.message.role === "assistant") {
      for (const content of entry.message.content) {
        if (content.type !== "toolCall" || content.name !== "read") continue;
        const path = content.arguments.path;
        if (typeof path !== "string") continue;
        const match = path.match(/(?:^|\/)skills\/([^/]+)\/SKILL\.md$/);
        if (match?.[1]) count(match[1]);
      }
    }
  }
  return skills;
};

export const isStandaloneSkillInjection = (text: string): boolean =>
  /^<skill\s+name=["'][^"']+["'][^>]*>[\s\S]*<\/skill>$/.test(text.trim());

const buildTranscript = (entries: SessionEntry[]): string => {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.type === "compaction") {
      lines.push(`Context checkpoint: ${entry.summary}`);
      continue;
    }
    if (entry.type === "branch_summary") {
      lines.push(`Earlier branch: ${entry.summary}`);
      continue;
    }
    if (entry.type !== "message") continue;

    const message = entry.message;
    if (message.role === "user") {
      const text = textContent(message.content).trim();
      if (text) lines.push(`User: ${text}`);
    } else if (message.role === "assistant") {
      const text = textContent(message.content).trim();
      if (text) lines.push(`Assistant: ${text}`);
      const tools = message.content
        .filter(
          (
            item,
          ): item is {
            type: "toolCall";
            id: string;
            name: string;
            arguments: Record<string, unknown>;
          } => item.type === "toolCall",
        )
        .map((item) => item.name);
      if (tools.length) lines.push(`Actions: ${tools.join(", ")}`);
      if (message.stopReason === "error" && message.errorMessage)
        lines.push(`Model error: ${message.errorMessage}`);
    } else if (message.role === "toolResult" && message.isError) {
      const error = textContent(message.content)
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500);
      lines.push(`${message.toolName} error: ${error || "unknown error"}`);
    }
  }

  const transcript = lines.join("\n\n");
  return transcript.length <= 18_000
    ? transcript
    : `${transcript.slice(0, 6_000)}\n\n[… middle omitted …]\n\n${transcript.slice(-12_000)}`;
};

const stripTerminalStrings = (text: string): string => {
  let safe = "";
  for (let index = 0; index < text.length; ) {
    const code = text.charCodeAt(index);
    const next = text[index + 1] ?? "";
    const stringControl =
      (code === 27 && "]P^_X".includes(next)) ||
      code === 144 ||
      code === 152 ||
      code === 157 ||
      code === 158 ||
      code === 159;
    if (!stringControl) {
      safe += text[index];
      index++;
      continue;
    }
    index += code === 27 ? 2 : 1;
    while (index < text.length) {
      if (text.charCodeAt(index) === 7 || text.charCodeAt(index) === 156) {
        index++;
        break;
      }
      if (text.charCodeAt(index) === 27 && text[index + 1] === "\\") {
        index += 2;
        break;
      }
      index++;
    }
  }
  return safe;
};

const terminalSafe = (text: string): string =>
  Array.from(stripVTControlCharacters(stripTerminalStrings(text)))
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (
        code === 9 ||
        code === 10 ||
        code === 13 ||
        (code >= 32 &&
          code !== 127 &&
          (code < 128 || code > 159) &&
          (code < 8234 || code > 8238) &&
          (code < 8294 || code > 8297))
      );
    })
    .join("");

const oneLine = (text: string, max = 180): string =>
  terminalSafe(text)
    .replace(/^[\s#*•-]+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

const failurePatternDetail = (
  content: ToolResultMessage["content"],
  type: string,
): string => {
  const detail = textContent(content)
    .split(/\r?\n/)
    .map((line) => terminalSafe(line).trim())
    .find(
      (line) =>
        !/^[>$]/.test(line) &&
        /\b(error|fatal|fail(?:ed|ure)?|not found|no such file|timed? out|denied|invalid|cannot|unexpected|missing|stale|exited|HTTP\s+[45]\d\d)\b|[✖×]/i.test(
          line,
        ),
    );
  if (!detail) return `${type} failure`;
  const sanitized = detail
    .replace(/^Error:\s*/i, "")
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, "$1<redacted>")
    .replace(/(?:[A-Za-z]:[\\/]|~\/|\/)(?:[^\s:]+[\\/])*[^\s:]*/g, "<path>")
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "<redacted>")
    .replace(/\b\d+\b/g, "#")
    .replace(/\s*\(or any of the parent directories\)\s*/gi, " ");
  return oneLine(sanitized, 56) || `${type} failure`;
};

export const failureReview = (
  entries: SessionEntry[],
  callsByTool: Record<string, number>,
) => {
  const failuresByTool = emptyCounts();
  const byType = emptyCounts();
  const patternCounts = new Map<string, number>();
  let total = 0;
  let runs = 0;
  let recovered = 0;
  let streak = 0;
  let maxStreak = 0;
  const recover = () => {
    if (!streak) return;
    recovered++;
    streak = 0;
  };

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "toolResult") {
      if (!message.isError) {
        recover();
        continue;
      }
      if (!streak) runs++;
      streak++;
      maxStreak = Math.max(maxStreak, streak);
      total++;
      failuresByTool[message.toolName] =
        (failuresByTool[message.toolName] ?? 0) + 1;
      const type = categorizeError(message);
      byType[type] = (byType[type] ?? 0) + 1;
      const pattern = `${oneLine(message.toolName, 24)}: ${failurePatternDetail(message.content, type)}`;
      patternCounts.set(pattern, (patternCounts.get(pattern) ?? 0) + 1);
    } else if (
      message.role === "assistant" &&
      message.stopReason !== "toolUse" &&
      message.stopReason !== "error"
    ) {
      recover();
    }
  }

  const byTool = Object.entries(failuresByTool)
    .map(([name, failures]) => {
      const calls = callsByTool[name] ?? 0;
      return {
        name,
        failures,
        calls,
        rate: calls ? (failures / calls) * 100 : 0,
      };
    })
    .sort(
      (a, b) =>
        b.failures - a.failures ||
        b.rate - a.rate ||
        a.name.localeCompare(b.name),
    );
  const patterns = [...patternCounts]
    .filter(([, count]) => count > 1)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  return {
    total,
    runs,
    recovered,
    unresolved: streak ? 1 : 0,
    maxStreak,
    byTool,
    byType,
    patterns,
  };
};

export const conciseStep = (text: string, maxWords = 10): string => {
  const normalized = oneLine(text);
  const firstClause = normalized.split(";")[0]?.trim() || normalized;
  return firstClause
    .split(/\s+/)
    .slice(0, maxWords)
    .join(" ")
    .replace(/[,:-]+$/, "");
};

export const readableGoal = (text: string): string => {
  const images = [...text.matchAll(/\.(?:png|jpe?g|gif|webp)/gi)];
  const first = images[0];
  const last = images.at(-1);
  if (first?.index == null || last?.index == null) return conciseStep(text);
  const after = text.slice(last.index + last[0].length).trim();
  if (after) return conciseStep(after);
  const before = text.slice(0, first.index);
  const pathStart = before.search(/(?:^|\s)\//);
  return conciseStep(
    (pathStart < 0 ? before : before.slice(0, pathStart)).replace(
      /\bWorked on\s*$/i,
      "",
    ),
  );
};

export const isConsequentialDecision = (text: string): boolean =>
  Boolean(conciseStep(text, 14)) &&
  !/\b(?:wording|layout|labels?|icons?|tests?|refactor(?:ing)?|deferred follow-up)\b/i.test(
    text,
  ) &&
  !/\b(?:suppress|sanitize)\b.*\b(?:commands?|paths?|volatile numbers?|error summaries?)\b/i.test(
    text,
  );

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

export const parseSemanticDecision = (text: string, hasOpenStep: boolean) => {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const marker = lines[0]?.toUpperCase();
  if (hasOpenStep && marker !== "NEW" && marker !== "CONTINUE")
    return { startsNewStep: false, summary: "", decisions: [] };
  const content =
    marker === "NEW" || marker === "CONTINUE" ? lines.slice(1) : lines;
  const decisions = content
    .filter((line) => line.startsWith("DECISION:"))
    .map((line) => conciseStep(line.slice("DECISION:".length), 14))
    .filter(isConsequentialDecision);
  const summary = content.find((line) => !line.startsWith("DECISION:")) ?? "";
  return {
    startsNewStep: hasOpenStep && marker === "NEW",
    summary: conciseStep(summary),
    decisions,
  };
};

const fallbackSummary = (entries: SessionEntry[]): string => {
  let goal = "session work";
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "user") {
      goal = readableGoal(textContent(entry.message.content)) || goal;
      break;
    }
  }
  return `Worked on ${goal}; automatic step summary failed.`;
};

const compactionGoal = (summary: string): string => {
  const lines = terminalSafe(summary)
    .split(/\r?\n/)
    .map((line) => line.trim());
  const heading = lines.findIndex((line) =>
    /^#{1,6}\s*(?:current\s+)?goal\s*:?(?:\s+.*)?$/i.test(line),
  );
  if (heading < 0) return "";
  const inline = lines[heading]?.replace(
    /^#{1,6}\s*(?:current\s+)?goal\s*:?\s*/i,
    "",
  );
  if (inline) return conciseStep(inline);
  for (const line of lines.slice(heading + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    const candidate = line.replace(/^[-*]\s*(?:\[[ x]\]\s*)?/i, "");
    if (candidate) return conciseStep(candidate);
  }
  return "";
};

const isGenericContinuation = (goal: string): boolean =>
  goal.split(/\s+/).length <= 6 &&
  /^(?:co|continue|go on|proceed|resume|combine)\b/i.test(goal);

export const recoverHistoricalSteps = (
  entries: SessionEntry[],
  contextWindow: number,
): MinimapStep[] => {
  const recovered: MinimapStep[] = [];
  let segmentStart = 0;
  for (let index = 0; index < entries.length; index++) {
    const boundary = entries[index];
    if (boundary?.type !== "compaction") continue;
    const segment = entries.slice(segmentStart, index + 1);
    let userGoal = "";
    let fallbackUserGoal = "";
    for (
      let segmentIndex = segment.length - 1;
      segmentIndex >= 0;
      segmentIndex--
    ) {
      const entry = segment[segmentIndex];
      if (!entry || entry.type !== "message" || entry.message.role !== "user")
        continue;
      const text = textContent(entry.message.content);
      if (isStandaloneSkillInjection(text)) continue;
      const candidate = readableGoal(text);
      fallbackUserGoal ||= candidate;
      if (!isGenericContinuation(candidate)) {
        userGoal = candidate;
        break;
      }
    }
    const summaryGoal = compactionGoal(boundary.summary);
    const stats = collectStats(segment);
    recovered.push({
      version: STEP_VERSION,
      throughEntryId: boundary.id,
      summary:
        userGoal ||
        summaryGoal ||
        fallbackUserGoal ||
        conciseStep(boundary.summary),
      recovered: true,
      tools: stats.tools,
      skills: stats.skills,
      decisions: [],
      errors: stats.errors,
      usage: {
        input: stats.input,
        output: stats.output,
        cacheRead: stats.cacheRead,
        cacheWrite: stats.cacheWrite,
        totalTokens: stats.totalTokens,
        cost: stats.cost,
      },
      createdAt: Date.parse(boundary.timestamp) || 0,
    });
    segmentStart = index + 1;
  }

  const inferred = inferStepContexts(recovered, entries, contextWindow);
  const resets = collectContextResets(entries, contextWindow);
  const entryIndexes = new Map(
    entries.map((entry, index) => [entry.id, index]),
  );
  return inferred.map((step, index) => {
    const previous = inferred[index - 1];
    const previousIndex = previous
      ? entryIndexes.get(previous.throughEntryId)
      : undefined;
    const reset = resets.find((item) => item.entryIndex === previousIndex);
    if (reset?.afterTokens == null) return step;
    return {
      ...step,
      contextStart: {
        tokens: reset.afterTokens,
        percent: reset.afterPercent,
        contextWindow,
      },
    };
  });
};

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
  const cacheTokens = stats.input + stats.cacheRead;
  const mappedTokens = stats.agentTokens + stats.summaryTokens;
  return {
    elapsedMs:
      Number.isFinite(first) && Number.isFinite(last) ? last - first : 0,
    calls,
    cacheShare: cacheTokens ? (stats.cacheRead / cacheTokens) * 100 : 0,
    failureRate: calls ? (stats.errors / calls) * 100 : 0,
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
      const next = entry.message.toolName;
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
  >,
  contextPercent?: number | null,
  resetCount = 0,
): [string, string] => {
  const calls = Object.values(stats.tools).reduce(
    (total, count) => total + count,
    0,
  );
  const skills = Object.values(stats.skills).reduce(
    (total, count) => total + count,
    0,
  );
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
  ];
};

const resetCountLabel = (resets: ContextReset[]): string => {
  if (!resets.length) return "";
  const overflow = resets.some((reset) => (reset.beforePercent ?? 0) > 100);
  return `↻${resets.length}${overflow ? "▲" : ""}`;
};

const topCounts = (counts: Record<string, number>, limit = 3): string =>
  Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => `${oneLine(name, 24)}×${count}`)
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

class MinimapPane implements Component {
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
        step.recovered ? `≈${index + 1}` : `${index + 1}.`,
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
          `${review.total}/${efficiency.calls} (${efficiency.failureRate.toFixed(1)}%) · ${review.runs} runs · max streak ×${review.maxStreak} · ${review.recovered} recovered${review.unresolved ? " · 1 unresolved" : ""}`,
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
        (step.decisions ?? [])
          .filter(isConsequentialDecision)
          .map((decision) => ({
            label: step.recovered ? `≈${index + 1}` : `${index + 1}.`,
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
      const prefix = step.recovered ? ` ≈${index + 1}. ` : ` ${index + 1}. `;
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
        contextWindow: context.contextWindow,
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

export default function minimapExtension(pi: ExtensionAPI) {
  const state: ViewState = { steps: [] };
  let overlay: OverlayHandle | undefined;
  let pane: MinimapPane | undefined;
  let closePane: (() => void) | undefined;
  let requestRender = () => {};
  let summaryRunning = false;
  let summaryPending = false;
  let branchGeneration = 0;
  let runContextStart: ContextSnapshot | undefined;
  let expanded = false;
  let paneContext: ExtensionContext | undefined;

  const snapshotContext = (ctx: ExtensionContext): ContextSnapshot => {
    const usage = ctx.getContextUsage();
    return {
      tokens: usage?.tokens ?? null,
      percent: usage?.percent ?? null,
      contextWindow: usage?.contextWindow ?? ctx.model?.contextWindow ?? 0,
    };
  };

  const mergeCounts = (
    previous: Record<string, number>,
    next: Record<string, number>,
  ): Record<string, number> => {
    const merged = Object.assign(emptyCounts(), previous);
    for (const [name, count] of Object.entries(next))
      merged[name] = (merged[name] ?? 0) + count;
    return merged;
  };

  const mergeUsage = (
    previous: UsageSnapshot,
    next: UsageSnapshot,
  ): UsageSnapshot => {
    const merged = { ...previous };
    addUsage(merged, next);
    return merged;
  };

  const restore = (ctx: ExtensionContext) => {
    const branch = ctx.sessionManager.getBranch();
    const restored = restoreSavedState(branch, ctx.model?.contextWindow ?? 0);
    state.steps = restored.steps;
    state.open = restored.open;
  };

  const appendOpenState = (callUsage: UsageSnapshot) => {
    const data: OpenStateData = {
      version: STEP_VERSION,
      open: state.open,
      callUsage,
    };
    pi.appendEntry(STATE_ENTRY_TYPE, data);
  };

  const finalizeOpen = (open: OpenStep) => {
    const step: MinimapStep = {
      version: STEP_VERSION,
      throughEntryId: open.throughEntryId,
      summary: open.summary,
      tools: open.tools,
      skills: open.skills,
      decisions: open.decisions,
      errors: open.errors,
      usage: open.usage,
      contextStart: open.contextStart,
      contextEnd: open.contextEnd,
      createdAt: open.createdAt,
    };
    pi.appendEntry(ENTRY_TYPE, step);
    state.steps.push(step);
  };

  const openPane = (ctx: ExtensionContext, hidden = false) => {
    if (ctx.mode !== "tui") return;
    paneContext = ctx;
    const promise = ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) => {
        closePane = () => done(undefined);
        requestRender = () => tui.requestRender();
        pane = new MinimapPane(
          tui,
          theme,
          state,
          () => ctx.sessionManager.getBranch(),
          () => ctx.getContextUsage(),
          expanded,
        );
        return pane;
      },
      {
        overlay: true,
        overlayOptions: minimapOverlayOptions(expanded),
        onHandle: (handle) => {
          overlay = handle;
          handle.setHidden(hidden);
        },
      },
    );
    void promise.catch(() => {
      closePane = undefined;
      overlay = undefined;
      pane = undefined;
      ctx.ui.notify("Session minimap failed to open", "error");
    });
  };

  const reopenPane = () => {
    if (!paneContext) return;
    const hidden = overlay?.isHidden() ?? false;
    closePane?.();
    closePane = undefined;
    overlay = undefined;
    pane = undefined;
    openPane(paneContext, hidden);
  };

  const updateSemanticMap = async (ctx: ExtensionContext): Promise<boolean> => {
    if (summaryRunning) {
      summaryPending = true;
      return false;
    }
    if (!ctx.model) return false;
    const generation = branchGeneration;
    const branch = ctx.sessionManager.getBranch();
    const previousThrough =
      state.open?.throughEntryId ?? state.steps.at(-1)?.throughEntryId;
    const pending = entriesAfter(branch, previousThrough);
    if (
      !pending.some(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "user" &&
          !isStandaloneSkillInjection(textContent(entry.message.content)),
      )
    )
      return true;
    const throughEntryId = branch.at(-1)?.id;
    if (!throughEntryId) return true;

    summaryRunning = true;
    const previousCurrent = state.current;
    state.current = {
      label:
        previousCurrent?.label ?? state.open?.summary ?? "Updating session map",
      tools: previousCurrent?.tools ?? emptyCounts(),
      errors: previousCurrent?.errors ?? 0,
    };
    requestRender();

    let decision = {
      startsNewStep: false,
      summary: state.open?.summary ?? fallbackSummary(pending),
      decisions: [] as string[],
    };
    let callUsage = emptyUsage();
    let summaryFailed = false;
    try {
      const prompt = [
        "CURRENT STEP:",
        state.open?.summary ?? "(none yet)",
        "CURRENT DECISIONS:",
        ...(state.open?.decisions ?? []).map((item) => `- ${item}`),
        "RECENT SETTLED STEPS:",
        ...state.steps
          .slice(-5)
          .map(
            (step, index) =>
              `${Math.max(0, state.steps.length - 5) + index + 1}: ${step.summary}`,
          ),
        "",
        "NEW ACTIVITY:",
        buildTranscript(pending),
      ].join("\n");
      const response = await ctx.modelRegistry.complete(
        ctx.model,
        {
          systemPrompt: SUMMARY_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: prompt }],
              timestamp: Date.now(),
            },
          ],
        },
        {
          cacheRetention: "none",
          maxTokens: 256,
          timeoutMs: SUMMARY_TIMEOUT_MS,
        },
      );
      callUsage = usageSnapshot(response.usage);
      if (response.stopReason === "error")
        throw new Error(response.errorMessage || "model error");
      decision = parseSemanticDecision(
        textContent(response.content),
        Boolean(state.open),
      );
      if (!decision.summary) throw new Error("empty model response");
    } catch {
      summaryFailed = true;
    }
    if (generation !== branchGeneration) {
      state.current = undefined;
      summaryRunning = false;
      requestRender();
      return false;
    }
    if (summaryFailed) {
      pi.appendEntry(STATE_ENTRY_TYPE, {
        version: STEP_VERSION,
        callUsage,
        usageOnly: true,
      });
      if (ctx.hasUI)
        ctx.ui.notify(
          "Minimap summary failed; it will retry after the next run",
          "warning",
        );
      state.current = undefined;
      summaryRunning = false;
      requestRender();
      return false;
    }

    const now = snapshotContext(ctx);
    const runStart =
      runContextStart ??
      state.open?.contextEnd ??
      state.steps.at(-1)?.contextEnd ??
      now;
    const runStats = collectStepStats(pending);

    if (decision.startsNewStep && state.open) {
      const semanticStart = state.open.contextEnd;
      finalizeOpen(state.open);
      state.open = {
        summary: decision.summary,
        throughEntryId,
        tools: runStats.tools,
        skills: runStats.skills,
        decisions: decision.decisions,
        errors: runStats.errors,
        usage: runStats.usage,
        contextStart: semanticStart,
        contextEnd: now,
        createdAt: Date.now(),
      };
    } else if (state.open) {
      state.open = {
        ...state.open,
        summary: decision.summary,
        throughEntryId,
        tools: mergeCounts(state.open.tools, runStats.tools),
        skills: mergeCounts(state.open.skills, runStats.skills),
        decisions: Array.from(
          new Set([...(state.open.decisions ?? []), ...decision.decisions]),
        ),
        errors: state.open.errors + runStats.errors,
        usage: mergeUsage(state.open.usage, runStats.usage),
        contextEnd: now,
      };
    } else {
      state.open = {
        summary: decision.summary,
        throughEntryId,
        tools: runStats.tools,
        skills: runStats.skills,
        decisions: decision.decisions,
        errors: runStats.errors,
        usage: runStats.usage,
        contextStart: runStart,
        contextEnd: now,
        createdAt: Date.now(),
      };
    }

    appendOpenState(callUsage);
    state.current = undefined;
    runContextStart = undefined;
    summaryRunning = false;
    requestRender();
    return true;
  };

  const reconcileSemanticMap = async (
    ctx: ExtensionContext,
  ): Promise<boolean> => {
    try {
      while (true) {
        const mapped = await updateSemanticMap(ctx);
        if (summaryPending && !summaryRunning) {
          summaryPending = false;
          continue;
        }
        return mapped;
      }
    } catch {
      summaryRunning = false;
      summaryPending = false;
      state.current = undefined;
      restore(ctx);
      requestRender();
      if (ctx.hasUI)
        ctx.ui.notify(
          "Minimap update failed; it will retry after the next run",
          "warning",
        );
      return false;
    }
  };

  pi.registerCommand("minimap", {
    description: "Toggle the session minimap side pane",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui" || !overlay) {
        if (ctx.hasUI)
          ctx.ui.notify("Minimap requires interactive mode", "warning");
        return;
      }
      overlay.setHidden(!overlay.isHidden());
    },
  });

  pi.registerShortcut("ctrl+shift+k", {
    description: "Scroll minimap up",
    handler: () => pane?.scrollBy(-3),
  });
  pi.registerShortcut("ctrl+shift+j", {
    description: "Scroll minimap down",
    handler: () => pane?.scrollBy(3),
  });
  pi.registerShortcut("ctrl+shift+m", {
    description: "Expand or compact minimap",
    handler: () => {
      expanded = !expanded;
      reopenPane();
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    branchGeneration++;
    restore(ctx);
    openPane(ctx);
    requestRender();
    await reconcileSemanticMap(ctx);
  });

  pi.on("before_agent_start", (_event, ctx) => {
    runContextStart ??= snapshotContext(ctx);
    state.current = {
      label: state.open?.summary ?? "Starting semantic step",
      tools: emptyCounts(),
      errors: 0,
    };
    requestRender();
  });

  pi.on("tool_execution_start", (event) => {
    if (!state.current) return;
    state.current.tools[event.toolName] =
      (state.current.tools[event.toolName] ?? 0) + 1;
    requestRender();
  });

  pi.on("tool_execution_end", (event) => {
    if (!state.current) return;
    if (event.isError) {
      state.current.errors++;
    }
    requestRender();
  });

  pi.on("message_end", () => requestRender());
  pi.on("session_compact", (_event, _ctx) => requestRender());
  pi.on("model_select", (_event, _ctx) => requestRender());

  pi.on("agent_settled", async (_event, ctx) => {
    let mapped = false;
    try {
      mapped = await reconcileSemanticMap(ctx);
    } finally {
      state.current = undefined;
      if (mapped) runContextStart = undefined;
      requestRender();
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    branchGeneration++;
    restore(ctx);
    state.current = undefined;
    runContextStart = undefined;
    requestRender();
    await reconcileSemanticMap(ctx);
  });

  pi.on("session_shutdown", () => {
    closePane?.();
    closePane = undefined;
    overlay = undefined;
    pane = undefined;
    paneContext = undefined;
    requestRender = () => {};
  });
}
