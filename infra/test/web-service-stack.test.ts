import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { BizFlowWebServiceStack } from "../lib/web-service-stack";

const DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function template(): Template {
  const app = new App();
  const stack = new BizFlowWebServiceStack(app, "TestWebService", {
    env: { account: "111122223333", region: "ap-northeast-1" },
    environmentName: "dev",
    imageDigest: DIGEST,
    repositoryName: "bizflow-web-dev",
    repositoryArn:
      "arn:aws:ecr:ap-northeast-1:111122223333:repository/bizflow-web-dev",
    vpcId: "vpc-0123456789abcdef0",
    availabilityZones: ["ap-northeast-1a", "ap-northeast-1c"],
    privateSubnetIds: ["subnet-0123456789abcdef0", "subnet-0fedcba9876543210"],
    privateSubnetRouteTableIds: [
      "rtb-0123456789abcdef0",
      "rtb-0fedcba9876543210",
    ],
    clusterName: "bizflow-web-dev",
    webAlbSecurityGroupId: "sg-0123456789abcdef0",
    httpsListenerArn:
      "arn:aws:elasticloadbalancing:ap-northeast-1:111122223333:listener/app/bizflow-web-dev/0123456789abcdef/0123456789abcdef",
    userPoolId: "ap-northeast-1_AbCdEf123",
    userPoolClientId: "0123456789abcdefghijklmnop",
    userPoolDomainName: "bizflow-dev-111122223333",
    webUrl: "https://bizflow.example.com",
    agentRuntimeArn:
      "arn:aws:bedrock-agentcore:ap-northeast-1:111122223333:runtime/BizFlowAgent_dev-example",
    agentRuntimeEndpointArn:
      "arn:aws:bedrock-agentcore:ap-northeast-1:111122223333:runtime/BizFlowAgent_dev-example/runtime-endpoint/PROD",
    endpointName: "PROD",
    readToolsFunctionName: "bizflow-read-tools-dev",
    writeToolsFunctionName: "bizflow-write-tools-dev",
    approvalFunctionName: "bizflow-approval-workflow-dev",
  });
  return Template.fromStack(stack);
}

describe("BizFlowWebServiceStack", () => {
  it("runs the digest-pinned ARM64 container in private Fargate subnets", () => {
    const result = template();

    result.hasResourceProperties("AWS::ECS::TaskDefinition", {
      Cpu: "512",
      Memory: "1024",
      RuntimePlatform: {
        CpuArchitecture: "ARM64",
        OperatingSystemFamily: "LINUX",
      },
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: "bizflow-web",
          Image: Match.anyValue(),
          PortMappings: Match.arrayWith([Match.objectLike({ ContainerPort: 3000 })]),
          ReadonlyRootFilesystem: true,
          Environment: Match.arrayWith([
            { Name: "HOSTNAME", Value: "0.0.0.0" },
            { Name: "PORT", Value: "3000" },
          ]),
        }),
      ]),
    });
    result.hasResourceProperties("AWS::ECS::Service", {
      DesiredCount: 1,
      EnableExecuteCommand: false,
      NetworkConfiguration: {
        AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: "DISABLED" }),
      },
    });
    const taskDefinitions = result.findResources("AWS::ECS::TaskDefinition");
    expect(JSON.stringify(taskDefinitions)).toContain(DIGEST);
  });

  it("limits the task role to AgentCore invocation and the three BFF Lambda APIs", () => {
    const result = template();

    result.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: "InvokeBizFlowAgentRuntime",
            Action: "bedrock-agentcore:InvokeAgentRuntime",
            Effect: "Allow",
            Resource: Match.arrayWith([
              "arn:aws:bedrock-agentcore:ap-northeast-1:111122223333:runtime/BizFlowAgent_dev-example",
              "arn:aws:bedrock-agentcore:ap-northeast-1:111122223333:runtime/BizFlowAgent_dev-example/runtime-endpoint/PROD",
            ]),
          }),
          Match.objectLike({
            Sid: "InvokeBizFlowBusinessApis",
            Action: "lambda:InvokeFunction",
            Effect: "Allow",
            Resource: Match.anyValue(),
          }),
        ]),
      },
    });
    const policies = result.findResources("AWS::IAM::Policy");
    const serialized = JSON.stringify(policies);
    expect(serialized).toContain("bizflow-read-tools-dev");
    expect(serialized).toContain("bizflow-write-tools-dev");
    expect(serialized).toContain("bizflow-approval-workflow-dev");
    expect(serialized).toContain(":function:bizflow-read-tools-dev");
    expect(serialized).toContain(":function:bizflow-write-tools-dev");
    expect(serialized).toContain(":function:bizflow-approval-workflow-dev");
    expect(serialized).not.toContain(":function/bizflow-");
  });

  it("allows the execution role to pull the injected GuardDuty agent image", () => {
    const result = template();

    result.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: "PullGuardDutyRuntimeMonitoringAgent",
            Action: Match.arrayWith([
              "ecr:BatchCheckLayerAvailability",
              "ecr:GetDownloadUrlForLayer",
              "ecr:BatchGetImage",
            ]),
            Effect: "Allow",
            Resource: "*",
          }),
        ]),
      },
    });
  });

  it("retains logs after normal deletion but cleans them up after a failed initial create", () => {
    const result = template();

    result.hasResource("AWS::Logs::LogGroup", {
      DeletionPolicy: "RetainExceptOnCreate",
      UpdateReplacePolicy: "Retain",
    });
  });

  it("places Cognito authentication before the target group forward action", () => {
    const result = template();

    result.hasResourceProperties("AWS::ElasticLoadBalancingV2::ListenerRule", {
      Priority: 10,
      Actions: Match.arrayWith([
        Match.objectLike({ Type: "authenticate-cognito", Order: 1 }),
        Match.objectLike({ Type: "forward", Order: 2 }),
      ]),
    });
    result.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", {
      HealthCheckPath: "/api/health",
      Port: 3000,
      Protocol: "HTTP",
      TargetType: "ip",
    });
  });
});
