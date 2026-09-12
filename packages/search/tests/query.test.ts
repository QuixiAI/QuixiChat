import test from "node:test";
import assert from "node:assert/strict";
import { lexicalQuery } from "../src/query.ts";

test("lexical queries quote every term, keep FTS operators literal and join by the requested match", () => {
  assert.equal(lexicalQuery('where did OR "the archive" go?'), '"where" AND "did" AND "OR" AND "the archive" AND "go?"');
  assert.equal(lexicalQuery("where did we decide", { match: "any" }), '"where" OR "did" OR "we" OR "decide"');
  assert.equal(lexicalQuery("  "), "");
  assert.throws(() => lexicalQuery('"unclosed'), /Close the quoted/);
});
