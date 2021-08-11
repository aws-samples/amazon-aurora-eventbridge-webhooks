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
            dbClusterIdentifier: "widgetscluster",
            port: 5432,
        });
        cluster.addDependsOn(subnetGroup);
        const dbInstance = new rds.CfnDBInstance(this, "WidgetInstance", {
            dbClusterIdentifier: cluster.dbClusterIdentifier,
            dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
            engine: "aurora-postgresql",
            dbInstanceClass: "db.t3.medium",
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2RrLXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiY2RrLXN0YWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUFBLHdDQUF3QztBQUN4Qyw4Q0FBOEM7QUFDOUMsd0NBQXdDO0FBQ3hDLHFDQUFxQztBQUNyQyx3Q0FBd0M7QUFDeEMsNkJBQTZCO0FBQzdCLG1EQUFtRDtBQUNuRCxpRUFBaUU7QUFDakUsOENBQThDO0FBQzlDLGtEQUFrRDtBQUNsRCw4Q0FBOEM7QUFDOUMsOERBQThEO0FBQzlELHdDQUF3QztBQUV4QyxNQUFhLFFBQVMsU0FBUSxHQUFHLENBQUMsS0FBSztJQUNyQyxZQUFZLEtBQW9CLEVBQUUsRUFBVSxFQUFFLEtBQXNCO1FBQ2xFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLGlEQUFpRDtRQUNqRCxNQUFNLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLENBQUMsSUFBSSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXJDLCtCQUErQjtRQUMvQixNQUFNLFFBQVEsR0FBRyxJQUFJLE1BQU0sQ0FBQyxRQUFRLENBQUMsSUFBSSxFQUFFLGlCQUFpQixDQUFDLENBQUM7UUFFOUQsNERBQTREO1FBQzVELE1BQU0sYUFBYSxHQUFHLElBQUksTUFBTSxDQUFDLFFBQVEsQ0FBQyxJQUFJLEVBQUUsdUJBQXVCLEVBQUU7WUFDdkUsT0FBTyxFQUFFLE1BQU0sQ0FBQyxPQUFPLENBQUMsV0FBVztZQUNuQyxPQUFPLEVBQUUsZUFBZTtZQUN4QixJQUFJLEVBQUUsTUFBTSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxjQUFjLEVBQUUsZUFBZSxDQUFDLENBQUM7WUFDdkUsV0FBVyxFQUFFLEVBQUUsU0FBUyxFQUFFLFFBQVEsQ0FBQyxZQUFZLEVBQUU7U0FDbEQsQ0FBQyxDQUFDO1FBRUgsUUFBUSxDQUFDLGdCQUFnQixDQUFDLGFBQWEs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L0IsRUFBRSxFQUFFLFNBQVM7b0JBQ2IsT0FBTyxFQUFFLGVBQWUsQ0FBQyxPQUFPO29CQUNoQyxnQkFBZ0IsRUFBRSxFQUFFLEdBQUcsRUFBRSxlQUFlLENBQUMsUUFBUSxFQUFFO2lCQUNwRDthQUNGO1NBQ0YsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztDQUNGO0FBektELDRCQXlLQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGVjMiBmcm9tIFwiQGF3cy1jZGsvYXdzLWVjMlwiO1xuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gXCJAYXdzLWNkay9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgKiBhcyByZHMgZnJvbSBcIkBhd3MtY2RrL2F3cy1yZHNcIjtcbmltcG9ydCAqIGFzIGNkayBmcm9tIFwiQGF3cy1jZGsvY29yZVwiO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gXCJAYXdzLWNkay9hd3MtaWFtXCI7XG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gXCJwYXRoXCI7XG5pbXBvcnQgKiBhcyBhcGlndyBmcm9tIFwiQGF3cy1jZGsvYXdzLWFwaWdhdGV3YXl2MlwiO1xuaW1wb3J0ICogYXMgYXBpZ3dpIGZyb20gXCJAYXdzLWNkay9hd3MtYXBpZ2F0ZXdheXYyLWludGVncmF0aW9uc1wiO1xuaW1wb3J0ICogYXMgZXZlbnRzIGZyb20gXCJAYXdzLWNkay9hd3MtZXZlbnRzXCI7XG5pbXBvcnQgKiBhcyBkeW5hbW9kYiBmcm9tIFwiQGF3cy1jZGsvYXdzLWR5bmFtb2RiXCI7XG5pbXBvcnQgKiBhcyBjbG91ZDkgZnJvbSBcIkBhd3MtY2RrL2F3cy1jbG91ZDlcIjtcbmltcG9ydCAqIGFzIHNlY3JldHNtYW5hZ2VyIGZyb20gXCJAYXdzLWNkay9hd3Mtc2VjcmV0c21hbmFnZXJcIjtcbmltcG9ydCAqIGFzIHNxcyBmcm9tIFwiQGF3cy1jZGsvYXdzLXNxc1wiO1xuXG5leHBvcnQgY2xhc3MgQ2RrU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBjb25zdHJ1Y3RvcihzY29wZTogY2RrLkNvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM/OiBjZGsuU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgLy8gVlBDIHRvIGhvc3QgQXVyb3JhIENsdXN0ZXIgYW5kIENsb3VkOSBpbnN0YW5jZVxuICAgIGNvbnN0IHZwYyA9IG5ldyBlYzIuVnBjKHRoaXMsIFwiVlBDXCIpO1xuXG4gICAgLy8gQ3VzdG9tIEV2ZW50QnVzIGZvciBXZWJob29rc1xuICAgIGNvbnN0IGV2ZW50QnVzID0gbmV3IGV2ZW50cy5FdmVudEJ1cyh0aGlzLCBcIldlYmhvb2tFdmVudEJ1c1wiKTtcblxuICAgIC8vIExhbWJkYSBGdW5jdGlvbiB0byByZWxheSBldmVudCBmcm9tIEF1cm9yYSB0byBFdmVudEJyaWRnZVxuICAgIGNvbnN0IHRvRXZlbnRCcmlkZ2UgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsIFwidG9FdmVudEJyaWRnZUZ1bmN0aW9uXCIsIHtcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18xMl9YLFxuICAgICAgaGFuZGxlcjogXCJpbmRleC5oYW5kbGVyXCIsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQocGF0aC5qb2luKFwiLi4vZnVuY3Rpb25zXCIsIFwidG9FdmVudEJyaWRnZVwiKSksXG4gICAgICBlbnZpcm9ubWVudDogeyBFVkVOVF9CVVM6IGV2ZW50QnVzLmV2ZW50QnVzTmFtZSB9LFxuICAgIH0pO1xuXG4gICAgZXZlbnRCdXMuZ3JhbnRQdXRFdmVudHNUbyh0b0V2ZW50QnJpZGdlKTtcblxuICAgIC8vIElBTSByb2xlIHRvIGJlIGFzc3VtZWQgYnkgQXVyb3JhIHRvIGludm9rZSBMYW1iZGEgRnVuY3Rpb25cbiAgICBjb25zdCByb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsIFwiTGFtYmRhUm9sZVwiLCB7XG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbChcInJkcy5hbWF6b25hd3MuY29tXCIpLFxuICAgIH0pO1xuXG4gICAgcm9sZS5hZGRUb1BvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgYWN0aW9uczogW1wibGFtYmRhOkludm9rZUZ1bmN0aW9uXCIsIFwibGFtYmRhOkludm9rZUFzeW5jXCJdLFxuICAgICAgICByZXNvdXJjZXM6IFt0b0V2ZW50QnJpZGdlLmZ1bmN0aW9uQXJuXSxcbiAgICAgIH0pXG4gICAgKTtcblxuICAgIC8vIEF1cm9yYSBDbHVzdGVyXG4gICAgY29uc3Qgc3VibmV0R3JvdXAgPSBuZXcgcmRzLkNmbkRCU3VibmV0R3JvdXAodGhpcywgXCJTdWJuZXRHcm91cFwiLCB7XG4gICAgICBkYlN1Ym5ldEdyb3VwRGVzY3JpcHRpb246IFwid2lkZ2V0ZGJzdWJuZXRncm91cFwiLFxuICAgICAgZGJTdWJuZXRHcm91cE5hbWU6IFwid2lkZ2V0ZGJzdWJuZXRncm91cFwiLFxuICAgICAgc3VibmV0SWRzOiB2cGMucHJpdmF0ZVN1Ym5ldHMubWFwKChpdCkgPT4gaXQuc3VibmV0SWQpLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgc2VjcmV0ID0gbmV3IHNlY3JldHNtYW5hZ2VyLlNlY3JldCh0aGlzLCBcIkRiQWRtaW5QYXNzd29yZFwiLCB7XG4gICAgICBnZW5lcmF0ZVNlY3JldFN0cmluZzoge1xuICAgICAgICBleGNsdWRlUHVuY3R1YXRpb246IHRydWUsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgY29uc3QgY2x1c3RlciA9IG5ldyByZHMuQ2ZuREJDbHVzdGVyKHRoaXMsIFwiV2lkZ2V0RGF0YWJhc2VcIiwge1xuICAgICAgZW5naW5lOiBcImF1cm9yYS1wb3N0Z3Jlc3FsXCIsXG4gICAgICBtYXN0ZXJVc2VybmFtZTogXCJkYmFkbWluXCIsXG4gICAgICBtYXN0ZXJVc2VyUGFzc3dvcmQ6IHNlY3JldC5zZWNyZXRWYWx1ZS50b1N0cmluZygpLFxuICAgICAgZGJTdWJuZXRHcm91cE5hbWU6IHN1Ym5ldEdyb3VwLmRiU3VibmV0R3JvdXBOYW1lLFxuICAgICAgYXNzb2NpYXRlZFJvbGVzOiBbeyBmZWF0dXJlTmFtZTogXCJMYW1iZGFcIiwgcm9sZUFybjogcm9sZS5yb2xlQXJuIH1dLFxuICAgICAgZGJDbHVzdGVySWRlbnRpZmllcjogXCJ3aWRnZXRzY2x1c3RlclwiLFxuICAgICAgcG9ydDogNTQzMixcbiAgICB9KTtcbiAgICBjbHVzdGVyLmFkZERlcGVuZHNPbihzdWJuZXRHcm91cCk7XG5cbiAgICBjb25zdCBkYkluc3RhbmNlID0gbmV3IHJkcy5DZm5EQkluc3RhbmNlKHRoaXMsIFwiV2lkZ2V0SW5zdGFuY2VcIiwge1xuICAgICAgZGJDbHVzdGVySWRlbnRpZmllcjogY2x1c3Rlci5kYkNsdXN0ZXJJZGVudGlmaWVyLFxuICAgICAgZGJTdWJuZXRHcm91cE5hbWU6IHN1Ym5ldEdyb3VwLmRiU3VibmV0R3JvdXBOYW1lLFxuICAgICAgZW5naW5lOiBcImF1cm9yYS1wb3N0Z3Jlc3FsXCIsXG4gICAgICBkYkluc3RhbmNlQ2xhc3M6IFwiZGIudDMubWVkaXVtXCIsXG4gICAgfSk7XG4gICAgZGJJbnN0YW5jZS5hZGREZXBlbmRzT24oY2x1c3Rlcik7XG5cbiAgICAvLyBDbG91ZDkgRGV2IEVudmlyb25tZW50IHRvIHByb3ZpZGUgcmVtb3RlIGFjY2VzcyB0byBBdXJvcmFcbiAgICBuZXcgY2xvdWQ5LkVjMkVudmlyb25tZW50KHRoaXMsIFwiQ2xvdWQ5RW52XCIsIHtcbiAgICAgIHZwYyxcbiAgICB9KTtcblxuICAgIGNvbnN0IHNlY3VyaXR5R3JvdXAgPSBlYzIuU2VjdXJpdHlHcm91cC5mcm9tU2VjdXJpdHlHcm91cElkKFxuICAgICAgdGhpcyxcbiAgICAgIFwiZGVmYXVsdFNlY3VyaXR5R3JvdXBcIixcbiAgICAgIHZwYy52cGNEZWZhdWx0U2VjdXJpdHlHcm91cFxuICAgICk7XG5cbiAgICBzZWN1cml0eUdyb3VwLmFkZEluZ3Jlc3NSdWxlKFxuICAgICAgZWMyLlBlZXIuaXB2NCh2cGMudnBjQ2lkckJsb2NrKSxcbiAgICAgIGVjMi5Qb3J0LnRjcCg1NDMyKSxcbiAgICAgIFwiQWxsb3cgYWxsIHRyYWZmaWMgZnJvbSBWUENcIlxuICAgICk7XG5cbiAgICAvLyBNb2NrIFNhYVMgYXBwbGljYXRpb24gKEFQSSBHYXRld2F5IC0+IExhbWJkYSAtPiBEeW5hbW9EQilcbiAgICBjb25zdCB3aWRnZXRUYWJsZSA9IG5ldyBkeW5hbW9kYi5UYWJsZSh0aGlzLCBcIlRhYmxlXCIsIHtcbiAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiBcImlkXCIsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgfSk7XG5cbiAgICBjb25zdCB0b0R5bmFtb0RCID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCBcInRvRHluYW1vREJGdW5jdGlvblwiLCB7XG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMTJfWCxcbiAgICAgIGhhbmRsZXI6IFwiaW5kZXguaGFuZGxlclwiLFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KHBhdGguam9pbihcIi4uL2Z1bmN0aW9uc1wiLCBcInRvRHluYW1vREJcIikpLFxuICAgICAgZW52aXJvbm1lbnQ6IHsgVEFCTEVfTkFNRTogd2lkZ2V0VGFibGUudGFibGVOYW1lIH0sXG4gICAgfSk7XG5cbiAgICB3aWRnZXRUYWJsZS5ncmFudFJlYWRXcml0ZURhdGEodG9EeW5hbW9EQik7XG5cbiAgICBjb25zdCBkZGJEZWZhdWx0SW50ZWdyYXRpb24gPSBuZXcgYXBpZ3dpLkxhbWJkYVByb3h5SW50ZWdyYXRpb24oe1xuICAgICAgaGFuZGxlcjogdG9EeW5hbW9EQixcbiAgICB9KTtcblxuICAgIGNvbnN0IGh0dHBBcGkgPSBuZXcgYXBpZ3cuSHR0cEFwaSh0aGlzLCBcIkRlc3RpbmF0aW9uV2ViaG9va0FwaVwiKTtcblxuICAgIGh0dHBBcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6IFwiL3Bvc3RcIixcbiAgICAgIG1ldGhvZHM6IFthcGlndy5IdHRwTWV0aG9kLkFOWV0sXG4gICAgICBpbnRlZ3JhdGlvbjogZGRiRGVmYXVsdEludGVncmF0aW9uLFxuICAgIH0pO1xuXG4gICAgY29uc3QgYXBpS2V5ID0gbmV3IHNlY3JldHNtYW5hZ2VyLlNlY3JldCh0aGlzLCBcIlRlbmFudEFBcGlLZXlcIiwge1xuICAgICAgZ2VuZXJhdGVTZWNyZXRTdHJpbmc6IHtcbiAgICAgICAgZXhjbHVkZVB1bmN0dWF0aW9uOiB0cnVlLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vRXZlbnQgQnJpZGdlIENvbm5lY3Rpb24gJiBSdWxlc1xuICAgIGNvbnN0IHRlbmFudEFDb25uZWN0aW9uID0gbmV3IGV2ZW50cy5DZm5Db25uZWN0aW9uKFxuICAgICAgdGhpcyxcbiAgICAgIFwiVGVuYW50QUNvbm5lY3Rpb25cIixcbiAgICAgIHtcbiAgICAgICAgYXV0aG9yaXphdGlvblR5cGU6IFwiQVBJX0tFWVwiLFxuICAgICAgICBhdXRoUGFyYW1ldGVyczoge1xuICAgICAgICAgIEFwaUtleUF1dGhQYXJhbWV0ZXJzOiB7XG4gICAgICAgICAgICBBcGlLZXlOYW1lOiBcIngtYXBpLWtleVwiLFxuICAgICAgICAgICAgQXBpS2V5VmFsdWU6IGFwaUtleS5zZWNyZXRWYWx1ZS50b1N0cmluZygpLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICB9XG4gICAgKTtcblxuICAgIGNvbnN0IHRlbmFudEFEZXN0aW5hdGlvbiA9IG5ldyBldmVudHMuQ2ZuQXBpRGVzdGluYXRpb24oXG4gICAgICB0aGlzLFxuICAgICAgXCJUZW5hbnRBRGVzdGluYXRpb25cIixcbiAgICAgIHtcbiAgICAgICAgY29ubmVjdGlvbkFybjogdGVuYW50QUNvbm5lY3Rpb24uYXR0ckFybixcbiAgICAgICAgaHR0cE1ldGhvZDogYXBpZ3cuSHR0cE1ldGhvZC5QT1NULFxuICAgICAgICBpbnZvY2F0aW9uRW5kcG9pbnQ6IGh0dHBBcGkuYXBpRW5kcG9pbnQgKyBcIi9wb3N0XCIsXG4gICAgICAgIGludm9jYXRpb25SYXRlTGltaXRQZXJTZWNvbmQ6IDMwMCxcbiAgICAgIH1cbiAgICApO1xuXG4gICAgY29uc3QgZXZlbnRCcmlkZ2VSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsIFwiRUJSb2xlXCIsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKFwiZXZlbnRzLmFtYXpvbmF3cy5jb21cIiksXG4gICAgfSk7XG5cbiAgICBldmVudEJyaWRnZVJvbGUuYWRkVG9Qb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIGFjdGlvbnM6IFtcImV2ZW50czpJbnZva2VBcGlEZXN0aW5hdGlvblwiXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbdGVuYW50QURlc3RpbmF0aW9uLmF0dHJBcm5dLFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgY29uc3QgZGVhZExldHRlclF1ZXVlID0gbmV3IHNxcy5RdWV1ZSh0aGlzLCBcIkRlYWRMZXR0ZXJRdWV1ZVwiKTtcblxuICAgIG5ldyBldmVudHMuQ2ZuUnVsZSh0aGlzLCBcIlRlbmFudEFSdWxlXCIsIHtcbiAgICAgIGV2ZW50QnVzTmFtZTogZXZlbnRCdXMuZXZlbnRCdXNOYW1lLFxuICAgICAgZXZlbnRQYXR0ZXJuOiB7XG4gICAgICAgIGRldGFpbDoge1xuICAgICAgICAgIHRlbmFudElkOiBbXCIxXCJdLFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICAgIHRhcmdldHM6IFtcbiAgICAgICAge1xuICAgICAgICAgIGFybjogdGVuYW50QURlc3RpbmF0aW9uLmF0dHJBcm4sXG4gICAgICAgICAgaWQ6IFwiVGVuYW50QVwiLFxuICAgICAgICAgIHJvbGVBcm46IGV2ZW50QnJpZGdlUm9sZS5yb2xlQXJuLFxuICAgICAgICAgIGRlYWRMZXR0ZXJDb25maWc6IHsgYXJuOiBkZWFkTGV0dGVyUXVldWUucXVldWVBcm4gfSxcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgfSk7XG4gIH1cbn1cbiJdfQ==