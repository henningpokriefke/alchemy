import * as Context from "effect/Context";

/**
 * Shared contracts for the GitHub Actions self-hosted runner components.
 *
 * These values are the deploy-time/runtime contract between the control
 * plane, the pools, and the EC2 runner agents: both sides derive names,
 * tags, and SSM paths from the resolved conventions, so changing them
 * after runners exist orphans live infrastructure (instances keep their
 * launch-time tags, SSM route entries keep their paths).
 */

/**
 * Default SSM prefix for the pool route registry. Each pool owns exactly
 * one parameter: `<ssmRoutesPrefix>/<pool-label>` holding the pool's
 * demand queue URL as a plain string.
 *
 * The webhook and the reaper discover pools by reading this prefix — no
 * pool ARNs are baked into the control plane at deploy time, so pools can
 * be added and removed without redeploying shared Lambdas.
 */
export const DEFAULT_SSM_ROUTES_PREFIX = "/alchemy/github-runners/routes";

/**
 * Default SSM prefix for short-lived per-job JIT-config parameters. The
 * scaler writes `<ssmJitPrefix>/<runner-name>` before launching the fleet;
 * the runner agent reads and deletes its own parameter during boot.
 */
export const DEFAULT_SSM_JIT_PREFIX = "/alchemy/github-runners/jit";

/**
 * Default tag proving Alchemy ownership on every runner EC2 instance and
 * EBS volume. The reaper only ever terminates instances carrying this
 * tag — it never touches foreign capacity.
 */
export const DEFAULT_MANAGED_TAG_KEY = "alchemy-github-runner";

/**
 * Default tag carrying the pool label (the GitHub `runs-on` target, e.g.
 * `my-team-ci`) on runner instances and volumes.
 */
export const DEFAULT_POOL_TAG_KEY = "github-runner-pool";

/**
 * Default tag carrying the GitHub `workflow_job` id
 * (`<owner>/<repo>/<job-id>`) on runner instances. Lets the reaper
 * correlate a live instance with its GitHub job without any additional
 * state.
 */
export const DEFAULT_JOB_TAG_KEY = "github-job-id";

/**
 * Default prefix for runner names (`<prefix>-<pool-label>-<job-id>`).
 */
export const DEFAULT_RUNNER_NAME_PREFIX = "gh";

/**
 * Default directory holding the GitHub Actions runner agent on the
 * prepared AMI. Override per pool via the compute `runnerDir` prop when
 * the image lays the agent out differently.
 */
export const DEFAULT_RUNNER_DIR = "/opt/actions-runner";

/**
 * Naming and tagging conventions shared by the control plane, the pools,
 * and the runner agents. Every field is optional — unset fields fall back
 * to the `DEFAULT_*` constants above, so teams can adopt their own
 * standards (company tag keys, existing SSM hierarchies) without forking
 * any component.
 *
 * The object is plain JSON-serializable data on purpose: the control
 * plane resolves it once at deploy time and hands it to every Lambda
 * through the environment, so deploy-time IAM and runtime behavior can
 * never drift apart.
 */
export interface RunnerConventionsInput {
  readonly ssmRoutesPrefix?: string;
  readonly ssmJitPrefix?: string;
  readonly managedTagKey?: string;
  readonly poolTagKey?: string;
  readonly jobTagKey?: string;
  readonly runnerNamePrefix?: string;
}

/**
 * Fully resolved runner conventions (see {@link RunnerConventionsInput}).
 */
export interface RunnerConventions {
  readonly ssmRoutesPrefix: string;
  readonly ssmJitPrefix: string;
  readonly managedTagKey: string;
  readonly poolTagKey: string;
  readonly jobTagKey: string;
  readonly runnerNamePrefix: string;
}

/**
 * Conventions used when a stack does not override them.
 */
export const DEFAULT_RUNNER_CONVENTIONS: RunnerConventions = {
  ssmRoutesPrefix: DEFAULT_SSM_ROUTES_PREFIX,
  ssmJitPrefix: DEFAULT_SSM_JIT_PREFIX,
  managedTagKey: DEFAULT_MANAGED_TAG_KEY,
  poolTagKey: DEFAULT_POOL_TAG_KEY,
  jobTagKey: DEFAULT_JOB_TAG_KEY,
  runnerNamePrefix: DEFAULT_RUNNER_NAME_PREFIX,
};

/**
 * Merge user overrides over the defaults. Pure and total — every unset
 * or empty field falls back to its default.
 */
export const resolveRunnerConventions = (
  input: RunnerConventionsInput = {},
): RunnerConventions => ({
  ssmRoutesPrefix:
    input.ssmRoutesPrefix || DEFAULT_RUNNER_CONVENTIONS.ssmRoutesPrefix,
  ssmJitPrefix: input.ssmJitPrefix || DEFAULT_RUNNER_CONVENTIONS.ssmJitPrefix,
  managedTagKey:
    input.managedTagKey || DEFAULT_RUNNER_CONVENTIONS.managedTagKey,
  poolTagKey: input.poolTagKey || DEFAULT_RUNNER_CONVENTIONS.poolTagKey,
  jobTagKey: input.jobTagKey || DEFAULT_RUNNER_CONVENTIONS.jobTagKey,
  runnerNamePrefix:
    input.runnerNamePrefix || DEFAULT_RUNNER_CONVENTIONS.runnerNamePrefix,
});

/**
 * Derive the IAM resource ARN covering every parameter below an SSM
 * prefix. Deploy-time policy statements must derive from the resolved
 * conventions (never hardcode the default paths) so custom prefixes keep
 * working.
 */
export const ssmParametersArn = (prefix: string): string =>
  `arn:aws:ssm:*:*:parameter${prefix}/*`;

/**
 * Deploy-only wiring: the resolved conventions. Handler modules consume
 * this context tag to build IAM statements at deploy time; runtime code
 * reads the same conventions back from the Lambda environment (see
 * `readConventions` in `env.ts`). Provided by `RunnerControlPlane` and
 * `RunnerPool` — never touched at runtime (behind the
 * `__ALCHEMY_RUNTIME__` guard).
 */
export interface RunnerConventionsConfig {
  readonly conventions: RunnerConventions;
}

export const RunnerConventionsConfig = Context.Service<
  RunnerConventionsConfig,
  { readonly conventions: RunnerConventions }
>()("GitHub.Actions.RunnerConventionsConfig");

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
  conventions: "RUNNER_CONVENTIONS",
  poolLabel: "POOL_LABEL",
  maxRunners: "MAX_RUNNERS",
  launchTemplateName: "LAUNCH_TEMPLATE_NAME",
  subnetIds: "SUBNET_IDS",
  instanceTypes: "INSTANCE_TYPES",
  market: "MARKET",
  startupDeadlineMinutes: "STARTUP_DEADLINE_MINUTES",
  maxRunnerAgeMinutes: "MAX_RUNNER_AGE_MINUTES",
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
 * id is unique per job attempt, so `prefix + label + job id` is
 * collision-free and lets the reaper correlate instances, runners, and
 * JIT parameters without a database.
 */
export const runnerNameFor = (
  label: string,
  jobId: number,
  prefix: string = DEFAULT_RUNNER_NAME_PREFIX,
): string => {
  const safeLabel = label.replace(/[^a-zA-Z0-9-]+/g, "-");
  return `${prefix}-${safeLabel}-${jobId}`;
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
