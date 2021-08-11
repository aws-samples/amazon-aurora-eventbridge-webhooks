var AWS = require("aws-sdk");
var dynamodb = new AWS.DynamoDB();

exports.handler = (event, context, callback) => {
  const tableName = process.env.TABLE_NAME;
  const id = Date.now().toString(36) + Math.random().toString(36).substring(2);
  let eventBody = event.body;

  if (event.isBase64Encoded) {
    const buff = Buffer.from(event.body, "base64");
    const eventBodyStr = buff.toString("UTF-8");
    eventBody = JSON.parse(eventBodyStr);
  }

  dynamodb.putItem(
    {
      TableName: tableName,
      Item: {
        id: { S: id },
        typename: { S: "Widget" },
        serializedWidget: { S: eventBody.toString() },
        createdAt: { S: new Date().toISOString() },
        updatedAt: { S: new Date().toISOString() },
      },
    },
    function (err, data) {
      if (err) {
        console.log("Error putting item into dynamodb failed: " + err);
        context.done("error");
      } else {
        return {
          statusCode: 200,
          body: "done",
        };
      }
    }
  );
};
