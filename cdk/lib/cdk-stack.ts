import * as ec2 from "@aws-cdk/aws-ec2";
import * as lambda from "@aws-cdk/aws-lambda";
import * as rds from "@aws-cdk/aws-rds";
import * as cdk from "@aws-cdk/core";
import * as iam from "@aws-cdk/aws-iam";
import * as path from "path";
import * as apigw from "@aws-cdk/aws-apigatewayv2";
import * as apigwi from "@aws-cdk/aws-apigatewayv2-integrations";
import * as events from "@aws-cdk/aws-events";
import * as dynamodb from "@aws-cdk/aws-dynamodb";
import * as cloud9 from "@aws-cdk/aws-cloud9";
import * as secretsmanager from "@aws-cdk/aws-secretsmanager";
import * as sqs from "@aws-cdk/aws-sqs";

export class CdkStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC to host Aurora Cluster and Cloud9 instance
    const vpc = new ec2.Vpc(this, "VPC");

    // Custom EventBus for Webhooks
    const eventBus = new events.EventBus(this, "WebhookEventBus");

    // Lambda Function to relay event from Aurora to EventBridge
    const toEventBridge = new lambda.Function(this, "toEventBridgeFunction", {
      runtime: lambda.Runtime.NODEJS_12_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join("../functions", "toEventBridge")),
      environment: { EVENT_BUS: eventBus.eventBusName },
    });

    eventBus.grantPutEventsTo(toEventBridge);

    // IAM role to be assumed by Aurora to invoke Lambda Function
    const role = new iam.Role(this, "LambdaRole", {
      assumedBy: new iam.ServicePrincipal("rds.amazonaws.com"),
    });

    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction", "lambda:InvokeAsync"],
        resources: [toEventBridge.functionArn],
      })
    );

    // Aurora Cluster
    const subnetGroup = new rds.CfnDBSubnetGroup(this, "SubnetGroup", {
      dbSubnetGroupDescription: "widgetdbsubnetgroup",
      dbSubnetGroupName: "widgetdbsubnetgroup",
      subnetIds: vpc.privateSubnets.map((it) => it.subnetId),
    });

    const secret = new secretsmanager.Secret(this, "DbAdminPassword", {
      generateSecretString: {
        excludePunctuation: true,
      },
    });

    const cluster = new rds.CfnDBCluster(this, "WidgetDatabase", {
      engine: "aurora-postgresql",
      masterUsername: "dbadmin",
      masterUserPassword: secret.secretValue.toString(),
      dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
      associatedRoles: [{ featureName: "Lambda", roleArn: role.roleArn }],
      dbClusterIdentifier: "widgetcluster",
      port: 5432,
      storageEncrypted: true,
    });
    cluster.addDependsOn(subnetGroup);

    const dbInstance = new rds.CfnDBInstance(this, "WidgetInstance", {
      dbClusterIdentifier: cluster.dbClusterIdentifier,
      dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
      engine: "aurora-postgresql",
      dbInstanceClass: "db.t3.medium",
      publiclyAccessible: false,
    });
    dbInstance.addDependsOn(cluster);

    // Cloud9 Dev Environment to provide remote access to Aurora
    new cloud9.Ec2Environment(this, "Cloud9Env", {
      vpc,
    });

    const securityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      "defaultSecurityGroup",
      vpc.vpcDefaultSecurityGroup
    );

    securityGroup.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(5432),
      "Allow all traffic from VPC"
    );

    // Mock SaaS application (API Gateway -> Lambda -> DynamoDB)
    const widgetTable = new dynamodb.Table(this, "Table", {
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
    });

    const toDynamoDB = new lambda.Function(this, "toDynamoDBFunction", {
      runtime: lambda.Runtime.NODEJS_12_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join("../functions", "toDynamoDB")),
      environment: { TABLE_NAME: widgetTable.tableName },
    });

    widgetTable.grantReadWriteData(toDynamoDB);

    const ddbDefaultIntegration = new apigwi.LambdaProxyIntegration({
      handler: toDynamoDB,
    });

    const httpApi = new apigw.HttpApi(this, "DestinationWebhookApi");

    httpApi.addRoutes({
      path: "/post",
      methods: [apigw.HttpMethod.ANY],
      integration: ddbDefaultIntegration,
    });

    const apiKey = new secretsmanager.Secret(this, "TenantAApiKey", {
      generateSecretString: {
        excludePunctuation: true,
      },
    });

    //Event Bridge Connection & Rules
    const tenantAConnection = new events.CfnConnection(
      this,
      "TenantAConnection",
      {
        authorizationType: "API_KEY",
        authParameters: {
          ApiKeyAuthParameters: {
            ApiKeyName: "x-api-key",
            ApiKeyValue: apiKey.secretValue.toString(),
          },
        },
      }
    );

    const tenantADestination = new events.CfnApiDestination(
      this,
      "TenantADestination",
      {
        connectionArn: tenantAConnection.attrArn,
        httpMethod: apigw.HttpMethod.POST,
        invocationEndpoint: httpApi.apiEndpoint + "/post",
        invocationRateLimitPerSecond: 300,
      }
    );

    const eventBridgeRole = new iam.Role(this, "EBRole", {
      assumedBy: new iam.ServicePrincipal("events.amazonaws.com"),
    });

    eventBridgeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["events:InvokeApiDestination"],
        resources: [tenantADestination.attrArn],
      })
    );

    const deadLetterQueue = new sqs.Queue(this, "DeadLetterQueue");

    new events.CfnRule(this, "TenantARule", {
      eventBusName: eventBus.eventBusName,
      eventPattern: {
        detail: {
          tenantId: ["1"],
        },
      },
      targets: [
        {
          arn: tenantADestination.attrArn,
          id: "TenantA",
          roleArn: eventBridgeRole.roleArn,
          deadLetterConfig: { arn: deadLetterQueue.queueArn },
        },
      ],
    });
  }
}
