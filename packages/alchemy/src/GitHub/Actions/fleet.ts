import type * as ec2 from "@distilled.cloud/aws/ec2";
import { DEFAULT_RUNNER_DIR } from "./shared.ts";

export type RunnerMarket = "spot" | "on-demand";

/**
 * One concrete launch candidate: an instance type in a subnet (hence an
 * Availability Zone). The scaler walks candidates in order and launches
 * into the first one with capacity.
 */
export interface LaunchCandidate {
  readonly instanceType: string;
  readonly subnetId: string;
}

/**
 * Order `(instance type × subnet)` candidates for capacity-spread.
 * `attempt` rotates the starting offset so consecutive jobs (and scaler
 * retries after a capacity miss) spread across types and AZs instead of
 * hammering the same pool — the poor-man's `price-capacity-optimized`
 * diversification on top of the fleet request itself.
 *
 * Pure and deterministic for a given `attempt`: safe to unit test.
 *
 * **Example:** Spread launches
 * ```typescript
 * const first = orderCandidates(["m7i.xlarge", "m7a.xlarge"], ["sub-a", "sub-b"], 0);
 * const retry = orderCandidates(["m7i.xlarge", "m7a.xlarge"], ["sub-a", "sub-b"], 1);
 * // retry starts at a different (type, subnet) pair than first
 * ```
 */
export const orderCandidates = (
  instanceTypes: readonly string[],
  subnetIds: readonly string[],
  attempt: number,
): LaunchCandidate[] => {
  const candidates: LaunchCandidate[] = [];
  for (const instanceType of instanceTypes) {
    for (const subnetId of subnetIds) {
      candidates.push({ instanceType, subnetId });
    }
  }
  if (candidates.length === 0) {
    return candidates;
  }
  const offset =
    ((attempt % candidates.length) + candidates.length) % candidates.length;
  return [...candidates.slice(offset), ...candidates.slice(0, offset)];
};

export interface FleetRequestInput {
  /**
   * Idempotency token. The scaler passes the SQS demand message id so a
   * retried delivery never launches a second instance for the same job.
   */
  readonly clientToken: string;
  readonly launchTemplateName: string;
  readonly candidates: readonly LaunchCandidate[];
  readonly market: RunnerMarket;
  /**
   * Tags applied to the launched instance and its volumes.
   */
  readonly tags: Readonly<Record<string, string>>;
}

/**
 * Build an `instant` EC2 Fleet request for exactly one runner: one
 * capacity unit, heterogeneous overrides (every type × subnet
 * combination), `price-capacity-optimized` for Spot.
 *
 * Capacity misses surface as in-band `Errors` on
 * `CreateFleetResult` (not as thrown errors) — the scaler inspects them
 * and, for `RunInstances`-style fallback, walks the next candidate.
 */
export const buildFleetRequest = (
  input: FleetRequestInput,
): ec2.CreateFleetRequest => ({
  ClientToken: input.clientToken,
  Type: "instant",
  TargetCapacitySpecification: {
    TotalTargetCapacity: 1,
    DefaultTargetCapacityType: input.market === "spot" ? "spot" : "on-demand",
  },
  ...(input.market === "spot"
    ? {
        SpotOptions: {
          AllocationStrategy: "price-capacity-optimized",
        },
      }
    : {
        OnDemandOptions: {
          AllocationStrategy: "lowest-price",
        },
      }),
  LaunchTemplateConfigs: [
    {
      LaunchTemplateSpecification: {
        LaunchTemplateName: input.launchTemplateName,
        Version: "$Default",
      },
      Overrides: input.candidates.map((candidate) => ({
        InstanceType: candidate.instanceType as ec2.InstanceType,
        SubnetId: candidate.subnetId,
      })),
    },
  ],
  TagSpecifications: [
    {
      ResourceType: "instance",
      Tags: Object.entries(input.tags).map(([Key, Value]) => ({
        Key,
        Value,
      })),
    },
    {
      ResourceType: "volume",
      Tags: Object.entries(input.tags).map(([Key, Value]) => ({
        Key,
        Value,
      })),
    },
  ],
});

export interface RunnerInstanceTags {
  readonly poolLabel: string;
  readonly runnerName: string;
  readonly jobKey: string;
}

/**
 * Tag keys every runner instance (and its volumes) must carry, taken from
 * the resolved conventions so custom tagging standards keep working.
 */
export interface RunnerTagKeys {
  readonly managedTagKey: string;
  readonly poolTagKey: string;
  readonly jobTagKey: string;
}

/**
 * Tags every runner instance (and its volumes) must carry: the Alchemy
 * ownership marker (the reaper's safety boundary), the pool label, the
 * job key for GitHub correlation, and a `Name` for console readability.
 * `RunnerConventions` satisfies `RunnerTagKeys` structurally, so callers
 * pass the resolved conventions straight through.
 */
export const runnerTags = (
  keys: RunnerTagKeys,
  input: RunnerInstanceTags,
): Record<string, string> => ({
  [keys.managedTagKey]: "true",
  [keys.poolTagKey]: input.poolLabel,
  [keys.jobTagKey]: input.jobKey,
  Name: input.runnerName,
});

export interface RunnerUserDataInput {
  /**
   * SSM prefix holding per-job JIT parameters
   * (`<ssmJitPrefix>/<runner-name>`). The instance derives its own
   * parameter name from its `Name` tag, so the script stays static per
   * pool and works for every job.
   */
  readonly ssmJitPrefix: string;
  /**
   * Tag key carrying the pool label on runner instances. Taken from the
   * resolved conventions so custom tagging standards keep working.
   */
  readonly poolTagKey: string;
  /**
   * Directory holding the GitHub Actions runner agent on the prepared
   * AMI. Override it when the image lays the agent out elsewhere instead
   * of replacing the whole script.
   * @default "/opt/actions-runner"
   */
  readonly runnerDir?: string;
  readonly fallbackPoolLabel: string;
  readonly fallbackRunnerName: string;
}

/**
 * Render the static runner boot script baked into the launch template.
 * Per-job inputs reach the instance exclusively through its own tags
 * (set per fleet call) and its JIT parameter — the script itself is
 * identical for every runner of the pool:
 *
 * 1. wait for IMDSv2, resolve region + instance id,
 * 2. read this instance's `Name` / pool tags,
 * 3. fetch + delete `<ssmJitPrefix>/<runner-name>`,
 * 4. configure + run the agent (`--jitconfig`: exactly one job),
 * 5. self-terminate via the EC2 API (no shutdown behavior is set on the
 *    launch template, so `shutdown -h` would merely stop the instance).
 *
 * Requires a prepared AMI with the GitHub Actions runner agent
 * pre-installed (see `runnerDir`) and the AWS CLI (`aws`) on PATH. For
 * fully custom images, skip this renderer and pass a complete script via
 * the pool compute `userData` prop instead.
 */
export const renderRunnerUserData = (
  input: RunnerUserDataInput,
): string => `#!/bin/bash
set -euo pipefail

RUNNER_DIR=${JSON.stringify(input.runnerDir ?? DEFAULT_RUNNER_DIR)}
JIT_PREFIX=${JSON.stringify(input.ssmJitPrefix)}
POOL_TAG=${JSON.stringify(input.poolTagKey)}
FALLBACK_POOL=${JSON.stringify(input.fallbackPoolLabel)}
FALLBACK_NAME=${JSON.stringify(input.fallbackRunnerName)}

TOKEN=$(curl -sS -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
META="curl -sS -H \\"X-aws-ec2-metadata-token: $TOKEN\\" http://169.254.169.254/latest/meta-data"
INSTANCE_ID=$($META/instance-id)
REGION=$($META/placement/region)

TAGS_TSV=$(aws ec2 describe-tags --region "$REGION" \\
  --filters "Name=resource-id,Values=$INSTANCE_ID" \\
  --query "Tags[].[Key,Value]" \\
  --output text)
TAG_VALUE() { echo "$TAGS_TSV" | awk -v key="$1" '$1 == key {print $2}'; }
EFFECTIVE_POOL=$(TAG_VALUE "$POOL_TAG")
RUNNER_NAME=$(TAG_VALUE "Name")
[ -z "$EFFECTIVE_POOL" ] && EFFECTIVE_POOL="$FALLBACK_POOL"
[ -z "$RUNNER_NAME" ] && RUNNER_NAME="$FALLBACK_NAME"

JIT_PARAM="$JIT_PREFIX/$RUNNER_NAME"
JIT_CONFIG=$(aws ssm get-parameter --region "$REGION" --name "$JIT_PARAM" --query "Parameter.Value" --output text)
aws ssm delete-parameter --region "$REGION" --name "$JIT_PARAM" || true

cd "$RUNNER_DIR"
./run.sh --jitconfig "$JIT_CONFIG"

aws ec2 terminate-instances --region "$REGION" --instance-ids "$INSTANCE_ID" || sudo shutdown -h now
`;

export type ScaleDecision = "launch" | "drop-stale" | "at-capacity";

export interface ScaleDecisionInput {
  /**
   * GitHub workflow job status (`queued` | `in_progress` | `completed`).
   * `undefined` when the status lookup failed with a not-found-style
   * error (job deleted out-of-band).
   */
  readonly jobStatus: string | undefined;
  readonly liveInstanceCount: number;
  readonly maxRunners: number;
}

/**
 * Decide what to do with one capacity-demand signal. Pure so the policy
 * is unit-testable without AWS or GitHub:
 *
 * - the job left `queued` (started elsewhere, finished, cancelled, or
 *   gone) → `drop-stale` (acknowledge the message, launch nothing),
 * - the pool is at `maxRunners` → `at-capacity` (fail the message so it
 *   returns to the queue and is retried after the visibility timeout),
 * - otherwise → `launch`.
 */
export const decideScale = (input: ScaleDecisionInput): ScaleDecision => {
  if (input.jobStatus !== "queued") {
    return "drop-stale";
  }
  if (input.liveInstanceCount >= input.maxRunners) {
    return "at-capacity";
  }
  return "launch";
};
