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
 *     runs-on: alchemy-ci-4x
 *   release:
 *     runs-on: alchemy-release-4x
 * ```
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

    const ci4x = yield* GitHub.Actions.RunnerPool("ci-4x", {
      controlPlane: runners,
      label: "alchemy-ci-4x",
      compute: yield* AWS.EC2.RunnerCompute("ci-4x-compute", {
        market: "spot",
        instanceTypes: [
          "m8i.xlarge",
          "m7i.xlarge",
          "m7i-flex.xlarge",
          "m7a.xlarge",
        ],
        allocationStrategy: "price-capacity-optimized",
        image: process.env.RUNNER_AMI!,
        network: {
          subnetIds: (process.env.RUNNER_SUBNET_IDS ?? "").split(","),
        },
      }),
      maxRunners: 50,
    });

    const release = yield* GitHub.Actions.RunnerPool("release", {
      controlPlane: runners,
      label: "alchemy-release-4x",
      compute: yield* AWS.EC2.RunnerCompute("release-compute", {
        market: "on-demand",
        instanceTypes: ["m8i.xlarge", "m7i.xlarge"],
        image: process.env.RUNNER_AMI!,
        network: {
          subnetIds: (process.env.RUNNER_SUBNET_IDS ?? "").split(","),
        },
      }),
      maxRunners: 5,
    });

    return {
      webhookUrl: runners.webhookUrl,
      ciPool: ci4x.label,
      releasePool: release.label,
    };
  }),
);
