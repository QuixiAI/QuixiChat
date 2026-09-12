import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { parseBrowserNames } from "./browser-engines.mjs";

test("unset defaults to both; each supported selection preserves exactly its engines", () => {
  assert.deepEqual(parseBrowserNames(undefined), ["chromium", "webkit"]);
  for (const value of ["chromium", "webkit", "chromium,webkit"]) {
    assert.deepEqual(parseBrowserNames(value), value.split(","));
  }
});

test("empty, unknown, duplicate and malformed selections fail instead of dropping engines", () => {
  for (const value of ["", "firefox", "Chromium", " chromium", "chromium, webkit", ",", "chromium,", ",webkit", "chromium,chromium", "webkit,webkit", "chromium,webkit,chromium", "webkit,chromium"]) {
    assert.throws(() => parseBrowserNames(value), /QUIXI_TEST_BROWSERS/);
  }
});

test("runner entry reads the environment and rejects missing engine implementations", () => {
  const entry = new URL("./browser-engines.mjs", import.meta.url).href;
  for (const value of [undefined, "chromium", "webkit", "chromium,webkit", "", "firefox", "webkit,webkit"]) {
    const env = { ...process.env };
    if (value === undefined) delete env.QUIXI_TEST_BROWSERS;
    else env.QUIXI_TEST_BROWSERS = value;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import { browserEngines } from ${JSON.stringify(entry)}; console.log(JSON.stringify(browserEngines({chromium:'C',webkit:'W'})));`], { env, encoding: "utf8" });
    if (value === "" || value === "firefox" || value === "webkit,webkit") {
      assert.notEqual(child.status, 0);
      assert.match(child.stderr, /QUIXI_TEST_BROWSERS/);
    } else {
      assert.equal(child.status, 0, child.stderr);
      assert.deepEqual(JSON.parse(child.stdout), parseBrowserNames(value).map(name => [name, name === "chromium" ? "C" : "W"]));
    }
  }
  const missing = spawnSync(process.execPath, ["--input-type=module", "-e", `import { browserEngines } from ${JSON.stringify(entry)}; browserEngines({});`], { env: { ...process.env, QUIXI_TEST_BROWSERS: "webkit" }, encoding: "utf8" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /was not provided/);
});
