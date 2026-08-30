import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateOutput,
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

test("rejects superseded approaches", () => {
  const reasons = evaluateOutput(
    scenario("remove a rejected approach from the canonical title"),
    "STEP CURRENT+NEW | Complete Redis caching with accepted process local storage",
  );
  assert.match(reasons.join("\n"), /forbidden text/);
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
