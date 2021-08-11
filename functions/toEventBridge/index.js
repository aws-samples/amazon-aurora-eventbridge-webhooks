const AWS = require("aws-sdk");
const eventbridge = new AWS.EventBridge();

exports.handler = async (event, context) => {
  const payload = {
    Entries: [
      {
        Source: "Aurora",
        EventBusName: process.env.EVENT_BUS,
        DetailType: "widget",
        Time: new Date(),
        Detail: JSON.stringify(event),
      },
    ],
  };

  await eventbridge.putEvents(payload).promise();
};
