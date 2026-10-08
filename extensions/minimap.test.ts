import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { createExtensionRuntime, ExtensionRunner, formatDimensionNote, SessionManager } from "@earendil-works/pi-coding-agent";
import type { UserMessage } from "@earendil-works/pi-ai";
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
import { LIVE_DIRECTION_SYSTEM_PROMPT, buildTranscript, splitPendingActivity } from "./minimap/summary.ts";
import { decideMilestoneBoundary } from "./minimap/jev.ts";

// Lifecycle tests must not use the operator's optional paid Jev gate.
delete process.env.PI_MINIMAP_JEV;

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

test("Jev accepts only confident typed boundary decisions", async () => {
  let requestBody = "";
  let authorization = "";
  const fetcher = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    requestBody = String(init?.body ?? "");
    authorization = new Headers(init?.headers).get("Authorization") ?? "";
    return new Response(
      JSON.stringify({
        answers: {
          boundary: { type: "choice", choice: "merge", confidence: 0.8 },
        },
      }),
    );
  }) as typeof fetch;

  assert.equal(
    await decideMilestoneBoundary(
      {
        currentMilestone: "Implement callback validation",
        newActivity: ["Verify valid and invalid callback states"],
      },
      { apiKey: "test-key", fetcher },
    ),
    "merge",
  );
  assert.equal(authorization, "Bearer test-key");
  const body = JSON.parse(requestBody) as {
    model: string;
    questions: {
      boundary: { type: string; criteria: { refresh?: unknown } };
    };
  };
  assert.equal(body.model, "jev-latest");
  assert.equal(body.questions.boundary.type, "choice");
  assert.equal(typeof body.questions.boundary.criteria.refresh, "string");
});

test("Jev refreshes title-changing corrections", async () => {
  const fetcher = (async () =>
    new Response(
      JSON.stringify({
        answers: {
          boundary: { type: "choice", choice: "refresh", confidence: 0.8 },
        },
      }),
    )) as typeof fetch;

  assert.equal(
    await decideMilestoneBoundary(
      {
        currentMilestone: "Add remote-service session cache",
        newActivity: [
          "Reject the remote service and use process-local storage instead.",
        ],
      },
      { apiKey: "test-key", fetcher },
    ),
    "refresh",
  );
});

test("Jev falls back when unavailable or uncertain", async () => {
  const lowConfidence = (async () =>
    new Response(
      JSON.stringify({
        answers: {
          boundary: { type: "choice", choice: "merge", confidence: 0.59 },
        },
      }),
    )) as typeof fetch;
  const failed = (async () =>
    new Response(null, { status: 500 })) as typeof fetch;
  const state = {
    currentMilestone: "Fix callback",
    newActivity: ["Continue fix"],
  };
  let callsWithoutKey = 0;
  const shouldNotRun = (async () => {
    callsWithoutKey++;
    return new Response(null, { status: 500 });
  }) as typeof fetch;

  assert.equal(
    await decideMilestoneBoundary(state, { fetcher: shouldNotRun }),
    "uncertain",
  );
  assert.equal(callsWithoutKey, 0);
  assert.equal(
    await decideMilestoneBoundary(state, {
      apiKey: "test-key",
      fetcher: lowConfidence,
    }),
    "uncertain",
  );
  assert.equal(
    await decideMilestoneBoundary(state, {
      apiKey: "test-key",
      fetcher: failed,
    }),
    "uncertain",
  );
});

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

test("collectStats includes native usage without minimap duplication", () => {
  const base = { parentId: null, timestamp: "2026-01-01T00:00:00Z" };
  const nativeEntries: SessionEntry[] = [
    {
      ...base,
      id: "warm",
      type: "usage",
      kind: "cache_warm",
      provider: "test",
      model: "test",
      usage: usage(10, 2),
    },
    {
      ...base,
      id: "unknown",
      type: "usage",
      kind: "future_operation",
      provider: "test",
      model: "test",
      usage: usage(20, 4),
    },
    {
      ...base,
      id: "compact",
      type: "compaction",
      summary: "Earlier work",
      firstKeptEntryId: "compact",
      tokensBefore: 100,
      usage: usage(30, 6),
    },
    {
      ...base,
      id: "branch",
      type: "branch_summary",
      summary: "Other branch",
      fromId: "user",
      usage: usage(40, 8),
    },
    {
      ...base,
      id: "unmetered",
      type: "branch_summary",
      summary: "No usage",
      fromId: "user",
    },
  ];
  const stats = collectStats([...entries, ...nativeEntries]);
  assert.equal(stats.input, 218);
  assert.equal(stats.output, 46);
  assert.equal(stats.totalTokens, 264);
  assert.equal(stats.agentTokens, 252);
  assert.equal(stats.summaryTokens, 12);
  assert.ok(Math.abs(stats.cost - 0.063) < 1e-9);
  assert.deepEqual({ ...stats.tools }, { read: 1 });
});

test("nested diagnostics count parent usage once", () => {
  const base = { parentId: null, timestamp: "2026-01-01T00:00:00Z" };
  const branch: SessionEntry[] = [
    {
      ...base,
      id: "assistant",
      type: "message",
      message: {
        role: "assistant",
        api: "test",
        provider: "test",
        model: "test",
        content: [
          { type: "toolCall", id: "outer", name: "codemode", arguments: {} },
        ],
        usage: usage(100, 20),
        stopReason: "toolUse",
        timestamp: 1,
      },
    } as SessionEntry,
    {
      ...base,
      id: "result",
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "outer",
        toolName: "codemode",
        content: [{ type: "text", text: "Handled nested errors" }],
        usage: usage(10, 2),
        isError: false,
        timestamp: 2,
        nestedCalls: {
          complete: false,
          calls: [
            {
              id: "outer/1",
              name: "read",
              status: "ok",
              arguments: { path: "/skills/session-closeout/SKILL.md" },
            },
            {
              id: "outer/2",
              name: "bash",
              status: "error",
              error: "Command exited with code 1",
            },
            {
              id: "outer/3",
              name: "bash",
              status: "error",
              error: "Command exited with code 1",
            },
            { id: "outer/4", name: "read", status: "ok", argumentsBytes: 9000 },
            { id: "outer/5", name: "write", status: "unfinished" },
          ],
        },
      },
    },
  ];
  const stats = collectStats(branch);
  assert.deepEqual({ ...stats.tools }, { codemode: 1, read: 2, bash: 2, write: 1 });
  assert.deepEqual({ ...stats.skills }, { "session-closeout": 1 });
  assert.equal(stats.errors, 2);
  assert.deepEqual({ ...stats.errorKinds }, { command: 2 });
  assert.equal(stats.agentTokens, 132);
  assert.equal(stats.totalTokens, 132);
  assert.equal(stats.cost, 0.02);
  assert.deepEqual({ ...stats.toolTokens }, { codemode: 12 });
  const review = failureReview(branch, stats.tools);
  assert.equal(review.total, 2);
  assert.equal(review.recovered, 1);
  assert.equal(review.unresolved, 0);
  assert.equal(review.patterns.length, 1);
  assert.deepEqual(review.byTool, [
    { name: "bash", failures: 2, calls: 2, rate: 100 },
  ]);

  const result = branch[1]!;
  assert.ok(result.type === "message" && result.message.role === "toolResult");
  result.message.isError = true;
  result.message.content = [{ type: "text", text: "Error: orchestration failed" }];
  assert.equal(collectStats(branch).errors, 3);
  assert.equal(failureReview(branch, stats.tools).unresolved, 1);
  result.message.nestedCalls!.calls = result.message.nestedCalls!.calls.filter(
    (call) => call.status !== "ok",
  );
  const unfinished = failureReview(branch, collectStats(branch).tools);
  assert.equal(unfinished.runs, 1);
  assert.equal(unfinished.recovered, 0);
  assert.equal(unfinished.maxStreak, 3);
});

test("model failures appear in diagnostics and recovery analysis", () => {
  const assistant = (
    id: string,
    stopReason: "stop" | "error",
    errorMessage?: string,
  ) =>
    ({
      type: "message",
      id,
      parentId: null,
      timestamp: `2026-01-01T00:00:0${id}Z`,
      message: {
        role: "assistant",
        content: [],
        api: "test",
        provider: "test",
        model: "test",
        usage: usage(1, 1),
        stopReason,
        ...(errorMessage ? { errorMessage } : {}),
        timestamp: Number(id),
      },
    }) as SessionEntry;
  const branch = [
    assistant("1", "error", "provider unavailable"),
    assistant("2", "stop"),
  ];

  const stats = collectStats(branch);
  assert.equal(stats.errors, 1);
  assert.deepEqual({ ...stats.errorKinds }, { model: 1 });
  assert.equal(sessionEfficiency(branch, stats).failureRate, 50);

  const review = failureReview(branch, {});
  assert.deepEqual(
    {
      total: review.total,
      runs: review.runs,
      recovered: review.recovered,
      unresolved: review.unresolved,
      maxStreak: review.maxStreak,
    },
    { total: 1, runs: 1, recovered: 1, unresolved: 0, maxStreak: 1 },
  );
  assert.deepEqual({ ...review.byType }, { model: 1 });
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
    malformed("mixed-state", "session-minimap-state", {
      version: 1,
      callUsage: { ...usage(4, 2), cost: 0 },
      usageOnly: true,
      revision: { replaceCount: 0, steps: [] },
    }),
    malformed("impossible-revision", "session-minimap-state", {
      version: 1,
      callUsage: { ...usage(0, 0), cost: 0 },
      revision: { replaceCount: 1, steps: [] },
    }),
    malformed("bad-evidence", "session-minimap-state", {
      version: 1, callUsage: { ...usage(0, 0), cost: 0 }, revision: { replaceCount: 0, steps: [] },
      open: { summary: "Invalid evidence", evidence: "unknown", throughEntryId: "user", tools: {}, decisions: [], errors: 0,
        usage: { ...usage(0, 0), cost: 0 }, contextStart: { tokens: null, percent: null },
        contextEnd: { tokens: null, percent: null }, createdAt: 0 },
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

test("long single-prompt runs become bounded semantic sources", () => {
  const run: SessionEntry[] = [
    {
      type: "message",
      id: "user-long-run",
      parentId: null,
      timestamp: "2026-01-01T00:00:00Z",
      message: {
        role: "user",
        content: "Implement the delivery",
        timestamp: 1,
      },
    } as SessionEntry,
    ...Array.from(
      { length: 10 },
      (_, index) =>
        ({
          type: "message",
          id: `work-${index + 1}`,
          parentId: index ? `work-${index}` : "user-long-run",
          timestamp: "2026-01-01T00:00:01Z",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: `**Phase ${index + 1} progress**` },
              {
                type: "toolCall",
                id: `call-${index + 1}`,
                name: "edit",
                arguments: {},
              },
            ],
            api: "test",
            provider: "test",
            model: "test",
            usage: usage(1, 1),
            stopReason: "toolUse",
            timestamp: index + 2,
          },
        }) as SessionEntry,
    ),
  ];

  const segments = splitPendingActivity(run);
  assert.equal(segments.length, 8);
  assert.deepEqual(
    segments.flatMap((segment) => segment.map((entry) => entry.id)),
    run.map((entry) => entry.id),
  );
  assert.ok(
    segments
      .slice(1)
      .every((segment) =>
        segment.every(
          (entry) => entry.type !== "message" || entry.message.role !== "user",
        ),
      ),
  );
  assert.deepEqual(
    splitPendingActivity(run.slice(1)).flatMap((segment) => segment.map((entry) => entry.id)),
    run.slice(1).map((entry) => entry.id),
  );
  assert.deepEqual(splitPendingActivity([entries[3]!]), []);
  const transcript = segments
    .map((segment) => buildTranscript(segment, 2_000))
    .join("\n");
  assert.match(transcript, /Actions: edit/);
  assert.doesNotMatch(transcript, /Phase \d+ progress|Progress:/);
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
    attempts: 5,
    cacheShare: 75,
    failureRate: 20,
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
        beforePercent: 91,
        afterPercent: 24,
      },
      {
        entryIndex: 2,
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

  assert.equal(resets[0]?.afterPercent, null);
  assert.equal(resets[1]?.afterPercent, 25);
});

test("settled semantic threads are not shown as active work", () => {
  assert.equal(minimapStatus(true, true), "active");
  assert.equal(minimapStatus(false, true), "settled");
  assert.equal(minimapStatus(false, false), "idle");
});

test("session_start reconciles pending activity without blocking", async () => {
  type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
  type Completion = {
    role: "assistant";
    content: Array<{ type: "text"; text: string }>;
    api: string;
    provider: string;
    model: string;
    usage: ReturnType<typeof usage>;
    stopReason: "stop";
    timestamp: number;
  };
  const handlers = new Map<string, Handler>();
  const branch = [
    {
      type: "message",
      id: "pending",
      parentId: null,
      timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: "Restore pending work", timestamp: 1 },
    } as SessionEntry,
    { ...entries[1], id: "pending-assistant", parentId: "pending",
      message: { role: "assistant", content: [{ type: "text", text: "Restored pending activity" }], api: "test", provider: "test", model: "test", usage: usage(0, 0), stopReason: "stop", timestamp: 1 } } as SessionEntry,
  ];
  let resolveCompletion = (_response: Completion) => {};
  const completion = new Promise<Completion>((resolve) => {
    resolveCompletion = resolve;
  });
  let resolvePersistence = () => {};
  const persisted = new Promise<void>((resolve) => {
    resolvePersistence = resolve;
  });
  let completeCalls = 0;
  const ctx = {
    mode: "rpc",
    hasUI: false,
    model: { contextWindow: 100 },
    sessionManager: { getBranch: () => branch },
    modelRegistry: {
      complete: () => {
        completeCalls++;
        return completion;
      },
    },
    getContextUsage: () => ({ tokens: 10, percent: 10, contextWindow: 100 }),
    ui: { notify: () => {} },
  } as unknown as ExtensionContext;
  const pi = {
    registerCommand: () => {},
    registerShortcut: () => {},
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    appendEntry: (customType: string, data: unknown) => {
      branch.push({
        type: "custom",
        id: `map-${branch.length}`,
        parentId: branch.at(-1)?.id ?? null,
        timestamp: "2026-01-01T00:00:01Z",
        customType,
        data,
      } as SessionEntry);
      if ((data as { callUsage: { totalTokens: number } }).callUsage.totalTokens) resolvePersistence();
    },
  } as unknown as ExtensionAPI;

  minimapExtension(pi);
  const start = handlers.get("session_start");
  assert.ok(start);
  assert.equal(start({}, ctx), undefined);
  assert.equal(completeCalls, 1);

  handlers.get("before_agent_start")?.({ prompt: "Steer into billing recovery" }, ctx);
  const steering = { role: "user" as const, content: "Steer into billing recovery", timestamp: 2 };
  handlers.get("message_end")?.({ message: steering }, ctx);
  branch.push({ type: "message", id: "steering", parentId: branch.at(-1)?.id ?? null,
    timestamp: "2026-01-01T00:00:02Z", message: steering });
  handlers.get("turn_end")?.({ message: { role: "assistant" }, toolResults: [] }, ctx);
  resolveCompletion({
    role: "assistant",
    content: [{ type: "text", text: "STEP CURRENT+NEW | Restored pending activity" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: usage(1, 1),
    stopReason: "stop",
    timestamp: 1,
  });
  await persisted;
  assert.equal(
    restoreSavedState(branch).open?.summary,
    "Steer into billing recovery",
  );
  assert.equal(restoreSavedState(branch).steps[0]?.summary, "Restore pending work");
  assert.equal(collectStats(branch).summaryTokens, 2);
});

test("tail reconciliation preserves user boundaries and recomputes their data", async () => {
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
    "STEP CURRENT+NEW | Investigated authentication behavior\nDECISION: Use native session storage",
    "STEP CURRENT+NEW | Implemented authentication flow",
    "STEP CURRENT+NEW | Verified authentication behavior",
  ];
  let contextTokens = 20;
  const branch: SessionEntry[] = [
    user("u1", "Investigate authentication", null),
    assistant("a1", "u1", "read", 10, 2),
  ];
  let customId = 0;
  const ctx = {
    mode: "rpc",
    hasUI: false,
    model: { contextWindow: 100 },
    isIdle: () => true,
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
  assert.deepEqual(restored.steps.map((step) => step.summary), [
    "Investigated authentication behavior", "Implemented authentication flow",
  ]);
  assert.equal(restored.open?.summary, "Verified authentication behavior");
  assert.equal(Object.hasOwn(restored.open ?? {}, "version"), false);
  assert.deepEqual(restored.steps.map((step) => ({ ...step.tools })), [{ read: 1 }, { edit: 1 }]);
  assert.deepEqual(restored.steps.map((step) => step.usage.totalTokens), [12, 23]);
  assert.deepEqual(restored.steps[0]?.decisions, ["Use native session storage"]);
  assert.deepEqual({ ...restored.open?.tools }, { test: 1 });
  assert.equal(restored.open?.errors, 1);
  assert.equal(restored.open?.usage.totalTokens, 40);
  assert.deepEqual(
    [restored.steps[0]?.contextStart.tokens, restored.steps[0]?.contextEnd.tokens],
    [20, 40],
  );
  assert.deepEqual([restored.open?.contextStart.tokens, restored.open?.contextEnd.tokens], [60, 60]);
});
test("fresh and stale history reconstruct after startup model restore", async () => {
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
  branch.push({ ...entries[1], id: "a10", parentId: "u10",
    message: { role: "assistant", content: [{ type: "text", text: "Completed final semantic goal" }], api: "test", provider: "test", model: "test", usage: usage(0, 0), stopReason: "stop", timestamp: 1 } } as SessionEntry);
  const prompts: string[] = [];
  let completeCalls = 0;
  let customId = 0;
  const ctx = {
    mode: "rpc",
    hasUI: false,
    model: { contextWindow: 100 },
    isIdle: () => true,
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
        const text = "STEP CURRENT+NEW | Completed semantic goal 10";
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
  await handlers.get("session_start")?.({}, {
    ...ctx,
    model: undefined,
  } as ExtensionContext);
  assert.equal(completeCalls, 0);
  await handlers.get("model_select")?.({}, ctx);
  assert.equal(completeCalls, 1);
  await handlers.get("session_start")?.({}, {
    ...ctx,
    model: undefined,
  } as ExtensionContext);
  assert.equal(completeCalls, 1);
  await handlers.get("model_select")?.({}, ctx);

  assert.equal(completeCalls, 1);
  assert.ok(prompts.every((prompt) => prompt.length < 20_000));
  assert.doesNotMatch(prompts.join("\n"), /activity below|NEW ACTIVITY:/);
  assert.match(prompts[0] ?? "", /SOURCE KIND: agent-directed continuation/);
  assert.doesNotMatch(prompts[0] ?? "", /^S\d+:/m);
  const restored = restoreSavedState(branch);
  assert.deepEqual(
    restored.steps.map((step) => step.summary),
    Array.from(
      { length: 9 },
      (_value, index) => readableGoal(`Goal ${index + 1} ${"x".repeat(5_000)}`),
    ),
  );
  assert.equal(restored.open?.summary, "Completed semantic goal 10");
  assert.deepEqual(
    restored.steps.map((step) => step.throughEntryId),
    Array.from({ length: 9 }, (_value, index) => `u${index + 1}`),
  );
  assert.equal(restored.open?.throughEntryId, "a10");
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
    ...(stopReason === "error" ? { errorMessage: "provider failed" } : {}),
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
  let idle = false;
  let contextTokens = 10;
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
    isIdle: () => idle,
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
        if (!idle) throw new Error("settled handler ran while active");
        completionOptions.push(args[2]);
        completeCalls++;
        if (completeCalls === 1) return firstResponse;
        if (completeCalls === 2) return completion("STEP CURRENT+NEW | Branch B");
        if (completeCalls === 3) return completion("", "error");
        const lastSourceId = branch
          .filter((entry) => entry.type === "message" && entry.message.role === "user")
          .at(-1)?.id;
        if (lastSourceId === "b5") return shutdownResponse;
        if (lastSourceId === "b4")
          return completion(
            "STEP CURRENT+NEW | Branch B caught up",
          );
        return completion("STEP CURRENT+NEW | Branch B recovered");
      },
    },
    getContextUsage: () => ({
      tokens: contextTokens,
      percent: contextTokens,
      contextWindow: 100,
    }),
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
      if (failAppend && (data as { callUsage: { totalTokens: number } }).callUsage.totalTokens) {
        failAppend = false;
        throw new Error("persistence failed");
      }
      appended.push({ branch: branchName, type, data });
    },
  } as unknown as ExtensionAPI;

  minimapExtension(pi);
  assert.ok(commands.includes("minimap"));
  const beforeStart = handlers.get("before_agent_start");
  const addAssistant = () => {
    const last = branch.at(-1);
    if (last?.type !== "message" || last.message.role !== "user") return;
    branch.push({ ...last, id: `${last.id}-assistant`, parentId: last.id,
      message: completion("Finished branch work") });
  };
  const settle = (event: unknown, context: ExtensionContext) => {
    if (idle) addAssistant();
    return handlers.get("agent_settled")?.(event, context);
  };
  const switchTree = (event: unknown, context: ExtensionContext) => {
    addAssistant();
    return handlers.get("session_tree")?.(event, context);
  };
  const shutdown = handlers.get("session_shutdown");
  assert.ok(beforeStart && handlers.has("agent_settled") && handlers.has("session_tree") && shutdown);

  beforeStart({ prompt: "Work on branch A" }, ctx);
  await settle({}, ctx);
  assert.equal(completeCalls, 0);
  assert.equal(appended.length, 0);
  idle = true;
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
  const billed = appended.filter((entry) =>
    (entry.data as { callUsage: { totalTokens: number } }).callUsage.totalTokens);
  assert.ok(billed.every((entry) => entry.branch === "B"));
  assert.equal(JSON.stringify(billed).includes("Branch A"), false);
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
  assert.equal(branch.at(-1)?.type, "custom");
  assert.deepEqual(rollbackIds, [branch.at(-1)?.id]);
  assert.equal(completeCalls, 4);
  branch = [...branch, userEntry("b4", "Continue branch B", "b3")];
  contextTokens = 20;
  beforeStart({ prompt: "Continue branch B" }, ctx);
  contextTokens = 30;
  await settle({}, ctx);
  assert.equal(completeCalls, 5);
  assert.equal(
    JSON.stringify(appended.at(-2)?.data).includes("recovered"),
    true,
  );
  assert.equal(
    JSON.stringify(appended.at(-1)?.data).includes("caught up"),
    true,
  );
  const recovered = restoreSavedState(branch);
  assert.equal(recovered.open?.throughEntryId, "b4-assistant");
  assert.equal(recovered.open?.contextStart.tokens, 20);
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
  branch = [...branch, userEntry("b5", "Cancel branch B", "b4")];
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

test("panes render live activity during thinking and tool execution", async (t) => {
  type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
  const handlers = new Map<string, Handler>();
  const shortcuts = new Map<string, () => void>();
  let component: Component | undefined;
  let hidden = false;
  let renderRequests = 0;
  let completeCalls = 0;
  let appendedEntries = 0;
  const tui = {
    requestRender: () => { renderRequests++; },
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
    model: { contextWindow: 100 },
    modelRegistry: { complete: () => { completeCalls++; throw new Error("unexpected model call"); } },
    isIdle: () => true,
    sessionManager: { getBranch: () => branch },
    getContextUsage: () => ({ tokens: 10, percent: 10, contextWindow: 100 }),
    ui: { custom, notify: () => {} },
  } as unknown as ExtensionContext;
  const pi = {
    registerCommand: () => {},
    registerShortcut: (key: string, options: { handler: () => void }) =>
      shortcuts.set(key, options.handler),
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    appendEntry: () => { appendedEntries++; },
  } as unknown as ExtensionAPI;

  minimapExtension(pi);
  await handlers.get("session_start")?.({}, ctx);
  const compact = component?.render(72) ?? [];
  assert.ok(compact.length > 0);
  assert.ok(compact.every((line) => visibleWidth(line) <= 72));
  assert.match(compact.join("\n"), /Repair authentication failure/);
  assert.match(compact.join("\n"), /Idle/);
  assert.doesNotMatch(compact.join("\n"), /No completed steps yet/);

  shortcuts.get("ctrl+shift+m")?.();
  const expanded = component?.render(96) ?? [];
  assert.match(expanded.join("\n"), /Ctrl\+Shift\+M compact/);
  assert.match(expanded.join("\n"), /Completed authentication audit/);
  assert.match(expanded.join("\n"), /Failure review/);
  assert.match(expanded.join("\n"), /Recent decisions/);
  assert.ok(expanded.every((line) => visibleWidth(line) <= 96));
  assert.match(expanded.join("\n"), /Repair authentication failure/);
  assert.match(expanded.join("\n"), /Idle/);

  let now = 10_000;
  t.mock.method(Date, "now", () => now);
  handlers.get("before_agent_start")?.({ prompt: "" }, ctx);
  assert.match(component?.render(96).join("\n") ?? "", /User request/);
  handlers.get("before_agent_start")?.(
    { prompt: "Fix live minimap labels" },
    ctx,
  );
  const active = component?.render(96) ?? [];
  assert.match(active.join("\n"), /Fix live minimap labels/);
  assert.doesNotMatch(active.join("\n"), /Starting semantic step/);
  assert.match(active.join("\n"), /Repair authentication failure/);
  shortcuts.get("ctrl+shift+m")?.();
  assert.match(component?.render(96).join("\n") ?? "", /Repair authentication failure/);
  shortcuts.get("ctrl+shift+m")?.();

  const render = () => component?.render(96).join("\n") ?? "";
  const stream = (assistantMessageEvent: unknown) =>
    handlers.get("message_update")?.({ assistantMessageEvent }, ctx);
  const text = (value: string) => stream({
    type: "text_delta",
    contentIndex: 0,
    partial: { content: [{ type: "text", text: value }] },
  });
  assert.equal(handlers.get("message_start")?.({ message: { role: "assistant" } }, ctx), undefined);
  assert.match(render(), /Live · Generating response/);
  assert.equal(stream({ type: "thinking_start" }), undefined);
  assert.match(render(), /Live · Thinking · 0s/);
  now += 5_000;
  const previousRenders = renderRequests;
  stream({ type: "thinking_delta", delta: "PRIVATE_REASONING_SENTINEL" });
  assert.ok(renderRequests > previousRenders);
  assert.match(render(), /Live · Thinking · 5s/);
  assert.doesNotMatch(render(), /PRIVATE_REASONING_SENTINEL/);

  stream({ type: "text_start" });
  text("Checking session");
  text("\u001b[31mChecking session data\u001b[0m");
  assert.match(render(), /Live · Responding/);
  assert.equal(render().match(/Checking session/g)?.length, 1);
  assert.doesNotMatch(render(), /\u001b/);
  text(" ".repeat(320) + "OUTSIDE_PREVIEW_BOUND");
  assert.doesNotMatch(render(), /OUTSIDE_PREVIEW_BOUND/);
  text(" ".repeat(319) + "🧪");
  assert.doesNotMatch(render(), /[\uD800-\uDBFF]/u);
  text("a".repeat(159) + "🧪");
  assert.doesNotMatch(render(), /[\uD800-\uDBFF]/u);
  stream({ type: "text_start" });
  text("Checking session data" + "x".repeat(100_000));
  stream({ type: "toolcall_start" });
  assert.match(render(), /Live · Preparing tool call/);
  handlers.get("tool_execution_start")?.({ toolName: "read" }, ctx);
  assert.match(render(), /Live · Running read/);
  assert.equal(render().match(/Running read/g)?.length, 1);
  handlers.get("tool_execution_end")?.({ toolName: "read", isError: false }, ctx);
  assert.match(render(), /Live · Finished read/);
  assert.equal(render().match(/Finished read/g)?.length, 1);
  assert.match(render(), /Checking session data/);
  handlers.get("tool_execution_start")?.({ toolName: "bash" }, ctx);
  handlers.get("tool_execution_end")?.({ toolName: "bash", isError: true }, ctx);
  assert.match(render(), /Live · Failed bash/);
  assert.doesNotMatch(render(), /Checking session data/); // Only three recent activities.
  assert.ok((component?.render(96) ?? []).every((line) => visibleWidth(line) <= 96));

  shortcuts.get("ctrl+shift+m")?.();
  const liveCompact = component?.render(60) ?? [];
  assert.match(liveCompact.join("\n"), /Live · Failed bash/);
  assert.ok(liveCompact.every((line) => visibleWidth(line) <= 60));
  handlers.get("message_end")?.({ message: { role: "assistant", stopReason: "aborted" } }, ctx);
  assert.match(render(), /Live · Aborted/);
  handlers.get("message_end")?.({ message: { role: "assistant", stopReason: "error" } }, ctx);
  assert.match(render(), /Live · Response failed/);
  assert.equal(completeCalls, 0);
  assert.equal(appendedEntries, 0);

  await handlers.get("session_tree")?.({}, ctx);
  assert.doesNotMatch(render(), /Live ·|Failed bash/);
  handlers.get("before_agent_start")?.({ prompt: "Check recovery" }, ctx);
  assert.match(render(), /Live · Starting/);
  assert.doesNotMatch(render(), /Failed bash/);
  stream({ type: "thinking_start" });
  await handlers.get("agent_settled")?.({}, ctx);
  assert.doesNotMatch(render(), /Live ·/);
  stream({ type: "thinking_delta", delta: "PRIVATE_REASONING_SENTINEL" });
  assert.doesNotMatch(render(), /Live ·|PRIVATE_REASONING_SENTINEL/);
  assert.equal(completeCalls, 0);
  assert.equal(appendedEntries, 0);

  const response = (value: string, stopReason: "stop" | "error" = "stop") => ({
    role: "assistant" as const,
    content: [{ type: "text" as const, text: value }],
    api: "test",
    provider: "test",
    model: "test",
    usage: usage(1, 1),
    stopReason,
    timestamp: 1,
  });
  const requests: Array<{
    prompt: string;
    systemPrompt: string;
    signal: AbortSignal | undefined;
    resolve: (value: ReturnType<typeof response>) => void;
  }> = [];
  t.mock.method(ctx.modelRegistry, "complete", (...[_model, request, options]: Parameters<ExtensionContext["modelRegistry"]["complete"]>) =>
    new Promise<ReturnType<typeof response>>((resolve) => {
      const message = request.messages[0] as { content: Array<{ text: string }> };
      requests.push({
        prompt: message.content[0]?.text ?? "",
        systemPrompt: request.systemPrompt ?? "",
        signal: options?.signal,
        resolve,
      });
    }),
  );
  t.mock.method(pi, "appendEntry", (customType: string, data: unknown) => {
    appendedEntries++;
    branch.push({
      type: "custom",
      id: `live-map-${appendedEntries}`,
      parentId: branch.at(-1)?.id ?? null,
      timestamp: "2026-01-01T00:00:05Z",
      customType,
      data,
    } as SessionEntry);
  });
  const settledHistory = restoreSavedState(branch);
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  let turn = 0;
  const addTurn = (value: string, result = "Routine tool result") => {
    const id = `live-${++turn}`;
    const message = {
      ...response(value),
      stopReason: "toolUse" as const,
      content: [
        { type: "thinking" as const, thinking: "**PRIVATE_REASONING_SENTINEL**" },
        { type: "text" as const, text: value },
        { type: "toolCall" as const, id, name: "read", arguments: { path: "authentication.ts" } },
      ],
    };
    const toolResult = {
      role: "toolResult" as const,
      toolCallId: id,
      toolName: "read",
      content: [{ type: "text" as const, text: result }],
      isError: false,
      timestamp: 1,
    };
    branch.push(
      { type: "message", id, parentId: branch.at(-1)?.id ?? null, timestamp: "2026-01-01T00:00:06Z", message },
      { type: "message", id: `${id}-result`, parentId: id, timestamp: "2026-01-01T00:00:07Z", message: toolResult },
    );
    handlers.get("tool_execution_start")?.({ toolName: "read" }, ctx);
    handlers.get("tool_execution_end")?.({ toolName: "read", isError: false }, ctx);
    const event = { message, toolResults: [toolResult] };
    assert.equal(handlers.get("turn_end")?.(event, ctx), undefined);
    return event;
  };
  const startRun = (prompt: string) => {
    handlers.get("before_agent_start")?.({ prompt }, ctx);
    branch.push({ type: "message", id: `live-user-${branch.length}`, parentId: branch.at(-1)?.id ?? null,
      timestamp: "2026-01-01T00:00:05Z", message: { role: "user", content: prompt, timestamp: 1 } });
  };
  startRun("Repair authentication failure");

  const routine = addTurn("Checking authentication data");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.systemPrompt, LIVE_DIRECTION_SYSTEM_PROMPT);
  assert.match(requests[0]!.prompt, /authentication\.ts/);
  assert.match(requests[0]!.prompt, /Routine tool result/);
  assert.doesNotMatch(requests[0]!.prompt, /PRIVATE_REASONING_SENTINEL/);
  const rendersBeforeCheck = renderRequests;
  requests[0]!.resolve(response("UNCHANGED"));
  await flush();
  assert.equal(renderRequests, rendersBeforeCheck);
  assert.match(render(), /Repair authentication failure/);
  assert.deepEqual(restoreSavedState(branch).steps.slice(0, settledHistory.steps.length), settledHistory.steps);
  assert.equal(restoreSavedState(branch).steps.at(-1)?.summary, settledHistory.open?.summary);
  assert.equal(collectStats(branch).summaryTokens, collectStats(entries).summaryTokens + 2);
  handlers.get("turn_end")?.(routine, ctx);
  await flush();
  assert.equal(requests.length, 1); // Do not recheck the same evidence.
  stream({ type: "thinking_delta", delta: "PRIVATE_REASONING_SENTINEL" });
  assert.equal(requests.length, 1); // No per-token model calls.

  addTurn("Authentication is fixed; investigate the separate billing outage", "Billing service is unavailable");
  addTurn("The billing outage needs an independent queue repair");
  addTurn("Queue corruption blocks billing recovery");
  assert.equal(requests.length, 2); // Coalesce turns while the background check runs.
  requests[1]!.resolve(response("STEP NEW | Investigating independent billing outage after authentication repair"));
  await flush();
  assert.equal(requests.length, 3);
  assert.match(render(), /Investigating independent billing outage/);
  assert.match(requests[2]!.prompt, /independent queue repair/);
  assert.match(requests[2]!.prompt, /Queue corruption/);
  assert.doesNotMatch(requests[2]!.prompt, /Checking authentication data|PRIVATE_REASONING_SENTINEL/);
  requests[2]!.resolve(response("STEP NEW | Repairing corrupted billing queue to unblock recovery"));
  await flush();
  assert.match(render(), /Repairing corrupted billing queue/);
  assert.match(render(), /Live ·/);
  shortcuts.get("ctrl+shift+m")?.();
  assert.match(render(), /Repairing corrupted billing queue/); // Both pane sizes retain pivot rows.
  const pivots = restoreSavedState(branch);
  assert.deepEqual(pivots.steps.slice(0, settledHistory.steps.length), settledHistory.steps);
  assert.equal(pivots.steps.length, settledHistory.steps.length + 3);
  assert.equal(pivots.open?.summary, "Repairing corrupted billing queue to unblock recovery");

  addTurn("Routine verification of the queue repair");
  requests[3]!.resolve(response("not a direction plan"));
  await flush();
  assert.match(render(), /Repairing corrupted billing queue/);
  addTurn("Retry routine queue verification");
  requests[4]!.resolve(response("", "error"));
  await flush();
  assert.match(render(), /Repairing corrupted billing queue/);

  addTurn("A stale change must not replace the next run");
  const oldRun = requests[5]!;
  startRun("Verify billing recovery");
  assert.equal(oldRun.signal?.aborted, true);
  const entriesBeforeStale = appendedEntries;
  const statsBeforeStale = collectStats(branch);
  oldRun.resolve(response("STEP NEW | Stale direction from the previous active run"));
  await flush();
  assert.equal(appendedEntries, entriesBeforeStale + 1);
  assert.equal(collectStats(branch).summaryTokens, statsBeforeStale.summaryTokens + 2);
  assert.equal(collectStats(branch).cost, statsBeforeStale.cost + 0.01);
  assert.match(render(), /Verify billing recovery/);
  assert.doesNotMatch(render(), /Stale direction/);

  addTurn("Another significant direction before settlement");
  const unsettled = requests[6]!;
  const statsBeforeSettlement = collectStats(branch);
  const settling = Promise.resolve(handlers.get("agent_settled")?.({}, ctx));
  assert.equal(unsettled.signal?.aborted, true);
  unsettled.resolve(response("STEP NEW | Stale direction must not overwrite settled history"));
  await flush();
  assert.equal(collectStats(branch).summaryTokens, statsBeforeSettlement.summaryTokens + 2);
  assert.equal(collectStats(branch).cost, statsBeforeSettlement.cost + 0.01);
  const finalRequest = requests[7]!;
  assert.notEqual(finalRequest.systemPrompt, LIVE_DIRECTION_SYSTEM_PROMPT);
  const sourceIds = [...finalRequest.prompt.matchAll(/^(S\d+|CURRENT|NEW|N\d+):/gm)].map((match) => match[1]);
  finalRequest.resolve(response(`STEP ${sourceIds.join("+")} | Restored authentication and billing after independent queue repair`));
  await settling;
  await flush();
  assert.doesNotMatch(render(), /Live ·|Stale direction/);
  assert.equal(restoreSavedState(branch).open?.summary, "Restored authentication and billing after independent queue repair");

  startRun("Check final recovery");
  addTurn("A stale direction from the previous session branch");
  const treeRequest = requests.at(-1)!;
  const entriesBeforeTree = appendedEntries;
  await handlers.get("session_tree")?.({}, { ...ctx, model: undefined } as ExtensionContext);
  assert.equal(treeRequest.signal?.aborted, true);
  treeRequest.resolve(response("STEP NEW | Stale direction must not cross the session tree"));
  await flush();
  assert.equal(appendedEntries, entriesBeforeTree);
  assert.doesNotMatch(render(), /Live ·|Stale direction/);

  startRun("Check final recovery");
  addTurn("A cancelled direction after shutdown");
  const shutdownRequest = requests.at(-1)!;
  handlers.get("session_shutdown")?.({}, ctx);
  assert.equal(shutdownRequest.signal?.aborted, true);
  const entriesBeforeShutdown = appendedEntries;
  shutdownRequest.resolve(response("STEP NEW | Cancelled direction must not persist after shutdown"));
  await flush();
  assert.equal(appendedEntries, entriesBeforeShutdown);
});


test("steering and handback retain rows and retry billed live checkpoints", async (t) => {
  type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
  const handlers = new Map<string, Handler>();
  const shortcuts = new Map<string, () => void>();
  let component: Component | undefined;
  const tui = { requestRender: () => {}, terminal: { rows: 40 } } as unknown as TUI;
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  const manager = SessionManager.inMemory(process.cwd());
  const notices: string[] = [];
  const requests: string[] = [];
  const pivot = "Investigating independent billing outage after authentication repair";
  const liveAnswers = ["UNCHANGED", `STEP NEW | ${pivot}`, `STEP NEW | ${pivot}`, "UNCHANGED"];
  let failCheckpoint = true;
  let completeCalls = 0;
  const response = (text: string) => ({
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "test", provider: "test", model: "test",
    usage: usage(1, 1), stopReason: "stop" as const, timestamp: 1,
  });
  const ctx = {
    mode: "tui", hasUI: true, model: { contextWindow: 100 },
    sessionManager: manager, isIdle: () => true,
    getContextUsage: () => ({ tokens: 10, percent: 10, contextWindow: 100 }),
    ui: {
      notify: (message: string) => notices.push(message),
      custom: (factory: (tui: TUI, theme: Theme, keybindings: never, done: () => void) => Component,
        options: { onHandle?: (handle: OverlayHandle) => void }) => {
        component = factory(tui, theme, {} as never, () => {});
        options.onHandle?.({ setHidden: () => {}, isHidden: () => false } as unknown as OverlayHandle);
        return Promise.resolve(undefined);
      },
    },
    modelRegistry: {
      complete: async (_model: unknown, request: { systemPrompt: string; messages: Array<{ content: Array<{ text: string }> }> }) => {
        completeCalls++;
        requests.push(request.messages[0]!.content[0]!.text);
        return response(request.systemPrompt === LIVE_DIRECTION_SYSTEM_PROMPT
          ? liveAnswers.shift()!
          : "STEP CURRENT+NEW | Verified final recovery after observed billing pivot");
      },
    },
  } as unknown as ExtensionContext;
  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerCommand: () => {},
    registerShortcut: (key: string, options: { handler: () => void }) => shortcuts.set(key, options.handler),
    appendEntry: (type: string, data: { callUsage: { totalTokens: number } }) => {
      manager.appendCustomEntry(type, data);
      if (failCheckpoint && data.callUsage.totalTokens) {
        failCheckpoint = false;
        throw new Error("checkpoint failed after leaf mutation");
      }
    },
  } as unknown as ExtensionAPI;
  minimapExtension(pi);
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  await handlers.get("session_start")?.({}, ctx);
  const header = (expanded = false) => {
    if (expanded) shortcuts.get("ctrl+shift+m")?.();
    assert.ok(component);
    const text = component.render(120).join("\n").split("Live ·")[0]!;
    if (expanded) shortcuts.get("ctrl+shift+m")?.();
    return text;
  };
  const assertCurrent = (calls: number, errors: number) => {
    assert.match(header(), new RegExp(`working · read×${calls}\\b`));
    if (errors) {
      assert.match(header(), new RegExp(`${errors} step failures`));
      assert.match(header(true), new RegExp(`${errors} current failures`));
    } else {
      assert.doesNotMatch(header(), /step failures/);
      assert.doesNotMatch(header(true), /current failures/);
    }
  };
  const rows = () => {
    const saved = restoreSavedState(manager.getBranch());
    return [...saved.steps, ...(saved.open ? [saved.open] : [])];
  };
  const steer = (content: UserMessage["content"]) => {
    const message = { role: "user" as const, content, timestamp: 1 };
    // Pi emits message_end before persisting the consumed steering message.
    handlers.get("message_end")?.({ message }, ctx);
    manager.appendMessage(message);
  };
  let turn = 0;
  const addTurn = (text: string, isError = false) => {
    const id = `call-${++turn}`;
    const message = { ...response(text), stopReason: "toolUse" as const,
      content: [...response(text).content, { type: "toolCall" as const, id, name: "read", arguments: {} }] };
    const result = { role: "toolResult" as const, toolCallId: id, toolName: "read",
      content: [{ type: "text" as const, text: "Public tool result" }], isError, timestamp: 1 };
    manager.appendMessage(message);
    handlers.get("tool_execution_start")?.({ toolName: "read" }, ctx);
    handlers.get("tool_execution_end")?.({ toolName: "read", isError }, ctx);
    manager.appendMessage(result);
    const event = { message, toolResults: [result] };
    handlers.get("turn_end")?.(event, ctx);
    return event;
  };

  handlers.get("before_agent_start")?.({ prompt: "Repair authentication" }, ctx);
  steer("Repair authentication");
  const routine = addTurn("Checking authentication data", true);
  await flush();
  assert.equal(completeCalls, 1);
  assert.equal(rows().length, 1);
  assert.equal(collectStats(manager.getBranch()).summaryTokens, 0);
  assert.match(notices[0] ?? "", /checkpoint failed/);
  handlers.get("turn_end")?.(routine, ctx);
  await flush();
  assert.equal(completeCalls, 1); // Retry persistence, not the provider.
  assert.equal(collectStats(manager.getBranch()).summaryTokens, 2);
  assertCurrent(1, 1);

  addTurn("Authentication is fixed; billing needs independent recovery");
  await flush();
  assert.deepEqual(rows().map((step) => step.summary), ["Repair authentication", pivot]);
  assertCurrent(1, 0); // A public pivot excludes preceding failures.
  assert.equal(rows()[0]?.errors, 1);
  addTurn("Routine billing verification");
  await flush();
  assert.equal(rows().length, 2); // An identical title is not another pivot.
  assertCurrent(2, 0); // Include pending activity after the pivot checkpoint.

  steer("Verify billing recovery");
  assert.equal(rows().length, 2); // Steering does not hide the last pivot.
  assert.doesNotMatch(header(), /working ·|step failures/); // Do not wait for the next checkpoint.
  assert.doesNotMatch(header(true), /current failures/);
  addTurn("Checking final billing recovery");
  await flush();
  assert.equal(rows().length, 3);
  assert.match(requests.at(-1) ?? "", /CURRENT MILESTONE: Verify billing recovery/);
  assert.doesNotMatch(requests.at(-1) ?? "", /Checking authentication data/);
  assertCurrent(1, 0); // Consumed steering starts a new counter scope.
  assert.equal(rows()[1]?.tools.read, 2);
  await handlers.get("agent_settled")?.({}, ctx);
  assert.deepEqual(rows().map((step) => step.summary), [
    "Repair authentication", pivot, "Verified final recovery after observed billing pivot",
  ]);
  assert.equal(collectStats(manager.getBranch()).summaryTokens, completeCalls * 2);

  const image = { type: "image" as const, data: "dGVzdA==", mimeType: "image/png" };
  const dimensionNote = formatDimensionNote({
    ...image, originalWidth: 3840, originalHeight: 2160,
    width: 2000, height: 1125, wasResized: true,
  })!;
  for (const [content, label] of [
    [[image], "User request"],
    [[image, { type: "text" as const, text: dimensionNote }], "User request"],
    [[image, { type: "text" as const, text: `Inspect payment screenshot\n\n${dimensionNote}` }], "Inspect payment screenshot"],
    [[image, { type: "text" as const, text: "[Image converted from image/bmp to image/png.]" }], "User request"],
    [[{ type: "text" as const, text: "[Image omitted: could not be converted to a supported inline image format.]" }], "User request"],
    [[{ type: "text" as const, text: "[Image omitted: could not be resized below the inline image size limit.]" }], "User request"],
    [[image, { type: "text" as const, text: "Inspect payment screenshot\n\n[Image converted from image/bmp to image/png.]" }], "Inspect payment screenshot"],
    [[{ type: "text" as const, text: "Inspect payment screenshot\n\n[Image omitted: could not be resized below the inline image size limit.]" }], "Inspect payment screenshot"],
    [[image, { type: "text" as const, text: `[Image converted from image/tiff to image/png.]\n${dimensionNote}` }], "User request"],
    [[image, { type: "text" as const, text: "[Image shows payment failure]" }], "[Image shows payment failure]"],
    ["/tmp/minimap-screenshot.png", "User request"],
    ['<file name="/abs/markup.txt">\nInline </file>\nFILE_BODY_SENTINEL\n</file>\nFix the checkout page', "Fix the checkout page"],
    ['<file name="/abs/markup.txt">\nInline </file>\nFILE_BODY_SENTINEL\n</file>', "User request"],
    ['<file name="/abs/shot.png"></file>\nFix the payment bug', "Fix the payment bug"],
    ['<file name="/abs/shot.png"></file>', "User request"],
    [`<file name="/abs/shot.png">${dimensionNote}</file>\nInspect payment screenshot`, "Inspect payment screenshot"],
    ['<file name="/abs/shot.bmp">[Image converted from image/bmp to image/png.]</file>\nInspect payment screenshot', "Inspect payment screenshot"],
    ['<file name="/abs/shot.tiff">[Image omitted: could not be converted to a supported inline image format.]</file>', "User request"],
    ['<file name="/abs/shot.png">[Image omitted: could not be resized below the inline image size limit.]</file>\nInspect payment screenshot', "Inspect payment screenshot"],
    ['<file name="/abs/first.png"></file>\n<file name="/abs/second.png"></file>\nCompare these payment screenshots', "Compare these payment screenshots"],
    ['<file name="/abs/payment.ts">\nNATIVE_FILE_CONTEXT\n</file>\nFix the payment bug', "Fix the payment bug"],
    ['<file name="/abs/payment.ts">\nNATIVE_FILE_CONTEXT\n</file>', "User request"],
    ['[Image shows payment failure]\n<file name="/abs/shot.png"></file>', "[Image shows payment failure]"],
  ] satisfies Array<[UserMessage["content"], string]>) {
    const previousTitles = rows().map((step) => step.summary);
    handlers.get("before_agent_start")?.({ prompt: "Follow the next request" }, ctx);
    steer(content);
    liveAnswers.push("UNCHANGED");
    addTurn("Reviewed the supplied screenshot");
    await flush();
    assert.deepEqual(rows().map((step) => step.summary), [...previousTitles, label]);
    assert.ok((requests.at(-1) ?? "").startsWith(`CURRENT MILESTONE: ${label}\n`));
    assert.doesNotMatch(requests.at(-1) ?? "", /<file name=|NATIVE_FILE_CONTEXT|\[Image(?:: original | converted from | omitted: )/);
    for (const mode of ["live", "history"] as const)
      assert.doesNotMatch(buildTranscript(manager.getBranch().slice(-5), 18_000, mode), /<file name=|NATIVE_FILE_CONTEXT|\[Image(?:: original | converted from | omitted: )/);
    await handlers.get("agent_settled")?.({}, ctx);
    assert.deepEqual(rows().slice(0, -1).map((step) => step.summary), previousTitles);
    assert.equal(rows().length, previousTitles.length + 1);
  }
  assert.equal(collectStats(manager.getBranch()).summaryTokens, completeCalls * 2);

  const delayed: Array<(value: ReturnType<typeof response>) => void> = [];
  t.mock.method(ctx.modelRegistry, "complete", () =>
    new Promise<ReturnType<typeof response>>((resolve) => delayed.push(resolve)));
  handlers.get("before_agent_start")?.({ prompt: "Verify delayed checkpoint recovery" }, ctx);
  steer("Verify delayed checkpoint recovery");
  addTurn("Checking delayed billing");
  const beforeLate = collectStats(manager.getBranch());
  const noticesBeforeLate = notices.length;
  const settling = Promise.resolve(handlers.get("agent_settled")?.({}, ctx));
  assert.equal(delayed.length, 2);
  failCheckpoint = true;
  delayed[0]!({ ...response("STEP NEW | Stale direction must not overwrite the settlement"), usage: usage(11, 0) });
  await flush();
  assert.match(notices.at(-1) ?? "", /checkpoint failed/);
  assert.equal(notices.length, noticesBeforeLate + 1);
  assert.equal(collectStats(manager.getBranch()).summaryTokens, beforeLate.summaryTokens);
  delayed[1]!({ ...response("STEP CURRENT+NEW | Verified delayed checkpoint recovery with retained usage"), usage: usage(22, 0) });
  await settling;
  assert.equal(collectStats(manager.getBranch()).summaryTokens, beforeLate.summaryTokens + 33);
  assert.equal(collectStats(manager.getBranch()).cost, beforeLate.cost + 0.02);
  await handlers.get("agent_settled")?.({}, ctx);
  assert.equal(delayed.length, 2);
  assert.equal(collectStats(manager.getBranch()).summaryTokens, beforeLate.summaryTokens + 33);
  assert.equal(rows().at(-1)?.summary, "Verified delayed checkpoint recovery with retained usage");
  handlers.get("session_shutdown")?.({}, ctx);
});

test("Current infers user titles, refines without tools or rows, and replays evidence badges", async (t) => {
  type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
  const handlers = new Map<string, Handler>();
  const shortcuts = new Map<string, () => void>();
  const manager = SessionManager.inMemory(process.cwd());
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  const userTitle = "Repair payment confirmation when settled invoices are reopened";
  const refinedTitle = "Repair duplicate payment confirmation using the existing retry policy";
  const pivot = "Investigate independent invoice corruption blocking the payment repair";
  const answers = [`STEP CURRENT | ${userTitle}`, `STEP CURRENT | ${refinedTitle}`, `STEP NEW | ${pivot}`, "UNCHANGED"];
  const prompts: string[] = [];
  let component: Component | undefined;
  let failRefinement = false;
  const response = (text: string) => ({
    role: "assistant" as const, content: [{ type: "text" as const, text }],
    api: "test", provider: "test", model: "test", stopReason: "stop" as const, timestamp: 1,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
  });
  const model = { contextWindow: 100 };
  const ctx = {
    mode: "tui", hasUI: true, model, sessionManager: manager, isIdle: () => true,
    getContextUsage: () => ({ tokens: 10, percent: 10, contextWindow: 100 }),
    modelRegistry: { complete: async (selected: unknown, request: { messages: Array<{ content: Array<{ text: string }> }> }) => {
      assert.equal(selected, model);
      prompts.push(request.messages[0]!.content[0]!.text);
      assert.ok(answers.length, "unexpected model call");
      return response(answers.shift()!);
    } },
    ui: { notify: () => {}, custom: (factory: (tui: TUI, theme: Theme, keybindings: never, done: () => void) => Component,
      options: { onHandle?: (handle: OverlayHandle) => void }) => {
      component = factory({ requestRender: () => {}, terminal: { rows: 50 } } as unknown as TUI,
        { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text } as unknown as Theme, {} as never, () => {});
      options.onHandle?.({ setHidden: () => {}, isHidden: () => false } as unknown as OverlayHandle);
      return Promise.resolve(undefined);
    } },
  } as unknown as ExtensionContext;
  minimapExtension({
    on: (event: string, handler: Handler) => handlers.set(event, handler), registerCommand: () => {},
    registerShortcut: (key: string, options: { handler: () => void }) => shortcuts.set(key, options.handler),
    appendEntry: (type: string, data: unknown) => {
      manager.appendCustomEntry(type, data);
      if (failRefinement) { failRefinement = false; throw new Error("refinement append failed after leaf mutation"); }
    },
  } as unknown as ExtensionAPI);
  const rows = () => {
    const saved = restoreSavedState(manager.getBranch());
    return [...saved.steps, ...(saved.open ? [saved.open] : [])];
  };
  const assertBadge = (badge: string, title: string) => {
    for (let layout = 0; layout < 2; layout++) {
      const text = component!.render(120).join("\n");
      const marker = `${badge} ${title.split(/\s+/).slice(0, 3).join(" ")}`;
      assert.ok(text.split("\n").some((line) => /\b\d+\./.test(line) && line.includes(marker)), text);
      if (rows().at(-1)?.summary === title && text.includes("Current"))
        assert.ok(text.split("\n").some((line) => line.includes("Current") && line.includes(marker)), text);
      shortcuts.get("ctrl+shift+m")!();
    }
  };
  const steer = (content: UserMessage["content"]) => {
    const message = { role: "user" as const, content, timestamp: 1 };
    handlers.get("message_end")!({ message }, ctx);
    manager.appendMessage(message); // Native ordering: emit, then persist.
  };
  const turn = (text: string) => {
    const message = { ...response(text), content: [
      { type: "thinking" as const, thinking: "**PRIVATE_TITLE_SENTINEL**" },
      { type: "text" as const, text },
    ] };
    handlers.get("message_end")!({ message }, ctx);
    manager.appendMessage(message);
    const event = { message, toolResults: [] };
    handlers.get("turn_end")!(event, ctx);
    return event;
  };
  await handlers.get("session_start")!({}, ctx);
  const request = "When I reopen a settled invoice, the payment confirmation runs again. Please find the cause and fix it without replacing the existing retry policy.";
  handlers.get("before_agent_start")!({ prompt: request }, ctx);
  steer(request);
  await flush();
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0]!.includes(request));
  assert.deepEqual(rows().map((step) => [step.summary, step.evidence]), [[userTitle, "user"]]);
  assertBadge("👤", userTitle);

  failRefinement = true;
  const refiningTurn = turn("The existing retry policy already supports deduplication; I will use it for payment confirmation.");
  await flush();
  assert.equal(rows()[0]?.summary, userTitle); // Failed refinement is not published.
  assert.equal(collectStats(manager.getBranch()).summaryTokens, 2);
  handlers.get("turn_end")!(refiningTurn, ctx);
  await flush(); // Retry the checkpoint, not the provider.
  assert.equal(prompts.length, 2); // Completed assistant turn, no tools required.
  assert.doesNotMatch(prompts[1]!, /PRIVATE_TITLE_SENTINEL/);
  assert.deepEqual(rows().map((step) => [step.summary, step.evidence]), [[refinedTitle, "both"]]);
  assertBadge("🔗", refinedTitle);
  for (const mode of ["live", "history"] as const)
    assert.doesNotMatch(buildTranscript(manager.getBranch(), 18_000, mode), /PRIVATE_TITLE_SENTINEL/);

  turn("An independent invoice corruption blocker prevents this repair; I will investigate that first.");
  await flush();
  assert.deepEqual(rows().map((step) => [step.summary, step.evidence]), [[refinedTitle, "both"], [pivot, "agent"]]);
  assertBadge("🤖", pivot);
  turn("Continuing the invoice corruption investigation.");
  await flush();
  assert.equal(rows().length, 2);
  assert.equal(collectStats(manager.getBranch()).summaryTokens, 8);
  const settledTitle = "Resolved invoice corruption preserving payment confirmation retry policy";
  answers.push(`STEP CURRENT+NEW | ${settledTitle}`);
  await handlers.get("agent_settled")!({}, ctx);
  assert.deepEqual(rows().map((step) => [step.summary, step.evidence]), [[refinedTitle, "both"], [settledTitle, "agent"]]);
  assert.equal(collectStats(manager.getBranch()).summaryTokens, 10);
  assert.doesNotMatch(prompts.at(-1)!, /PRIVATE_TITLE_SENTINEL/);

  const shortTitle = "Proceed with the work approved by the user";
  answers.push(`STEP CURRENT | ${shortTitle}`);
  handlers.get("before_agent_start")!({ prompt: "yes" }, ctx);
  steer("yes");
  await flush();
  assert.equal(rows().length, 3);
  assert.equal(rows().at(-1)?.evidence, "user");
  assert.equal(rows().at(-1)?.summary, shortTitle);
  assertBadge("👤", shortTitle);

  // A later native handler can delay persistence and replace the consumed message.
  const oldWork = { ...response("Read the previous approval instructions"), stopReason: "toolUse" as const,
    content: [{ type: "toolCall" as const, id: "prior-read", name: "read", arguments: {} }] };
  const oldResult = { role: "toolResult" as const, toolCallId: "prior-read", toolName: "read",
    content: [{ type: "text" as const, text: "Prior goal read failed" }], isError: true, timestamp: 1 };
  manager.appendMessage(oldWork);
  manager.appendMessage(oldResult);
  answers.push("UNCHANGED");
  handlers.get("turn_end")!({ message: oldWork, toolResults: [oldResult] }, ctx);
  await flush();
  const beforeDelayed = rows();
  const callsBeforeDelayed = prompts.length;
  const delayedTitle = "Restore billing notifications after repairing invoice confirmation failures";
  answers.push(`STEP CURRENT | ${delayedTitle}`);
  let releaseHandler!: () => void;
  const delayedHandler = new Promise<void>((resolve) => { releaseHandler = resolve; });
  const runner = new ExtensionRunner([
    { path: "minimap", handlers: new Map([["message_end", [handlers.get("message_end")!]]]) },
    { path: "delay", handlers: new Map([["message_end", [async () => {
      await delayedHandler;
      return { message: { role: "user" as const, content: "Repair billing notification failures after invoice confirmation", timestamp: 1 } };
    }]]]) },
  ] as unknown as ConstructorParameters<typeof ExtensionRunner>[0], createExtensionRuntime(), process.cwd(), manager, ctx.modelRegistry);
  t.mock.method(runner, "createContext", () => ctx);
  const nextMessage = { role: "user" as const, content: "Fix billing notifications", timestamp: 1 };
  handlers.get("before_agent_start")!({ prompt: nextMessage.content }, ctx);
  for (let layout = 0; layout < 2; layout++) {
    const header = component!.render(120).join("\n").split("Live ·")[0]!;
    assert.doesNotMatch(header, /working ·|step failures|current failures/);
    shortcuts.get("ctrl+shift+m")!();
  }
  const dispatch = runner.emitMessageEnd({ type: "message_end", message: nextMessage });
  await flush();
  assert.equal(prompts.length, callsBeforeDelayed); // Never infer into the preceding open row.
  assert.deepEqual(rows(), beforeDelayed);
  for (let layout = 0; layout < 2; layout++) {
    const header = component!.render(120).join("\n").split("Live ·")[0]!;
    assert.doesNotMatch(header, /working ·|step failures|current failures/);
    shortcuts.get("ctrl+shift+m")!();
  }
  releaseHandler();
  const finalMessage = (await dispatch) ?? nextMessage;
  assert.ok(finalMessage.role === "user");
  manager.appendMessage(finalMessage);
  handlers.get("message_start")!({ message: response("") }, ctx);
  await flush();
  assert.equal(prompts.length, callsBeforeDelayed + 1);
  assert.match(prompts.at(-1)!, /USER REQUEST:\nRepair billing notification failures after invoice confirmation/);
  assert.deepEqual(rows().slice(0, -1).map(({ summary, evidence }) => [summary, evidence]),
    beforeDelayed.map(({ summary, evidence }) => [summary, evidence]));
  assert.equal(rows().at(-1)?.summary, delayedTitle);
  assert.equal(rows().at(-1)?.evidence, "user");
  assertBadge("👤", delayedTitle);

  // A reload reads the recorded metadata; it does not need a model call.
  const callsBeforeReload = prompts.length;
  await handlers.get("session_start")!({}, { ...ctx, model: undefined });
  assertBadge("🔗", refinedTitle);
  assertBadge("🤖", settledTitle);
  assert.equal(prompts.length, callsBeforeReload);
  const shutdownTitle = "Do not start inferred task checks after shutdown";
  answers.push(`STEP CURRENT | ${shutdownTitle}`);
  handlers.get("before_agent_start")!({ prompt: shutdownTitle }, ctx);
  const shutdownMessage = { role: "user" as const, content: shutdownTitle, timestamp: 1 };
  manager.appendMessage((await runner.emitMessageEnd({ type: "message_end", message: shutdownMessage })) as UserMessage);
  const callsBeforeShutdown = prompts.length;
  const entriesBeforeShutdown = manager.getBranch().length;
  handlers.get("session_shutdown")!({}, ctx);
  await flush();
  assert.equal(prompts.length, callsBeforeShutdown);
  assert.equal(manager.getBranch().length, entriesBeforeShutdown);
});
