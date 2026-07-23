import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { BizFlowWebFoundationStack } from "../lib/web-foundation-stack";

function template(): Template {
  const app = new App();
  const stack = new BizFlowWebFoundationStack(app, "TestWebFoundation", {
    env: { account: "111122223333", region: "ap-northeast-1" },
    environmentName: "dev",
    availabilityZones: ["ap-northeast-1a", "ap-northeast-1c"],
    domainName: "bizflow.example.com",
    hostedZoneId: "Z0123456789ABC",
    hostedZoneName: "example.com",
    certificateArn:
      "arn:aws:acm:ap-northeast-1:111122223333:certificate/00000000-0000-0000-0000-000000000000",
  });
  return Template.fromStack(stack);
}

describe("BizFlowWebFoundationStack", () => {
  it("creates an immutable scanned web repository and private Fargate network", () => {
    const result = template();

    result.hasResourceProperties("AWS::ECR::Repository", {
      RepositoryName: "bizflow-web-dev",
      ImageTagMutability: "IMMUTABLE",
      ImageScanningConfiguration: { ScanOnPush: true },
    });
    result.resourceCountIs("AWS::EC2::NatGateway", 1);
    result.resourceCountIs("AWS::EC2::Subnet", 4);
    result.hasResourceProperties("AWS::ECS::Cluster", {
      ClusterName: "bizflow-web-dev",
      ClusterSettings: Match.arrayWith([
        { Name: "containerInsights", Value: "enabled" },
      ]),
    });
  });

  it("configures Cognito for the HTTPS ALB authorization-code flow", () => {
    const result = template();

    result.hasResourceProperties("AWS::Cognito::UserPool", {
      DeletionProtection: "ACTIVE",
      MfaConfiguration: "OPTIONAL",
      UsernameAttributes: ["email"],
    });
    result.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      GenerateSecret: true,
      AllowedOAuthFlows: ["code"],
      AllowedOAuthScopes: Match.arrayWith(["openid", "email", "profile"]),
      CallbackURLs: ["https://bizflow.example.com/oauth2/idpresponse"],
      PreventUserExistenceErrors: "ENABLED",
    });
    result.resourceCountIs("AWS::Cognito::UserPoolGroup", 2);
    result.hasResourceProperties("AWS::Cognito::UserPoolDomain", {
      Domain: Match.stringLikeRegexp("^bizflow-dev-[0-9a-f]{12}$"),
    });
  });

  it("creates a literal Cognito domain prefix even when the account is unresolved", () => {
    const app = new App();
    const stack = new BizFlowWebFoundationStack(app, "AgnosticWebFoundation", {
      environmentName: "dev",
      availabilityZones: ["ap-northeast-1a", "ap-northeast-1c"],
      domainName: "bizflow.example.com",
      hostedZoneId: "Z0123456789ABC",
      hostedZoneName: "example.com",
      certificateArn:
        "arn:aws:acm:ap-northeast-1:111122223333:certificate/00000000-0000-0000-0000-000000000000",
    });

    Template.fromStack(stack).hasResourceProperties(
      "AWS::Cognito::UserPoolDomain",
      {
        Domain: Match.stringLikeRegexp("^bizflow-dev-[0-9a-f]{12}$"),
      },
    );
  });

  it("creates an HTTPS-only ALB entry point with DNS and WAF", () => {
    const result = template();

    result.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", {
      Scheme: "internet-facing",
      Type: "application",
    });
    result.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
      Port: 443,
      Protocol: "HTTPS",
    });
    result.hasResourceProperties("AWS::Route53::RecordSet", {
      Name: "bizflow.example.com.",
      Type: "A",
    });
    result.resourceCountIs("AWS::WAFv2::WebACL", 1);
    result.resourceCountIs("AWS::WAFv2::WebACLAssociation", 1);
  });
});
