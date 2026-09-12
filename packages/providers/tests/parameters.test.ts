import test from "node:test";
import assert from "node:assert/strict";
import { prepare } from "../src/request.ts";
import {
  CompatibilityError,
  adapterCatalog,
  initialProviderCatalogs,
  type ProviderInput,
} from "../src/index.ts";
import { model, input } from "./fixtures.ts";
const issue = (code: string) => (error: unknown) =>
  error instanceof CompatibilityError &&
  error.issues.some((item) => item.code === code);
const withParameters = (
  parameters: ProviderInput["parameters"],
): ProviderInput => ({ ...input(), parameters });

test("reviewed catalogs declare sampling parameters with dated protocol sources", () => {
  for (const catalog of initialProviderCatalogs()) {
    assert.deepEqual(
      [...catalog.model.capabilities.parameters],
      catalog.providerId === "anthropic"
        ? ["maxOutputTokens", "temperature", "topP", "stopSequences", "thinkingBudgetTokens"]
        : ["maxOutputTokens", "temperature", "topP", "stopSequences"],
    );
    assert.deepEqual(
      [...adapterCatalog(catalog)[0]!.capabilities.parameters],
      [...catalog.model.capabilities.parameters],
    );
    assert.equal(
      new Date(catalog.review.reviewedAt).toISOString().slice(0, 10),
      catalog.providerId === "anthropic" ? "2026-09-11" : "2026-09-10",
    );
    assert.ok(
      catalog.review.sources.includes(
        catalog.providerId === "anthropic"
          ? "https://platform.claude.com/docs/en/api/messages/create"
          : "https://github.com/openai/openai-node/blob/master/src/resources/chat/completions/completions.ts",
      ),
    );
    assert.ok(
      catalog.limitations.some((value) => value.includes("stop sequences")),
    );
  }
});

for (const protocol of ["openai-compatible", "anthropic"] as const) {
  const stopKey = protocol === "anthropic" ? "stop_sequences" : "stop";
  const otherStopKey = protocol === "anthropic" ? "stop" : "stop_sequences";
  const temperatureMax = protocol === "anthropic" ? 1 : 2;
  test(`${protocol}: sampling parameters map to protocol fields and blank settings are omitted`, () => {
    const body = prepare(
      protocol,
      withParameters({
        maxOutputTokens: 100,
        temperature: 0.3,
        topP: 0.9,
        stopSequences: ["END", "STOP"],
      }),
      model(protocol),
    ).body;
    assert.equal(body.temperature, 0.3);
    assert.equal(body.top_p, 0.9);
    assert.deepEqual(body[stopKey], ["END", "STOP"]);
    assert.equal(otherStopKey in body, false);
    const blank = prepare(
      protocol,
      withParameters({
        maxOutputTokens: 100,
        temperature: undefined,
        topP: undefined,
        stopSequences: [],
      } as unknown as ProviderInput["parameters"]),
      model(protocol),
    ).body;
    for (const key of ["temperature", "top_p", "stop", "stop_sequences"])
      assert.equal(key in blank, false, key);
    const edge = prepare(
      protocol,
      withParameters({ maxOutputTokens: 100, temperature: temperatureMax, topP: 1 }),
      model(protocol),
    ).body;
    assert.equal(edge.temperature, temperatureMax);
    assert.equal(edge.top_p, 1);
  });
  test(`${protocol}: catalog permission and protocol ranges reject settings before any request`, () => {
    const limited = model(protocol);
    limited.capabilities = {
      ...limited.capabilities,
      parameters: ["maxOutputTokens"],
    };
    assert.doesNotThrow(() =>
      prepare(
        protocol,
        withParameters({
          maxOutputTokens: 100,
          temperature: undefined,
        } as unknown as ProviderInput["parameters"]),
        limited,
      ),
    );
    for (const parameters of [
      { maxOutputTokens: 100, temperature: 0.5 },
      { maxOutputTokens: 100, topP: 0.5 },
      { maxOutputTokens: 100, stopSequences: ["END"] },
    ])
      assert.throws(
        () => prepare(protocol, withParameters(parameters), limited),
        issue("parameter_unsupported"),
      );
    assert.throws(
      () =>
        prepare(
          protocol,
          withParameters({
            maxOutputTokens: 100,
            temperature: temperatureMax + 0.01,
          }),
          model(protocol),
        ),
      issue("temperature"),
    );
    assert.throws(
      () =>
        prepare(
          protocol,
          withParameters({ maxOutputTokens: 100, temperature: -0.1 }),
          model(protocol),
        ),
      issue("temperature"),
    );
    assert.throws(
      () =>
        prepare(
          protocol,
          withParameters({ maxOutputTokens: 100, topP: 1.01 }),
          model(protocol),
        ),
      issue("top_p"),
    );
    for (const stopSequences of [
      [""],
      ["a", "b", "c", "d", "e"],
      ["x".repeat(1025)],
    ])
      assert.throws(
        () =>
          prepare(
            protocol,
            withParameters({ maxOutputTokens: 100, stopSequences }),
            model(protocol),
          ),
        issue("stop_sequences"),
      );
  });
}
