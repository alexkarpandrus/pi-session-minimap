import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const STATE_ENTRY_TYPE = "session-minimap-state";
export const STEP_VERSION = 1;

export type UsageSnapshot = Pick<
  Usage,
  "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens"
> & {
  cost: number;
};

export interface ContextSnapshot {
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
  skills: Record<string, number>;
  decisions: string[];
  errors: number;
  usage: UsageSnapshot;
  contextStart: ContextSnapshot;
  contextEnd: ContextSnapshot;
  createdAt: number;
}

export type OpenStep = Omit<MinimapStep, "version">;

export interface StepRevision {
  replaceCount: number;
  steps: MinimapStep[];
}

export type TailSource = Pick<
  OpenStep,
  "throughEntryId" | "decisions" | "contextStart" | "contextEnd" | "createdAt"
>;

export type MinimapStateData = {
  version: 1;
  callUsage: UsageSnapshot;
} & (
  | {
      revision: StepRevision;
      open?: OpenStep;
      usageOnly?: never;
    }
  | {
      usageOnly: true;
      open?: never;
      revision?: never;
    }
);

export interface SessionStats extends UsageSnapshot {
  tools: Record<string, number>;
  skills: Record<string, number>;
  errors: number;
  errorKinds: Record<string, number>;
  agentTokens: number;
  summaryTokens: number;
  toolTokens: Record<string, number>;
}

export interface CurrentStep {
  label: string;
  tools: Record<string, number>;
  errors: number;
}

export interface ViewState {
  steps: MinimapStep[];
  open: OpenStep | undefined;
  current: CurrentStep | undefined;
}

export const emptyUsage = (): UsageSnapshot => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: 0,
});

export const emptyCounts = (): Record<string, number> =>
  Object.create(null) as Record<string, number>;

export const usageSnapshot = (usage?: Usage): UsageSnapshot =>
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

export const addUsage = (
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

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

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
  isStringArray(value.decisions) &&
  isFiniteNumber(value.errors) &&
  isUsageSnapshot(value.usage) &&
  isContextSnapshot(value.contextStart) &&
  isContextSnapshot(value.contextEnd) &&
  isFiniteNumber(value.createdAt);

const isMinimapStep = (value: unknown): value is MinimapStep =>
  isRecord(value) && value.version === STEP_VERSION && isOpenStep(value);

const isStepRevision = (value: unknown): value is StepRevision =>
  isRecord(value) &&
  isNonNegativeSafeInteger(value.replaceCount) &&
  Array.isArray(value.steps) &&
  value.steps.every(isMinimapStep);

const isMinimapStateData = (value: unknown): value is MinimapStateData => {
  if (
    !isRecord(value) ||
    value.version !== STEP_VERSION ||
    !isUsageSnapshot(value.callUsage)
  )
    return false;
  if (value.usageOnly === true)
    return value.open === undefined && value.revision === undefined;
  return (
    value.usageOnly === undefined &&
    (value.open === undefined || isOpenStep(value.open)) &&
    isStepRevision(value.revision)
  );
};

export const stateFromEntry = (
  entry: SessionEntry,
): MinimapStateData | undefined =>
  entry.type === "custom" &&
  entry.customType === STATE_ENTRY_TYPE &&
  isMinimapStateData(entry.data)
    ? entry.data
    : undefined;

export const restoreSavedState = (
  branch: SessionEntry[],
): Pick<ViewState, "steps" | "open"> => {
  const steps: MinimapStep[] = [];
  let open: OpenStep | undefined;
  for (const entry of branch) {
    const checkpoint = stateFromEntry(entry);
    if (!checkpoint) continue;
    if (checkpoint.revision) {
      if (checkpoint.revision.replaceCount > steps.length) continue;
      steps.splice(
        steps.length - checkpoint.revision.replaceCount,
        checkpoint.revision.replaceCount,
        ...checkpoint.revision.steps,
      );
    }
    if (!checkpoint.usageOnly) open = checkpoint.open;
  }
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
