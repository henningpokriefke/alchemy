import { routePoolLabels } from "@/GitHub/Actions/routing.ts";
import { describe, expect, it } from "alchemy-test";

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
