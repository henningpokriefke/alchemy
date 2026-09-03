import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Function } from "../../AWS/Lambda/Function.ts";
import { Queue } from "../../AWS/SQS/Queue.ts";
import { Parameter } from "../../AWS/SSM/Parameter.ts";
import type { RunnerComputeSpec } from "../../AWS/EC2/RunnerCompute.ts";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import {
  ScalerDeployConfig,
  ScalerFunction,
  main as scalerMain,
  scalerImpl,
} from "./handlers/scaler.ts";
import { Env, routeParameterName } from "./shared.ts";
import type { RunnerControlPlane } from "./RunnerControlPlane.ts";

export interface RunnerPoolProps {
  /**
   * The control plane this pool belongs to. Supplies the organization,
   * the GitHub App credentials, and the shared SSM route prefix.
   */
  readonly controlPlane: RunnerControlPlane;
  /**
   * Unique pool label and GitHub `runs-on` target (e.g.
   * `alchemy-ci-4x`). Must match `^[a-zA-Z0-9_-]+$` — it becomes part of
   * the SSM route path, the runner names, and the instance tags.
   */
  readonly label: string;
  /**
   * Compute backing this pool (see `AWS.EC2.RunnerCompute`). Spot vs.
   * on-demand is purely a compute property — a release pool is an
   * ordinary `RunnerPool` with an on-demand compute.
   */
  readonly compute: RunnerComputeSpec;
  /**
   * Maximum concurrent runner instances for this pool. Demand beyond the
   * limit stays queued in SQS and is retried after the visibility
   * timeout — GitHub jobs wait instead of over-provisioning.
   */
  readonly maxRunners: number;
}

export interface RunnerPoolResources {
  readonly label: string;
  readonly demand: Queue;
  readonly route: Parameter;
  readonly scaler: Function;
  readonly compute: RunnerComputeSpec;
  readonly maxRunners: number;
  readonly controlPlane: RunnerControlPlane;
}

export type RunnerPool = Effect.Success<ReturnType<typeof RunnerPool>>;

const LABEL_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * A homogeneous runner pool: the central scaling and routing unit.
 *
 * A pool owns one SQS demand queue (+ DLQ), one SSM route entry mapping
 * its label to that queue, and one scale Lambda. The GitHub webhook fans
 * capacity signals out to every pool whose label matches the job; the
 * scaler validates the job with GitHub and launches exactly one EC2
 * Fleet per queued job.
 *
 * Pools are independent: adding or removing a pool never redeploys the
 * control plane or sibling pools — the webhook and reaper discover pools
 * through the SSM route registry.
 *
 * ### CI Pool on Spot
 * **Example:** PR CI with price-optimized Spot capacity
 * ```typescript
 * const ci4x = yield* GitHub.Actions.RunnerPool("ci-4x", {
 *   controlPlane: runners,
 *   label: "alchemy-ci-4x",
 *   compute: yield* AWS.EC2.RunnerCompute("ci-4x-compute", {
 *     market: "spot",
 *     instanceTypes: ["m8i.xlarge", "m7i.xlarge", "m7i-flex.xlarge", "m7a.xlarge"],
 *     allocationStrategy: "price-capacity-optimized",
 *     image: runnerAmi,
 *     network: { subnetIds: network.publicSubnetIds },
 *   }),
 *   maxRunners: 50,
 * });
 * ```
 *
 * ### Release Pool on On-Demand
 * **Example:** Same abstraction, stable capacity
 * ```typescript
 * const release = yield* GitHub.Actions.RunnerPool("release", {
 *   controlPlane: runners,
 *   label: "alchemy-release-4x",
 *   compute: yield* AWS.EC2.RunnerCompute("release-compute", {
 *     market: "on-demand",
 *     instanceTypes: ["m8i.xlarge", "m7i.xlarge"],
 *     image: runnerAmi,
 *     network: { subnetIds: network.publicSubnetIds },
 *   }),
 *   maxRunners: 5,
 * });
 * ```
 *
 * @resource
 */
export const RunnerPool = (id: string, props: RunnerPoolProps) =>
  Namespace.push(
    id,
    Effect.gen(function* () {
      if (!LABEL_PATTERN.test(props.label)) {
        return yield* Effect.fail(
          new Error(
            `GitHub.Actions.RunnerPool label "${props.label}" must match ${LABEL_PATTERN} (SSM path, runner name, and instance tag safe)`,
          ),
        );
      }
      if (!Number.isInteger(props.maxRunners) || props.maxRunners < 1) {
        return yield* Effect.fail(
          new Error(
            "GitHub.Actions.RunnerPool maxRunners must be a positive integer",
          ),
        );
      }
      if (props.compute.kind !== "aws-ec2") {
        return yield* Effect.fail(
          new Error(
            `GitHub.Actions.RunnerPool supports only aws-ec2 compute in V1 (got ${(props.compute as { kind: string }).kind})`,
          ),
        );
      }

      const deadLetter = yield* Queue("DemandDlq", {
        messageRetentionPeriod: "14 days",
      });
      const demand = yield* Queue("Demand", {
        visibilityTimeout: "3 minutes",
        redrivePolicy: {
          deadLetterTargetArn: deadLetter.queueArn,
          maxReceiveCount: 5,
        },
      });

      const route = yield* Parameter("Route", {
        name: routeParameterName(
          props.controlPlane.ssmRoutesPrefix,
          props.label,
        ),
        description: `Capacity-demand route for GitHub Actions pool ${props.label}`,
        value: Output.all(demand.queueUrl, demand.queueArn).pipe(
          Output.map(([queueUrl, queueArn]) =>
            JSON.stringify({ queueUrl, queueArn }),
          ),
        ),
      });

      const scaler = yield* ScalerFunction.pipe(
        Effect.provide(
          ScalerFunction.make(
            {
              main: scalerMain,
              timeout: Duration.minutes(2),
              memorySize: 512,
              env: {
                [Env.organization]: props.controlPlane.organization,
                [Env.appId]: props.controlPlane.githubApp.appId,
                [Env.appPrivateKey]: props.controlPlane.githubApp.privateKey,
                [Env.installationId]: String(
                  props.controlPlane.githubApp.installationId,
                ),
                [Env.ssmRoutesPrefix]: props.controlPlane.ssmRoutesPrefix,
                [Env.poolLabel]: props.label,
                [Env.maxRunners]: String(props.maxRunners),
                [Env.launchTemplateName]: props.compute.launchTemplateName,
                [Env.subnetIds]: JSON.stringify(props.compute.subnetIds),
                [Env.instanceTypes]: JSON.stringify(
                  props.compute.instanceTypes,
                ),
                [Env.market]: props.compute.market,
              },
            },
            scalerImpl.pipe(
              Effect.provide(Layer.succeed(ScalerDeployConfig, { demand })),
            ),
          ),
        ),
      );

      const resources: RunnerPoolResources = {
        label: props.label,
        demand,
        route,
        scaler,
        compute: props.compute,
        maxRunners: props.maxRunners,
        controlPlane: props.controlPlane,
      };
      return resources;
    }).pipe(Effect.orDie),
  );
