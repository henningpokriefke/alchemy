import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/**
 * A pool's entry in the SSM route registry
 * (`<SSM_ROUTES_PREFIX>/<pool-label>`).
 */
export interface RouteTarget {
  readonly queueUrl: string;
  readonly queueArn: string;
}

export class RouteDecodeError extends Data.TaggedError("RouteDecodeError")<{
  readonly parameterName: string;
  readonly reason: string;
}> {}

/**
 * Decode and validate an SSM route parameter value. A corrupt entry must
 * never break the webhook fan-out — the caller logs the typed error and
 * skips the pool.
 *
 * **Example:** Decode a registry value
 * ```typescript
 * const target = yield* decodeRouteValue(
 *   "/alchemy/github-runners/routes/alchemy-ci-4x",
 *   raw,
 * ).pipe(
 *   Effect.catchTag("RouteDecodeError", (error) =>
 *     Effect.logWarning(error.reason).pipe(Effect.as(undefined)),
 *   ),
 * );
 * ```
 */
export const decodeRouteValue = (
  parameterName: string,
  raw: string,
): Effect.Effect<RouteTarget, RouteDecodeError> =>
  Effect.gen(function* () {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return yield* Effect.fail(
        new RouteDecodeError({
          parameterName,
          reason: "value is not valid JSON",
        }),
      );
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).queueUrl !== "string" ||
      typeof (parsed as Record<string, unknown>).queueArn !== "string"
    ) {
      return yield* Effect.fail(
        new RouteDecodeError({
          parameterName,
          reason: "value must be { queueUrl: string, queueArn: string }",
        }),
      );
    }
    const value = parsed as { queueUrl: string; queueArn: string };
    if (value.queueUrl.length === 0 || value.queueArn.length === 0) {
      return yield* Effect.fail(
        new RouteDecodeError({
          parameterName,
          reason: "queueUrl and queueArn must be non-empty",
        }),
      );
    }
    return { queueUrl: value.queueUrl, queueArn: value.queueArn };
  });

/**
 * Match a job's `workflow_job.labels` against the registered pool labels.
 *
 * Matching is deliberately exact: pool labels are unique `runs-on` targets
 * (e.g. `alchemy-ci-4x`), never overlapping hardware aliases like `linux`
 * or `x64`. A job with labels `["self-hosted", "alchemy-ci-4x"]` routes to
 * exactly one pool; a job with no registered label routes nowhere (GitHub
 * keeps it queued for other runners).
 *
 * Returns the matched pool labels in job-label order, deduplicated.
 *
 * **Example:** Route a queued job
 * ```typescript
 * const pools = routePoolLabels(
 *   ["self-hosted", "alchemy-ci-4x"],
 *   ["alchemy-ci-4x", "alchemy-release-4x"],
 * );
 * // ["alchemy-ci-4x"]
 * ```
 */
export const routePoolLabels = (
  jobLabels: readonly string[],
  registeredLabels: readonly string[],
): string[] => {
  const registered = new Set(registeredLabels);
  const matched = new Set<string>();
  for (const label of jobLabels) {
    if (registered.has(label)) {
      matched.add(label);
    }
  }
  return [...matched];
};
