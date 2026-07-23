import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import { createHash } from "node:crypto";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import { Construct } from "constructs";

export interface BizFlowWebFoundationStackProps extends StackProps {
  readonly availabilityZones: string[];
  readonly certificateArn: string;
  readonly domainName: string;
  readonly environmentName: string;
  readonly hostedZoneId: string;
  readonly hostedZoneName: string;
}

export class BizFlowWebFoundationStack extends Stack {
  public constructor(
    scope: Construct,
    id: string,
    props: BizFlowWebFoundationStackProps,
  ) {
    super(scope, id, props);

    const repository = new ecr.Repository(this, "WebRepository", {
      repositoryName: `bizflow-web-${props.environmentName}`,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      encryption: ecr.RepositoryEncryption.AES_256,
      emptyOnDelete: false,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{ maxImageCount: 30 }],
    });

    const vpc = new ec2.Vpc(this, "WebVpc", {
      vpcName: `bizflow-web-${props.environmentName}`,
      availabilityZones: props.availabilityZones,
      natGateways: 1,
      restrictDefaultSecurityGroup: true,
      subnetConfiguration: [
        {
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: "application",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    const cluster = new ecs.Cluster(this, "WebCluster", {
      clusterName: `bizflow-web-${props.environmentName}`,
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
      enableFargateCapacityProviders: true,
    });

    const userPool = new cognito.UserPool(this, "WebUserPool", {
      userPoolName: `bizflow-web-${props.environmentName}`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      passwordPolicy: {
        minLength: 12,
        requireDigits: true,
        requireLowercase: true,
        requireSymbols: true,
        requireUppercase: true,
        tempPasswordValidity: Duration.days(3),
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const callbackUrl = `https://${props.domainName.toLowerCase()}/oauth2/idpresponse`;
    const logoutUrl = `https://${props.domainName.toLowerCase()}/`;
    const userPoolClient = userPool.addClient("WebUserPoolClient", {
      userPoolClientName: `bizflow-web-alb-${props.environmentName}`,
      generateSecret: true,
      preventUserExistenceErrors: true,
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        callbackUrls: [callbackUrl],
        logoutUrls: [logoutUrl],
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
      },
    });

    const userPoolDomain = userPool.addDomain("WebUserPoolDomain", {
      cognitoDomain: {
        domainPrefix: buildCognitoDomainPrefix(
          props.domainName,
          props.environmentName,
        ),
      },
    });

    new cognito.CfnUserPoolGroup(this, "UsersGroup", {
      groupName: "BizFlowUsers",
      description: "Authenticated BizFlow application users",
      userPoolId: userPool.userPoolId,
      precedence: 20,
    });
    new cognito.CfnUserPoolGroup(this, "ApproversGroup", {
      groupName: "BizFlowApprovers",
      description: "Users allowed to approve or reject business actions",
      userPoolId: userPool.userPoolId,
      precedence: 10,
    });

    const albSecurityGroup = new ec2.SecurityGroup(this, "WebAlbSecurityGroup", {
      vpc,
      description: "Public HTTPS ingress for BizFlow Web",
      allowAllOutbound: true,
    });
    albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS");
    albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "HTTP redirect");

    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, "WebLoadBalancer", {
      loadBalancerName: `bizflow-web-${props.environmentName}`,
      vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      deletionProtection: true,
      dropInvalidHeaderFields: true,
    });
    loadBalancer.setAttribute("routing.http.x_amzn_tls_version_and_cipher_suite.enabled", "true");

    const certificate = acm.Certificate.fromCertificateArn(
      this,
      "WebCertificate",
      props.certificateArn,
    );
    const httpsListener = loadBalancer.addListener("HttpsListener", {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [certificate],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      defaultAction: elbv2.ListenerAction.fixedResponse(503, {
        contentType: "application/json",
        messageBody: JSON.stringify({ status: "web-service-not-deployed" }),
      }),
    });
    loadBalancer.addListener("HttpListener", {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: "HTTPS",
        port: "443",
        permanent: true,
      }),
    });

    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(
      this,
      "WebHostedZone",
      {
        hostedZoneId: props.hostedZoneId,
        zoneName: props.hostedZoneName,
      },
    );
    new route53.ARecord(this, "WebAliasRecord", {
      zone: hostedZone,
      recordName: props.domainName,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.LoadBalancerTarget(loadBalancer),
      ),
    });

    const webAcl = new wafv2.CfnWebACL(this, "WebAcl", {
      name: `bizflow-web-${props.environmentName}`,
      scope: "REGIONAL",
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `bizflow-web-${props.environmentName}`,
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: "AWSManagedCommonRules",
          priority: 0,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesCommonRuleSet",
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "AWSManagedCommonRules",
            sampledRequestsEnabled: true,
          },
        },
        {
          name: "RateLimitPerIp",
          priority: 10,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              aggregateKeyType: "IP",
              limit: 1000,
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "RateLimitPerIp",
            sampledRequestsEnabled: true,
          },
        },
      ],
    });
    new wafv2.CfnWebACLAssociation(this, "WebAclAssociation", {
      resourceArn: loadBalancer.loadBalancerArn,
      webAclArn: webAcl.attrArn,
    });

    const privateSubnets = vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    });
    this.output("WebRepositoryName", repository.repositoryName);
    this.output("WebRepositoryArn", repository.repositoryArn);
    this.output("WebRepositoryUri", repository.repositoryUri);
    this.output("WebVpcId", vpc.vpcId);
    this.output("WebAvailabilityZones", vpc.availabilityZones.join(","));
    this.output("WebPrivateSubnetIds", privateSubnets.subnetIds.join(","));
    this.output(
      "WebPrivateSubnetRouteTableIds",
      privateSubnets.subnets
        .map((subnet) => subnet.routeTable.routeTableId)
        .join(","),
    );
    this.output("WebClusterName", cluster.clusterName);
    this.output("WebClusterArn", cluster.clusterArn);
    this.output("WebAlbArn", loadBalancer.loadBalancerArn);
    this.output("WebAlbDnsName", loadBalancer.loadBalancerDnsName);
    this.output("WebAlbSecurityGroupId", albSecurityGroup.securityGroupId);
    this.output("WebHttpsListenerArn", httpsListener.listenerArn);
    this.output("WebUserPoolId", userPool.userPoolId);
    this.output("WebUserPoolArn", userPool.userPoolArn);
    this.output("WebUserPoolClientId", userPoolClient.userPoolClientId);
    this.output("WebUserPoolDomainName", userPoolDomain.domainName);
    this.output("WebUrl", `https://${props.domainName.toLowerCase()}`);
  }

  private output(id: string, value: string): void {
    new CfnOutput(this, id, { value });
  }
}

function buildCognitoDomainPrefix(
  domainName: string,
  environmentName: string,
): string {
  const domainHash = createHash("sha256")
    .update(`${environmentName}\n${domainName.toLowerCase()}`, "utf8")
    .digest("hex")
    .slice(0, 12);
  return `bizflow-${environmentName}-${domainHash}`;
}
