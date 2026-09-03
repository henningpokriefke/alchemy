import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Effect from "effect/Effect";
import * as Output from "../../Output.ts";
import type { Output as OutputType } from "../../Output.ts";
import { LaunchTemplate } from "../AutoScaling/LaunchTemplate.ts";
import { SecurityGroup } from "./SecurityGroup.ts";
import { InstanceProfile } from "../IAM/InstanceProfile.ts";
import { Role } from "../IAM/Role.ts";
import { renderRunnerUserData } from "../../GitHub/Actions/fleet.ts";
import type { RunnerMarket } from "../../GitHub/Actions/fleet.ts";
import {
  ssmParametersArn,
  type RunnerConventions,
} from "../../GitHub/Actions/shared.ts";

export type { RunnerMarket };

export interface RunnerComputeNetwork {
  /**
   * Subnets to launch runners into. Spread across Availability Zones for
   * Spot diversification. Public subnets are recommended: runners need
   * only outbound connectivity (GitHub, registries, AWS APIs) and public
   * IPv4 avoids fixed NAT Gateway costs that would break scale-to-zero
   * economics. Private subnets work but require NAT.
   */
  readonly subnetIds: string[];
  /**
   * Security groups attached to runners. When omitted, a locked-down
   * group is created (no inbound, all outbound) in the subnets' VPC.
   */
  readonly securityGroupIds?: string[];
}

export interface RunnerComputeProps {
  /**
   * Prepared runner AMI with the GitHub Actions agent, the AWS CLI on
   * `PATH`, and Docker/build tools. The AMI's root snapshot defines the
   * runner disk — size it generously (e.g. 80 GB gp3) when building the
   * image. Plain string on purpose: bring whatever image fits the team
   * (AL2023, Ubuntu, hardened base images) and pair it with `runnerDir`
   * or `userData` below.
   */
  readonly image: string;
  /**
   * Candidate instance types for the fleet, cheapest-first. The scaler
   * offers every type × subnet combination to EC2 Fleet with
   * `price-capacity-optimized` (Spot), so list several types across
   * families (e.g. `m8i`, `m7i`, `m7i-flex`, `m7a`) instead of betting on
   * one pool.
   */
  readonly instanceTypes: readonly string[];
  /**
   * `spot` for preemptible CI capacity (interruption-tolerant ephemeral
   * runners), `on-demand` for stable pools such as releases.
   */
  readonly market: RunnerMarket;
  /**
   * Subnets (and optionally security groups) for runners.
   */
  readonly network: RunnerComputeNetwork;
  /**
   * Directory holding the GitHub Actions runner agent on `image`.
   * Only used with the default boot script.
   * @default "/opt/actions-runner"
   */
  readonly runnerDir?: string;
  /**
   * Complete user-data boot script, replacing the default
   * `renderRunnerUserData` flow (fetch JIT config from SSM, run the
   * agent with `--jitconfig` for exactly one job, self-terminate).
   * Use it for fully custom images whose bootstrap differs; the script
   * still receives the pool's tags on the instance.
   */
  readonly userData?: string;
  /**
   * Bring-your-own instance profile. The role behind it must allow the
   * runner agent bootstrap: `ssm:GetParameter` +
   * `ssm:DeleteParameter` on the pool's JIT prefix,
   * `ec2:DescribeTags` on `*`, and `ec2:TerminateInstances` scoped to
   * runner instances for self-termination. When omitted, a least-privilege
   * role + profile is created.
   */
  readonly instanceProfileName?: string;
  /**
   * Additional managed policy ARNs for the managed instance role (e.g.
   * CloudWatch agent access). Only valid without `instanceProfileName`.
   */
  readonly roleManagedPolicyArns?: string[];
  /**
   * Tags applied to the launch template, role, profile, and security
   * group. Runner instances themselves are tagged per job by the scaler.
   */
  readonly tags?: Record<string, string>;
}

/**
 * The compute backing a runner pool scales on: launch template plus the
 * placement and IAM references the scaler launches from. Internal to the
 * pool — pools accept plain {@link RunnerComputeProps} and resolve the
 * spec at deploy time, so there is no separate compute resource to manage.
 */
export interface RunnerComputeSpec {
  readonly kind: "aws-ec2";
  /**
   * Name of the `$Default` launch template version the scaler launches.
   */
  readonly launchTemplateName: OutputType<string>;
  readonly launchTemplateId: OutputType<string>;
  readonly subnetIds: readonly string[];
  readonly securityGroupIds: ReadonlyArray<string | OutputType<string>>;
  readonly instanceProfileName: OutputType<string>;
  readonly instanceTypes: readonly string[];
  readonly market: RunnerMarket;
  readonly imageId: string;
}

/**
 * Resolve a pool's compute into EC2 resources (security group, instance
 * role/profile, launch template) inside the caller's namespace. Called by
 * `GitHub.Actions.RunnerPool` — not a standalone resource, so pools stay
 * the single unit users manage while all EC2 specifics remain in the EC2
 * module.
 */
export const resolveRunnerCompute = (
  props: RunnerComputeProps,
  options: {
    readonly conventions: RunnerConventions;
    readonly fallbackPoolLabel: string;
  },
) =>
  Effect.gen(function* () {
    const { conventions, fallbackPoolLabel } = options;
    if (props.instanceTypes.length === 0) {
      return yield* Effect.fail(
        new Error("Runner pool compute requires at least one instance type"),
      );
    }
    if (props.network.subnetIds.length === 0) {
      return yield* Effect.fail(
        new Error("Runner pool compute requires at least one subnet"),
      );
    }
    if (
      props.instanceProfileName !== undefined &&
      props.roleManagedPolicyArns?.length
    ) {
      return yield* Effect.fail(
        new Error(
          "Runner pool compute roleManagedPolicyArns only applies to the managed instance role — omit it with instanceProfileName",
        ),
      );
    }

    const securityGroupIds: Array<string | OutputType<string>> =
      props.network.securityGroupIds !== undefined
        ? [...props.network.securityGroupIds]
        : [
            (yield* SecurityGroup("RunnerSecurityGroup", {
              vpcId: (yield* resolveVpcId(
                props.network.subnetIds,
              )) as import("./Vpc.ts").VpcId,
              description: "GitHub Actions runners: no inbound, all outbound",
              ingress: [],
              egress: [
                {
                  ipProtocol: "-1",
                  cidrIpv4: "0.0.0.0/0",
                  description: "Runner outbound to GitHub and registries",
                },
              ],
              tags: props.tags,
            })).groupId,
          ];

    const instanceProfileName: OutputType<string> =
      props.instanceProfileName !== undefined
        ? Output.asOutput(props.instanceProfileName)
        : (yield* InstanceProfile("RunnerProfile", {
            roleName: (yield* Role("RunnerRole", {
              assumeRolePolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Principal: { Service: "ec2.amazonaws.com" },
                    Action: ["sts:AssumeRole"],
                  },
                ],
              },
              managedPolicyArns: props.roleManagedPolicyArns,
              inlinePolicies: {
                RunnerBootstrap: {
                  Version: "2012-10-17",
                  Statement: [
                    {
                      Effect: "Allow",
                      Action: ["ssm:GetParameter", "ssm:DeleteParameter"],
                      Resource: [ssmParametersArn(conventions.ssmJitPrefix)],
                    },
                    {
                      Effect: "Allow",
                      Action: ["ec2:DescribeTags"],
                      Resource: ["*"],
                    },
                    {
                      Effect: "Allow",
                      Action: ["ec2:TerminateInstances"],
                      Resource: ["*"],
                      Condition: {
                        StringEquals: {
                          [`aws:ResourceTag/${conventions.managedTagKey}`]:
                            "true",
                        },
                      },
                    },
                  ],
                },
              },
              tags: props.tags,
            })).roleName,
            tags: props.tags,
          })).instanceProfileName;

    const userData =
      props.userData ??
      renderRunnerUserData({
        ssmJitPrefix: conventions.ssmJitPrefix,
        poolTagKey: conventions.poolTagKey,
        runnerDir: props.runnerDir,
        fallbackPoolLabel,
        fallbackRunnerName: `${conventions.runnerNamePrefix}-${fallbackPoolLabel}-pending`,
      });

    const template = yield* LaunchTemplate("RunnerLaunchTemplate", {
      imageId: props.image,
      instanceType: props.instanceTypes[0],
      securityGroupIds:
        securityGroupIds as unknown as import("./SecurityGroup.ts").SecurityGroupId[],
      instanceProfileName: instanceProfileName as unknown as string,
      userData,
      tags: {
        ...props.tags,
        [conventions.managedTagKey]: "true",
      },
    });

    const spec: RunnerComputeSpec = {
      kind: "aws-ec2",
      launchTemplateName: template.launchTemplateName,
      launchTemplateId: template.launchTemplateId,
      subnetIds: props.network.subnetIds,
      securityGroupIds,
      instanceProfileName,
      instanceTypes: props.instanceTypes,
      market: props.market,
      imageId: props.image,
    };
    return spec;
  });

const resolveVpcId = (subnetIds: readonly string[]) =>
  Effect.gen(function* () {
    const result = yield* ec2.describeSubnets({
      SubnetIds: [...subnetIds],
    });
    const vpcIds = [
      ...new Set(
        (result.Subnets ?? []).flatMap((subnet) =>
          subnet.VpcId ? [subnet.VpcId] : [],
        ),
      ),
    ];
    if (vpcIds.length === 0) {
      return yield* Effect.fail(
        new Error(
          "Runner pool compute could not resolve a VPC from network.subnetIds",
        ),
      );
    }
    if (vpcIds.length > 1) {
      return yield* Effect.fail(
        new Error(
          "Runner pool compute requires all network.subnetIds to be in one VPC",
        ),
      );
    }
    return vpcIds[0];
  });
