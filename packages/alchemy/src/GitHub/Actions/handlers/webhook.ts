import * as sqs from "@distilled.cloud/aws/sqs";
import * as ssm from "@distilled.cloud/aws/ssm";
import * as Effect from "effect/Effect";
import * as Lambda from "../../../AWS/Lambda/Function.ts";
import { Function } from "../../../AWS/Lambda/Function.ts";
import { verifyWebhookSignature } from "../crypto.ts";
import { readConventions, readEnv } from "../env.ts";
import { routePoolLabels } from "../routing.ts";
import {
  Env,
  RunnerConventionsConfig,
  ssmParametersArn,
  type DemandMessage,
} from "../shared.ts";

/**
 * Static entry for the webhook receiver Lambda. Deploy it through
 * `RunnerControlPlane` (which calls `WebhookFunction.make` with the
 * app's env) — never instantiate it directly.
 */
export const main = import.meta.url;

export class WebhookFunction extends Function<WebhookFunction>()("Webhook") {}

interface FunctionUrlEvent {
  readonly version: string;
  readonly headers: Record<string, string | undefined>;
  readonly body?: string | undefined;
  readonly isBase64Encoded: boolean;
  readonly requestContext: { readonly http: { readonly method: string } };
}

const isFunctionUrlEvent = (event: unknown): event is FunctionUrlEvent =>
  typeof event === "object" &&
  event !== null &&
  (event as { version?: unknown }).version === "2.0" &&
  typeof (event as { requestContext?: { http?: unknown } }).requestContext
    ?.http === "object";

const proxyResponse = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const header = (
  headers: Record<string, string | undefined>,
  name: string,
): string | undefined => {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) {
      return value;
    }
  }
  return undefined;
};

interface WorkflowJobPayload {
  readonly action: string;
  readonly workflow_job?: {
    readonly id: number;
    readonly labels: readonly string[];
  };
  readonly repository?: {
    readonly name: string;
    readonly owner: { readonly login: string };
  };
}

const listRoutes = (prefix: string) =>
  Effect.gen(function* () {
    const routes = new Map<string, { queueUrl: string }>();
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
            (cause) => new Error(`Failed to list pool routes: ${cause}`),
          ),
        );
      for (const parameter of page.Parameters ?? []) {
        // Route values are plain queue URLs (see `RunnerPool`). Skip
        // corrupt entries without breaking fan-out to healthy pools.
        const value =
          typeof parameter.Value === "string" ? parameter.Value.trim() : "";
        if (!parameter.Name || !value) {
          if (parameter.Name) {
            yield* Effect.logWarning(
              `Skipping pool route ${parameter.Name}: empty queue URL`,
            );
          }
          continue;
        }
        const label = parameter.Name.slice(prefix.length + 1);
        routes.set(label, { queueUrl: value });
      }
      nextToken = page.NextToken;
    } while (nextToken);
    return routes;
  });

const handleDelivery = (
  rawBody: string,
  signature: string | undefined,
  deliveryId: string | undefined,
) =>
  Effect.gen(function* () {
    const secret = yield* readEnv(Env.webhookSecret);
    if (!secret) {
      return yield* Effect.fail(
        new Error(`Missing required webhook env ${Env.webhookSecret}`),
      );
    }
    const valid = yield* verifyWebhookSignature({
      secret,
      rawBody,
      signatureHeader: signature,
    });
    if (!valid) {
      return { statusCode: 401, body: { error: "invalid signature" } };
    }

    let payload: WorkflowJobPayload;
    try {
      payload = JSON.parse(rawBody) as WorkflowJobPayload;
    } catch {
      return { statusCode: 400, body: { error: "invalid JSON payload" } };
    }
    if (
      payload.action !== "queued" ||
      !payload.workflow_job ||
      !payload.repository
    ) {
      return { statusCode: 202, body: { ignored: true } };
    }

    const conventions = yield* readConventions();
    const routes = yield* listRoutes(conventions.ssmRoutesPrefix);
    const matched = routePoolLabels(payload.workflow_job.labels, [
      ...routes.keys(),
    ]);
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    for (const poolLabel of matched) {
      const target = routes.get(poolLabel);
      if (!target) {
        continue;
      }
      const demand: DemandMessage = {
        owner,
        repo,
        jobId: payload.workflow_job.id,
        poolLabel,
        deliveryId: deliveryId ?? "unknown",
      };
      yield* sqs
        .sendMessage({
          QueueUrl: target.queueUrl,
          MessageBody: JSON.stringify(demand),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new Error(`Failed to signal pool ${poolLabel}: ${cause}`),
          ),
        );
    }
    return { statusCode: 200, body: { pools: matched } };
  });

/**
 * Webhook receiver implementation: verifies the GitHub HMAC signature,
 * matches `workflow_job.queued` labels against the SSM route registry,
 * and persists one capacity-demand message per matched pool. Nothing
 * expensive happens here — job validation and EC2 launches belong to
 * the pool scaler.
 */
export const webhookImpl = Effect.gen(function* () {
  const host = yield* Lambda.Function;

  if (!globalThis.__ALCHEMY_RUNTIME__) {
    // IAM derives from the same resolved conventions the runtime reads
    // back from the environment, so custom prefixes keep working.
    const { conventions } = yield* RunnerConventionsConfig;
    yield* host.bind`Allow(${host}, GitHub.Actions.WebhookFanOut)`({
      policyStatements: [
        {
          Effect: "Allow",
          Action: ["ssm:GetParametersByPath"],
          Resource: [ssmParametersArn(conventions.ssmRoutesPrefix)],
        },
        {
          // Demand targets are discovered at runtime via the route
          // registry, so they cannot be enumerated at deploy time. The
          // webhook only ever addresses queue URLs published by pool
          // stacks into that registry.
          Effect: "Allow",
          Action: ["sqs:SendMessage"],
          Resource: ["*"],
        },
      ],
    });
  }

  yield* host.listen(
    Effect.sync(() => (event: unknown) => {
      if (!isFunctionUrlEvent(event)) {
        return undefined;
      }
      return Effect.gen(function* () {
        const rawBody = event.isBase64Encoded
          ? Buffer.from(event.body ?? "", "base64").toString("utf8")
          : (event.body ?? "");
        // Failures propagate as invocation errors (GitHub observes a
        // failed delivery and retries; the recovery Lambda covers the
        // rest). 4xx answers below are deliberate responses, not errors.
        return yield* handleDelivery(
          rawBody,
          header(event.headers, "x-hub-signature-256"),
          header(event.headers, "x-github-delivery"),
        ).pipe(
          Effect.tapError((cause) =>
            Effect.logError(`Webhook delivery failed: ${cause}`),
          ),
          Effect.map((result) => proxyResponse(result.statusCode, result.body)),
          Effect.orDie,
        );
      });
    }),
  );
});

export default webhookImpl;
