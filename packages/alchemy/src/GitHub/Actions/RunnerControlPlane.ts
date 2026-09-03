import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Function } from "../../AWS/Lambda/Function.ts";
import { every } from "../../AWS/Scheduler/builders.ts";
import { Webhook } from "../Webhook.ts";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import type { GitHubAppCredentials } from "./GitHubApp.ts";
import {
  RECOVERY_SCHEDULE,
  RecoveryFunction,
  main as recoveryMain,
  recoveryImpl,
} from "./handlers/recovery.ts";
import {
  REAPER_SCHEDULE,
  ReaperFunction,
  main as reaperMain,
  reaperImpl,
} from "./handlers/reaper.ts";
import {
  WebhookFunction,
  main as webhookMain,
  webhookImpl,
} from "./handlers/webhook.ts";
import { Env, SSM_ROUTES_PREFIX } from "./shared.ts";

export type { GitHubAppCredentials };

export interface RunnerControlPlaneRepository {
  /**
   * Repository owner (user or organization).
   */
  readonly owner: string;
  /**
   * Repository name.
   */
  readonly repository: string;
}

export interface RunnerControlPlaneReaperOptions {
  /**
   * Minutes an instance may boot before the reaper treats it as stuck.
   * @default 10
   */
  readonly startupDeadlineMinutes?: number;
  /**
   * Maximum age of a runner instance before the reaper terminates it
   * regardless of state (safety net for leaked capacity).
   * @default 180
   */
  readonly maxRunnerAgeMinutes?: number;
}

export interface RunnerControlPlaneProps {
  /**
   * GitHub organization the runners serve (org-level runners).
   */
  readonly organization: string;
  /**
   * GitHub App credentials. The private key is only materialized into the
   * control-plane Lambdas' encrypted environment — never into state, logs,
   * or runner instances.
   */
  readonly githubApp: GitHubAppCredentials;
  /**
   * HMAC secret for the `workflow_job` webhook deliveries. Required: the
   * receiver rejects unsigned deliveries.
   */
  readonly webhookSecret: Redacted.Redacted<string>;
  /**
   * Repositories Alchemy should wire with a `workflow_job` webhook
   * pointing at the receiver. Entries may use `"owner/repo"` shorthand.
   * Requires `GitHub.providers()` in the stack. Webhooks for other repos
   * (or org-level webhooks) can target `controlPlane.webhookUrl`
   * manually with the same secret.
   */
  readonly repositories?: ReadonlyArray<string | RunnerControlPlaneRepository>;
  /**
   * SSM prefix for the pool route registry. Pools, webhook, and reaper
   * must share it — only override it to run fully isolated fleets in one
   * account.
   * @default "/alchemy/github-runners/routes"
   */
  readonly ssmRoutesPrefix?: string;
  /**
   * Reaper tuning.
   */
  readonly reaper?: RunnerControlPlaneReaperOptions;
}

export interface RunnerControlPlaneResources {
  readonly organization: string;
  readonly githubApp: GitHubAppCredentials;
  readonly ssmRoutesPrefix: string;
  readonly webhookUrl: Output.Output<string | undefined>;
  readonly webhookFunction: Function;
  readonly reaperFunction: Function;
  readonly recoveryFunction: Function;
  readonly webhooks: readonly Webhook[];
}

export type RunnerControlPlane = Effect.Success<
  ReturnType<typeof RunnerControlPlane>
>;

/**
 * Serverless control plane for self-hosted GitHub Actions runners: one
 * per GitHub App / organization.
 *
 * Owns the webhook receiver (Lambda + Function URL), the shared reaper,
 * and the webhook recovery loop — plus optional repository webhooks.
 * It owns no EC2 configuration and makes no scheduling decisions:
 * GitHub stays the workflow engine, job queue, and job→runner scheduler,
 * while pools translate demand into fleet capacity.
 *
 * Pools register through the SSM route registry, so the control plane
 * never changes when pools come and go. Idle cost is effectively zero:
 * with no jobs there are no runner instances and the Lambdas only run
 * on delivery plus two short scheduler ticks.
 *
 * ### Control Plane
 * **Example:** App, webhooks, and shared repair loops
 * ```typescript
 * const runners = yield* GitHub.Actions.RunnerControlPlane("runners", {
 *   organization: "my-org",
 *   githubApp: {
 *     appId: "123456",
 *     privateKey: Redacted.make(process.env.GITHUB_APP_PRIVATE_KEY!),
 *     installationId: 78901234,
 *   },
 *   webhookSecret: Redacted.make(process.env.GITHUB_WEBHOOK_SECRET!),
 *   repositories: ["my-org/api", "my-org/web"],
 * });
 * ```
 *
 * @resource
 */
export const RunnerControlPlane = (
  id: string,
  props: RunnerControlPlaneProps,
) =>
  Namespace.push(
    id,
    Effect.gen(function* () {
      if (props.organization.trim().length === 0) {
        return yield* Effect.fail(
          new Error(
            "GitHub.Actions.RunnerControlPlane requires a non-empty organization",
          ),
        );
      }

      const ssmRoutesPrefix = props.ssmRoutesPrefix ?? SSM_ROUTES_PREFIX;
      const repositories = (props.repositories ?? []).map(normalizeRepository);

      const webhookFunction = yield* WebhookFunction.pipe(
        Effect.provide(
          WebhookFunction.make(
            {
              main: webhookMain,
              functionUrl: true,
              memorySize: 256,
              timeout: Duration.seconds(30),
              env: {
                [Env.webhookSecret]: props.webhookSecret,
                [Env.ssmRoutesPrefix]: ssmRoutesPrefix,
              },
            },
            webhookImpl,
          ),
        ),
      );

      const reaperFunction = yield* ReaperFunction.pipe(
        Effect.provide(
          ReaperFunction.make(
            {
              main: reaperMain,
              memorySize: 512,
              timeout: Duration.minutes(5),
              env: {
                [Env.organization]: props.organization,
                [Env.appId]: props.githubApp.appId,
                [Env.appPrivateKey]: props.githubApp.privateKey,
                [Env.installationId]: String(props.githubApp.installationId),
                [Env.ssmRoutesPrefix]: ssmRoutesPrefix,
                [Env.startupDeadlineMinutes]: String(
                  props.reaper?.startupDeadlineMinutes ?? 10,
                ),
                [Env.maxRunnerAgeMinutes]: String(
                  props.reaper?.maxRunnerAgeMinutes ?? 180,
                ),
              },
            },
            reaperImpl,
          ),
        ),
      );
      yield* every(REAPER_SCHEDULE).toLambda(reaperFunction);

      const webhooks: Webhook[] = [];
      for (const repository of repositories) {
        const webhook = yield* Webhook(
          `${sanitizeId(repository.repository)}Webhook`,
          {
            owner: repository.owner,
            repository: repository.repository,
            // functionUrl is always set (functionUrl: true above) — but
            // its attribute type keeps `undefined`, so narrow explicitly
            // instead of a postfix `!` (which cannot narrow an Output's
            // type argument).
            url: webhookFunction.functionUrl.pipe(
              Output.map((url) => {
                if (!url) {
                  throw new Error(
                    "GitHub.Actions.RunnerControlPlane webhook function URL is missing",
                  );
                }
                return url;
              }),
            ),
            events: ["workflow_job"],
            secret: props.webhookSecret,
          },
        );
        webhooks.push(webhook);
      }

      const hookIds: number[] = [];
      for (const webhook of webhooks) {
        // Yielding an Output resolves to an Accessor; yielding the
        // accessor resolves the value (same double-yield as the Lambda
        // SQS fixtures).
        const hookIdAccessor = yield* webhook.webhookId;
        const hookId = yield* hookIdAccessor;
        hookIds.push(hookId);
      }

      const recoveryFunction = yield* RecoveryFunction.pipe(
        Effect.provide(
          RecoveryFunction.make(
            {
              main: recoveryMain,
              memorySize: 256,
              timeout: Duration.minutes(5),
              env: {
                [Env.appId]: props.githubApp.appId,
                [Env.appPrivateKey]: props.githubApp.privateKey,
                [Env.installationId]: String(props.githubApp.installationId),
                [Env.recoveryWebhooks]: JSON.stringify(
                  hookIds.map((hookId, index) => ({
                    owner: repositories[index].owner,
                    repo: repositories[index].repository,
                    hookId,
                  })),
                ),
              },
            },
            recoveryImpl,
          ),
        ),
      );
      yield* every(RECOVERY_SCHEDULE).toLambda(recoveryFunction);

      const resources: RunnerControlPlaneResources = {
        organization: props.organization,
        githubApp: props.githubApp,
        ssmRoutesPrefix,
        webhookUrl: webhookFunction.functionUrl,
        webhookFunction,
        reaperFunction,
        recoveryFunction,
        webhooks,
      };
      return resources;
    }).pipe(Effect.orDie),
  );

const normalizeRepository = (
  entry: string | RunnerControlPlaneRepository,
): RunnerControlPlaneRepository => {
  if (typeof entry !== "string") {
    return entry;
  }
  const [owner, repository] = entry.split("/");
  if (!owner || !repository) {
    throw new Error(
      `GitHub.Actions.RunnerControlPlane repositories entries must be "owner/repo" (got "${entry}")`,
    );
  }
  return { owner, repository };
};

const sanitizeId = (name: string): string =>
  name.replace(/[^a-zA-Z0-9]+/g, "-");
