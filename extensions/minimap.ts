import type {
  ExtensionAPI,
  ExtensionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import {
  STATE_ENTRY_TYPE,
  STEP_VERSION,
  emptyCounts,
  emptyUsage,
  entriesAfter,
  restoreSavedState,
  stateFromEntry,
  usageSnapshot,
  type ContextSnapshot,
  type MinimapStateData,
  type TailSource,
  type ViewState,
} from "./minimap/state.ts";
import { textContent } from "./minimap/diagnostics.ts";
import {
  MAX_PENDING_SOURCES,
  MAX_TRANSCRIPT_CHARS,
  SUMMARY_SYSTEM_PROMPT,
  SUMMARY_TIMEOUT_MS,
  buildTranscript,
  parseTailPlan,
  reconcileTail,
  splitPendingActivity,
} from "./minimap/summary.ts";
import { MinimapPane, minimapOverlayOptions } from "./minimap/pane.ts";

export {
  categorizeError,
  collectContextResets,
  collectStats,
  conciseStep,
  extractSkills,
  failureReview,
  isConsequentialDecision,
  isStandaloneSkillInjection,
  readableGoal,
} from "./minimap/diagnostics.ts";
export {
  entriesAfter,
  restoreSavedState,
  type ContextReset,
  type MinimapStep,
} from "./minimap/state.ts";
export {
  SUMMARY_SYSTEM_PROMPT,
  parseTailPlan,
} from "./minimap/summary.ts";
export {
  alignScrollStart,
  compactMetrics,
  contextRangeLabel,
  dashboardContextLabel,
  elapsedLabel,
  meterBar,
  minimapHeight,
  minimapOverlayOptions,
  minimapStatus,
  scrollWindow,
  sessionEfficiency,
  trailingFailureStreak,
  wrapStepSummary,
} from "./minimap/pane.ts";

export default function minimapExtension(pi: ExtensionAPI) {
  const state: ViewState = { steps: [], open: undefined, current: undefined };
  let overlay: OverlayHandle | undefined;
  let pane: MinimapPane | undefined;
  let closePane: (() => void) | undefined;
  let requestRender = () => {};
  let summaryRunning = false;
  let summaryPending = false;
  let summaryAbort: AbortController | undefined;
  let branchGeneration = 0;
  let runContextStart: ContextSnapshot | undefined;
  let expanded = false;
  let paneContext: ExtensionContext | undefined;
  let pendingPersistence:
    | { generation: number; data: MinimapStateData }
    | undefined;

  const snapshotContext = (ctx: ExtensionContext): ContextSnapshot => {
    const usage = ctx.getContextUsage();
    return {
      tokens: usage?.tokens ?? null,
      percent: usage?.percent ?? null,
    };
  };

  const restore = (ctx: ExtensionContext) => {
    const branch = ctx.sessionManager.getBranch();
    const restored = restoreSavedState(branch);
    state.steps = restored.steps;
    state.open = restored.open;
  };

  const appendPersistedState = (
    ctx: ExtensionContext,
    data: MinimapStateData,
  ) => {
    // The extension API is read-only, but pi uses a SessionManager at runtime and
    // mutates its leaf before a failed append returns. Roll that mutation back.
    const mutableSessionManager = ctx.sessionManager as SessionManager;
    const previousLeaf = ctx.sessionManager.getBranch().at(-1)?.id;
    try {
      pi.appendEntry(STATE_ENTRY_TYPE, data);
    } catch (error) {
      if (ctx.sessionManager.getBranch().at(-1)?.id !== previousLeaf) {
        if (previousLeaf) mutableSessionManager.branch(previousLeaf);
        else mutableSessionManager.resetLeaf();
      }
      throw error;
    }
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
    const generation = branchGeneration;
    if (pendingPersistence) {
      if (pendingPersistence.generation !== generation) {
        pendingPersistence = undefined;
      } else {
        appendPersistedState(ctx, pendingPersistence.data);
        pendingPersistence = undefined;
        restore(ctx);
        state.current = undefined;
        requestRender();
      }
    }
    if (!ctx.model) return false;
    const branch = ctx.sessionManager.getBranch();
    const openAtStart = state.open;
    const recentSteps = state.steps.slice(-5);
    const settledPrefixCount = state.steps.length - recentSteps.length;
    const previousThrough =
      openAtStart?.throughEntryId ?? state.steps.at(-1)?.throughEntryId;
    const pending = entriesAfter(branch, previousThrough);
    const pendingSegments = splitPendingActivity(pending);
    if (!pendingSegments.length) return true;
    const newSegments = pendingSegments.slice(0, MAX_PENDING_SOURCES);
    const newSourceIds = newSegments.map((_segment, index) =>
      newSegments.length === 1 ? "NEW" : `N${index + 1}`,
    );
    const sourceIds = [
      ...recentSteps.map((_step, index) => `S${index + 1}`),
      ...(openAtStart ? ["CURRENT"] : []),
      ...newSourceIds,
    ];
    summaryRunning = true;
    const previousCurrent = state.current;
    state.current = {
      label:
        previousCurrent?.label ??
        openAtStart?.summary ??
        "Updating session map",
      tools: previousCurrent?.tools ?? emptyCounts(),
      errors: previousCurrent?.errors ?? 0,
    };
    requestRender();

    let plan: ReturnType<typeof parseTailPlan>;
    let callUsage = emptyUsage();
    const controller = new AbortController();
    summaryAbort = controller;
    try {
      const prompt = [
        "ORDERED SOURCES:",
        ...recentSteps.map((step, index) => `S${index + 1}: ${step.summary}`),
        ...(openAtStart ? [`CURRENT: ${openAtStart.summary}`] : []),
        ...(openAtStart?.decisions.length
          ? [
              "CURRENT DECISIONS (metadata only)",
              ...openAtStart.decisions.map((item) => `- ${item}`),
            ]
          : []),
        ...newSegments.flatMap((segment, index) => [
          "",
          `${newSourceIds[index]}:`,
          buildTranscript(
            segment,
            Math.floor(MAX_TRANSCRIPT_CHARS / newSegments.length),
          ),
        ]),
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
          maxTokens: Math.min(2_048, Math.max(256, sourceIds.length * 24)),
          timeoutMs: SUMMARY_TIMEOUT_MS,
          signal: controller.signal,
        },
      );
      callUsage = usageSnapshot(response.usage);
      if (response.stopReason === "error")
        throw new Error(response.errorMessage || "model error");
      plan = parseTailPlan(textContent(response.content), sourceIds);
      if (!plan) throw new Error("invalid minimap tail plan");
    } catch {
      plan = undefined;
    } finally {
      if (summaryAbort === controller) summaryAbort = undefined;
    }
    if (generation !== branchGeneration) {
      state.current = undefined;
      summaryRunning = false;
      requestRender();
      return false;
    }
    if (!plan) {
      appendPersistedState(ctx, {
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
    const unknownContext: ContextSnapshot = {
      tokens: null,
      percent: null,
    };
    const runStart =
      runContextStart ??
      openAtStart?.contextEnd ??
      state.steps.at(-1)?.contextEnd ??
      now;
    const createdAt = Date.now();
    const sources: TailSource[] = [
      ...recentSteps,
      ...(openAtStart ? [openAtStart] : []),
      ...newSegments.map((segment, index) => {
        const last = segment.filter((entry) => !stateFromEntry(entry)).at(-1);
        if (!last) throw new Error("minimap new activity source is empty");
        const sourceCreatedAt = Date.parse(
          segment.find(
            (entry) =>
              entry.type === "message" && entry.message.role === "user",
          )?.timestamp ?? "",
        );
        const isLast = index === newSegments.length - 1;
        return {
          throughEntryId: last.id,
          decisions: [],
          contextStart: isLast ? runStart : unknownContext,
          contextEnd: isLast ? now : unknownContext,
          createdAt: Number.isFinite(sourceCreatedAt)
            ? sourceCreatedAt
            : createdAt,
        };
      }),
    ];
    const boundary =
      settledPrefixCount > 0
        ? state.steps[settledPrefixCount - 1]?.throughEntryId
        : undefined;
    const { completed, open } = reconcileTail(branch, boundary, sources, plan);
    const data: MinimapStateData = {
      version: STEP_VERSION,
      open,
      revision: {
        replaceCount: recentSteps.length,
        steps: completed,
      },
      callUsage,
    };
    try {
      appendPersistedState(ctx, data);
    } catch (error) {
      pendingPersistence = { generation, data };
      runContextStart = undefined;
      throw error;
    }
    state.steps.splice(settledPrefixCount, recentSteps.length, ...completed);
    state.open = open;
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
  pi.on("model_select", async (_event, ctx) => {
    requestRender();
    if (ctx.isIdle()) await reconcileSemanticMap(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!ctx.isIdle()) return;
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
    summaryAbort?.abort();
    summaryAbort = undefined;
    restore(ctx);
    state.current = undefined;
    runContextStart = undefined;
    requestRender();
    await reconcileSemanticMap(ctx);
  });

  pi.on("session_shutdown", () => {
    branchGeneration++;
    summaryAbort?.abort();
    summaryAbort = undefined;
    closePane?.();
    closePane = undefined;
    overlay = undefined;
    pane = undefined;
    paneContext = undefined;
    requestRender = () => {};
  });
}
