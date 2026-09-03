import { Octokit } from "@octokit/rest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as NodeCrypto from "node:crypto";

/**
 * Credentials for a GitHub App installation. The app owns the runner
 * lifecycle: it receives `workflow_job` webhooks, mints installation
 * tokens, generates per-job JIT configs, and cleans up orphaned runners.
 *
 * The private key never enters Alchemy state as plaintext — pass it as
 * `Redacted` and it is only materialized into the control-plane Lambdas'
 * encrypted environment variables.
 *
 * Required app permissions: `Actions: read` (job status), `Administration:
 * read/write` (JIT configs, runner inventory, orphan removal),
 * `Webhooks: read/write` when Alchemy manages repository webhooks.
 */
export interface GitHubAppCredentials {
  /**
   * GitHub App ID (numeric, as shown in the app settings).
   */
  readonly appId: string;
  /**
   * PEM-encoded RSA private key of the GitHub App.
   */
  readonly privateKey: Redacted.Redacted<string>;
  /**
   * Installation ID of the app on the target organization.
   */
  readonly installationId: number;
}

/**
 * Mint a short-lived GitHub App JWT (`RS256`, 10-minute expiry) for the
 * `Authorization: Bearer` exchange to an installation token.
 *
 * Pure apart from the clock and the RSA signature — safe to unit test
 * around (see `decodeJwtPayload` in tests via the exported shape).
 */
export const createAppJwt = (
  credentials: Pick<GitHubAppCredentials, "appId" | "privateKey">,
  nowSeconds?: number,
): Effect.Effect<string> =>
  Effect.sync(() => {
    const now = nowSeconds ?? Math.floor(Date.now() / 1000);
    const header = base64UrlEncode('{"alg":"RS256","typ":"JWT"}');
    const payload = base64UrlEncode(
      JSON.stringify({
        iat: now - 60,
        exp: now + 600,
        iss: credentials.appId,
      }),
    );
    const signingInput = `${header}.${payload}`;
    const signer = NodeCrypto.createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    const signature = signer.sign(
      Redacted.value(credentials.privateKey),
      "base64",
    );
    return `${signingInput}.${base64UrlFromBase64(signature)}`;
  });

const base64UrlEncode = (input: string): string =>
  base64UrlFromBase64(Buffer.from(input, "utf8").toString("base64"));

const base64UrlFromBase64 = (input: string): string =>
  input.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

interface CachedToken {
  readonly token: string;
  readonly expiresAtSeconds: number;
}

const tokenCache = new Map<string, CachedToken>();

/**
 * Resolve an `Octokit` authenticated as the app installation, caching the
 * installation token in-memory (Lambda execution environment reuse) until
 * 60 seconds before expiry.
 */
export const installationOctokit = (
  credentials: GitHubAppCredentials,
): Effect.Effect<Octokit, Error> =>
  Effect.gen(function* () {
    const cacheKey = `${credentials.appId}:${credentials.installationId}`;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAtSeconds - 60 > nowSeconds) {
      return new Octokit({ auth: cached.token });
    }
    const jwt = yield* createAppJwt(credentials);
    const appOctokit = new Octokit({ auth: jwt });
    const { data } = yield* Effect.tryPromise({
      try: () =>
        appOctokit.rest.apps.createInstallationAccessToken({
          installation_id: credentials.installationId,
        }),
      catch: (cause) =>
        new Error(`Failed to mint GitHub installation token: ${cause}`),
    });
    tokenCache.set(cacheKey, {
      token: data.token,
      expiresAtSeconds: Math.floor(new Date(data.expires_at).getTime() / 1000),
    });
    return new Octokit({ auth: data.token });
  });

/**
 * Resolve the organization's default runner group id. JIT configs must
 * target an explicit group; the default group serves every repository
 * unless an admin restricted it. Lists groups through `octokit.request`
 * (the generated client in use does not expose the list endpoint yet).
 */
export const defaultRunnerGroupId = (
  octokit: Octokit,
  org: string,
): Effect.Effect<number, Error> =>
  Effect.tryPromise({
    try: async () => {
      const response = await octokit.request(
        "GET /orgs/{org}/actions/runner-groups",
        { org, per_page: 100 },
      );
      const groups = (
        response.data as {
          runner_groups: ReadonlyArray<{
            id: number;
            name: string;
            is_default?: boolean | null;
          }>;
        }
      ).runner_groups;
      const fallback =
        groups.find((group) => group.is_default || group.name === "Default") ??
        groups[0];
      if (!fallback) {
        throw new Error(`Organization ${org} has no runner groups`);
      }
      return fallback.id;
    },
    catch: (cause) =>
      new Error(`Failed to resolve default runner group: ${cause}`),
  });

/**
 * Generate a single-use JIT runner config for an organization runner.
 * The returned `encoded_jit_config` is passed to the runner agent as
 * `./run.sh --jitconfig <value>` — JIT runners are implicitly ephemeral
 * (exactly one job, then auto-removed).
 */
export const generateJitConfig = (
  octokit: Octokit,
  input: {
    readonly org: string;
    readonly name: string;
    readonly labels: readonly string[];
  },
): Effect.Effect<{ readonly encodedJitConfig: string }, Error> =>
  Effect.gen(function* () {
    const runnerGroupId = yield* defaultRunnerGroupId(octokit, input.org);
    return yield* Effect.tryPromise({
      try: async () => {
        const { data } =
          await octokit.rest.actions.generateRunnerJitconfigForOrg({
            org: input.org,
            name: input.name,
            runner_group_id: runnerGroupId,
            labels: [...input.labels],
          });
        return { encodedJitConfig: data.encoded_jit_config };
      },
      catch: (cause) =>
        new Error(`Failed to generate JIT runner config: ${cause}`),
    });
  });

/**
 * Read the current status of a workflow job (`queued` | `in_progress` |
 * `completed`). A deleted job resolves to the pseudo-status `"gone"`.
 * The scaler drops demand whose job already left `queued` state (duplicate
 * delivery, GitHub-side retry, or cancellation).
 */
export const getJobStatus = (
  octokit: Octokit,
  input: {
    readonly owner: string;
    readonly repo: string;
    readonly jobId: number;
  },
): Effect.Effect<{ readonly status: string }, Error> =>
  Effect.tryPromise({
    try: async () => {
      try {
        const { data } = await octokit.rest.actions.getJobForWorkflowRun({
          owner: input.owner,
          repo: input.repo,
          job_id: input.jobId,
        });
        return { status: data.status };
      } catch (error: unknown) {
        if (
          typeof error === "object" &&
          error !== null &&
          (error as { status?: unknown }).status === 404
        ) {
          return { status: "gone" };
        }
        throw error;
      }
    },
    catch: (cause) => new Error(`Failed to read workflow job status: ${cause}`),
  });

export interface OrgRunner {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly busy: boolean;
  readonly labels: readonly { readonly name: string }[];
}

/**
 * List all self-hosted runners of the organization (paginated).
 */
export const listOrgRunners = (
  octokit: Octokit,
  org: string,
): Effect.Effect<readonly OrgRunner[], Error> =>
  Effect.tryPromise({
    try: () =>
      octokit.paginate(octokit.rest.actions.listSelfHostedRunnersForOrg, {
        org,
        per_page: 100,
      }) as Promise<readonly OrgRunner[]>,
    catch: (cause) =>
      new Error(`Failed to list organization runners: ${cause}`),
  });

/**
 * Remove an orphaned self-hosted runner registration. Safe to call for an
 * already-removed runner — a `404` resolves to `void`.
 */
export const deleteOrgRunner = (
  octokit: Octokit,
  input: { readonly org: string; readonly runnerId: number },
): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    try: async () => {
      try {
        await octokit.rest.actions.deleteSelfHostedRunnerFromOrg({
          org: input.org,
          runner_id: input.runnerId,
        });
      } catch (error: unknown) {
        if (
          typeof error === "object" &&
          error !== null &&
          (error as { status?: unknown }).status === 404
        ) {
          return;
        }
        throw error;
      }
    },
    catch: (cause) =>
      new Error(`Failed to delete organization runner: ${cause}`),
  });
