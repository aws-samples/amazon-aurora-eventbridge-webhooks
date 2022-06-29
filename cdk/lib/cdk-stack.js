"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CdkStack = void 0;
const ec2 = require("@aws-cdk/aws-ec2");
const lambda = require("@aws-cdk/aws-lambda");
const rds = require("@aws-cdk/aws-rds");
const cdk = require("@aws-cdk/core");
const iam = require("@aws-cdk/aws-iam");
const path = require("path");
const apigw = require("@aws-cdk/aws-apigatewayv2");
const apigwi = require("@aws-cdk/aws-apigatewayv2-integrations");
const events = require("@aws-cdk/aws-events");
const dynamodb = require("@aws-cdk/aws-dynamodb");
const cloud9 = require("@aws-cdk/aws-cloud9");
const secretsmanager = require("@aws-cdk/aws-secretsmanager");
const sqs = require("@aws-cdk/aws-sqs");
class CdkStack extends cdk.Stack {
    constructor(scope, id, props) {
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
        role.addToPolicy(new iam.PolicyStatement({
            actions: ["lambda:InvokeFunction", "lambda:InvokeAsync"],
            resources: [toEventBridge.functionArn],
        }));
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
        const securityGroup = ec2.SecurityGroup.fromSecurityGroupId(this, "defaultSecurityGroup", vpc.vpcDefaultSecurityGroup);
        securityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(5432), "Allow all traffic from VPC");
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
        const tenantAConnection = new events.CfnConnection(this, "TenantAConnection", {
            authorizationType: "API_KEY",
            authParameters: {
                ApiKeyAuthParameters: {
                    ApiKeyName: "x-api-key",
                    ApiKeyValue: apiKey.secretValue.toString(),
                },
            },
        });
        const tenantADestination = new events.CfnApiDestination(this, "TenantADestination", {
            connectionArn: tenantAConnection.attrArn,
            httpMethod: apigw.HttpMethod.POST,
            invocationEndpoint: httpApi.apiEndpoint + "/post",
            invocationRateLimitPerSecond: 300,
        });
        const eventBridgeRole = new iam.Role(this, "EBRole", {
            assumedBy: new iam.ServicePrincipal("events.amazonaws.com"),
        });
        eventBridgeRole.addToPolicy(new iam.PolicyStatement({
            actions: ["events:InvokeApiDestination"],
            resources: [tenantADestination.attrArn],
        }));
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
exports.CdkStack = CdkStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2RrLXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiY2RrLXN0YWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUFBLHdDQUF3QztBQUN4Qyw4Q0FBOEM7QUFDOUMsd0NBQXdDO0FBQ3hDLHFDQUFxQztBQUNyQyx3Q0FBd0M7QUFDeEMsNkJBQTZCO0FBQzdCLG1EQUFtRDtBQUNuRCxpRUFBaUU7QUFDakUsOENBQThDO0FBQzlDLGtEQUFrRDtBQUNsRCw4Q0FBOEM7QUFDOUMsOERBQThEO0FBQzlELHdDQUF3QztBQUV4QyxNQUFhLFFBQVMsU0FBUSxHQUFHLENBQUMsS0FBSztJQUNyQyxZQUFZLEtBQW9CLEVBQUUsRUFBVSxFQUFFLEtBQXNCO1FBQ2xFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLGlEQUFpRDtRQUNqRCxNQUFNLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLENBQUMsSUFBSSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXJDLCtCQUErQjtRQUMvQixNQUFNLFFBQVEsR0FBRyxJQUFJLE1BQU0sQ0FBQyxRQUFRLENBQUMsSUFBSSxFQUFFLGlCQUFpQixDQUFDLENBQUM7UUFFOUQsNERBQTREO1FBQzVELE1BQU0sYUFBYSxHQUFHLElBQUksTUFBTSxDQUFDLFFBQVEsQ0FBQyxJQUFJLEVBQUUsdUJBQXVCLEVBQUU7WUFDdkUsT0FBTyxFQUFFLE1BQU0sQ0FBQyxPQUFPLENBQUMsV0FBVztZQUNuQyxPQUFPLEVBQUUsZUFBZTtZQUN4QixJQUFJLEVBQUUsTUFBTSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxjQUFjLEVBQUUsZUFBZSxDQUFDLENBQUM7WUFDdkUsV0FBVyxFQUFFLEVBQUUsU0FBUyxFQUFFLFFBQVEsQ0FBQyxZQUFZLEVBQUU7U0FDbEQsQ0FBQyxDQUFDO1FBRUgsUUFBUSxDQUFDLGdCQUFnQixDQUFDLGFBQWEs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O2dCQUNQO29CQUNFLEdBQUcsRUFBRSxrQkFBa0IsQ0FBQyxPQUFPO29CQUMvQixFQUFFLEVBQUUsU0FBUztvQkFDYixPQUFPLEVBQUUsZUFBZSxDQUFDLE9BQU87b0JBQ2hDLGdCQUFnQixFQUFFLEVBQUUsR0FBRyxFQUFFLGVBQWUsQ0FBQyxRQUFRLEVBQUU7aUJBQ3BEO2FBQ0Y7U0FDRixDQUFDLENBQUM7SUFDTCxDQUFDO0NBQ0Y7QUEzS0QsNEJBMktDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgZWMyIGZyb20gXCJAYXdzLWNkay9hd3MtZWMyXCI7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSBcIkBhd3MtY2RrL2F3cy1sYW1iZGFcIjtcbmltcG9ydCAqIGFzIHJkcyBmcm9tIFwiQGF3cy1jZGsvYXdzLXJkc1wiO1xuaW1wb3J0ICogYXMgY2RrIGZyb20gXCJAYXdzLWNkay9jb3JlXCI7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSBcIkBhd3MtY2RrL2F3cy1pYW1cIjtcbmltcG9ydCAqIGFzIHBhdGggZnJvbSBcInBhdGhcIjtcbmltcG9ydCAqIGFzIGFwaWd3IGZyb20gXCJAYXdzLWNkay9hd3MtYXBpZ2F0ZXdheXYyXCI7XG5pbXBvcnQgKiBhcyBhcGlnd2kgZnJvbSBcIkBhd3MtY2RrL2F3cy1hcGlnYXRld2F5djItaW50ZWdyYXRpb25zXCI7XG5pbXBvcnQgKiBhcyBldmVudHMgZnJvbSBcIkBhd3MtY2RrL2F3cy1ldmVudHNcIjtcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gXCJAYXdzLWNkay9hd3MtZHluYW1vZGJcIjtcbmltcG9ydCAqIGFzIGNsb3VkOSBmcm9tIFwiQGF3cy1jZGsvYXdzLWNsb3VkOVwiO1xuaW1wb3J0ICogYXMgc2VjcmV0c21hbmFnZXIgZnJvbSBcIkBhd3MtY2RrL2F3cy1zZWNyZXRzbWFuYWdlclwiO1xuaW1wb3J0ICogYXMgc3FzIGZyb20gXCJAYXdzLWNkay9hd3Mtc3FzXCI7XG5cbmV4cG9ydCBjbGFzcyBDZGtTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBjZGsuQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wcz86IGNkay5TdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICAvLyBWUEMgdG8gaG9zdCBBdXJvcmEgQ2x1c3RlciBhbmQgQ2xvdWQ5IGluc3RhbmNlXG4gICAgY29uc3QgdnBjID0gbmV3IGVjMi5WcGModGhpcywgXCJWUENcIik7XG5cbiAgICAvLyBDdXN0b20gRXZlbnRCdXMgZm9yIFdlYmhvb2tzXG4gICAgY29uc3QgZXZlbnRCdXMgPSBuZXcgZXZlbnRzLkV2ZW50QnVzKHRoaXMsIFwiV2ViaG9va0V2ZW50QnVzXCIpO1xuXG4gICAgLy8gTGFtYmRhIEZ1bmN0aW9uIHRvIHJlbGF5IGV2ZW50IGZyb20gQXVyb3JhIHRvIEV2ZW50QnJpZGdlXG4gICAgY29uc3QgdG9FdmVudEJyaWRnZSA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgXCJ0b0V2ZW50QnJpZGdlRnVuY3Rpb25cIiwge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzEyX1gsXG4gICAgICBoYW5kbGVyOiBcImluZGV4LmhhbmRsZXJcIixcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldChwYXRoLmpvaW4oXCIuLi9mdW5jdGlvbnNcIiwgXCJ0b0V2ZW50QnJpZGdlXCIpKSxcbiAgICAgIGVudmlyb25tZW50OiB7IEVWRU5UX0JVUzogZXZlbnRCdXMuZXZlbnRCdXNOYW1lIH0sXG4gICAgfSk7XG5cbiAgICBldmVudEJ1cy5ncmFudFB1dEV2ZW50c1RvKHRvRXZlbnRCcmlkZ2UpO1xuXG4gICAgLy8gSUFNIHJvbGUgdG8gYmUgYXNzdW1lZCBieSBBdXJvcmEgdG8gaW52b2tlIExhbWJkYSBGdW5jdGlvblxuICAgIGNvbnN0IHJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgXCJMYW1iZGFSb2xlXCIsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKFwicmRzLmFtYXpvbmF3cy5jb21cIiksXG4gICAgfSk7XG5cbiAgICByb2xlLmFkZFRvUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBhY3Rpb25zOiBbXCJsYW1iZGE6SW52b2tlRnVuY3Rpb25cIiwgXCJsYW1iZGE6SW52b2tlQXN5bmNcIl0sXG4gICAgICAgIHJlc291cmNlczogW3RvRXZlbnRCcmlkZ2UuZnVuY3Rpb25Bcm5dLFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgLy8gQXVyb3JhIENsdXN0ZXJcbiAgICBjb25zdCBzdWJuZXRHcm91cCA9IG5ldyByZHMuQ2ZuREJTdWJuZXRHcm91cCh0aGlzLCBcIlN1Ym5ldEdyb3VwXCIsIHtcbiAgICAgIGRiU3VibmV0R3JvdXBEZXNjcmlwdGlvbjogXCJ3aWRnZXRkYnN1Ym5ldGdyb3VwXCIsXG4gICAgICBkYlN1Ym5ldEdyb3VwTmFtZTogXCJ3aWRnZXRkYnN1Ym5ldGdyb3VwXCIsXG4gICAgICBzdWJuZXRJZHM6IHZwYy5wcml2YXRlU3VibmV0cy5tYXAoKGl0KSA9PiBpdC5zdWJuZXRJZCksXG4gICAgfSk7XG5cbiAgICBjb25zdCBzZWNyZXQgPSBuZXcgc2VjcmV0c21hbmFnZXIuU2VjcmV0KHRoaXMsIFwiRGJBZG1pblBhc3N3b3JkXCIsIHtcbiAgICAgIGdlbmVyYXRlU2VjcmV0U3RyaW5nOiB7XG4gICAgICAgIGV4Y2x1ZGVQdW5jdHVhdGlvbjogdHJ1ZSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBjb25zdCBjbHVzdGVyID0gbmV3IHJkcy5DZm5EQkNsdXN0ZXIodGhpcywgXCJXaWRnZXREYXRhYmFzZVwiLCB7XG4gICAgICBlbmdpbmU6IFwiYXVyb3JhLXBvc3RncmVzcWxcIixcbiAgICAgIG1hc3RlclVzZXJuYW1lOiBcImRiYWRtaW5cIixcbiAgICAgIG1hc3RlclVzZXJQYXNzd29yZDogc2VjcmV0LnNlY3JldFZhbHVlLnRvU3RyaW5nKCksXG4gICAgICBkYlN1Ym5ldEdyb3VwTmFtZTogc3VibmV0R3JvdXAuZGJTdWJuZXRHcm91cE5hbWUsXG4gICAgICBhc3NvY2lhdGVkUm9sZXM6IFt7IGZlYXR1cmVOYW1lOiBcIkxhbWJkYVwiLCByb2xlQXJuOiByb2xlLnJvbGVBcm4gfV0sXG4gICAgICBkYkNsdXN0ZXJJZGVudGlmaWVyOiBcIndpZGdldGNsdXN0ZXJcIixcbiAgICAgIHBvcnQ6IDU0MzIsXG4gICAgICBzdG9yYWdlRW5jcnlwdGVkOiB0cnVlLFxuICAgIH0pO1xuICAgIGNsdXN0ZXIuYWRkRGVwZW5kc09uKHN1Ym5ldEdyb3VwKTtcblxuICAgIGNvbnN0IGRiSW5zdGFuY2UgPSBuZXcgcmRzLkNmbkRCSW5zdGFuY2UodGhpcywgXCJXaWRnZXRJbnN0YW5jZVwiLCB7XG4gICAgICBkYkNsdXN0ZXJJZGVudGlmaWVyOiBjbHVzdGVyLmRiQ2x1c3RlcklkZW50aWZpZXIsXG4gICAgICBkYlN1Ym5ldEdyb3VwTmFtZTogc3VibmV0R3JvdXAuZGJTdWJuZXRHcm91cE5hbWUsXG4gICAgICBlbmdpbmU6IFwiYXVyb3JhLXBvc3RncmVzcWxcIixcbiAgICAgIGRiSW5zdGFuY2VDbGFzczogXCJkYi50My5tZWRpdW1cIixcbiAgICAgIHB1YmxpY2x5QWNjZXNzaWJsZTogZmFsc2UsXG4gICAgfSk7XG4gICAgZGJJbnN0YW5jZS5hZGREZXBlbmRzT24oY2x1c3Rlcik7XG5cbiAgICAvLyBDbG91ZDkgRGV2IEVudmlyb25tZW50IHRvIHByb3ZpZGUgcmVtb3RlIGFjY2VzcyB0byBBdXJvcmFcbiAgICBuZXcgY2xvdWQ5LkVjMkVudmlyb25tZW50KHRoaXMsIFwiQ2xvdWQ5RW52XCIsIHtcbiAgICAgIHZwYyxcbiAgICB9KTtcblxuICAgIGNvbnN0IHNlY3VyaXR5R3JvdXAgPSBlYzIuU2VjdXJpdHlHcm91cC5mcm9tU2VjdXJpdHlHcm91cElkKFxuICAgICAgdGhpcyxcbiAgICAgIFwiZGVmYXVsdFNlY3VyaXR5R3JvdXBcIixcbiAgICAgIHZwYy52cGNEZWZhdWx0U2VjdXJpdHlHcm91cFxuICAgICk7XG5cbiAgICBzZWN1cml0eUdyb3VwLmFkZEluZ3Jlc3NSdWxlKFxuICAgICAgZWMyLlBlZXIuaXB2NCh2cGMudnBjQ2lkckJsb2NrKSxcbiAgICAgIGVjMi5Qb3J0LnRjcCg1NDMyKSxcbiAgICAgIFwiQWxsb3cgYWxsIHRyYWZmaWMgZnJvbSBWUENcIlxuICAgICk7XG5cbiAgICAvLyBNb2NrIFNhYVMgYXBwbGljYXRpb24gKEFQSSBHYXRld2F5IC0+IExhbWJkYSAtPiBEeW5hbW9EQilcbiAgICBjb25zdCB3aWRnZXRUYWJsZSA9IG5ldyBkeW5hbW9kYi5UYWJsZSh0aGlzLCBcIlRhYmxlXCIsIHtcbiAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiBcImlkXCIsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgfSk7XG5cbiAgICBjb25zdCB0b0R5bmFtb0RCID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCBcInRvRHluYW1vREJGdW5jdGlvblwiLCB7XG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMTJfWCxcbiAgICAgIGhhbmRsZXI6IFwiaW5kZXguaGFuZGxlclwiLFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KHBhdGguam9pbihcIi4uL2Z1bmN0aW9uc1wiLCBcInRvRHluYW1vREJcIikpLFxuICAgICAgZW52aXJvbm1lbnQ6IHsgVEFCTEVfTkFNRTogd2lkZ2V0VGFibGUudGFibGVOYW1lIH0sXG4gICAgfSk7XG5cbiAgICB3aWRnZXRUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEodG9EeW5hbW9EQik7XG5cbiAgICBjb25zdCBkZGJEZWZhdWx0SW50ZWdyYXRpb24gPSBuZXcgYXBpZ3dpLkxhbWJkYVByb3h5SW50ZWdyYXRpb24oe1xuICAgICAgaGFuZGxlcjogdG9EeW5hbW9EQixcbiAgICB9KTtcblxuICAgIGNvbnN0IGh0dHBBcGkgPSBuZXcgYXBpZ3cuSHR0cEFwaSh0aGlzLCBcIkRlc3RpbmF0aW9uV2ViaG9va0FwaVwiKTtcblxuICAgIGh0dHBBcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6IFwiL3Bvc3RcIixcbiAgICAgIG1ldGhvZHM6IFthcGlndy5IdHRwTWV0aG9kLkFOWV0sXG4gICAgICBpbnRlZ3JhdGlvbjogZGRiRGVmYXVsdEludGVncmF0aW9uLFxuICAgIH0pO1xuXG4gICAgY29uc3QgYXBpS2V5ID0gbmV3IHNlY3JldHNtYW5hZ2VyLlNlY3JldCh0aGlzLCBcIlRlbmFudEFBcGlLZXlcIiwge1xuICAgICAgZ2VuZXJhdGVTZWNyZXRTdHJpbmc6IHtcbiAgICAgICAgZXhjbHVkZVB1bmN0dWF0aW9uOiB0cnVlLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vRXZlbnQgQnJpZGdlIENvbm5lY3Rpb24gJiBSdWxlc1xuICAgIGNvbnN0IHRlbmFudEFDb25uZWN0aW9uID0gbmV3IGV2ZW50cy5DZm5Db25uZWN0aW9uKFxuICAgICAgdGhpcyxcbiAgICAgIFwiVGVuYW50QUNvbm5lY3Rpb25cIixcbiAgICAgIHtcbiAgICAgICAgYXV0aG9yaXphdGlvblR5cGU6IFwiQVBJX0tFWVwiLFxuICAgICAgICBhdXRoUGFyYW1ldGVyczoge1xuICAgICAgICAgIEFwaUtleUF1dGhQYXJhbWV0ZXJzOiB7XG4gICAgICAgICAgICBBcGlLZXlOYW1lOiBcIngtYXBpLWtleVwiLFxuICAgICAgICAgICAgQXBpS2V5VmFsdWU6IGFwaUtleS5zZWNyZXRWYWx1ZS50b1N0cmluZygpLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICB9XG4gICAgKTtcblxuICAgIGNvbnN0IHRlbmFudEFEZXN0aW5hdGlvbiA9IG5ldyBldmVudHMuQ2ZuQXBpRGVzdGluYXRpb24oXG4gICAgICB0aGlzLFxuICAgICAgXCJUZW5hbnRBRGVzdGluYXRpb25cIixcbiAgICAgIHtcbiAgICAgICAgY29ubmVjdGlvbkFybjogdGVuYW50QUNvbm5lY3Rpb24uYXR0ckFybixcbiAgICAgICAgaHR0cE1ldGhvZDogYXBpZ3cuSHR0cE1ldGhvZC5QT1NULFxuICAgICAgICBpbnZvY2F0aW9uRW5kcG9pbnQ6IGh0dHBBcGkuYXBpRW5kcG9pbnQgKyBcIi9wb3N0XCIsXG4gICAgICAgIGludm9jYXRpb25SYXRlTGltaXRQZXJTZWNvbmQ6IDMwMCxcbiAgICAgIH1cbiAgICApO1xuXG4gICAgY29uc3QgZXZlbnRCcmlkZ2VSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsIFwiRUJSb2xlXCIsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKFwiZXZlbnRzLmFtYXpvbmF3cy5jb21cIiksXG4gICAgfSk7XG5cbiAgICBldmVudEJyaWRnZVJvbGUuYWRkVG9Qb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGFjdGlvbnM6IFtcImV2ZW50czpJbnZva2VBcGlEZXN0aW5hdGlvblwiXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbdGVuYW50QURlc3RpbmF0aW9uLmF0dHJBcm5dLFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgY29uc3QgZGVhZExldHRlclF1ZXVlID0gbmV3IHNxcy5RdWV1ZSh0aGlzLCBcIkRlYWRMZXR0ZXJRdWV1ZVwiKTtcblxuICAgIG5ldyBldmVudHMuQ2ZuUnVsZSh0aGlzLCBcIlRlbmFudEFSdWxlXCIsIHtcbiAgICAgIGV2ZW50QnVzTmFtZTogZXZlbnRCdXMuZXZlbnRCdXNOYW1lLFxuICAgICAgZXZlbnRQYXR0ZXJuOiB7XG4gICAgICAgIGRldGFpbDoge1xuICAgICAgICAgIHRlbmFudElkOiBbXCIxXCJdLFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICAgIHRhcmdldHM6IFtcbiAgICAgICAge1xuICAgICAgICAgIGFybjogdGVuYW50QURlc3RpbmF0aW9uLmF0dHJBcm4sXG4gICAgICAgICAgaWQ6IFwiVGVuYW50QVwiLFxuICAgICAgICAgIHJvbGVBcm46IGV2ZW50QnJpZGdlUm9sZS5yb2xlQXJuLFxuICAgICAgICAgIGRlYWRMZXR0ZXJDb25maWc6IHsgYXJuOiBkZWFkTGV0dGVyUXVldWUucXVldWVBcm4gfSxcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgfSk7XG4gIH1cbn1cbiJdfQ==