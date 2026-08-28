import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  alignScrollStart,
  applyStepCorrections,
  categorizeError,
  collectStats,
  collectContextResets,
  compactMetrics,
  contextRangeLabel,
  contextResetLabel,
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
      summaryUsage: { ...usage(8, 4), cost: 0.003 },
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
    ["step"],
  );
  assert.equal(entriesAfter(entries, "missing").length, entries.length);
});

test("finalized steps close matching restored checkpoints", () => {
  const snapshot = { ...usage(0, 0), cost: 0 };
  const open = (summary: string, throughEntryId: string) => ({
    summary,
    throughEntryId,
    tools: {},
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
    summaryUsage: snapshot,
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
      summaryError: "summary failed",
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
    summaryUsage: { ...usage(8, 4), cost: 0.003 },
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

test("compact metrics preserve live totals in two rows", () => {
  assert.deepEqual(
    compactMetrics(
      {
        input: 1_900_000,
        output: 157_000,
        cost: 44.025,
        agentTokens: 55_500_000,
        summaryTokens: 5_100,
        tools: { read: 155, bash: 109 },
        errors: 13,
      },
      49,
      3,
    ),
    [
      "tok 1.9m→157k · $44.02 · ctx now49% ▓▓▓░░░",
      "work agent55.5m · minimap5.1k · calls264 · err13 · ↻3",
    ],
  );
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

test("context reset labels identify overflow", () => {
  assert.equal(
    contextResetLabel({
      entryIndex: 0,
      beforeTokens: 290,
      afterTokens: 44,
      beforePercent: 145,
      afterPercent: 22,
    }),
    "overflow 145→22%",
  );
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
    summaryUsage: { ...usage(0, 0), cost: 0 },
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
