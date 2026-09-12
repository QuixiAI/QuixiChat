import test from "node:test";
import assert from "node:assert/strict";
import { fuseRanked, RRF_K } from "../src/fusion.ts";
const list = (ids: string[]) => ids.map((id) => ({ id, item: id }));
test("RRF with k=60 sums reciprocal ranks and explains each origin", () => {
  const fused = fuseRanked(list(["a", "b", "c"]), list(["c", "d", "a"]));
  assert.equal(RRF_K, 60);
  assert.deepEqual(fused.map((item) => [item.id, item.explanation, item.lexicalRank, item.semanticRank]), [
    ["a", "Exact + semantic match", 1, 3],
    ["c", "Exact + semantic match", 3, 1],
    ["b", "Exact text match", 2, null],
    ["d", "Semantic match", null, 2],
  ]);
  assert.ok(Math.abs(fused[0]!.score - (1 / 61 + 1 / 63)) < 1e-12);
  assert.ok(Math.abs(fused[2]!.score - 1 / 62) < 1e-12);
});
test("ties resolve by lexical then semantic rank, duplicates within one list count once, and k is validated", () => {
  const fused = fuseRanked(list(["x", "y"]), list(["y", "x"]));
  assert.deepEqual(fused.map((item) => item.id), ["x", "y"]);
  assert.equal(fused[0]!.score, fused[1]!.score);
  const duplicated = fuseRanked(list(["a", "a", "b"]), []);
  assert.deepEqual(duplicated.map((item) => [item.id, item.lexicalRank]), [["a", 1], ["b", 3]]);
  assert.deepEqual(fuseRanked([], []), []);
  assert.throws(() => fuseRanked(list(["a"]), [], 0), RangeError);
  const lexicalOnly = fuseRanked(list(["p", "q"]), []);
  assert.deepEqual(lexicalOnly.map((item) => item.explanation), ["Exact text match", "Exact text match"]);
});
