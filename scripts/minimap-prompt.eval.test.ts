import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateOutput,
  modelOutputOptions,
  parseAttempts,
  scenarios,
} from "./minimap-prompt.eval.ts";

const scenario = (name: string) => {
  const match = scenarios.find((item) => item.name === name);
  assert.ok(match, `missing scenario: ${name}`);
  return match;
};

for (const item of scenarios) {
  test(`oracle passes: ${item.name}`, () => {
    assert.deepEqual(evaluateOutput(item, item.oracle), []);
  });
}

test("rejects invented source identifiers", () => {
  const reasons = evaluateOutput(
    scenario("merge a retry into its existing milestone"),
    "STEP CURRENT+N1 | Complete the existing authentication callback validation repair",
  );
  assert.match(reasons.join("\n"), /grammar/);
});

test("rejects incorrect semantic grouping", () => {
  const reasons = evaluateOutput(
    scenario("merge a retry into its existing milestone"),
    `STEP CURRENT | Complete robust authentication callback input validation
STEP NEW | Complete the remaining authentication callback correction successfully`,
  );
  assert.match(reasons.join("\n"), /grouping/);
});

test("rejects titles outside the word limit", () => {
  const reasons = evaluateOutput(
    scenario("merge a retry into its existing milestone"),
    "STEP CURRENT+NEW | Complete callback repair",
  );
  assert.match(reasons.join("\n"), /6-10 word/);
});

test("rejects routine decisions", () => {
  const item = scenario("merge a retry into its existing milestone");
  const reasons = evaluateOutput(
    item,
    `${item.oracle}\nDECISION: Complete the remaining callback correction`,
  );
  assert.match(reasons.join("\n"), /expected 0 decisions/);
});

test("rejects user-directed corrections as decisions", () => {
  const item = scenario(
    "preserve the accepted outcome after approach rejection",
  );
  const reasons = evaluateOutput(
    item,
    `${item.oracle}\nDECISION: Use existing process-local cache instead of Redis`,
  );
  assert.match(reasons.join("\n"), /expected 0 decisions/);
});

test("rejects completion restatements as decisions", () => {
  const item = scenario(
    "merge adjacent refinements but preserve phase boundaries",
  );
  const reasons = evaluateOutput(
    item,
    `${item.oracle}\nDECISION: Accept corrected operator guide examples`,
  );
  assert.match(reasons.join("\n"), /expected 0 decisions/);
});

test("rejects a superseded approach as the accepted outcome", () => {
  const reasons = evaluateOutput(
    scenario("preserve the accepted outcome after approach rejection"),
    "STEP CURRENT+NEW | Complete Redis-backed session caching implementation successfully",
  );
  assert.match(reasons.join("\n"), /forbidden text/);
});

test("allows a rejected approach as concise contrast", () => {
  const reasons = evaluateOutput(
    scenario("preserve the accepted outcome after approach rejection"),
    "STEP CURRENT+NEW | Complete session caching with process-local storage instead of Redis",
  );
  assert.deepEqual(reasons, []);
});

test("requires consequential decisions", () => {
  const reasons = evaluateOutput(
    scenario("capture a consequential agent decision"),
    "STEP NEW | Implement atomic revision persistence with SQLite transactions",
  );
  assert.match(reasons.join("\n"), /expected 1 decisions/);
});

test("requires the expected decision content", () => {
  const reasons = evaluateOutput(
    scenario("capture a consequential agent decision"),
    `STEP NEW | Implement atomic revision persistence with SQLite transactions
DECISION: Use independent writes for every revision`,
  );
  assert.match(reasons.join("\n"), /missing decision matching/);
});

test("bounds live evaluation attempts", () => {
  assert.equal(parseAttempts(undefined), 1);
  assert.equal(parseAttempts("5"), 5);
  for (const value of ["0", "6", "1.5", "invalid"])
    assert.throws(() => parseAttempts(value), /integer from 1 to 5/);
});

test("reserves text output for GPT-5 reasoning models", () => {
  assert.deepEqual(modelOutputOptions("gpt-5-mini"), {
    max_output_tokens: 1_024,
    reasoning: { effort: "minimal" },
  });
  assert.deepEqual(modelOutputOptions("gpt-4o-mini"), {
    max_output_tokens: 256,
  });
});
