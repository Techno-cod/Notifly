require("dotenv").config();
const amqp = require("amqplib");
const { Pool } = require("pg");
const Redis = require("ioredis");
const sgMail = require("@sendgrid/mail");
const { v4: uuidv4 } = require("uuid");

// ── Setup ──────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const redis = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: process.env.REDIS_PORT || 6379,
  retryStrategy: (times) => Math.min(times * 100, 2000),
});

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://notifly:notifly123@localhost:5672";
const QUEUE = "notifications";

// ── Idempotency check ──────────────────────────────────────────────
const isAlreadyProcessed = async (idempotencyKey) => {
  const result = await redis.get(`idempotency:${idempotencyKey}`);
  return result !== null;
};

const markAsProcessed = async (idempotencyKey) => {
  // Store for 24 hours
  await redis.set(`idempotency:${idempotencyKey}`, "done", "EX", 86400);
};

// ── Get user email from DB ─────────────────────────────────────────
const getUserEmail = async (userId) => {
  const result = await pool.query(
    "SELECT email, name FROM users WHERE id = $1",
    [userId]
  );
  return result.rows[0] || null;
};

// ── Save notification to DB ────────────────────────────────────────
const saveNotification = async ({ userId, eventType, channel, payload, idempotencyKey, status, error }) => {
  const result = await pool.query(
    `INSERT INTO notifications
       (user_id, event_type, channel, payload, status, idempotency_key, sent_at, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      userId,
      eventType,
      channel,
      JSON.stringify(payload),
      status,
      idempotencyKey,
      status === "sent" ? new Date() : null,
      error || null,
    ]
  );
  return result.rows[0].id;
};

// ── Deliver in-app via Redis Pub/Sub ──────────────────────────────
const deliverInApp = async (userId, eventType, payload, idempotencyKey) => {
  try {
    const message = JSON.stringify({
      type: eventType,
      payload,
      timestamp: new Date().toISOString(),
    });

    // Publish to Redis channel — gateway picks this up and sends via Socket.io
    await redis.publish(`user:${userId}`, message);

    await saveNotification({
      userId,
      eventType,
      channel: "in_app",
      payload,
      idempotencyKey: `${idempotencyKey}:in_app`,
      status: "sent",
    });

    console.log(`[Worker] ✓ In-app delivered to user ${userId}`);
  } catch (err) {
    console.error(`[Worker] ✗ In-app failed for user ${userId}:`, err.message);
    await saveNotification({
      userId,
      eventType,
      channel: "in_app",
      payload,
      idempotencyKey: `${idempotencyKey}:in_app`,
      status: "failed",
      error: err.message,
    });
  }
};

// ── Deliver email via SendGrid ─────────────────────────────────────
const deliverEmail = async (userId, eventType, payload, idempotencyKey) => {
  try {
    const user = await getUserEmail(userId);
    if (!user) {
      console.warn(`[Worker] User ${userId} not found — skipping email`);
      return;
    }

    const subject = formatEmailSubject(eventType, payload);
    const body = formatEmailBody(eventType, payload, user.name);

    await sgMail.send({
      to: user.email,
      from: process.env.SENDGRID_FROM_EMAIL,
      subject,
      html: body,
    });

    await saveNotification({
      userId,
      eventType,
      channel: "email",
      payload,
      idempotencyKey: `${idempotencyKey}:email`,
      status: "sent",
    });

    console.log(`[Worker] ✓ Email delivered to ${user.email}`);
  } catch (err) {
    console.error(`[Worker] ✗ Email failed for user ${userId}:`, err.message);
    await saveNotification({
      userId,
      eventType,
      channel: "email",
      payload,
      idempotencyKey: `${idempotencyKey}:email`,
      status: "failed",
      error: err.message,
    });
  }
};

// ── Email formatting ───────────────────────────────────────────────
const formatEmailSubject = (eventType, payload) => {
  const subjects = {
    "order.placed":   `Order Confirmed — #${payload.orderId}`,
    "order.shipped":  `Your Order Has Shipped — #${payload.orderId}`,
    "user.welcome":   `Welcome to Notifly!`,
    "password.reset": `Reset Your Password`,
  };
  return subjects[eventType] || `Notification: ${eventType}`;
};

const formatEmailBody = (eventType, payload, userName) => {
  return `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #1F2A44;">Hi ${userName},</h2>
      <p style="color: #555;">
        ${getEmailMessage(eventType, payload)}
      </p>
      <div style="background: #F8F7F3; border-radius: 12px; padding: 16px; margin: 24px 0;">
        <pre style="margin: 0; font-size: 13px; color: #333;">${JSON.stringify(payload, null, 2)}</pre>
      </div>
      <p style="color: #999; font-size: 12px;">
        This notification was sent by Notifly.
      </p>
    </div>
  `;
};

const getEmailMessage = (eventType, payload) => {
  const messages = {
    "order.placed":   `Your order #${payload.orderId} has been placed successfully. Total: ₹${payload.amount}.`,
    "order.shipped":  `Great news! Your order #${payload.orderId} is on its way.`,
    "user.welcome":   `Welcome aboard! Your account has been created successfully.`,
    "password.reset": `A password reset was requested for your account.`,
  };
  return messages[eventType] || `You have a new notification: ${eventType}`;
};

// ── Process a single message ───────────────────────────────────────
const processMessage = async (msg, channel) => {
  let parsed;
  try {
    parsed = JSON.parse(msg.content.toString());
  } catch (err) {
    console.error("[Worker] Failed to parse message:", err.message);
    channel.nack(msg, false, false); // discard malformed message
    return;
  }

  const { type, userId, data, idempotencyKey } = parsed;
  console.log(`[Worker] Processing: ${type} for user ${userId}`);

  // ── Idempotency check ──────────────────────────────────────────
  if (await isAlreadyProcessed(idempotencyKey)) {
    console.log(`[Worker] Duplicate detected — skipping ${idempotencyKey}`);
    channel.ack(msg);
    return;
  }

  // ── Deliver to both channels ───────────────────────────────────
  await Promise.all([
    deliverInApp(userId, type, data, idempotencyKey),
    deliverEmail(userId, type, data, idempotencyKey),
  ]);

  // ── Mark as processed ──────────────────────────────────────────
  await markAsProcessed(idempotencyKey);

  // ── Acknowledge message ────────────────────────────────────────
  channel.ack(msg);
  console.log(`[Worker] ✓ Done: ${type} for user ${userId}`);
};

// ── Main ───────────────────────────────────────────────────────────
const start = async () => {
  try {
    console.log("[Worker] Starting...");

    const connection = await amqp.connect(RABBITMQ_URL);
    const channel = await connection.createChannel();

    await channel.assertQueue(QUEUE, { durable: true });

    // Process one message at a time
    channel.prefetch(1);

    console.log("[Worker] Waiting for messages...");

    channel.consume(QUEUE, (msg) => {
      if (msg !== null) {
        processMessage(msg, channel);
      }
    });

    // Graceful shutdown
    process.on("SIGINT", async () => {
      console.log("[Worker] Shutting down...");
      await channel.close();
      await connection.close();
      process.exit(0);
    });

  } catch (err) {
    console.error("[Worker] Failed to start:", err.message);
    setTimeout(start, 5000); // retry after 5s
  }
};

start();