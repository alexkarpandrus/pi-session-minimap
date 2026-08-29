import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  visibleWidth,
  type Component,
  type OverlayHandle,
  type TUI,
} from "@earendil-works/pi-tui";
import minimapExtension, {
  alignScrollStart,
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
  isStandaloneSkillInjection,
  isConsequentialDecision,
  minimapHeight,
  minimapOverlayOptions,
  minimapStatus,
  meterBar,
  parseTailPlan,
  readableGoal,
  restoreSavedState,
  scrollWindow,
  sessionEfficiency,
  trailingFailureStreak,
  wrapStepSummary,
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
    customType: "session-minimap-state",
    data: {
      version: 1,
      callUsage: { ...usage(8, 4), cost: 0.003 },
      usageOnly: true,
    },
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

test("entriesAfter slices after a persisted boundary", () => {
  assert.deepEqual(
    entriesAfter(entries, "result").map((entry) => entry.id),
    ["summary"],
  );
  assert.equal(entriesAfter(entries, "missing").length, entries.length);
});

test("malformed persisted minimap entries are ignored", () => {
  const malformed = (id: string, customType: string, data: unknown) =>
    ({
      type: "custom",
      id,
      parentId: null,
      timestamp: "2026-01-01T00:00:00Z",
      customType,
      data,
    }) as SessionEntry;
  const branch = [
    malformed("bad-open", "session-minimap-state", {
      version: 1,
      callUsage: "corrupt",
      open: "corrupt",
    }),
    malformed("bad-revision", "session-minimap-state", {
      version: 1,
      callUsage: { ...usage(0, 0), cost: 0 },
      revision: { replaceCount: 1, steps: ["corrupt"] },
    }),
    malformed("impossible-revision", "session-minimap-state", {
      version: 1,
      callUsage: { ...usage(0, 0), cost: 0 },
      revision: { replaceCount: 1, steps: [] },
    }),
  ];

  assert.deepEqual(restoreSavedState(branch), { steps: [], open: undefined });
  assert.equal(collectStats(branch).summaryTokens, 0);
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

test("tail plans rename and merge adjacent semantic sources", () => {
  assert.deepEqual(
    parseTailPlan(
      [
        "STEP S1+S2 | Unified authentication implementation",
        "STEP CURRENT+NEW | Verified authentication behavior",
        "DECISION: Keep the pane non-capturing and use global scroll shortcuts",
      ].join("\n"),
      ["S1", "S2", "CURRENT", "NEW"],
    ),
    {
      groups: [
        {
          sources: ["S1", "S2"],
          summary: "Unified authentication implementation",
        },
        {
          sources: ["CURRENT", "NEW"],
          summary: "Verified authentication behavior",
        },
      ],
      decisions: [
        "Keep the pane non-capturing and use global scroll shortcuts",
      ],
    },
  );

  for (const malformed of [
    "STEP S1 | Missing new activity",
    "STEP NEW+S1 | Reordered sources",
    "STEP S1+S1+NEW | Duplicated source",
    "DECISION: Interleaved decision\nSTEP S1+NEW | Invalid order",
    "STEP S1+NEW | Too many decisions\nDECISION: First direction\nDECISION: Second direction\nDECISION: Third direction",
    "STEP S1+NEW | Empty decision\nDECISION:",
    "Unstructured response",
  ])
    assert.equal(parseTailPlan(malformed, ["S1", "NEW"]), undefined);
});

test("routine minimap mechanics are not recorded as decisions", () => {
  const parsed = parseTailPlan(
    [
      "STEP CURRENT+NEW | Improved minimap accuracy",
      "DECISION: Keep AgentsView excluded",
    ].join("\n"),
    ["CURRENT", "NEW"],
  );
  assert.deepEqual(parsed?.decisions, ["Keep AgentsView excluded"]);
  assert.equal(isConsequentialDecision("Adjust layout labels"), false);
  assert.equal(
    isConsequentialDecision(
      "Suppress commands, paths, secrets, and volatile numbers in repeated error summaries",
    ),
    false,
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

test("failure labels strip terminal control strings", () => {
  const toolName = "read\x1b]52;c;ZmFrZS1jbGlwYm9hcmQ=\x07";
  const entries = [1, 2].map(
    (id) =>
      ({
        type: "message",
        id: String(id),
        parentId: null,
        timestamp: `2026-01-01T00:00:0${id}Z`,
        message: {
          role: "toolResult",
          toolCallId: `call-${id}`,
          toolName,
          content: [],
          isError: true,
          timestamp: id,
        },
      }) as SessionEntry,
  );

  const review = failureReview(entries, { [toolName]: 2 });
  assert.equal(categorizeError({ toolName, content: [] }), "read");
  assert.equal(trailingFailureStreak(entries)?.source, "read");
  assert.equal(review.patterns[0]?.label, "read: read failure");
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
      "Improve historical summaries automatically Worked on /var/tmp/screenshot.png",
    ),
    "Improve historical summaries automatically",
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
      errorKinds: { test: 8, typecheck: 5 },
    },
    49,
    3,
  );

  assert.deepEqual(metrics, [
    "tok 1.9m→157k · $44.02 · ctx now49% ▓▓▓░░░",
    "agent55.5m · map5.1k · calls264 · skills2 · err13 · ↻3",
    "errors test×8 typecheck×5",
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

test("tail reconciliation merges steps and recomputes their data", async () => {
  type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
  const handlers = new Map<string, Handler>();
  const user = (
    id: string,
    content: string,
    parentId: string | null,
  ): SessionEntry =>
    ({
      type: "message",
      id,
      parentId,
      timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content, timestamp: 1 },
    }) as SessionEntry;
  const assistant = (
    id: string,
    parentId: string,
    toolName: string,
    input: number,
    output: number,
  ): SessionEntry =>
    ({
      type: "message",
      id,
      parentId,
      timestamp: "2026-01-01T00:00:01Z",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: `call-${id}`, name: toolName, arguments: {} },
        ],
        api: "test",
        provider: "test",
        model: "test",
        usage: usage(input, output),
        stopReason: "toolUse",
        timestamp: 2,
      },
    }) as SessionEntry;

  const plans = [
    "STEP NEW | Investigated authentication behavior\nDECISION: Use native session storage",
    "STEP CURRENT | Investigated authentication behavior\nSTEP NEW | Implemented authentication flow",
    "STEP S1+CURRENT | Built authentication flow\nSTEP NEW | Verified authentication behavior",
  ];
  let contextTokens = 20;
  let branch: SessionEntry[] = [
    user("u1", "Investigate authentication", null),
    assistant("a1", "u1", "read", 10, 2),
  ];
  let customId = 0;
  const ctx = {
    mode: "rpc",
    hasUI: false,
    model: { contextWindow: 100 },
    sessionManager: { getBranch: () => branch },
    modelRegistry: {
      complete: async () => ({
        role: "assistant" as const,
        content: [{ type: "text" as const, text: plans.shift()! }],
        api: "test",
        provider: "test",
        model: "test",
        usage: usage(1, 1),
        stopReason: "stop" as const,
        timestamp: 1,
      }),
    },
    getContextUsage: () => ({
      tokens: contextTokens,
      percent: contextTokens,
      contextWindow: 100,
    }),
    ui: { notify: () => {} },
  } as unknown as ExtensionContext;
  const pi = {
    registerCommand: () => {},
    registerShortcut: () => {},
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    appendEntry: (customType: string, data: unknown) => {
      branch.push({
        type: "custom",
        id: `map-${++customId}`,
        parentId: branch.at(-1)?.id ?? null,
        timestamp: "2026-01-01T00:00:02Z",
        customType,
        data,
      } as SessionEntry);
    },
  } as unknown as ExtensionAPI;

  minimapExtension(pi);
  const settle = handlers.get("agent_settled");
  assert.ok(settle);
  await settle({}, ctx);

  contextTokens = 40;
  branch.push(
    user("u2", "Implement authentication", branch.at(-1)?.id ?? null),
    assistant("a2", "u2", "edit", 20, 3),
  );
  await settle({}, ctx);

  contextTokens = 60;
  branch.push(
    user("u3", "Verify authentication", branch.at(-1)?.id ?? null),
    assistant("a3", "u3", "test", 30, 4),
    {
      type: "message",
      id: "r3",
      parentId: "a3",
      timestamp: "2026-01-01T00:00:02Z",
      message: {
        role: "toolResult",
        toolCallId: "call-a3",
        toolName: "test",
        content: [{ type: "text", text: "failed" }],
        usage: usage(5, 1),
        isError: true,
        timestamp: 3,
      },
    } as SessionEntry,
  );
  await settle({}, ctx);

  const restored = restoreSavedState(branch);
  assert.deepEqual(
    restored.steps.map((step) => step.summary),
    ["Built authentication flow"],
  );
  assert.equal(restored.open?.summary, "Verified authentication behavior");
  assert.equal(Object.hasOwn(restored.open ?? {}, "version"), false);
  assert.deepEqual({ ...restored.steps[0]?.tools }, { read: 1, edit: 1 });
  assert.deepEqual(restored.steps[0]?.usage, {
    ...usage(30, 5),
    cost: 0.02,
  });
  assert.deepEqual(restored.steps[0]?.decisions, [
    "Use native session storage",
  ]);
  assert.deepEqual({ ...restored.open?.tools }, { test: 1 });
  assert.equal(restored.open?.errors, 1);
  assert.deepEqual(restored.open?.usage, { ...usage(35, 5), cost: 0.02 });
  assert.deepEqual(
    [
      restored.steps[0]?.contextStart?.tokens,
      restored.steps[0]?.contextEnd?.tokens,
    ],
    [20, 40],
  );
  assert.deepEqual(
    [restored.open?.contextStart.tokens, restored.open?.contextEnd.tokens],
    [40, 60],
  );
});
test("fresh history is reconstructed into ordered semantic steps", async () => {
  type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
  const handlers = new Map<string, Handler>();
  const user = (id: string, content: string, parentId: string | null) =>
    ({
      type: "message",
      id,
      parentId,
      timestamp: `2026-01-01T00:00:${id.slice(1).padStart(2, "0")}Z`,
      message: { role: "user", content, timestamp: 1 },
    }) as SessionEntry;
  const branch = Array.from({ length: 10 }, (_value, index) => {
    const number = index + 1;
    return user(
      `u${number}`,
      `Goal ${number} ${"x".repeat(5_000)}`,
      index ? `u${index}` : null,
    );
  });
  const prompts: string[] = [];
  let completeCalls = 0;
  let customId = 0;
  const ctx = {
    mode: "rpc",
    hasUI: false,
    model: { contextWindow: 100 },
    sessionManager: {
      getBranch: () => branch,
      branch: () => {},
      resetLeaf: () => {},
    },
    modelRegistry: {
      complete: async (
        _model: unknown,
        request: { messages: Array<{ content: Array<{ text: string }> }> },
      ) => {
        const prompt = request.messages[0]?.content[0]?.text ?? "";
        prompts.push(prompt);
        completeCalls++;
        const text =
          completeCalls === 1
            ? Array.from(
                { length: 8 },
                (_value, index) =>
                  `STEP N${index + 1} | Completed semantic goal ${index + 1}`,
              ).join("\n")
            : [
                "STEP S1 | Completed semantic goal 3",
                "STEP S2 | Completed semantic goal 4",
                "STEP S3 | Completed semantic goal 5",
                "STEP S4 | Completed semantic goal 6",
                "STEP S5 | Completed semantic goal 7",
                "STEP CURRENT | Completed semantic goal 8",
                "STEP N1 | Completed semantic goal 9",
                "STEP N2 | Completed semantic goal 10",
              ].join("\n");
        return {
          role: "assistant" as const,
          content: [{ type: "text" as const, text }],
          api: "test",
          provider: "test",
          model: "test",
          usage: usage(1, 1),
          stopReason: "stop" as const,
          timestamp: 1,
        };
      },
    },
    getContextUsage: () => ({ tokens: 30, percent: 30, contextWindow: 100 }),
    ui: { notify: () => {} },
  } as unknown as ExtensionContext;
  const pi = {
    registerCommand: () => {},
    registerShortcut: () => {},
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    appendEntry: (customType: string, data: unknown) => {
      branch.push({
        type: "custom",
        id: `map-${++customId}`,
        parentId: branch.at(-1)?.id ?? null,
        timestamp: "2026-01-01T00:00:04Z",
        customType,
        data,
      } as SessionEntry);
    },
  } as unknown as ExtensionAPI;

  minimapExtension(pi);
  await handlers.get("session_start")?.({}, ctx);

  assert.equal(completeCalls, 2);
  assert.ok(prompts.every((prompt) => prompt.length < 20_000));
  assert.match(prompts[0] ?? "", /N8:\s+activity below/);
  assert.doesNotMatch(prompts[0] ?? "", /N9:\s+activity below/);
  assert.match(prompts[1] ?? "", /N2:\s+activity below/);
  const restored = restoreSavedState(branch);
  assert.deepEqual(
    restored.steps.map((step) => step.summary),
    Array.from(
      { length: 9 },
      (_value, index) => `Completed semantic goal ${index + 1}`,
    ),
  );
  assert.equal(restored.open?.summary, "Completed semantic goal 10");
  assert.deepEqual(
    restored.steps.map((step) => step.throughEntryId),
    Array.from({ length: 9 }, (_value, index) => `u${index + 1}`),
  );
  assert.equal(restored.open?.throughEntryId, "u10");
});

test("lifecycle reconciles on settlement and recovers update failures", async () => {
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
  const completionOptions: unknown[] = [];
  let failAppend = false;
  const rollbackIds: string[] = [];
  let resolveFirst = (_response: Completion) => {};
  const firstResponse = new Promise<Completion>((resolve) => {
    resolveFirst = resolve;
  });
  let resolveShutdown = (_response: Completion) => {};
  const shutdownResponse = new Promise<Completion>((resolve) => {
    resolveShutdown = resolve;
  });

  const ctx = {
    mode: "rpc",
    hasUI: true,
    model: { contextWindow: 100 },
    sessionManager: {
      getBranch: () => branch,
      branch: (entryId: string) => {
        rollbackIds.push(entryId);
        branch = branch.slice(
          0,
          branch.findIndex((entry) => entry.id === entryId) + 1,
        );
      },
      resetLeaf: () => {
        branch = [];
      },
    },
    modelRegistry: {
      complete: async (...args: unknown[]) => {
        completionOptions.push(args[2]);
        completeCalls++;
        if (completeCalls === 1) return firstResponse;
        if (completeCalls === 2) return completion("STEP NEW | Branch B");
        if (completeCalls === 3) return completion("", "error");
        if (completeCalls === 6) return shutdownResponse;
        return completion("STEP CURRENT+N1+N2 | Branch B recovered");
      },
    },
    getContextUsage: () => ({ tokens: 10, percent: 10, contextWindow: 100 }),
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionContext;
  const pi = {
    registerCommand: (name: string) => commands.push(name),
    registerShortcut: () => {},
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    appendEntry: (type: string, data: unknown) => {
      const entry = {
        type: "custom",
        id: `map-${appended.length + 1}`,
        parentId: branch.at(-1)?.id ?? null,
        timestamp: "2026-01-01T00:00:00Z",
        customType: type,
        data,
      } as SessionEntry;
      branch.push(entry);
      if (failAppend) {
        failAppend = false;
        throw new Error("persistence failed");
      }
      appended.push({ branch: branchName, type, data });
    },
  } as unknown as ExtensionAPI;

  minimapExtension(pi);
  assert.ok(commands.includes("minimap"));
  const settle = handlers.get("agent_settled");
  const switchTree = handlers.get("session_tree");
  const shutdown = handlers.get("session_shutdown");
  assert.ok(settle && switchTree && shutdown);

  const settlingA = Promise.resolve(settle({}, ctx));
  await Promise.resolve();
  assert.equal(completeCalls, 1);
  branchName = "B";
  branch = [userEntry("b1", "Work on branch B")];
  const switching = Promise.resolve(switchTree({}, ctx));
  resolveFirst(completion("STEP NEW | Branch A"));
  await Promise.all([settlingA, switching]);

  assert.equal(completeCalls, 2);
  const { signal, ...options } = completionOptions.at(-1) as {
    signal: AbortSignal;
    cacheRetention: string;
    maxTokens: number;
    timeoutMs: number;
  };
  assert.equal(signal.aborted, false);
  assert.deepEqual(options, {
    cacheRetention: "none",
    maxTokens: 256,
    timeoutMs: 60_000,
  });
  assert.equal(
    (completionOptions[0] as { signal: AbortSignal }).signal.aborted,
    true,
  );
  assert.ok(appended.every((entry) => entry.branch === "B"));
  assert.equal(JSON.stringify(appended).includes("Branch A"), false);
  assert.equal(JSON.stringify(appended).includes("Branch B"), true);

  branch = [...branch, userEntry("b2", "Retry branch B", "b1")];
  await settle({}, ctx);
  assert.equal(completeCalls, 3);
  assert.deepEqual(notices, [
    "Minimap summary failed; it will retry after the next run",
  ]);

  branch = [...branch, userEntry("b3", "Finish branch B", "b2")];
  failAppend = true;
  await settle({}, ctx);
  assert.equal(branch.at(-1)?.id, "b3");
  assert.deepEqual(rollbackIds, ["b3"]);
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
  branch = [...branch, userEntry("b4", "Cancel branch B", "b3")];
  const settlingShutdown = Promise.resolve(settle({}, ctx));
  await Promise.resolve();
  assert.equal(completeCalls, 6);
  const beforeShutdown = appended.length;
  shutdown({ reason: "quit" }, ctx);
  assert.equal(
    (completionOptions.at(-1) as { signal: AbortSignal }).signal.aborted,
    true,
  );
  resolveShutdown(completion("STEP CURRENT+NEW | Should not persist"));
  await settlingShutdown;
  assert.equal(appended.length, beforeShutdown);
});

test("compact and expanded panes render within their width", async () => {
  type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
  const handlers = new Map<string, Handler>();
  const shortcuts = new Map<string, () => void>();
  let component: Component | undefined;
  let hidden = false;
  const tui = {
    requestRender: () => {},
    terminal: { rows: 40 },
  } as unknown as TUI;
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  const handle = {
    setHidden: (value: boolean) => {
      hidden = value;
    },
    isHidden: () => hidden,
  } as unknown as OverlayHandle;
  const custom = ((
    factory: (
      tui: TUI,
      theme: Theme,
      keybindings: never,
      done: () => void,
    ) => Component,
    options: { onHandle?: (value: OverlayHandle) => void },
  ) => {
    component = factory(tui, theme, {} as never, () => {});
    options.onHandle?.(handle);
    return Promise.resolve(undefined);
  }) as unknown as ExtensionContext["ui"]["custom"];
  const branch: SessionEntry[] = [
    ...entries,
    {
      type: "custom",
      id: "pane-state",
      parentId: "summary",
      timestamp: "2026-01-01T00:00:04Z",
      customType: "session-minimap-state",
      data: {
        version: 1,
        callUsage: { ...usage(0, 0), cost: 0 },
        revision: {
          replaceCount: 0,
          steps: [
            {
              version: 1,
              throughEntryId: "assistant",
              summary: "Completed authentication audit",
              tools: { read: 1 },
              skills: {},
              decisions: ["Keep native session storage"],
              errors: 0,
              usage: { ...usage(100, 20), cost: 0.01 },
              contextStart: { tokens: 10, percent: 10, contextWindow: 100 },
              contextEnd: { tokens: 20, percent: 20, contextWindow: 100 },
              createdAt: 1,
            },
          ],
        },
        open: {
          throughEntryId: "result",
          summary: "Repair authentication failure",
          tools: { read: 1 },
          skills: {},
          decisions: ["Use bounded recovery retries"],
          errors: 1,
          usage: { ...usage(10, 2), cost: 0.01 },
          contextStart: { tokens: 20, percent: 20, contextWindow: 100 },
          contextEnd: { tokens: 30, percent: 30, contextWindow: 100 },
          createdAt: 2,
        },
      },
    } as SessionEntry,
  ];
  const ctx = {
    mode: "tui",
    hasUI: true,
    sessionManager: { getBranch: () => branch },
    getContextUsage: () => ({ tokens: 10, percent: 10, contextWindow: 100 }),
    ui: { custom, notify: () => {} },
  } as unknown as ExtensionContext;
  const pi = {
    registerCommand: () => {},
    registerShortcut: (key: string, options: { handler: () => void }) =>
      shortcuts.set(key, options.handler),
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    appendEntry: () => {},
  } as unknown as ExtensionAPI;

  minimapExtension(pi);
  await handlers.get("session_start")?.({}, ctx);
  const compact = component?.render(72) ?? [];
  assert.ok(compact.length > 0);
  assert.ok(compact.every((line) => visibleWidth(line) <= 72));

  shortcuts.get("ctrl+shift+m")?.();
  const expanded = component?.render(96) ?? [];
  assert.match(expanded.join("\n"), /Ctrl\+Shift\+M compact/);
  assert.match(expanded.join("\n"), /Completed authentication audit/);
  assert.match(expanded.join("\n"), /Failure review/);
  assert.match(expanded.join("\n"), /Recent decisions/);
  assert.ok(expanded.every((line) => visibleWidth(line) <= 96));
});
