import { Octokit } from "@octokit/rest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Lambda from "../../../AWS/Lambda/Function.ts";
import { Function } from "../../../AWS/Lambda/Function.ts";
import { isScheduleEvent } from "../../../AWS/Scheduler/ScheduleEventSource.ts";
import { requiredEnv } from "../env.ts";
import {
  installationOctokit,
  type GitHubAppCredentials,
} from "../GitHubApp.ts";
import { Env } from "../shared.ts";

/**
 * Static entry for the webhook recovery Lambda. Deploy it through
 * `RunnerControlPlane` (which calls `RecoveryFunction.make` with the
 * app's env) — never instantiate it directly.
 */
export const main = import.meta.url;

export class RecoveryFunction extends Function<RecoveryFunction>()(
  "Recovery",
) {}

/**
 * How often recovery scans webhook deliveries. Shared as a constant so
 * the control plane and the handler agree on the schedule descriptor.
 */
export const RECOVERY_SCHEDULE = "10 minutes";

/**
 * A repository webhook managed by the control plane, as recorded in the
 * recovery env by `RunnerControlPlane`.
 */
export interface RecoveryWebhook {
  readonly owner: string;
  readonly repo: string;
  readonly hookId: number;
}

const parseWebhooks = (
  raw: string,
): Effect.Effect<readonly RecoveryWebhook[], Error> => {
  try {
    const parsed = JSON.parse(raw) as ReadonlyArray<Record<string, unknown>>;
    if (!Array.isArray(parsed)) {
      return Effect.fail(
        new Error(`Invalid ${Env.recoveryWebhooks}: expected a JSON array`),
      );
    }
    return Effect.succeed(
      parsed.map((entry) => {
        if (
          typeof entry.owner !== "string" ||
          typeof entry.repo !== "string" ||
          typeof entry.hookId !== "number"
        ) {
          throw new Error("webhook entries must be { owner, repo, hookId }");
        }
        return { owner: entry.owner, repo: entry.repo, hookId: entry.hookId };
      }),
    );
  } catch (cause) {
    return Effect.fail(new Error(`Invalid ${Env.recoveryWebhooks}: ${cause}`));
  }
};

const redeliverFailed = (
  octokit: Octokit,
  webhook: RecoveryWebhook,
): Effect.Effect<{ checked: number; redelivered: number }, Error> =>
  Effect.gen(function* () {
    const { data: deliveries } = yield* Effect.tryPromise({
      try: () =>
        octokit.rest.repos.listWebhookDeliveries({
          owner: webhook.owner,
          repo: webhook.repo,
          hook_id: webhook.hookId,
          per_page: 100,
        }),
      catch: (cause) =>
        new Error(
          `Failed to list deliveries for ${webhook.owner}/${webhook.repo}: ${cause}`,
        ),
    });
    let redelivered = 0;
    for (const delivery of deliveries.slice(0, 20)) {
      const payload = delivery as {
        id: number;
        event?: string;
        status_code?: number;
        delivered_at?: string;
      };
      if (payload.event !== "workflow_job") {
        continue;
      }
      if (payload.status_code === undefined || payload.status_code < 400) {
        continue;
      }
      const deliveredAt = payload.delivered_at
        ? new Date(payload.delivered_at).getTime()
        : 0;
      if (Date.now() - deliveredAt > 3_600_000) {
        continue;
      }
      yield* Effect.tryPromise({
        try: () =>
          octokit.rest.repos.redeliverWebhookDelivery({
            owner: webhook.owner,
            repo: webhook.repo,
            hook_id: webhook.hookId,
            delivery_id: payload.id,
          }),
        catch: (cause) =>
          new Error(`Failed to redeliver ${payload.id}: ${cause}`),
      });
      redelivered += 1;
    }
    return { checked: deliveries.length, redelivered };
  });

/**
 * Webhook recovery implementation: periodically scans the managed
 * repository webhooks' recent deliveries and redelivers failed
 * `workflow_job` events. Together with the SQS-backed demand queues this
 * gives the scale-to-zero control plane durable delivery semantics
 * without a permanently running listener.
 */
export const recoveryImpl = Effect.gen(function* () {
  const host = yield* Lambda.Function;

  yield* host.listen(
    Effect.sync(() => (event: unknown) => {
      if (!isScheduleEvent(event)) {
        return undefined;
      }
      return runRecovery().pipe(
        Effect.tapError((cause) =>
          Effect.logError(`Recovery run failed: ${cause}`),
        ),
        Effect.orDie,
      );
    }),
  );
});

const runRecovery = () =>
  Effect.gen(function* () {
    const credentials: GitHubAppCredentials = {
      appId: yield* requiredEnv("recovery", Env.appId),
      privateKey: Redacted.make(
        yield* requiredEnv("recovery", Env.appPrivateKey),
      ),
      installationId: Number(
        yield* requiredEnv("recovery", Env.installationId),
      ),
    };
    const webhooks = yield* parseWebhooks(
      yield* requiredEnv("recovery", Env.recoveryWebhooks),
    );
    if (webhooks.length === 0) {
      yield* Effect.log("No managed webhooks configured — nothing to recover");
      return;
    }
    const octokit = yield* installationOctokit(credentials);
    for (const webhook of webhooks) {
      const { checked, redelivered } = yield* redeliverFailed(octokit, webhook);
      if (redelivered > 0) {
        yield* Effect.log(
          `Redelivered ${redelivered}/${checked} failed workflow_job deliveries for ${webhook.owner}/${webhook.repo}`,
        );
      }
    }
  });

export default recoveryImpl;
