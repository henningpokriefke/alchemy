import * as ec2 from "@distilled.cloud/aws/ec2";
import * as sqs from "@distilled.cloud/aws/sqs";
import * as ssm from "@distilled.cloud/aws/ssm";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Lambda from "../../../AWS/Lambda/Function.ts";
import { Function } from "../../../AWS/Lambda/Function.ts";
import { isScheduleEvent } from "../../../AWS/Scheduler/ScheduleEventSource.ts";
import { optionalEnv, requiredEnv } from "../env.ts";
import { decodeRouteValue } from "../routing.ts";
import {
  deleteOrgRunner,
  installationOctokit,
  listOrgRunners,
  type GitHubAppCredentials,
  type OrgRunner,
} from "../GitHubApp.ts";
import {
  Env,
  MANAGED_TAG_KEY,
  SSM_JIT_PREFIX,
  SSM_ROUTES_PREFIX,
} from "../shared.ts";

/**
 * Static entry for the shared reaper Lambda. Deploy it through
 * `RunnerControlPlane` (which calls `ReaperFunction.make` with the
 * app's env) — never instantiate it directly.
 */
export const main = import.meta.url;

export class ReaperFunction extends Function<ReaperFunction>()("Reaper") {}

/**
 * How often the reaper runs. Shared as a constant so the control plane
 * and the handler agree on the schedule descriptor.
 */
export const REAPER_SCHEDULE = "5 minutes";

const tagValue = (
  tags: ReadonlyArray<{ Key?: string; Value?: string }> | undefined,
  key: string,
): string | undefined => tags?.find((tag) => tag.Key === key)?.Value;

const listManagedInstances = () =>
  ec2
    .describeInstances({
      Filters: [
        { Name: `tag:${MANAGED_TAG_KEY}`, Values: ["true"] },
        {
          Name: "instance-state-name",
          Values: ["pending", "running", "stopping", "stopped"],
        },
      ],
    })
    .pipe(
      Effect.map((result) =>
        (result.Reservations ?? []).flatMap((reservation) =>
          (reservation.Instances ?? []).flatMap((instance) =>
            instance.InstanceId
              ? [
                  {
                    instanceId: instance.InstanceId,
                    state: instance.State?.Name ?? "unknown",
                    launchTime: instance.LaunchTime,
                    name: tagValue(instance.Tags, "Name"),
                  },
                ]
              : [],
          ),
        ),
      ),
      Effect.mapError(
        (cause) => new Error(`Failed to list managed instances: ${cause}`),
      ),
    );

const terminateInstances = (instanceIds: readonly string[]) =>
  instanceIds.length === 0
    ? Effect.void
    : ec2.terminateInstances({ InstanceIds: [...instanceIds] }).pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause) => new Error(`Failed to terminate instances: ${cause}`),
        ),
      );

const deleteSsmParameter = (name: string) =>
  ssm.deleteParameter({ Name: name }).pipe(
    Effect.asVoid,
    Effect.orElseSucceed(() => undefined),
  );

interface NamedParameter {
  readonly name: string;
  readonly value: string | undefined;
  readonly lastModified: Date | undefined;
}

const listParameters = (prefix: string, owner: string) =>
  Effect.gen(function* () {
    const parameters: NamedParameter[] = [];
    let nextToken: string | undefined;
    do {
      const page = yield* ssm
        .getParametersByPath({
          Path: prefix,
          Recursive: false,
          WithDecryption: false,
          NextToken: nextToken,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new Error(`Failed to list ${owner} parameters: ${cause}`),
          ),
        );
      for (const parameter of page.Parameters ?? []) {
        if (parameter.Name) {
          parameters.push({
            name: parameter.Name,
            value:
              typeof parameter.Value === "string" ? parameter.Value : undefined,
            lastModified: parameter.LastModifiedDate,
          });
        }
      }
      nextToken = page.NextToken;
    } while (nextToken);
    return parameters;
  });

const queueExists = (queueUrl: string) => {
  const queueName = queueUrl.split("/").pop();
  if (!queueName) {
    return Effect.succeed(true);
  }
  return sqs.getQueueUrl({ QueueName: queueName }).pipe(
    Effect.as(true),
    Effect.catchTag("QueueDoesNotExist", () => Effect.succeed(false)),
    Effect.orElseSucceed(() => true),
  );
};

/**
 * Reaper implementation: garbage collection and repair only — never
 * scheduling. Terminates instances that missed their startup deadline
 * or exceeded the maximum age, removes orphaned GitHub runner
 * registrations, and collects stale JIT parameters and pool routes. All
 * discovery is tag- and registry-based, so one shared reaper serves
 * every pool.
 */
export const reaperImpl = Effect.gen(function* () {
  const host = yield* Lambda.Function;

  if (!globalThis.__ALCHEMY_RUNTIME__) {
    yield* host.bind`Allow(${host}, GitHub.Actions.ReaperCleanup)`({
      policyStatements: [
        {
          Effect: "Allow",
          Action: ["ec2:DescribeInstances"],
          Resource: ["*"],
        },
        {
          // The tag condition is the safety boundary: the reaper can only
          // terminate instances Alchemy launched for runners.
          Effect: "Allow",
          Action: ["ec2:TerminateInstances"],
          Resource: ["*"],
          Condition: {
            StringEquals: {
              [`aws:ResourceTag/${MANAGED_TAG_KEY}`]: "true",
            },
          },
        },
        {
          Effect: "Allow",
          Action: ["ssm:GetParametersByPath", "ssm:DeleteParameter"],
          Resource: ["arn:aws:ssm:*:*:parameter/alchemy/github-runners/*"],
        },
        {
          Effect: "Allow",
          Action: ["sqs:GetQueueUrl"],
          Resource: ["*"],
        },
      ],
    });
  }

  yield* host.listen(
    Effect.sync(() => (event: unknown) => {
      if (!isScheduleEvent(event)) {
        return undefined;
      }
      return runReap().pipe(
        Effect.tapError((cause) =>
          Effect.logError(`Reaper run failed: ${cause}`),
        ),
        Effect.orDie,
      );
    }),
  );
});

const runReap = () =>
  Effect.gen(function* () {
    const organization = yield* requiredEnv("reaper", Env.organization);
    const credentials: GitHubAppCredentials = {
      appId: yield* requiredEnv("reaper", Env.appId),
      privateKey: Redacted.make(
        yield* requiredEnv("reaper", Env.appPrivateKey),
      ),
      installationId: Number(yield* requiredEnv("reaper", Env.installationId)),
    };
    const routesPrefix =
      (yield* optionalEnv(Env.ssmRoutesPrefix)) ?? SSM_ROUTES_PREFIX;
    const jitPrefix = (yield* optionalEnv(Env.ssmJitPrefix)) ?? SSM_JIT_PREFIX;
    const startupDeadlineMinutes = Number(
      (yield* optionalEnv(Env.startupDeadlineMinutes)) ?? "10",
    );
    const maxRunnerAgeMinutes = Number(
      (yield* optionalEnv(Env.maxRunnerAgeMinutes)) ?? "180",
    );

    const labels = yield* collectRouteLabels(routesPrefix);
    const labelSet = new Set(labels);
    const instances = yield* listManagedInstances();
    const liveNames = new Set(
      instances.flatMap((instance) => (instance.name ? [instance.name] : [])),
    );
    const octokit = yield* installationOctokit(credentials);
    const runners = yield* listOrgRunners(octokit, organization);
    const now = Date.now();

    const toTerminate: string[] = [];
    for (const instance of instances) {
      const ageMinutes =
        instance.launchTime === undefined
          ? Number.POSITIVE_INFINITY
          : (now - instance.launchTime.getTime()) / 60_000;
      const runner = runners.find(
        (candidate) => candidate.name === instance.name,
      );
      if (
        instance.state === "stopped" ||
        instance.state === "stopping" ||
        ageMinutes > maxRunnerAgeMinutes ||
        (ageMinutes > startupDeadlineMinutes &&
          (runner === undefined || runner.status !== "online"))
      ) {
        yield* Effect.log(
          `Reaping instance ${instance.instanceId} (${instance.name ?? "unnamed"}, state ${instance.state}, age ${Math.round(ageMinutes)}m)`,
        );
        toTerminate.push(instance.instanceId);
        if (runner !== undefined) {
          yield* deleteOrgRunner(octokit, {
            org: organization,
            runnerId: runner.id,
          });
        }
      }
    }
    yield* terminateInstances(toTerminate);

    for (const runner of runners) {
      if (!isManagedRunner(runner, labelSet)) {
        continue;
      }
      if (runner.busy || runner.status === "online") {
        continue;
      }
      if (liveNames.has(runner.name)) {
        continue;
      }
      yield* Effect.log(`Removing orphaned runner registration ${runner.name}`);
      yield* deleteOrgRunner(octokit, {
        org: organization,
        runnerId: runner.id,
      });
    }

    const jitParameters = yield* listParameters(jitPrefix, "JIT");
    for (const parameter of jitParameters) {
      const runnerName = parameter.name.slice(jitPrefix.length + 1);
      const ageMinutes =
        parameter.lastModified === undefined
          ? Number.POSITIVE_INFINITY
          : (now - parameter.lastModified.getTime()) / 60_000;
      if (!liveNames.has(runnerName) && ageMinutes > startupDeadlineMinutes) {
        yield* deleteSsmParameter(parameter.name);
      }
    }
  });

const collectRouteLabels = (prefix: string) =>
  Effect.gen(function* () {
    const labels: string[] = [];
    const parameters = yield* listParameters(prefix, "pool route");
    for (const parameter of parameters) {
      if (!parameter.value) {
        continue;
      }
      const decoded = yield* Effect.result(
        decodeRouteValue(parameter.name, parameter.value),
      );
      if (Result.isFailure(decoded)) {
        yield* Effect.logWarning(
          `Removing corrupt pool route ${parameter.name}: ${decoded.failure.reason}`,
        );
        yield* deleteSsmParameter(parameter.name);
        continue;
      }
      if (!(yield* queueExists(decoded.success.queueUrl))) {
        yield* Effect.log(
          `Removing stale pool route ${parameter.name} (queue gone)`,
        );
        yield* deleteSsmParameter(parameter.name);
        continue;
      }
      labels.push(parameter.name.slice(prefix.length + 1));
    }
    return labels;
  });

const isManagedRunner = (
  runner: OrgRunner,
  labels: ReadonlySet<string>,
): boolean => runner.labels.some((label) => labels.has(label.name));

export default reaperImpl;
