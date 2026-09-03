import * as ec2 from "@distilled.cloud/aws/ec2";
import * as ssm from "@distilled.cloud/aws/ssm";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { EventSourceMapping } from "../../../AWS/Lambda/EventSourceMapping.ts";
import * as Lambda from "../../../AWS/Lambda/Function.ts";
import { Function } from "../../../AWS/Lambda/Function.ts";
import { isSQSEvent } from "../../../AWS/Lambda/QueueEventSource.ts";
import type { Queue } from "../../../AWS/SQS/Queue.ts";
import * as Namespace from "../../../Namespace.ts";
import { readConventions, readJsonEnv, requiredEnv } from "../env.ts";
import {
  buildFleetRequest,
  decideScale,
  orderCandidates,
  runnerTags,
  type RunnerMarket,
} from "../fleet.ts";
import {
  generateJitConfig,
  getJobStatus,
  installationOctokit,
  type GitHubAppCredentials,
} from "../GitHubApp.ts";
import {
  Env,
  ssmParametersArn,
  type DemandMessage,
  type RunnerConventions,
  jitParameterName,
  runnerNameFor,
} from "../shared.ts";

/**
 * Static entry for the pool scaler Lambda. Deploy it through
 * `RunnerPool` (which calls `ScalerFunction.make` with the pool's env
 * and provides `ScalerDeployConfig`) — never instantiate it directly.
 */
export const main = import.meta.url;

export class ScalerFunction extends Function<ScalerFunction>()("Scaler") {}

/**
 * Deploy-only wiring: the demand queue object plus the resolved
 * conventions (for the JIT parameter IAM scope). Provided by
 * `RunnerPool` at deploy time; never touched at runtime (the
 * `__ALCHEMY_RUNTIME__` guard below), so Lambda execution never needs
 * it in context.
 */
export interface ScalerDeployConfig {
  readonly demand: Queue;
  readonly conventions: RunnerConventions;
}

export const ScalerDeployConfig = Context.Service<
  ScalerDeployConfig,
  { readonly demand: Queue; readonly conventions: RunnerConventions }
>()("GitHub.Actions.ScalerDeployConfig");

const parseDemand = (body: string): Effect.Effect<DemandMessage, Error> => {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (
      typeof parsed.owner !== "string" ||
      typeof parsed.repo !== "string" ||
      typeof parsed.jobId !== "number" ||
      typeof parsed.poolLabel !== "string" ||
      typeof parsed.deliveryId !== "string"
    ) {
      return Effect.fail(
        new Error(
          "demand must be { owner, repo, jobId, poolLabel, deliveryId }",
        ),
      );
    }
    return Effect.succeed({
      owner: parsed.owner,
      repo: parsed.repo,
      jobId: parsed.jobId,
      poolLabel: parsed.poolLabel,
      deliveryId: parsed.deliveryId,
    });
  } catch (cause) {
    return Effect.fail(new Error(`Invalid demand message: ${cause}`));
  }
};

const scalerCredentials = (): Effect.Effect<GitHubAppCredentials, Error> =>
  Effect.gen(function* () {
    const appId = yield* requiredEnv("scaler", Env.appId);
    const privateKey = yield* requiredEnv("scaler", Env.appPrivateKey);
    const installationIdRaw = yield* requiredEnv("scaler", Env.installationId);
    const installationId = Number(installationIdRaw);
    if (!Number.isInteger(installationId)) {
      return yield* Effect.fail(
        new Error(`Invalid ${Env.installationId}: ${installationIdRaw}`),
      );
    }
    return {
      appId,
      privateKey: Redacted.make(privateKey),
      installationId,
    };
  });

const liveInstanceCount = (poolLabel: string, poolTagKey: string) =>
  ec2
    .describeInstances({
      Filters: [
        { Name: `tag:${poolTagKey}`, Values: [poolLabel] },
        {
          Name: "instance-state-name",
          Values: ["pending", "running"],
        },
      ],
    })
    .pipe(
      Effect.map((result) =>
        (result.Reservations ?? []).reduce(
          (total, reservation) => total + (reservation.Instances ?? []).length,
          0,
        ),
      ),
      Effect.mapError(
        (cause) => new Error(`Failed to count live runners: ${cause}`),
      ),
    );

const handleDemand = (record: {
  readonly body: string;
  readonly messageId: string;
  readonly receiveCount: number;
}) =>
  Effect.gen(function* () {
    const demand = yield* parseDemand(record.body);
    const organization = yield* requiredEnv("scaler", Env.organization);
    const poolLabel = yield* requiredEnv("scaler", Env.poolLabel);
    if (demand.poolLabel !== poolLabel) {
      yield* Effect.logWarning(
        `Ignoring demand for pool ${demand.poolLabel} (this scaler serves ${poolLabel})`,
      );
      return;
    }
    const maxRunners = Number(yield* requiredEnv("scaler", Env.maxRunners));
    const launchTemplateName = yield* requiredEnv(
      "scaler",
      Env.launchTemplateName,
    );
    const subnetIds =
      (yield* readJsonEnv<readonly string[]>(Env.subnetIds)) ?? [];
    const instanceTypes =
      (yield* readJsonEnv<readonly string[]>(Env.instanceTypes)) ?? [];
    const market = (yield* requiredEnv("scaler", Env.market)) as RunnerMarket;
    const conventions = yield* readConventions();

    const octokit = yield* installationOctokit(yield* scalerCredentials());
    const { status } = yield* getJobStatus(octokit, {
      owner: demand.owner,
      repo: demand.repo,
      jobId: demand.jobId,
    });
    const live = yield* liveInstanceCount(poolLabel, conventions.poolTagKey);
    const decision = decideScale({
      jobStatus: status,
      liveInstanceCount: live,
      maxRunners,
    });
    if (decision === "drop-stale") {
      yield* Effect.log(
        `Dropping stale demand for job ${demand.owner}/${demand.repo}#${demand.jobId} (status ${status})`,
      );
      return;
    }
    if (decision === "at-capacity") {
      return yield* Effect.fail(
        new Error(
          `Pool ${poolLabel} at capacity (${live}/${maxRunners}) — returning demand to the queue`,
        ),
      );
    }

    const runnerName = runnerNameFor(
      poolLabel,
      demand.jobId,
      conventions.runnerNamePrefix,
    );
    const jobKey = `${demand.owner}/${demand.repo}/${demand.jobId}`;
    const { encodedJitConfig } = yield* generateJitConfig(octokit, {
      org: organization,
      name: runnerName,
      labels: [poolLabel],
    });
    const jitName = jitParameterName(conventions.ssmJitPrefix, runnerName);
    yield* ssm
      .putParameter({
        Name: jitName,
        Value: encodedJitConfig,
        Type: "String",
        Overwrite: true,
        Tags: [
          { Key: conventions.poolTagKey, Value: poolLabel },
          { Key: conventions.jobTagKey, Value: jobKey },
        ],
      })
      .pipe(
        Effect.mapError(
          (cause) => new Error(`Failed to store JIT config: ${cause}`),
        ),
      );

    const candidates = orderCandidates(
      instanceTypes,
      subnetIds,
      record.receiveCount,
    );
    const fleet = buildFleetRequest({
      clientToken: record.messageId,
      launchTemplateName,
      candidates,
      market,
      tags: runnerTags(conventions, { poolLabel, runnerName, jobKey }),
    });
    const result = yield* ec2
      .createFleet(fleet)
      .pipe(
        Effect.mapError(
          (cause) => new Error(`EC2 Fleet launch failed: ${cause}`),
        ),
      );
    const errors = result.Errors ?? [];
    if (errors.length > 0 || !result.FleetId) {
      const detail = errors
        .map((error) => error.ErrorMessage ?? error.ErrorCode ?? "unknown")
        .join("; ");
      return yield* Effect.fail(
        new Error(
          `EC2 Fleet launch returned errors: ${detail || "no fleet id"}`,
        ),
      );
    }
    yield* Effect.log(
      `Launched runner ${runnerName} for job ${jobKey} (fleet ${result.FleetId})`,
    );
  });

/**
 * Pool scaler implementation: the deploy half creates the SQS
 * event-source mapping plus the fleet/SSM/SQS IAM statements; the runtime
 * half serves demand messages. All pool/compute/GitHub configuration
 * arrives via Lambda env (set by `RunnerPool` from resolved Outputs);
 * the only deploy-time objects are the demand queue and the resolved
 * conventions, injected through `ScalerDeployConfig` behind the runtime
 * guard.
 */
export const scalerImpl = Effect.gen(function* () {
  const host = yield* Lambda.Function;
  let demand: Queue | undefined;
  let conventions: RunnerConventions | undefined;
  if (globalThis.__ALCHEMY_RUNTIME__) {
    demand = undefined;
    conventions = undefined;
  } else {
    const config = yield* ScalerDeployConfig;
    demand = config.demand;
    conventions = config.conventions;
  }

  if (
    !globalThis.__ALCHEMY_RUNTIME__ &&
    demand !== undefined &&
    conventions !== undefined
  ) {
    const queue = demand;
    const jitArn = ssmParametersArn(conventions.ssmJitPrefix);
    yield* host.bind`Allow(${host}, GitHub.Actions.ScalerFleet)`({
      policyStatements: [
        {
          Effect: "Allow",
          Action: [
            "ec2:CreateFleet",
            "ec2:RunInstances",
            "ec2:DescribeInstances",
            "ec2:DescribeLaunchTemplates",
            "ec2:DescribeImages",
            "ec2:CreateTags",
          ],
          Resource: ["*"],
        },
        {
          Effect: "Allow",
          Action: ["iam:PassRole"],
          Resource: ["arn:aws:iam::*:role/*"],
          Condition: {
            StringEquals: { "iam:PassedToService": "ec2.amazonaws.com" },
          },
        },
        {
          Effect: "Allow",
          Action: ["ssm:PutParameter"],
          Resource: [jitArn],
        },
        {
          Effect: "Allow",
          Action: [
            "sqs:ReceiveMessage",
            "sqs:DeleteMessage",
            "sqs:GetQueueAttributes",
          ],
          Resource: [queue.queueArn],
        },
      ],
    });

    yield* Namespace.push(
      host.LogicalId,
      Effect.gen(function* () {
        const Mapping = yield* EventSourceMapping;
        yield* Mapping("DemandEventSource", {
          functionName: host.functionName,
          eventSourceArn: queue.queueArn,
          batchSize: 1,
        });
      }),
    );
  }

  yield* host.listen(
    Effect.sync(() => (event: unknown) => {
      if (!isSQSEvent(event)) {
        return undefined;
      }
      return Stream.fromArray(event.Records).pipe(
        Stream.runForEach((record) =>
          handleDemand({
            body: record.body,
            messageId: record.messageId,
            receiveCount:
              Number(record.attributes?.ApproximateReceiveCount ?? "1") - 1,
          }).pipe(
            Effect.tapError((cause) =>
              Effect.logError(
                `Scaler failed for demand ${record.messageId}: ${cause}`,
              ),
            ),
            Effect.orDie,
          ),
        ),
      );
    }),
  );
});

export default scalerImpl;
