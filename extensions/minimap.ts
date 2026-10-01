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
  addUsage,
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
import {
  isStandaloneSkillInjection,
  readableGoal,
  oneLine,
  textContent,
} from "./minimap/diagnostics.ts";
import {
  decideMilestoneBoundary,
  type MilestoneBoundaryDecision,
} from "./minimap/jev.ts";
import {
  LIVE_DIRECTION_SYSTEM_PROMPT,
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
  let directionAbort: AbortController | undefined;
  let directionPending = false;
  let directionThroughEntryId: string | undefined;
  let branchGeneration = 0;
  let runContextStart: ContextSnapshot | undefined;
  let expanded = false;
  let streamingActivity = false;
  let paneContext: ExtensionContext | undefined;
  let pendingPersistence:
    | {
        generation: number;
        data: MinimapStateData;
        current: ViewState["current"];
        direction?: { throughEntryId: string | undefined; label: string | undefined } | undefined;
      }
    | undefined;

  const snapshotContext = (ctx: ExtensionContext): ContextSnapshot => {
    const usage = ctx.getContextUsage();
    return {
      tokens: usage?.tokens ?? null,
      percent: usage?.percent ?? null,
    };
  };

  const updateActivity = (phase: string, text?: string, replace = false) => {
    const current = state.current;
    if (!current) return;
    if (current.phase?.label !== phase)
      current.phase = { label: phase, startedAt: Date.now() };
    if (text !== undefined) {
      const activity = (current.activity ??= []);
      // ponytail: inspect at most 320 source chars; widen for ANSI-heavy prefixes.
      const preview = oneLine(text.slice(0, 320), 160).replace(/[\uD800-\uDBFF]$/u, "");
      if (replace && activity.length) activity[activity.length - 1] = preview;
      else activity.push(preview);
      current.activity = activity.slice(-3);
    }
    requestRender();
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

  const flushPersistence = (ctx: ExtensionContext) => {
    const pending = pendingPersistence;
    if (!pending) return;
    if (pending.generation !== branchGeneration) {
      pendingPersistence = undefined;
      return;
    }
    appendPersistedState(ctx, pending.data);
    if (pending.data.revision) {
      const { replaceCount, steps } = pending.data.revision;
      state.steps.splice(state.steps.length - replaceCount, replaceCount, ...steps);
      state.open = pending.data.open;
    }
    if (pending.direction) {
      directionThroughEntryId = pending.direction.throughEntryId;
      if (pending.direction.label && state.current && state.current === pending.current)
        state.current.label = pending.direction.label;
    }
    pendingPersistence = undefined;
    if (pending.data.revision || pending.direction?.label) requestRender();
  };

  const persist = (
    ctx: ExtensionContext,
    data: MinimapStateData,
    direction?: { throughEntryId: string | undefined; label: string | undefined },
  ) => {
    if (pendingPersistence?.generation === branchGeneration && data.usageOnly) {
      addUsage(pendingPersistence.data.callUsage, data.callUsage);
      flushPersistence(ctx);
      return;
    }
    pendingPersistence = { generation: branchGeneration, data, direction, current: state.current };
    flushPersistence(ctx);
  };

  const startStep = (
    ctx: ExtensionContext,
    label: string,
    throughEntryId: string,
    previousThrough: string | undefined,
    callUsage = emptyUsage(),
    direction?: { throughEntryId: string | undefined; label: string | undefined },
  ) => {
    const branch = ctx.sessionManager.getBranch();
    const now = snapshotContext(ctx);
    const start = direction ? now : (runContextStart ?? now);
    const sources: TailSource[] = [
      ...(state.open
        ? [{ ...state.open, throughEntryId: previousThrough ?? state.open.throughEntryId, contextEnd: start }]
        : []),
      {
        throughEntryId, decisions: [], contextStart: start, contextEnd: now,
        createdAt: Date.parse(branch.find((entry) => entry.id === throughEntryId)!.timestamp),
      },
    ];
    const { completed, open } = reconcileTail(
      branch, state.steps.at(-1)?.throughEntryId, sources,
      {
        groups: [
          ...(state.open ? [{ sources: ["CURRENT"], summary: state.open.summary }] : []),
          { sources: ["NEW"], summary: label },
        ],
        decisions: [],
      },
    );
    persist(ctx, {
      version: STEP_VERSION, revision: { replaceCount: 0, steps: completed }, open, callUsage,
    }, direction);
  };

  const captureSteering = (ctx: ExtensionContext) => {
    flushPersistence(ctx);
    const branch = ctx.sessionManager.getBranch();
    const pending = entriesAfter(branch, state.open?.throughEntryId ?? state.steps.at(-1)?.throughEntryId);
    for (const [index, entry] of pending.entries()) {
      if (entry.type !== "message" || entry.message.role !== "user") continue;
      const label = readableGoal(textContent(entry.message.content));
      if (!label || isStandaloneSkillInjection(textContent(entry.message.content))) continue;
      const previous = pending[index - 1] ?? branch[branch.indexOf(entry) - 1];
      startStep(ctx, label, entry.id, previous?.id);
      directionThroughEntryId = entry.id;
    }
  };

  const cancelDirectionUpdate = () => {
    directionAbort?.abort();
    directionAbort = undefined;
    directionPending = false;
    directionThroughEntryId = undefined;
  };

  const updateLiveDirection = async (ctx: ExtensionContext): Promise<void> => {
    const current = state.current;
    if (ctx.mode !== "tui" || !ctx.model || !current || summaryRunning) return;
    if (directionAbort) {
      directionPending = true;
      return;
    }
    try { captureSteering(ctx); } catch {
      if (ctx.hasUI) ctx.ui.notify("Minimap checkpoint failed; persistence will retry before another model call", "warning");
      return;
    }
    const pending = entriesAfter(
      ctx.sessionManager.getBranch(), directionThroughEntryId,
    );
    const throughEntryId = pending.at(-1)?.id;
    const transcript = buildTranscript(pending, MAX_TRANSCRIPT_CHARS, "live");
    if (!transcript) {
      directionThroughEntryId = throughEntryId ?? directionThroughEntryId;
      return;
    }
    const generation = branchGeneration;
    const controller = new AbortController();
    directionAbort = controller;
    try {
      const response = await ctx.modelRegistry.complete(
        ctx.model,
        {
          systemPrompt: LIVE_DIRECTION_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [{
                type: "text",
                text: `CURRENT MILESTONE: ${current.label}\n\nPUBLIC ACTIVITY:\n${transcript}`,
              }],
              timestamp: Date.now(),
            },
          ],
        },
        {
          cacheRetention: "none",
          maxTokens: 256,
          timeoutMs: SUMMARY_TIMEOUT_MS,
          signal: controller.signal,
        },
      );
      // Keep published boundaries intact, and never overwrite another run.
      if (
        controller.signal.aborted || generation !== branchGeneration ||
        state.current !== current
      ) return;
      const callUsage = usageSnapshot(response.usage);
      const text = textContent(response.content).trim();
      const plan = response.stopReason !== "error" && response.stopReason !== "aborted"
        ? parseTailPlan(text, ["NEW"]) : undefined;
      const valid = text === "UNCHANGED" || (plan && !plan.decisions.length);
      const label = valid ? plan?.groups[0]?.summary : undefined;
      const direction = valid ? { throughEntryId, label } : undefined;
      if (label && label !== current.label && throughEntryId) {
        startStep(ctx, label, throughEntryId, directionThroughEntryId, callUsage, direction);
      } else {
        persist(ctx, { version: STEP_VERSION, usageOnly: true, callUsage }, direction);
      }
    } catch {
      if (pendingPersistence && ctx.hasUI)
        ctx.ui.notify("Minimap checkpoint failed; persistence will retry before another model call", "warning");
    } finally {
      if (directionAbort === controller) {
        directionAbort = undefined;
        if (directionPending) {
          directionPending = false;
          void updateLiveDirection(ctx);
        }
      }
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
    captureSteering(ctx);
    if (!ctx.model) return false;
    const branch = ctx.sessionManager.getBranch();
    let openAtStart = state.open;
    const checkpointOpen = state.open;
    const settledPrefixCount = state.steps.length;
    const previousThrough =
      openAtStart?.throughEntryId ?? state.steps.at(-1)?.throughEntryId;
    let pendingSegments = splitPendingActivity(
      entriesAfter(branch, previousThrough),
    );
    let rebuildingOpen = false;
    if (!pendingSegments.length && openAtStart) {
      const openSegments = splitPendingActivity(
        entriesAfter(branch, state.steps.at(-1)?.throughEntryId),
      );
      if (openSegments.length > 1) {
        pendingSegments = openSegments;
        openAtStart = undefined;
        rebuildingOpen = true;
      }
    }
    if (!pendingSegments.length) return true;
    const newSegments = pendingSegments.slice(0, MAX_PENDING_SOURCES);
    const newSourceIds = newSegments.map((_segment, index) =>
      newSegments.length === 1 ? "NEW" : `N${index + 1}`,
    );
    const sourceIds = [
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
      phase: { label: "Updating milestones", startedAt: Date.now() },
      activity: previousCurrent?.activity ?? [],
    };
    const summaryCurrent = state.current;
    requestRender();

    let plan: ReturnType<typeof parseTailPlan>;
    let callUsage = emptyUsage();
    const controller = new AbortController();
    summaryAbort = controller;
    try {
      const current = openAtStart;
      let boundaryDecision: MilestoneBoundaryDecision = "uncertain";
      const apiKey =
        process.env.PI_MINIMAP_JEV === "1"
          ? process.env.TYPESAFE_API_KEY
          : undefined;
      if (current && !rebuildingOpen && apiKey) {
        boundaryDecision = await decideMilestoneBoundary(
          {
            currentMilestone: current.summary,
            newActivity: newSegments.map((segment) =>
              buildTranscript(
                segment,
                Math.floor(MAX_TRANSCRIPT_CHARS / newSegments.length),
              ),
            ),
          },
          {
            apiKey,
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
            ]),
          },
        );
      }

      if (boundaryDecision === "merge" && current) {
        plan = {
          groups: [
            {
              sources: ["CURRENT", ...newSourceIds],
              summary: current.summary,
            },
          ],
          decisions: [],
        };
      } else {
        const prompt = [
          "ORDERED SOURCES:",
          ...(current ? [`CURRENT: ${current.summary}`] : []),
          ...(current?.decisions.length
            ? [
                "CURRENT DECISIONS (metadata only)",
                ...current.decisions.map((item) => `- ${item}`),
              ]
            : []),
          ...newSegments.flatMap((segment, index) => {
            const userSteered = segment.some(
              (entry) =>
                entry.type === "message" &&
                entry.message.role === "user" &&
                !isStandaloneSkillInjection(textContent(entry.message.content)),
            );
            return [
              "",
              `${newSourceIds[index]}:`,
              `SOURCE KIND: ${userSteered ? "user-steered run start" : "agent-directed continuation"}`,
              buildTranscript(
                segment,
                Math.floor(MAX_TRANSCRIPT_CHARS / newSegments.length),
              ),
            ];
          }),
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
      }
    } catch {
      plan = undefined;
    } finally {
      if (summaryAbort === controller) summaryAbort = undefined;
    }
    if (generation !== branchGeneration) {
      if (state.current === summaryCurrent) state.current = undefined;
      summaryRunning = false;
      requestRender();
      return false;
    }
    if (state.current !== summaryCurrent || state.open !== checkpointOpen || state.steps.length !== settledPrefixCount) {
      persist(ctx, { version: STEP_VERSION, usageOnly: true, callUsage });
      summaryRunning = false;
      return false;
    }
    if (!plan) {
      persist(ctx, {
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
      (rebuildingOpen ? state.open?.contextStart : openAtStart?.contextEnd) ??
      state.steps.at(-1)?.contextEnd ??
      now;
    const createdAt = Date.now();
    const sources: TailSource[] = [
      ...(openAtStart ? [openAtStart] : []),
      ...newSegments.map((segment, index) => {
        const last = segment.filter((entry) => !stateFromEntry(entry)).at(-1);
        if (!last) throw new Error("minimap new activity source is empty");
        const sourceCreatedAt = Date.parse(
          segment.find((entry) => entry.type === "message")?.timestamp ?? "",
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
        replaceCount: 0,
        steps: completed,
      },
      callUsage,
    };
    persist(ctx, data);
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
      if (ctx.isIdle()) state.current = undefined;
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

  pi.on("session_start", (_event, ctx) => {
    branchGeneration++;
    cancelDirectionUpdate();
    restore(ctx);
    openPane(ctx);
    requestRender();
    void reconcileSemanticMap(ctx);
  });

  pi.on("before_agent_start", (event, ctx) => {
    cancelDirectionUpdate();
    directionThroughEntryId = ctx.sessionManager.getBranch().at(-1)?.id;
    runContextStart = snapshotContext(ctx);
    streamingActivity = false;
    state.current = {
      label:
        readableGoal(event.prompt) ||
        state.open?.summary ||
        "Starting semantic step",
      tools: emptyCounts(),
      errors: 0,
      phase: { label: "Starting", startedAt: Date.now() },
      activity: [],
    };
    requestRender();
  });

  pi.on("message_start", (event) => {
    if (event.message.role !== "assistant") return;
    streamingActivity = false;
    updateActivity("Generating response");
  });

  pi.on("message_update", (event) => {
    const update = event.assistantMessageEvent;
    switch (update.type) {
      case "thinking_start":
      case "thinking_delta":
        updateActivity("Thinking");
        break;
      case "text_start":
        streamingActivity = false;
        updateActivity("Responding");
        break;
      case "text_delta": {
        const block = update.partial.content[update.contentIndex];
        if (block?.type === "text") {
          updateActivity("Responding", block.text, streamingActivity);
          streamingActivity = true;
        }
        break;
      }
      case "toolcall_start":
        updateActivity("Preparing tool call");
        break;
    }
  });

  pi.on("tool_execution_start", (event) => {
    if (!state.current) return;
    state.current.tools[event.toolName] =
      (state.current.tools[event.toolName] ?? 0) + 1;
    const activity = `Running ${oneLine(event.toolName, 24)}`;
    updateActivity(activity, activity);
  });

  pi.on("tool_execution_end", (event) => {
    if (!state.current) return;
    if (event.isError) {
      state.current.errors++;
    }
    const activity = `${event.isError ? "Failed" : "Finished"} ${oneLine(event.toolName, 24)}`;
    updateActivity(activity, activity);
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role === "user") {
      const label = readableGoal(textContent(event.message.content));
      if (label && !isStandaloneSkillInjection(textContent(event.message.content))) {
        cancelDirectionUpdate();
        runContextStart = snapshotContext(ctx);
        if (state.current) state.current = { ...state.current, label };
      }
    }
    if (event.message.role === "assistant") {
      if (event.message.stopReason === "aborted") updateActivity("Aborted");
      else if (event.message.stopReason === "error") updateActivity("Response failed");
    }
    requestRender();
  });
  pi.on("turn_end", (event, ctx) => {
    try { captureSteering(ctx); } catch {
      if (ctx.hasUI) ctx.ui.notify("Minimap checkpoint failed; it will retry after the next turn", "warning");
      return;
    }
    if (event.message.role !== "assistant" || !event.toolResults.length) return;
    void updateLiveDirection(ctx);
  });
  pi.on("session_compact", (_event, _ctx) => requestRender());
  pi.on("model_select", async (_event, ctx) => {
    requestRender();
    if (ctx.isIdle()) await reconcileSemanticMap(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!ctx.isIdle()) return;
    cancelDirectionUpdate();
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
    cancelDirectionUpdate();
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
    cancelDirectionUpdate();
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
