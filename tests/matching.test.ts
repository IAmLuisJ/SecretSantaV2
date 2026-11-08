import assert from "node:assert/strict";
import test from "node:test";
import { findDraw } from "../app/server/matching.ts";

const adults = ["alex", "blake", "casey", "devon"];
const couple = { firstId: "alex", secondId: "blake" };

test("a complete draw respects a couple and directed last-season assignments", () => {
  const previous = [
    { giverId: "alex", recipientId: "casey" },
    { giverId: "blake", recipientId: "devon" },
    { giverId: "casey", recipientId: "blake" },
    { giverId: "devon", recipientId: "alex" },
  ];
  const result = findDraw(adults, [couple], previous);
  assert.ok(result);
  assert.deepEqual(new Map(result.map(({ giverId, recipientId }) => [giverId, recipientId])), new Map([
    ["alex", "devon"],
    ["blake", "casey"],
    ["casey", "alex"],
    ["devon", "blake"],
  ]));
});

for (const { name, roster, exclusions, previous } of [
  { name: "one adult", roster: adults.slice(0, 1), exclusions: [], previous: [] },
  { name: "three adults with two givers competing for one recipient", roster: adults.slice(0, 3), exclusions: [couple], previous: [] },
  {
    name: "two adults who drew each other last time",
    roster: adults.slice(0, 2),
    exclusions: [],
    previous: [{ giverId: "alex", recipientId: "blake" }, { giverId: "blake", recipientId: "alex" }],
  },
]) {
  test(`a draw is infeasible with ${name}`, () => {
    assert.equal(findDraw(roster, exclusions, previous), null);
  });
}

test("the first two-adult draw includes the only two valid assignments", () => {
  assert.deepEqual(new Map(findDraw(adults.slice(0, 2), [], [])?.map(({ giverId, recipientId }) => [giverId, recipientId])), new Map([
    ["alex", "blake"], ["blake", "alex"],
  ]));
});
