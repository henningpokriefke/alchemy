/**
 * Shared constants for the GitHub Actions self-hosted runner components.
 *
 * These values are the deploy-time/runtime contract between the control
 * plane, the pools, and the EC2 runner agents: both sides derive names,
 * tags, and SSM paths from these constants, so changing them orphans live
 * infrastructure (instances keep their launch-time tags, SSM route entries
 * keep their paths).
 */

/**
 * Tag applied to every runner EC2 instance and EBS volume proving Alchemy
 * ownership. The reaper only ever terminates instances carrying this tag —
 * it never touches foreign capacity.
 */
export const MANAGED_TAG_KEY = "alchemy-github-runner";

/**
 * Tag carrying the pool label (the GitHub `runs-on` target, e.g.
 * `alchemy-ci-4x`) on runner instances and volumes.
 */
export const POOL_TAG_KEY = "github-runner-pool";

/**
 * Tag carrying the GitHub `workflow_job` id (`<owner>/<repo>/<job-id>`) on
 * runner instances. Lets the reaper correlate a live instance with its
 * GitHub job without any additional state.
 */
export const JOB_TAG_KEY = "github-job-id";

/**
 * Prefix for the SSM Parameter Store registry that maps pool labels to
 * demand queues. Each pool owns exactly one parameter:
 * `<SSM_ROUTES_PREFIX>/<pool-label>` with a JSON
 * `{ queueUrl, queueArn }` value.
 *
 * The webhook and the reaper discover pools by reading this prefix — no
 * pool ARNs are baked into the control plane at deploy time, so pools can
 * be added and removed without redeploying shared Lambdas.
 */
export const SSM_ROUTES_PREFIX = "/alchemy/github-runners/routes";

/**
 * Prefix for short-lived per-job JIT-config parameters. The scaler writes
 * `<SSM_JIT_PREFIX>/<runner-name>` before launching the fleet; the runner
 * agent reads and deletes its own parameter during boot.
 */
export const SSM_JIT_PREFIX = "/alchemy/github-runners/jit";

/**
 * Environment variable names shared by the control-plane Lambdas. Deploy
 * code writes them (via `Function` `env` props); handler code reads them
 * at runtime. Keeping the names in one place avoids silent typos between
 * the two sides.
 */
export const Env = {
  organization: "GITHUB_ORG",
  appId: "GITHUB_APP_ID",
  appPrivateKey: "GITHUB_APP_PRIVATE_KEY",
  installationId: "GITHUB_APP_INSTALLATION_ID",
  webhookSecret: "GITHUB_WEBHOOK_SECRET",
  ssmRoutesPrefix: "SSM_ROUTES_PREFIX",
  ssmJitPrefix: "SSM_JIT_PREFIX",
  poolLabel: "POOL_LABEL",
  maxRunners: "MAX_RUNNERS",
  launchTemplateName: "LAUNCH_TEMPLATE_NAME",
  subnetIds: "SUBNET_IDS",
  instanceTypes: "INSTANCE_TYPES",
  market: "MARKET",
  startupDeadlineMinutes: "STARTUP_DEADLINE_MINUTES",
  maxRunnerAgeMinutes: "MAX_RUNNER_AGE_MINUTES",
  recoveryWebhooks: "RECOVERY_WEBHOOKS",
} as const;

/**
 * Derive the SSM route parameter name for a pool label.
 */
export const routeParameterName = (prefix: string, label: string): string =>
  `${prefix.replace(/\/$/, "")}/${label}`;

/**
 * Derive the SSM parameter name holding a runner's JIT config.
 */
export const jitParameterName = (prefix: string, runnerName: string): string =>
  `${prefix.replace(/\/$/, "")}/${runnerName}`;

/**
 * Derive the EC2 instance / GitHub runner name for a job. GitHub runner
 * names must be unique per runner within the scope (org); the workflow job
 * id is unique per job attempt, so `label + job id` is collision-free and
 * lets the reaper correlate instances, runners, and JIT parameters
 * without a database.
 */
export const runnerNameFor = (label: string, jobId: number): string => {
  const safeLabel = label.replace(/[^a-zA-Z0-9-]+/g, "-");
  return `gh-${safeLabel}-${jobId}`;
};

/**
 * One capacity-demand signal on a pool's SQS queue, as published by the
 * webhook Lambda and consumed by the pool scaler. The queue persists
 * demand — never job semantics: GitHub stays the source of truth and the
 * scaler re-validates the job before launching.
 */
export interface DemandMessage {
  readonly owner: string;
  readonly repo: string;
  readonly jobId: number;
  readonly poolLabel: string;
  /**
   * GitHub delivery id, for log correlation.
   */
  readonly deliveryId: string;
}
