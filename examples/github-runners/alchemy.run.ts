import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

/**
 * Autoscaling GitHub Actions runners on EC2 Spot with scale-to-zero.
 *
 * Prerequisites:
 * - a GitHub App (Actions: read, Administration: read/write) installed on
 *   the organization, with `workflow_job` webhook events enabled,
 * - a prepared runner AMI (agent at /opt/actions-runner, awscli on PATH),
 * - public subnets for the runners (or private subnets with NAT).
 *
 * Deploy with `pnpm --filter github-runners-example deploy`, then point
 * workflows at the pool labels:
 *
 * ```yaml
 * jobs:
 *   test:
 *     runs-on: my-team-ci
 *   release:
 *     runs-on: my-team-release
 * ```
 *
 * Pools are plain composition: any label, instance family, or market works
 * — teams with existing SSM hierarchies or tag standards pass
 * `conventions` on the control plane, teams with custom images pass
 * `runnerDir` / `userData` on the pool compute.
 */
export default Alchemy.Stack(
  "GitHubRunnersExample",
  {
    providers: Layer.mergeAll(AWS.providers(), GitHub.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const runners = yield* GitHub.Actions.RunnerControlPlane("runners", {
      organization: "my-org",
      githubApp: {
        appId: process.env.GITHUB_APP_ID!,
        privateKey: Redacted.make(process.env.GITHUB_APP_PRIVATE_KEY!),
        installationId: Number(process.env.GITHUB_APP_INSTALLATION_ID!),
      },
      webhookSecret: Redacted.make(process.env.GITHUB_WEBHOOK_SECRET!),
      repositories: ["my-org/api", "my-org/web"],
    });

    const ci = yield* GitHub.Actions.RunnerPool("ci", {
      controlPlane: runners,
      label: "my-team-ci",
      compute: {
        market: "spot",
        instanceTypes: [
          "m8i.xlarge",
          "m7i.xlarge",
          "m7i-flex.xlarge",
          "m7a.xlarge",
        ],
        image: process.env.RUNNER_AMI!,
        network: {
          subnetIds: (process.env.RUNNER_SUBNET_IDS ?? "").split(","),
        },
      },
      maxRunners: 50,
    });

    const release = yield* GitHub.Actions.RunnerPool("release", {
      controlPlane: runners,
      label: "my-team-release",
      compute: {
        market: "on-demand",
        instanceTypes: ["m8i.xlarge", "m7i.xlarge"],
        image: process.env.RUNNER_AMI!,
        network: {
          subnetIds: (process.env.RUNNER_SUBNET_IDS ?? "").split(","),
        },
      },
      maxRunners: 5,
    });

    return {
      webhookUrl: runners.webhookUrl,
      ciPool: ci.label,
      releasePool: release.label,
    };
  }),
);
