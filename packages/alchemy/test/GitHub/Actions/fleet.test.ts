import {
  buildFleetRequest,
  decideScale,
  orderCandidates,
  renderRunnerUserData,
  runnerTags,
} from "@/GitHub/Actions/fleet.ts";
import { DEFAULT_RUNNER_CONVENTIONS } from "@/GitHub/Actions/shared.ts";
import { describe, expect, it } from "alchemy-test";

describe("orderCandidates", () => {
  it("returns empty for empty inputs", () => {
    expect(orderCandidates([], ["sub-a"], 0)).toEqual([]);
    expect(orderCandidates(["m7i.xlarge"], [], 0)).toEqual([]);
  });

  it("expands the type x subnet matrix in order", () => {
    expect(
      orderCandidates(["m7i.xlarge", "m7a.xlarge"], ["sub-a", "sub-b"], 0),
    ).toEqual([
      { instanceType: "m7i.xlarge", subnetId: "sub-a" },
      { instanceType: "m7i.xlarge", subnetId: "sub-b" },
      { instanceType: "m7a.xlarge", subnetId: "sub-a" },
      { instanceType: "m7a.xlarge", subnetId: "sub-b" },
    ]);
  });

  it("rotates the starting offset per attempt", () => {
    const types = ["m7i.xlarge", "m7a.xlarge"];
    const subnets = ["sub-a", "sub-b"];
    const first = orderCandidates(types, subnets, 0);
    const second = orderCandidates(types, subnets, 1);
    expect(second[0]).toEqual(first[1]);
    expect(second).toHaveLength(first.length);
    // full rotation wraps around deterministically
    expect(orderCandidates(types, subnets, 4)).toEqual(first);
  });
});

describe("buildFleetRequest", () => {
  const base = {
    clientToken: "msg-123",
    launchTemplateName: "lt-name",
    candidates: [
      { instanceType: "m7i.xlarge", subnetId: "sub-a" },
      { instanceType: "m7a.xlarge", subnetId: "sub-b" },
    ],
    tags: { Name: "gh-alchemy-ci-4x-42" },
  } as const;

  it("builds a single-capacity instant fleet for spot", () => {
    const request = buildFleetRequest({ ...base, market: "spot" });
    expect(request.Type).toBe("instant");
    expect(request.ClientToken).toBe("msg-123");
    expect(request.TargetCapacitySpecification).toEqual({
      TotalTargetCapacity: 1,
      DefaultTargetCapacityType: "spot",
    });
    expect(request.SpotOptions).toEqual({
      AllocationStrategy: "price-capacity-optimized",
    });
    expect(request.OnDemandOptions).toBeUndefined();
    expect(request.LaunchTemplateConfigs?.[0].Overrides).toEqual([
      { InstanceType: "m7i.xlarge", SubnetId: "sub-a" },
      { InstanceType: "m7a.xlarge", SubnetId: "sub-b" },
    ]);
  });

  it("builds an on-demand fleet without spot options", () => {
    const request = buildFleetRequest({ ...base, market: "on-demand" });
    expect(request.TargetCapacitySpecification?.DefaultTargetCapacityType).toBe(
      "on-demand",
    );
    expect(request.SpotOptions).toBeUndefined();
    expect(request.OnDemandOptions).toEqual({
      AllocationStrategy: "lowest-price",
    });
  });

  it("tags instances and volumes", () => {
    const request = buildFleetRequest({ ...base, market: "spot" });
    const resourceTypes = (request.TagSpecifications ?? []).map(
      (spec) => spec.ResourceType,
    );
    expect(resourceTypes).toEqual(["instance", "volume"]);
    for (const spec of request.TagSpecifications ?? []) {
      expect(spec.Tags).toEqual([
        { Key: "Name", Value: "gh-alchemy-ci-4x-42" },
      ]);
    }
  });
});

describe("runnerTags", () => {
  it("marks ownership, pool, job, and name", () => {
    expect(
      runnerTags(DEFAULT_RUNNER_CONVENTIONS, {
        poolLabel: "alchemy-ci-4x",
        runnerName: "gh-alchemy-ci-4x-42",
        jobKey: "octo/hello/42",
      }),
    ).toEqual({
      "alchemy-github-runner": "true",
      "github-runner-pool": "alchemy-ci-4x",
      "github-job-id": "octo/hello/42",
      Name: "gh-alchemy-ci-4x-42",
    });
  });

  it("follows custom tag keys", () => {
    expect(
      runnerTags(
        {
          managedTagKey: "platform-managed",
          poolTagKey: "ci-pool",
          jobTagKey: "ci-job",
        },
        {
          poolLabel: "team-ci",
          runnerName: "gh-team-ci-7",
          jobKey: "octo/hello/7",
        },
      ),
    ).toEqual({
      "platform-managed": "true",
      "ci-pool": "team-ci",
      "ci-job": "octo/hello/7",
      Name: "gh-team-ci-7",
    });
  });
});

describe("renderRunnerUserData", () => {
  it("embeds the JIT prefix and self-terminate flow", () => {
    const script = renderRunnerUserData({
      ssmJitPrefix: "/alchemy/github-runners/jit",
      poolTagKey: "github-runner-pool",
      fallbackPoolLabel: "alchemy-ci-4x",
      fallbackRunnerName: "gh-x-1",
    });
    expect(script.startsWith("#!/bin/bash")).toBe(true);
    expect(script).toContain("/alchemy/github-runners/jit");
    expect(script).toContain("--jitconfig");
    expect(script).toContain("delete-parameter");
    expect(script).toContain("terminate-instances");
    expect(script).toContain("alchemy-ci-4x");
    expect(script).toContain("/opt/actions-runner");
    // region is self-discovered via IMDS so the template stays portable
    expect(script).toContain("placement/region");
  });

  it("honors a custom agent directory and pool tag key", () => {
    const script = renderRunnerUserData({
      ssmJitPrefix: "/platform/ci/jit",
      poolTagKey: "ci-pool",
      runnerDir: "/usr/local/actions-runner",
      fallbackPoolLabel: "team-ci",
      fallbackRunnerName: "gh-team-ci-pending",
    });
    expect(script).toContain("/usr/local/actions-runner");
    expect(script).toContain("/platform/ci/jit");
    expect(script).toContain("ci-pool");
  });
});

describe("decideScale", () => {
  it("launches for queued jobs under capacity", () => {
    expect(
      decideScale({
        jobStatus: "queued",
        liveInstanceCount: 2,
        maxRunners: 50,
      }),
    ).toBe("launch");
  });

  it("drops demand for non-queued or unknown jobs", () => {
    for (const jobStatus of ["in_progress", "completed", undefined]) {
      expect(
        decideScale({ jobStatus, liveInstanceCount: 0, maxRunners: 50 }),
      ).toBe("drop-stale");
    }
  });

  it("backs off at capacity so the message returns to the queue", () => {
    expect(
      decideScale({
        jobStatus: "queued",
        liveInstanceCount: 50,
        maxRunners: 50,
      }),
    ).toBe("at-capacity");
  });
});
