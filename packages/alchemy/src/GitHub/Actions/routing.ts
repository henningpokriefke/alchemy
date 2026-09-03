/**
 * Match a job's `workflow_job.labels` against the registered pool labels.
 *
 * Matching is deliberately exact: pool labels are unique `runs-on` targets
 * (e.g. `my-team-ci`), never overlapping hardware aliases like `linux`
 * or `x64`. A job with labels `["self-hosted", "my-team-ci"]` routes to
 * exactly one pool; a job with no registered label routes nowhere (GitHub
 * keeps it queued for other runners).
 *
 * Returns the matched pool labels in job-label order, deduplicated.
 *
 * **Example:** Route a queued job
 * ```typescript
 * const pools = routePoolLabels(
 *   ["self-hosted", "my-team-ci"],
 *   ["my-team-ci", "my-team-release"],
 * );
 * // ["my-team-ci"]
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
