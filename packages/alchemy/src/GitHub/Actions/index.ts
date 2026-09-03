/**
 * Self-hosted GitHub Actions runners on AWS, assembled from small
 * composable pieces.
 *
 * `RunnerControlPlane` provisions the serverless control plane (webhook
 * receiver, shared reaper) once per GitHub App / organization;
 * `RunnerPool` adds one homogeneous, independently scalable pool per
 * `runs-on` label, with plain compute props (AMI, instance types, market,
 * networking) resolved to EC2 resources at deploy time.
 *
 * Teams with existing standards override naming and tagging through the
 * control plane's `conventions` prop instead of forking components; teams
 * with custom images override the boot script per pool via the compute
 * `runnerDir` / `userData` props.
 *
 * Handler modules under `./handlers/` plus `crypto.ts`, `env.ts`,
 * `fleet.ts`, `routing.ts`, and `shared.ts` are internal: they hold the
 * static Lambda implementations and the pure helpers the composites are
 * built from. Deploy-time objects cross into handlers exclusively through
 * deploy-config context tags (consumed behind the `__ALCHEMY_RUNTIME__`
 * guard); every runtime value arrives via Lambda environment variables.
 * The pure, unit-tested helpers teams compose with directly are
 * re-exported below.
 */
export * from "./GitHubApp.ts";
export * from "./RunnerControlPlane.ts";
export * from "./RunnerPool.ts";
export {
  buildFleetRequest,
  decideScale,
  orderCandidates,
  renderRunnerUserData,
  runnerTags,
  type FleetRequestInput,
  type LaunchCandidate,
  type RunnerInstanceTags,
  type RunnerMarket,
  type RunnerTagKeys,
  type RunnerUserDataInput,
  type ScaleDecision,
  type ScaleDecisionInput,
} from "./fleet.ts";
export { routePoolLabels } from "./routing.ts";
export {
  DEFAULT_RUNNER_CONVENTIONS,
  resolveRunnerConventions,
  type RunnerConventions,
  type RunnerConventionsInput,
} from "./shared.ts";
