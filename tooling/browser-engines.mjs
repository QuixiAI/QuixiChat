/** One explicit engine selection shared by Node runners and Playwright projects. */
export function parseBrowserNames(value) {
  if (value === undefined) return ["chromium", "webkit"];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("QUIXI_TEST_BROWSERS must not be empty; use chromium, webkit, or chromium,webkit.");
  }
  const names = value.split(",");
  if (names.some(name => name !== "chromium" && name !== "webkit")) {
    throw new Error("QUIXI_TEST_BROWSERS contains an unknown or empty browser; use chromium, webkit, or chromium,webkit (without spaces).");
  }
  if (new Set(names).size !== names.length) {
    throw new Error("QUIXI_TEST_BROWSERS contains duplicate browsers.");
  }
  if (value !== "chromium" && value !== "webkit" && value !== "chromium,webkit") {
    throw new Error("QUIXI_TEST_BROWSERS must be chromium, webkit, or chromium,webkit.");
  }
  return names;
}

export function browserNames() {
  return parseBrowserNames(process.env.QUIXI_TEST_BROWSERS);
}

export function browserEngines(engines) {
  return browserNames().map(name => {
    if (!engines[name]) throw new Error(`Selected browser engine ${name} was not provided by the runner.`);
    return [name, engines[name]];
  });
}
