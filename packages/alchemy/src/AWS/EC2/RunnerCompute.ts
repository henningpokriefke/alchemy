import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Effect from "effect/Effect";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import type { Output as OutputType } from "../../Output.ts";
import { LaunchTemplate } from "../AutoScaling/LaunchTemplate.ts";
import { SecurityGroup } from "./SecurityGroup.ts";
import { InstanceProfile } from "../IAM/InstanceProfile.ts";
import { Role } from "../IAM/Role.ts";
import {
  MANAGED_TAG_KEY,
  SSM_JIT_PREFIX,
} from "../../GitHub/Actions/shared.ts";
import { renderRunnerUserData } from "../../GitHub/Actions/fleet.ts";
import type { RunnerMarket } from "../../GitHub/Actions/fleet.ts";

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
   * Prepared runner AMI with the GitHub Actions agent at
   * `/opt/actions-runner`, the AWS CLI on `PATH`, and Docker/build tools.
   * The AMI's root snapshot defines the runner disk — size it generously
   * (e.g. 80 GB gp3) when building the image.
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
   * `spot` for PR CI (steep discount, interruption-tolerant ephemeral
   * runners), `on-demand` for release pools.
   */
  readonly market: RunnerMarket;
  /**
   * Spot allocation strategy. Only meaningful with `market: "spot"`.
   * @default "price-capacity-optimized"
   */
  readonly allocationStrategy?:
    | "price-capacity-optimized"
    | "capacity-optimized"
    | "lowest-price";
  /**
   * Subnets (and optionally security groups) for runners.
   */
  readonly network: RunnerComputeNetwork;
  /**
   * Bring-your-own instance profile. The role behind it must allow the
   * runner agent bootstrap: `ssm:GetParameter` +
   * `ssm:DeleteParameter` on `parameter/alchemy/github-runners/jit/*`,
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
 * The compute contract a runner pool scales on. This is the seam that
 * keeps `RunnerPool` compute-agnostic: V1 implements `aws-ec2`, a future
 * backend (Fargate, Kubernetes, bare metal) implements the same shape and
 * pools keep working unchanged.
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

export type RunnerCompute = Effect.Success<ReturnType<typeof RunnerCompute>>;

/**
 * EC2 compute for GitHub Actions runners: launch template, locked-down
 * networking, and least-privilege instance IAM.
 *
 * `RunnerCompute` owns every EC2-specific detail so `RunnerPool` never
 * touches instance types, AMIs, or subnets directly. The scaler launches
 * one EC2 Fleet per queued job from the template; the template's user
 * data boots the prepared AMI's agent with the job's JIT config and the
 * runner self-terminates after exactly one job.
 *
 * ### Spot CI Compute
 * **Example:** Price-optimized Spot fleet across families and AZs
 * ```typescript
 * const compute = yield* AWS.EC2.RunnerCompute("ci-4x-compute", {
 *   market: "spot",
 *   instanceTypes: ["m8i.xlarge", "m7i.xlarge", "m7i-flex.xlarge", "m7a.xlarge"],
 *   allocationStrategy: "price-capacity-optimized",
 *   image: runnerAmi,
 *   network: { subnetIds: network.publicSubnetIds },
 * });
 * ```
 *
 * ### On-Demand Release Compute
 * **Example:** Stable capacity for releases
 * ```typescript
 * const compute = yield* AWS.EC2.RunnerCompute("release-compute", {
 *   market: "on-demand",
 *   instanceTypes: ["m8i.xlarge", "m7i.xlarge"],
 *   image: runnerAmi,
 *   network: { subnetIds: network.publicSubnetIds },
 * });
 * ```
 *
 * @resource
 */
export const RunnerCompute = (id: string, props: RunnerComputeProps) =>
  Namespace.push(
    id,
    Effect.gen(function* () {
      if (props.instanceTypes.length === 0) {
        return yield* Effect.fail(
          new Error("EC2.RunnerCompute requires at least one instance type"),
        );
      }
      if (props.network.subnetIds.length === 0) {
        return yield* Effect.fail(
          new Error("EC2.RunnerCompute requires at least one subnet"),
        );
      }
      if (
        props.market === "on-demand" &&
        props.allocationStrategy !== undefined &&
        props.allocationStrategy !== "lowest-price"
      ) {
        return yield* Effect.fail(
          new Error(
            `EC2.RunnerCompute allocationStrategy "${props.allocationStrategy}" only applies to spot capacity — omit it for on-demand pools`,
          ),
        );
      }
      if (
        props.instanceProfileName !== undefined &&
        props.roleManagedPolicyArns?.length
      ) {
        return yield* Effect.fail(
          new Error(
            "EC2.RunnerCompute roleManagedPolicyArns only applies to the managed instance role — omit it with instanceProfileName",
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
                        Resource: [
                          "arn:aws:ssm:*:*:parameter/alchemy/github-runners/jit/*",
                        ],
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
                            [`aws:ResourceTag/${MANAGED_TAG_KEY}`]: "true",
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

      const template = yield* LaunchTemplate("RunnerLaunchTemplate", {
        imageId: props.image,
        instanceType: props.instanceTypes[0],
        securityGroupIds:
          securityGroupIds as unknown as import("./SecurityGroup.ts").SecurityGroupId[],
        instanceProfileName: instanceProfileName as unknown as string,
        userData: renderRunnerUserData({
          ssmJitPrefix: SSM_JIT_PREFIX,
          fallbackPoolLabel: id,
          fallbackRunnerName: `gh-${id}-pending`,
        }),
        tags: {
          ...props.tags,
          [MANAGED_TAG_KEY]: "true",
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
    }).pipe(Effect.orDie),
  );

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
          "EC2.RunnerCompute could not resolve a VPC from network.subnetIds",
        ),
      );
    }
    if (vpcIds.length > 1) {
      return yield* Effect.fail(
        new Error(
          "EC2.RunnerCompute requires all network.subnetIds to be in one VPC",
        ),
      );
    }
    return vpcIds[0];
  });
