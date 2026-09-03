import {
  DEFAULT_RUNNER_CONVENTIONS,
  resolveRunnerConventions,
  runnerNameFor,
  ssmParametersArn,
} from "@/GitHub/Actions/shared.ts";
import { describe, expect, it } from "alchemy-test";

describe("resolveRunnerConventions", () => {
  it("resolves defaults when nothing is overridden", () => {
    expect(resolveRunnerConventions()).toEqual(DEFAULT_RUNNER_CONVENTIONS);
    expect(resolveRunnerConventions({})).toEqual(DEFAULT_RUNNER_CONVENTIONS);
  });

  it("merges overrides over defaults", () => {
    expect(
      resolveRunnerConventions({
        ssmRoutesPrefix: "/platform/ci/routes",
        managedTagKey: "platform-managed",
      }),
    ).toEqual({
      ...DEFAULT_RUNNER_CONVENTIONS,
      ssmRoutesPrefix: "/platform/ci/routes",
      managedTagKey: "platform-managed",
    });
  });

  it("treats empty strings as unset", () => {
    expect(resolveRunnerConventions({ poolTagKey: "" }).poolTagKey).toBe(
      DEFAULT_RUNNER_CONVENTIONS.poolTagKey,
    );
  });
});

describe("ssmParametersArn", () => {
  it("covers every parameter below the prefix", () => {
    expect(ssmParametersArn("/alchemy/github-runners/routes")).toBe(
      "arn:aws:ssm:*:*:parameter/alchemy/github-runners/routes/*",
    );
    expect(ssmParametersArn("/platform/ci/jit")).toBe(
      "arn:aws:ssm:*:*:parameter/platform/ci/jit/*",
    );
  });
});

describe("runnerNameFor", () => {
  it("supports a custom name prefix", () => {
    expect(runnerNameFor("team-ci", 7, "ci")).toBe("ci-team-ci-7");
  });
});
