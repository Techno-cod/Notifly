const amqp = require("amqplib");

let connection = null;
let channel = null;

const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://notifly:notifly123@localhost:5672";

const connect = async () => {
  try {
    connection = await amqp.connect(RABBITMQ_URL);
    channel = await connection.createChannel();

    // Declare the main queue — durable means it survives RabbitMQ restarts
    await channel.assertQueue("notifications", { durable: true });

    console.log("[RabbitMQ] Connected and queue ready");
    return channel;
  } catch (error) {
    console.error("[RabbitMQ] Connection failed:", error.message);
    // Retry after 5 seconds
    setTimeout(connect, 5000);
  }
};

const getChannel = () => channel;

module.exports = { connect, getChannel };