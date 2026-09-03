import { decodeRouteValue, routePoolLabels } from "@/GitHub/Actions/routing.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";

describe("routePoolLabels", () => {
  it("matches a single pool label exactly", () => {
    expect(
      routePoolLabels(
        ["self-hosted", "alchemy-ci-4x"],
        ["alchemy-ci-4x", "alchemy-release-4x"],
      ),
    ).toEqual(["alchemy-ci-4x"]);
  });

  it("returns empty when no label is registered", () => {
    expect(
      routePoolLabels(["self-hosted", "linux"], ["alchemy-ci-4x"]),
    ).toEqual([]);
  });

  it("ignores generic hardware labels", () => {
    expect(
      routePoolLabels(["linux", "x64", "large"], ["alchemy-ci-4x"]),
    ).toEqual([]);
  });

  it("matches multiple pools in job-label order without duplicates", () => {
    expect(
      routePoolLabels(
        ["alchemy-release-4x", "alchemy-ci-4x", "alchemy-ci-4x"],
        ["alchemy-ci-4x", "alchemy-release-4x"],
      ),
    ).toEqual(["alchemy-release-4x", "alchemy-ci-4x"]);
  });

  it("is case-sensitive", () => {
    expect(routePoolLabels(["Alchemy-CI-4x"], ["alchemy-ci-4x"])).toEqual([]);
  });
});

describe("decodeRouteValue", () => {
  it.effect("decodes a valid route target", () =>
    Effect.gen(function* () {
      const target = yield* decodeRouteValue(
        "/alchemy/github-runners/routes/alchemy-ci-4x",
        JSON.stringify({
          queueUrl: "https://sqs.eu-central-1.amazonaws.com/123/q",
          queueArn: "arn:aws:sqs:eu-central-1:123:q",
        }),
      );
      expect(target.queueUrl).toBe(
        "https://sqs.eu-central-1.amazonaws.com/123/q",
      );
      expect(target.queueArn).toBe("arn:aws:sqs:eu-central-1:123:q");
    }),
  );

  it.effect("fails on invalid JSON", () =>
    Effect.gen(function* () {
      const error = yield* decodeRouteValue("p", "not-json").pipe(Effect.flip);
      expect(error._tag).toBe("RouteDecodeError");
    }),
  );

  it.effect("fails when queue fields are missing or empty", () =>
    Effect.gen(function* () {
      const missing = yield* decodeRouteValue(
        "p",
        JSON.stringify({ queueUrl: "x" }),
      ).pipe(Effect.flip);
      expect(missing._tag).toBe("RouteDecodeError");

      const empty = yield* decodeRouteValue(
        "p",
        JSON.stringify({ queueUrl: "", queueArn: "" }),
      ).pipe(Effect.flip);
      expect(empty._tag).toBe("RouteDecodeError");
    }),
  );
});
