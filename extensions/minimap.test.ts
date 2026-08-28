import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import minimapExtension, {
  alignScrollStart,
  applyStepCorrections,
  categorizeError,
  collectStats,
  collectContextResets,
  compactMetrics,
  contextRangeLabel,
  dashboardContextLabel,
  conciseStep,
  entriesAfter,
  elapsedLabel,
  extractSkills,
  failureReview,
  inferStepContexts,
  isStandaloneSkillInjection,
  isConsequentialDecision,
  minimapHeight,
  minimapOverlayOptions,
  minimapStatus,
  meterBar,
  parseSemanticDecision,
  readableGoal,
  recoverHistoricalSteps,
  restoreSavedState,
  scrollWindow,
  sessionEfficiency,
  trailingFailureStreak,
  wrapStepSummary,
  type MinimapStep,
} from "./minimap.ts";

const usage = (input: number, output: number) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
});

const entries = [
  {
    type: "message",
    id: "user",
    parentId: null,
    timestamp: "2026-01-01T00:00:00Z",
    message: { role: "user", content: "Fix it", timestamp: 1 },
  },
  {
    type: "message",
    id: "assistant",
    parentId: "user",
    timestamp: "2026-01-01T00:00:01Z",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }],
      api: "test",
      provider: "test",
      model: "test",
      usage: usage(100, 20),
      stopReason: "toolUse",
      timestamp: 2,
    },
  },
  {
    type: "message",
    id: "result",
    parentId: "assistant",
    timestamp: "2026-01-01T00:00:02Z",
    message: {
      role: "toolResult",
      toolCallId: "call",
      toolName: "read",
      content: [{ type: "text", text: "failed" }],
      usage: usage(10, 2),
      isError: true,
      timestamp: 3,
    },
  },
  {
    type: "custom",
    id: "summary",
    parentId: "result",
    timestamp: "2026-01-01T00:00:03Z",
    customType: "session-minimap-open-step",
    data: {
      version: 1,
      callUsage: { ...usage(8, 4), cost: 0.003 },
      usageOnly: true,
    },
  },
  {
    type: "custom",
    id: "step",
    parentId: "result",
    timestamp: "2026-01-01T00:00:03Z",
    customType: "session-minimap-step",
    data: {
      version: 1,
      throughEntryId: "result",
      summary: "Inspected the failure.",
      tools: { read: 1 },
      errors: 1,
      usage: { ...usage(110, 22), cost: 0.02 },
      createdAt: 4,
    } satisfies MinimapStep,
  },
] as SessionEntry[];

test("collectStats separates agent and minimap usage", () => {
  const stats = collectStats(entries);
  assert.equal(stats.input, 118);
  assert.equal(stats.output, 26);
  assert.equal(stats.agentTokens, 132);
  assert.equal(stats.summaryTokens, 12);
  assert.deepEqual({ ...stats.tools }, { read: 1 });
  assert.deepEqual({ ...stats.skills }, {});
  assert.equal(stats.errors, 1);
  assert.deepEqual({ ...stats.errorKinds }, { read: 1 });
  assert.deepEqual({ ...stats.toolTokens }, { read: 12 });
});

test("entriesAfter keeps append-only step boundaries", () => {
  assert.deepEqual(
    entriesAfter(entries, "result").map((entry) => entry.id),
    ["summary", "step"],
  );
  assert.equal(entriesAfter(entries, "missing").length, entries.length);
});

test("finalized steps close matching restored checkpoints", () => {
  const snapshot = { ...usage(0, 0), cost: 0 };
  const open = (summary: string, throughEntryId: string) => ({
    summary,
    throughEntryId,
    tools: {},
    skills: {},
    errors: 0,
    usage: snapshot,
    contextStart: { tokens: 10, percent: 10, contextWindow: 100 },
    contextEnd: { tokens: 20, percent: 20, contextWindow: 100 },
    createdAt: 1,
  });
  const custom = (
    id: string,
    customType: string,
    data: unknown,
  ): SessionEntry =>
    ({
      type: "custom",
      id,
      parentId: null,
      timestamp: "2026-01-01T00:00:00Z",
      customType,
      data,
    }) as SessionEntry;
  const oldOpen = custom("open-old", "session-minimap-open-step", {
    version: 1,
    callUsage: snapshot,
    open: open("Old goal", "result-old"),
  });
  const finalized = custom("step-old", "session-minimap-step", {
    version: 1,
    throughEntryId: "result-old",
    summary: "Old goal",
    tools: {},
    errors: 0,
    usage: snapshot,
    createdAt: 1,
  });
  const newOpen = custom("open-new", "session-minimap-open-step", {
    version: 1,
    callUsage: snapshot,
    open: open("New goal", "result-new"),
  });
  const summaryFailure = custom(
    "summary-failure",
    "session-minimap-open-step",
    {
      version: 1,
      callUsage: { ...usage(3, 2), cost: 0 },
      usageOnly: true,
    },
  );

  assert.equal(restoreSavedState([oldOpen, finalized]).open, undefined);
  assert.equal(
    restoreSavedState([oldOpen, summaryFailure]).open?.summary,
    "Old goal",
  );
  assert.equal(collectStats([summaryFailure]).summaryTokens, 5);
  assert.equal(
    restoreSavedState([oldOpen, finalized, newOpen]).open?.summary,
    "New goal",
  );

  const legacyCompaction = {
    type: "compaction",
    id: "compact-after-failure",
    parentId: "summary-failure",
    timestamp: "2026-01-01T00:00:01Z",
    summary: "## Goal\nLegacy goal",
    firstKeptEntryId: "summary-failure",
    tokensBefore: 80,
  } as SessionEntry;
  assert.equal(
    restoreSavedState([summaryFailure, legacyCompaction], 100).steps[0]
      ?.summary,
    "Legacy goal",
  );

  const checkpointBefore = custom(
    "checkpoint-before",
    "session-minimap-open-step",
    {
      version: 1,
      callUsage: snapshot,
      open: open("Spanning goal", "result-before"),
    },
  );
  const compaction = {
    type: "compaction",
    id: "compact-covered",
    parentId: "checkpoint-before",
    timestamp: "2026-01-01T00:00:01Z",
    summary: "## Goal\nSpanning goal",
    firstKeptEntryId: "result-covered",
    tokensBefore: 80,
  } as SessionEntry;
  const resultCovered = {
    type: "message",
    id: "result-covered",
    parentId: "compact-covered",
    timestamp: "2026-01-01T00:00:02Z",
    message: {
      role: "assistant",
      content: [],
      api: "test",
      provider: "test",
      model: "test",
      usage: usage(10, 2),
      stopReason: "stop",
      timestamp: 2,
    },
  } as SessionEntry;
  const checkpointAfter = custom(
    "checkpoint-after",
    "session-minimap-open-step",
    {
      version: 1,
      callUsage: snapshot,
      open: open("Spanning goal", "result-covered"),
    },
  );
  const coveredStep = custom("covered-step", "session-minimap-step", {
    version: 1,
    throughEntryId: "result-covered",
    summary: "Spanning goal",
    tools: {},
    errors: 0,
    usage: snapshot,
    createdAt: 2,
  });
  const covered = restoreSavedState(
    [checkpointBefore, compaction, resultCovered, checkpointAfter, coveredStep],
    100,
  );
  assert.deepEqual(
    covered.steps.map((step) => [step.summary, step.recovered]),
    [["Spanning goal", undefined]],
  );
});

test("long minimap text wraps fully instead of clipping", () => {
  const summary =
    "Installed the session minimap extension and verified that the local package loads correctly.";
  const lines = wrapStepSummary(summary, 28);
  assert.ok(lines.length > 2);
  assert.ok(lines.every((line) => visibleWidth(line) <= 28));
  assert.equal(lines.join(" "), summary);
  assert.ok(!lines.join("").includes("…"));
});

test("step labels stay concise without rewriting stored summaries", () => {
  assert.equal(
    conciseStep(
      "Installed the session minimap extension locally; restart pi or run reload.",
      10,
    ),
    "Installed the session minimap extension locally",
  );
  assert.equal(
    conciseStep("\u001b]0;spoofed title\u0007Safe\u0000 session title"),
    "Safe session title",
  );
  assert.equal(conciseStep("\u001b]0;spoofed\u001b\\Safe title"), "Safe title");
  assert.equal(conciseStep("\u009d0;spoofed\u009cSafe title"), "Safe title");
});

test("semantic decisions can continue across user messages", () => {
  assert.deepEqual(
    parseSemanticDecision("CONTINUE\nImproved minimap readability", true),
    {
      startsNewStep: false,
      summary: "Improved minimap readability",
      decisions: [],
      corrections: [],
    },
  );
  assert.deepEqual(parseSemanticDecision("NEW\nAdded context history", true), {
    startsNewStep: true,
    summary: "Added context history",
    decisions: [],
    corrections: [],
  });
  assert.deepEqual(parseSemanticDecision("Missing marker", true), {
    startsNewStep: false,
    summary: "",
    decisions: [],
    corrections: [],
  });
  assert.deepEqual(
    parseSemanticDecision(
      "CONTINUE\nImproved minimap readability\nDECISION: Keep the pane non-capturing and use global scroll shortcuts",
      true,
    ),
    {
      startsNewStep: false,
      summary: "Improved minimap readability",
      decisions: [
        "Keep the pane non-capturing and use global scroll shortcuts",
      ],
      corrections: [],
    },
  );
});

test("routine minimap mechanics are not recorded as decisions", () => {
  const parsed = parseSemanticDecision(
    [
      "CONTINUE",
      "Improved minimap accuracy",
      "DECISION: Keep AgentsView excluded",
      "DECISION: Use append-only title corrections rather than rewriting history",
      "DECISION: Infer corrections from later evidence automatically",
    ].join("\n"),
    true,
  );
  assert.deepEqual(parsed.decisions, ["Keep AgentsView excluded"]);
  assert.equal(isConsequentialDecision("Adjust layout labels"), false);
  assert.equal(
    isConsequentialDecision(
      "Suppress commands, paths, secrets, and volatile numbers in repeated error summaries",
    ),
    false,
  );
});

test("semantic summaries can correct factually wrong settled titles", () => {
  assert.deepEqual(
    parseSemanticDecision(
      "CONTINUE\nImproved minimap accuracy\nCORRECT: 5 | Evaluated AgentsView and improved minimap density",
      true,
    ),
    {
      startsNewStep: false,
      summary: "Improved minimap accuracy",
      decisions: [],
      corrections: [
        {
          step: 5,
          summary: "Evaluated AgentsView and improved minimap density",
        },
      ],
    },
  );
});

test("invoked skills are attached to semantic steps", () => {
  const skillEntries = [
    {
      type: "message",
      id: "skill-user",
      parentId: null,
      timestamp: "2026-01-01T00:00:00Z",
      message: {
        role: "user",
        content: '<skill name="diagnosing-bugs">instructions</skill>',
        timestamp: 1,
      },
    },
    {
      type: "message",
      id: "skill-read",
      parentId: "skill-user",
      timestamp: "2026-01-01T00:00:01Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "skill-call",
            name: "read",
            arguments: {
              path: "/home/me/.pi/agent/skills/session-closeout/SKILL.md",
            },
          },
        ],
        api: "test",
        provider: "test",
        model: "test",
        usage: usage(5, 1),
        stopReason: "toolUse",
        timestamp: 2,
      },
    },
  ] as SessionEntry[];
  assert.deepEqual(
    { ...extractSkills(skillEntries) },
    {
      "diagnosing-bugs": 1,
      "session-closeout": 1,
    },
  );
  const hostile = extractSkills([
    {
      type: "message",
      id: "hostile-skill",
      parentId: null,
      timestamp: "2026-01-01T00:00:02Z",
      message: {
        role: "user",
        content: '<skill name="__proto__">instructions</skill>',
        timestamp: 3,
      },
    } as SessionEntry,
  ]);
  assert.equal(hostile.__proto__, 1);
  assert.equal(Object.getPrototypeOf(hostile), null);
});

test("tool failures are grouped into useful categories", () => {
  const error = (text: string) =>
    categorizeError({
      toolName: "bash",
      content: [{ type: "text", text }],
    });

  assert.equal(error("error TS2322: bad type"), "typecheck");
  assert.equal(error("SyntaxError: unexpected token"), "runtime");
  assert.equal(error("✖ wrapping test\n# fail 1"), "test");
  assert.equal(
    error("fatal: not a git repository\nCommand exited with code 128"),
    "command",
  );
});

test("failure review supports session postmortems", () => {
  const result = (
    id: string,
    toolName: string,
    text: string,
    isError: boolean,
  ) =>
    ({
      type: "message",
      id,
      parentId: null,
      timestamp: `2026-01-01T00:00:0${id}Z`,
      message: {
        role: "toolResult",
        toolCallId: `call-${id}`,
        toolName,
        content: [{ type: "text", text }],
        isError,
        timestamp: Number(id),
      },
    }) as SessionEntry;
  const review = failureReview(
    [
      result("1", "fetch", "Error: fetch failed", true),
      result("2", "fetch", "Error: fetch failed", true),
      result("3", "fetch", "ok", false),
      result(
        "4",
        "bash",
        "> app check\nError: tests failed in /Users/alice/private/test.ts",
        true,
      ),
      result(
        "5",
        "bash",
        "> app check\nError: tests failed in /Users/bob/private/test.ts",
        true,
      ),
    ],
    { fetch: 3, bash: 2 },
  );

  assert.deepEqual(
    {
      total: review.total,
      runs: review.runs,
      recovered: review.recovered,
      unresolved: review.unresolved,
      maxStreak: review.maxStreak,
    },
    { total: 4, runs: 2, recovered: 1, unresolved: 1, maxStreak: 2 },
  );
  assert.deepEqual(
    review.byTool.map(({ name, failures, calls }) => ({
      name,
      failures,
      calls,
    })),
    [
      { name: "bash", failures: 2, calls: 2 },
      { name: "fetch", failures: 2, calls: 3 },
    ],
  );
  assert.deepEqual({ ...review.byType }, { fetch: 2, test: 2 });
  assert.deepEqual(review.patterns, [
    { label: "bash: tests failed in <path>", count: 2 },
    { label: "fetch: fetch failed", count: 2 },
  ]);
});

test("legacy steps get context ranges without rewriting entries", () => {
  const step: MinimapStep = {
    version: 1,
    throughEntryId: "result",
    summary: "Inspect failure",
    tools: { read: 1 },
    errors: 1,
    usage: { ...usage(110, 22), cost: 0.02 },
    createdAt: 4,
  };

  const [inferred] = inferStepContexts([step], entries, 1000);
  assert.equal(inferred?.contextStart, undefined);
  assert.equal(inferred?.contextEnd?.tokens, 120);
  assert.equal(inferred?.contextEnd?.percent, 12);
  assert.equal(step.contextEnd, undefined);
});

test("standalone skill injections do not start semantic steps", () => {
  assert.equal(
    isStandaloneSkillInjection('<skill name="cloudflare">instructions</skill>'),
    true,
  );
  assert.equal(
    isStandaloneSkillInjection(
      '<skill name="cloudflare">instructions</skill>\nAdd email',
    ),
    false,
  );
});

test("live labels ignore leading and trailing screenshot paths", () => {
  assert.equal(
    readableGoal(
      "/var/tmp/Screenshot\\ 2026.png make the live label readable earlier",
    ),
    "make the live label readable earlier",
  );
  assert.equal(
    readableGoal("Show agent decisions while working /var/tmp/screenshot.png"),
    "Show agent decisions while working",
  );
  assert.equal(
    readableGoal(
      "/var/tmp/first.png\n/var/tmp/second.png\nalso this fix rough cases",
    ),
    "also this fix rough cases",
  );
  assert.equal(
    readableGoal(
      "Infer append-only historical title corrections automatically Worked on /var/tmp/screenshot.png",
    ),
    "Infer append-only historical title corrections automatically",
  );
});

test("scroll windows clamp to available history", () => {
  assert.deepEqual(scrollWindow(20, 5, 99), { start: 15, end: 20, max: 15 });
  assert.deepEqual(scrollWindow(20, 5, -4), { start: 0, end: 5, max: 15 });
});

test("wrapped chrome leaves useful room for the minimap", () => {
  assert.equal(minimapHeight(50, 20), 30);
  assert.equal(minimapHeight(50, 10), 24);
  assert.equal(minimapHeight(25, 20), 23);
  assert.equal(minimapHeight(50, 20, true), 20);
  assert.equal(minimapHeight(20, 30, true), 18);
});

test("native session efficiency stays factual and comparable", () => {
  const efficiency = sessionEfficiency(entries, {
    input: 25,
    cacheRead: 75,
    errors: 1,
    tools: { read: 4 },
    agentTokens: 90,
    summaryTokens: 10,
  });
  assert.deepEqual(efficiency, {
    elapsedMs: 3_000,
    calls: 4,
    cacheShare: 75,
    failureRate: 25,
    mapOverhead: 10,
  });
  assert.equal(elapsedLabel(3_000), "3s");
  assert.equal(elapsedLabel(7_500_000), "2h 5m");
  assert.equal(elapsedLabel(183_600_000), "2d 3h");
});

test("attention appears only for an unresolved failure streak", () => {
  const failures = [
    {
      type: "message",
      id: "failure-1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00Z",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "fetch",
        content: [],
        isError: true,
        timestamp: 1,
      },
    },
    {
      type: "message",
      id: "failure-2",
      parentId: "failure-1",
      timestamp: "2026-01-01T00:00:01Z",
      message: {
        role: "toolResult",
        toolCallId: "call-2",
        toolName: "fetch",
        content: [],
        isError: true,
        timestamp: 2,
      },
    },
  ] as SessionEntry[];
  assert.deepEqual(trailingFailureStreak(failures), {
    source: "fetch",
    count: 2,
  });
  assert.equal(trailingFailureStreak(entries), undefined);
  assert.equal(
    trailingFailureStreak([
      ...failures,
      {
        type: "message",
        id: "success",
        parentId: "failure-2",
        timestamp: "2026-01-01T00:00:02Z",
        message: {
          role: "toolResult",
          toolCallId: "call-3",
          toolName: "fetch",
          content: [],
          isError: false,
          timestamp: 3,
        },
      } as SessionEntry,
    ]),
    undefined,
  );
});

test("expanded minimap uses a large centered non-capturing overlay", () => {
  const compact = minimapOverlayOptions(false);
  const expanded = minimapOverlayOptions(true);
  assert.deepEqual(
    [compact.anchor, compact.width, compact.margin, compact.nonCapturing],
    ["top-right", 60, 0, true],
  );
  assert.deepEqual(
    [expanded.anchor, expanded.width, expanded.margin, expanded.nonCapturing],
    ["center", "85%", 1, true],
  );
  assert.equal(expanded.maxHeight, "90%");
  assert.equal(compact.visible?.(100, 40), false);
  assert.equal(expanded.visible?.(79, 40), false);
  assert.equal(expanded.visible?.(80, 40), true);
  assert.equal(expanded.visible?.(100, 40), true);
});

test("dashboard graphics compress context without hiding resets", () => {
  assert.equal(meterBar(73, 100, 10), "███████░░░");
  assert.equal(meterBar(145, 100, 6), "██████");
  assert.equal(meterBar(null, 100, 6), "░░░░░░");
  assert.equal(dashboardContextLabel(81, 89, []), "81→89%");
  assert.equal(
    dashboardContextLabel(89, 44, [
      {
        entryIndex: 1,
        beforeTokens: 290,
        afterTokens: 44,
        beforePercent: 145,
        afterPercent: 22,
      },
    ]),
    "↻▲145↘22→44%",
  );
  assert.equal(
    dashboardContextLabel(44, 73, [
      {
        entryIndex: 1,
        beforeTokens: 180,
        beforePercent: 91,
        afterPercent: 24,
      },
      {
        entryIndex: 2,
        beforeTokens: 208,
        beforePercent: 104,
        afterPercent: 22,
      },
    ]),
    "↻2▲ 44→73%",
  );
});

test("compact metrics fit the fixed-width pane", () => {
  const metrics = compactMetrics(
    {
      input: 1_900_000,
      output: 157_000,
      cost: 44.025,
      agentTokens: 55_500_000,
      summaryTokens: 5_100,
      tools: { read: 155, bash: 109 },
      skills: { tdd: 2 },
      errors: 13,
    },
    49,
    3,
  );

  assert.deepEqual(metrics, [
    "tok 1.9m→157k · $44.02 · ctx now49% ▓▓▓░░░",
    "agent55.5m · map5.1k · calls264 · skills2 · err13 · ↻3",
  ]);
  assert.ok(metrics.every((metric) => visibleWidth(metric) <= 58));
});

test("history scrolling starts at a complete step card", () => {
  const starts = [0, 4, 9];
  assert.equal(alignScrollStart(8, starts), 4);
  assert.equal(alignScrollStart(9, starts), 9);
  assert.equal(alignScrollStart(2, starts), 0);
  assert.equal(alignScrollStart(8, []), 8);
});

test("partial context snapshots use explicit labels", () => {
  assert.equal(contextRangeLabel(undefined, "81", "%"), "ctx end 81%");
  assert.equal(contextRangeLabel("81", "89", "%"), "ctx 81→89%");
  assert.equal(contextRangeLabel("44", undefined, "%"), "ctx start 44%");
  assert.equal(
    contextRangeLabel("44", "29", "%", true),
    "ctx start 44% · end 29%",
  );
  assert.equal(
    contextRangeLabel("44", "29", "%", true, "now"),
    "ctx start 44% · now 29%",
  );
});

test("context resets are derived from compaction entries", () => {
  const resetEntries = [
    {
      type: "compaction",
      id: "compact",
      parentId: null,
      timestamp: "2026-01-01T00:00:00Z",
      summary: "checkpoint",
      firstKeptEntryId: "after",
      tokensBefore: 160,
    },
    {
      type: "message",
      id: "empty-after",
      parentId: "compact",
      timestamp: "2026-01-01T00:00:00Z",
      message: {
        role: "assistant",
        content: [],
        api: "test",
        provider: "test",
        model: "test",
        usage: usage(0, 0),
        stopReason: "stop",
        timestamp: 1,
      },
    },
    {
      type: "message",
      id: "after",
      parentId: "compact",
      timestamp: "2026-01-01T00:00:01Z",
      message: {
        role: "assistant",
        content: [],
        api: "test",
        provider: "test",
        model: "test",
        usage: usage(60, 10),
        stopReason: "stop",
        timestamp: 2,
      },
    },
  ] as SessionEntry[];

  assert.deepEqual(collectContextResets(resetEntries, 200), [
    {
      entryIndex: 0,
      beforeTokens: 160,
      afterTokens: 70,
      beforePercent: 80,
      afterPercent: 35,
    },
  ]);
});

test("current context only fills the latest unresolved compaction", () => {
  const compaction = (id: string, tokensBefore: number): SessionEntry =>
    ({
      type: "compaction",
      id,
      parentId: null,
      timestamp: "2026-01-01T00:00:00Z",
      summary: "checkpoint",
      firstKeptEntryId: id,
      tokensBefore,
    }) as SessionEntry;
  const resets = collectContextResets(
    [compaction("first", 80), compaction("second", 60)],
    100,
    25,
  );

  assert.equal(resets[0]?.afterTokens, undefined);
  assert.equal(resets[1]?.afterTokens, 25);
});

test("settled semantic threads are not shown as active work", () => {
  assert.equal(minimapStatus(true, true), "active");
  assert.equal(minimapStatus(false, true), "settled");
  assert.equal(minimapStatus(false, false), "idle");
});

test("legacy sessions recover compaction-bounded steps", () => {
  const legacyEntries = [
    {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: "Build login flow", timestamp: 1 },
    },
    {
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      timestamp: "2026-01-01T00:00:01Z",
      message: {
        role: "assistant",
        content: [],
        api: "test",
        provider: "test",
        model: "test",
        usage: usage(40, 10),
        stopReason: "stop",
        timestamp: 2,
      },
    },
    {
      type: "compaction",
      id: "compact-1",
      parentId: "assistant-1",
      timestamp: "2026-01-01T00:00:02Z",
      summary: "Completed login flow",
      firstKeptEntryId: "user-1",
      tokensBefore: 50,
    },
    {
      type: "message",
      id: "user-2",
      parentId: "compact-1",
      timestamp: "2026-01-01T00:00:03Z",
      message: { role: "user", content: "Tune caching policy", timestamp: 3 },
    },
    {
      type: "message",
      id: "assistant-2",
      parentId: "user-2",
      timestamp: "2026-01-01T00:00:04Z",
      message: {
        role: "assistant",
        content: [],
        api: "test",
        provider: "test",
        model: "test",
        usage: usage(25, 5),
        stopReason: "stop",
        timestamp: 4,
      },
    },
    {
      type: "compaction",
      id: "compact-2",
      parentId: "assistant-2",
      timestamp: "2026-01-01T00:00:05Z",
      summary: "Completed cache tuning",
      firstKeptEntryId: "user-2",
      tokensBefore: 30,
    },
  ] as SessionEntry[];

  const recovered = recoverHistoricalSteps(legacyEntries, 100);
  assert.deepEqual(
    recovered.map((step) => ({
      throughEntryId: step.throughEntryId,
      summary: step.summary,
      start: step.contextStart?.percent,
      end: step.contextEnd?.percent,
      recovered: step.recovered,
    })),
    [
      {
        throughEntryId: "compact-1",
        summary: "Build login flow",
        start: undefined,
        end: 50,
        recovered: true,
      },
      {
        throughEntryId: "compact-2",
        summary: "Tune caching policy",
        start: 30,
        end: 30,
        recovered: true,
      },
    ],
  );

  const restored = restoreSavedState(
    [
      ...legacyEntries,
      {
        type: "message",
        id: "assistant-3",
        parentId: "compact-2",
        timestamp: "2026-01-01T00:00:06Z",
        message: {
          role: "assistant",
          content: [],
          api: "test",
          provider: "test",
          model: "test",
          usage: usage(10, 2),
          stopReason: "stop",
          timestamp: 6,
        },
      },
      {
        type: "custom",
        id: "step-3",
        parentId: "assistant-3",
        timestamp: "2026-01-01T00:00:07Z",
        customType: "session-minimap-step",
        data: {
          version: 1,
          throughEntryId: "assistant-3",
          summary: "Ship the minimap",
          tools: {},
          errors: 0,
          usage: { ...usage(10, 2), cost: 0.01 },
          createdAt: 7,
        } satisfies MinimapStep,
      },
    ] as SessionEntry[],
    100,
  );
  assert.deepEqual(
    restored.steps.map((step) => step.summary),
    ["Build login flow", "Tune caching policy", "Ship the minimap"],
  );
});

test("legacy recovery replaces generic continuation prompts with compaction goals", () => {
  const recovered = recoverHistoricalSteps(
    [
      {
        type: "message",
        id: "continue",
        parentId: null,
        timestamp: "2026-01-01T00:00:00Z",
        message: { role: "user", content: "continue", timestamp: 1 },
      },
      {
        type: "compaction",
        id: "compact",
        parentId: "continue",
        timestamp: "2026-01-01T00:00:01Z",
        summary:
          "## Goal\nRecover receipts and retry completed attempts\n\n## Progress\nDone",
        firstKeptEntryId: "continue",
        tokensBefore: 50,
      },
    ] as SessionEntry[],
    100,
  );

  assert.equal(
    recovered[0]?.summary,
    "Recover receipts and retry completed attempts",
  );
});

test("step corrections preserve history while latest title wins", () => {
  const step = {
    version: 1,
    throughEntryId: "result",
    summary: "Improving minimap density with cached AgentsView health data",
    tools: {},
    errors: 0,
    usage: { ...usage(0, 0), cost: 0 },
    createdAt: 1,
  } satisfies MinimapStep;
  const corrections = [
    {
      type: "custom",
      id: "correction-1",
      parentId: "step",
      timestamp: "2026-01-01T00:00:04Z",
      customType: "session-minimap-step-correction",
      data: {
        version: 1,
        throughEntryId: "result",
        summary: "Evaluated AgentsView",
        createdAt: 2,
      },
    },
    {
      type: "custom",
      id: "correction-2",
      parentId: "correction-1",
      timestamp: "2026-01-01T00:00:05Z",
      customType: "session-minimap-step-correction",
      data: {
        version: 1,
        throughEntryId: "result",
        summary: "Evaluated AgentsView and improved minimap density",
        createdAt: 3,
      },
    },
  ] as SessionEntry[];

  const [corrected] = applyStepCorrections([step], corrections);
  assert.equal(
    corrected?.summary,
    "Evaluated AgentsView and improved minimap density",
  );
  assert.equal(
    step.summary,
    "Improving minimap density with cached AgentsView health data",
  );
});

test("lifecycle rebuilds long sessions that have no completed steps", async () => {
  const snapshot = { ...usage(0, 0), cost: 0 };
  const user = (id: string, parentId: string | null, content: string) =>
    ({
      type: "message",
      id,
      parentId,
      timestamp: `2026-01-01T00:0${id.at(-1)}:00Z`,
      message: { role: "user", content, timestamp: 1 },
    }) as SessionEntry;
  const assistant = (id: string, parentId: string) =>
    ({
      type: "message",
      id,
      parentId,
      timestamp: `2026-01-01T00:0${id.at(-1)}:30Z`,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
        api: "test",
        provider: "test",
        model: "test",
        usage: usage(20, 2),
        stopReason: "stop",
        timestamp: 2,
      },
    }) as SessionEntry;
  const branch = [
    user("user-1", null, "Build the restaurant site"),
    assistant("assistant-1", "user-1"),
    {
      type: "compaction",
      id: "compact-1",
      parentId: "assistant-1",
      timestamp: "2026-01-01T00:01:45Z",
      summary: "## Goal\nBuild the restaurant site",
      firstKeptEntryId: "user-1",
      tokensBefore: 90,
    } as SessionEntry,
    user("user-2", "compact-1", "Deploy the custom domain"),
    assistant("assistant-2", "user-2"),
    user("user-3", "assistant-2", "Add more restaurant sources"),
    assistant("assistant-3", "user-3"),
    user("user-4", "assistant-3", "Simplify the UI and add English"),
    assistant("assistant-4", "user-4"),
    {
      type: "custom",
      id: "checkpoint",
      parentId: "assistant-4",
      timestamp: "2026-01-01T00:05:00Z",
      customType: "session-minimap-open-step",
      data: {
        version: 1,
        callUsage: snapshot,
        open: {
          summary: "Build the restaurant site",
          throughEntryId: "assistant-4",
          tools: {},
          skills: {},
          decisions: [],
          errors: 0,
          usage: { ...usage(80, 8), cost: 0.08 },
          contextStart: { tokens: 0, percent: 0, contextWindow: 100 },
          contextEnd: { tokens: 80, percent: 80, contextWindow: 100 },
          createdAt: 1,
        },
      },
    },
  ] as SessionEntry[];
  type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
  const handlers = new Map<string, Handler>();
  const appended: Array<{ type: string; data: unknown }> = [];
  let completeCalls = 0;
  let failReconstruction = true;
  const ctx = {
    mode: "rpc",
    hasUI: false,
    model: { contextWindow: 100 },
    sessionManager: { getBranch: () => branch },
    modelRegistry: {
      complete: async () => {
        completeCalls++;
        return {
          role: "assistant",
          content: [
            {
              type: "text",
              text: [
                "STEP 1 | Build the restaurant menu MVP",
                "STEP 2 | Deploy the custom production domain",
                "STEP 3 | Expand supported restaurant menu sources",
                "CURRENT 4 | Simplify and localize the user interface",
              ].join("\n"),
            },
          ],
          api: "test",
          provider: "test",
          model: "test",
          usage: usage(1, 1),
          stopReason: "stop",
          timestamp: 1,
        };
      },
    },
    getContextUsage: () => ({ tokens: 80, percent: 80, contextWindow: 100 }),
  } as unknown as ExtensionContext;
  const pi = {
    registerCommand: () => {},
    registerShortcut: () => {},
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    appendEntry: (type: string, data: unknown) => {
      if (type === "session-minimap-reconstruction" && failReconstruction) {
        failReconstruction = false;
        throw new Error("persistence failed");
      }
      appended.push({ type, data });
    },
  } as unknown as ExtensionAPI;

  minimapExtension(pi);
  await handlers.get("session_start")?.({}, ctx);
  await handlers.get("session_start")?.({}, ctx);

  const reconstruction = appended.find(
    (entry) => entry.type === "session-minimap-reconstruction",
  );
  const data = reconstruction?.data as {
    steps: MinimapStep[];
    open: { summary: string };
  };
  assert.deepEqual(
    data.steps.map((step) => step.summary),
    [
      "Build the restaurant menu MVP",
      "Deploy the custom production domain",
      "Expand supported restaurant menu sources",
    ],
  );
  assert.ok(data.steps.every((step) => step.recovered));
  assert.equal(data.open.summary, "Simplify and localize the user interface");
  assert.equal(
    appended.filter((entry) => entry.type === "session-minimap-reconstruction")
      .length,
    1,
  );

  const persisted = {
    type: "custom",
    id: "reconstruction",
    parentId: "checkpoint",
    timestamp: "2026-01-01T00:06:00Z",
    customType: "session-minimap-reconstruction",
    data: reconstruction?.data,
  } as SessionEntry;
  const restored = restoreSavedState([...branch, persisted], 100);
  assert.deepEqual(
    restored.steps.map((step) => step.summary),
    data.steps.map((step) => step.summary),
  );
  assert.equal(restored.open?.summary, data.open.summary);
  assert.equal(collectStats([...branch, persisted]).summaryTokens, 2);
  assert.equal(completeCalls, 2);
});

test("lifecycle reconciles on idle agent end and recovers update failures", async () => {
  const userEntry = (
    id: string,
    content: string,
    parentId: string | null = null,
  ): SessionEntry =>
    ({
      type: "message",
      id,
      parentId,
      timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content, timestamp: 1 },
    }) as SessionEntry;
  const completion = (text: string, stopReason: "stop" | "error" = "stop") => ({
    role: "assistant" as const,
    content: text ? [{ type: "text" as const, text }] : [],
    api: "test",
    provider: "test",
    model: "test",
    usage: usage(1, 1),
    stopReason,
    errorMessage: stopReason === "error" ? "provider failed" : undefined,
    timestamp: 1,
  });
  type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
  type Completion = ReturnType<typeof completion>;

  const handlers = new Map<string, Handler>();
  const commands: string[] = [];
  const notices: string[] = [];
  const appended: Array<{ branch: string; type: string; data: unknown }> = [];
  let branchName = "A";
  let branch = [userEntry("a1", "Work on branch A")];
  let completeCalls = 0;
  let failAppend = false;
  let resolveFirst = (_response: Completion) => {};
  const firstResponse = new Promise<Completion>((resolve) => {
    resolveFirst = resolve;
  });

  const ctx = {
    mode: "rpc",
    hasUI: true,
    model: { contextWindow: 100 },
    sessionManager: { getBranch: () => branch },
    modelRegistry: {
      complete: async () => {
        completeCalls++;
        if (completeCalls === 1) return firstResponse;
        if (completeCalls === 2) return completion("NEW\nBranch B");
        if (completeCalls === 3) return completion("", "error");
        return completion("CONTINUE\nBranch B recovered");
      },
    },
    getContextUsage: () => ({ tokens: 10, percent: 10, contextWindow: 100 }),
    isIdle: () => true,
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionContext;
  const pi = {
    registerCommand: (name: string) => commands.push(name),
    registerShortcut: () => {},
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    appendEntry: (type: string, data: unknown) => {
      if (failAppend) {
        failAppend = false;
        throw new Error("persistence failed");
      }
      appended.push({ branch: branchName, type, data });
    },
  } as unknown as ExtensionAPI;

  minimapExtension(pi);
  assert.ok(commands.includes("minimap"));
  const end = handlers.get("agent_end");
  const settle = handlers.get("agent_settled");
  const switchTree = handlers.get("session_tree");
  assert.ok(end && settle && switchTree);

  const settlingA = Promise.resolve(settle({}, ctx));
  await Promise.resolve();
  assert.equal(completeCalls, 1);
  branchName = "B";
  branch = [userEntry("b1", "Work on branch B")];
  const switching = Promise.resolve(switchTree({}, ctx));
  resolveFirst(completion("NEW\nBranch A"));
  await Promise.all([settlingA, switching]);

  assert.equal(completeCalls, 2);
  assert.ok(appended.every((entry) => entry.branch === "B"));
  assert.equal(JSON.stringify(appended).includes("Branch A"), false);
  assert.equal(JSON.stringify(appended).includes("Branch B"), true);

  branch = [...branch, userEntry("b2", "Retry branch B", "b1")];
  await end({}, ctx);
  assert.equal(completeCalls, 3);
  assert.deepEqual(notices, [
    "Minimap summary failed; it will retry after the next run",
  ]);

  branch = [...branch, userEntry("b3", "Finish branch B", "b2")];
  failAppend = true;
  await settle({}, ctx);
  assert.equal(completeCalls, 4);
  await settle({}, ctx);
  assert.equal(completeCalls, 5);
  assert.equal(
    JSON.stringify(appended.at(-1)?.data).includes("recovered"),
    true,
  );
  await settle({}, ctx);
  assert.equal(completeCalls, 5);
  assert.deepEqual(notices, [
    "Minimap summary failed; it will retry after the next run",
    "Minimap update failed; it will retry after the next run",
  ]);
  assert.equal(
    Object.hasOwn(appended.at(-1)?.data as object, "summaryError"),
    false,
  );
});
