require("dotenv").config();
const amqp = require("amqplib");
const { Pool } = require("pg");
const Redis = require("ioredis");
const sgMail = require("@sendgrid/mail");

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
const MAX_ATTEMPTS = 3;

// Digest window — how long a batch stays "open" before flushing.
// 20s here so you can actually demo it. In production this maps to
// batch_frequency: hourly = 3600000, daily = 86400000.
const DIGEST_WINDOW_MS = 20 * 1000;

// ── Idempotency ────────────────────────────────────────────────────
const isAlreadyProcessed = async (idempotencyKey) => {
  const result = await redis.get(`idempotency:${idempotencyKey}`);
  return result !== null;
};

const markAsProcessed = async (idempotencyKey) => {
  await redis.set(`idempotency:${idempotencyKey}`, "done", "EX", 86400);
};

// ── User + preferences lookup ─────────────────────────────────────
const getUser = async (userId) => {
  const result = await pool.query("SELECT email, name FROM users WHERE id = $1", [userId]);
  return result.rows[0] || null;
};

const getPreference = async (userId, eventType, channel) => {
  const result = await pool.query(
    `SELECT enabled, batch FROM notification_preferences
     WHERE user_id = $1 AND event_type = $2 AND channel = $3`,
    [userId, eventType, channel]
  );
  // No row = defaults: enabled, not batched
  if (result.rows.length === 0) return { enabled: true, batch: false };
  return result.rows[0];
};

// ── Save notification status to DB ─────────────────────────────────
const saveNotification = async ({ userId, eventType, channel, payload, idempotencyKey, status, error }) => {
  await pool.query(
    `INSERT INTO notifications
       (user_id, event_type, channel, payload, status, idempotency_key, sent_at, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      userId, eventType, channel, JSON.stringify(payload), status,
      idempotencyKey, status === "sent" ? new Date() : null, error || null,
    ]
  );
};

// ── Dead letter ──────────────────────────────────────────────────
const sendToDeadLetter = async ({ eventType, userId, payload, idempotencyKey, channel, attempts, lastError }) => {
  await pool.query(
    `INSERT INTO dead_letters
       (event_type, user_id, payload, idempotency_key, channel, attempts, last_error)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [eventType, userId, JSON.stringify(payload), idempotencyKey, channel, attempts, lastError]
  );
  console.error(`[Worker] ☠ Dead-lettered ${channel} for user ${userId} after ${attempts} attempts`);
};

// ── Immediate delivery ─────────────────────────────────────────────
const deliverInApp = async (userId, eventType, payload) => {
  const message = JSON.stringify({ type: eventType, payload, timestamp: new Date().toISOString() });
  await redis.publish(`user:${userId}`, message);
};

const deliverEmail = async (userId, eventType, payload) => {
  const user = await getUser(userId);
  if (!user) throw new Error(`User ${userId} not found`);
  await sgMail.send({
    to: user.email,
    from: process.env.SENDGRID_FROM_EMAIL,
    subject: formatEmailSubject(eventType, payload),
    html: formatEmailBody(eventType, payload, user.name),
  });
};

const formatEmailSubject = (eventType, payload) => {
  const subjects = {
    "order.placed":   `Order Confirmed — #${payload.orderId}`,
    "order.shipped":  `Your Order Has Shipped — #${payload.orderId}`,
    "user.welcome":   `Welcome to Notifly!`,
    "password.reset": `Reset Your Password`,
  };
  return subjects[eventType] || `Notification: ${eventType}`;
};

const formatEmailBody = (eventType, payload, userName) => `
  <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
    <h2 style="color: #1F2A44;">Hi ${userName},</h2>
    <p style="color: #555;">${getEmailMessage(eventType, payload)}</p>
    <div style="background: #F8F7F3; border-radius: 12px; padding: 16px; margin: 24px 0;">
      <pre style="margin: 0; font-size: 13px; color: #333;">${JSON.stringify(payload, null, 2)}</pre>
    </div>
    <p style="color: #999; font-size: 12px;">This notification was sent by Notifly.</p>
  </div>
`;

const getEmailMessage = (eventType, payload) => {
  const messages = {
    "order.placed":   `Your order #${payload.orderId} has been placed successfully. Total: ₹${payload.amount}.`,
    "order.shipped":  `Great news! Your order #${payload.orderId} is on its way.`,
    "user.welcome":   `Welcome aboard! Your account has been created successfully.`,
    "password.reset": `A password reset was requested for your account.`,
  };
  return messages[eventType] || `You have a new notification: ${eventType}`;
};

// ── Digest batching ──────────────────────────────────────────────
const pushToDigest = async (userId, eventType, channel, payload) => {
  const listKey = `digest:list:${userId}:${eventType}:${channel}`;
  const metaKey = `digest:meta:${userId}:${eventType}:${channel}`;

  await redis.rpush(listKey, JSON.stringify(payload));
  // NX = only set if not already set, so the window starts on the FIRST event
  await redis.set(metaKey, Date.now(), "NX");
};

const formatDigestSummary = (eventType, count) => {
  const labels = {
    "order.placed":  "new orders placed",
    "order.shipped": "orders shipped",
    "user.welcome":  "welcome events",
  };
  const label = labels[eventType] || eventType;
  return count === 1 ? `1 ${label}` : `${count} ${label}`;
};

const deliverDigest = async (userId, eventType, channel, payloads) => {
  const count = payloads.length;
  const summary = formatDigestSummary(eventType, count);

  if (channel === "in_app") {
    const message = JSON.stringify({
      type: eventType,
      digest: true,
      count,
      payload: { summary, items: payloads },
      timestamp: new Date().toISOString(),
    });
    await redis.publish(`user:${userId}`, message);
  } else if (channel === "email") {
    const user = await getUser(userId);
    if (!user) return;
    await sgMail.send({
      to: user.email,
      from: process.env.SENDGRID_FROM_EMAIL,
      subject: `You have ${summary}`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
          <h2 style="color: #1F2A44;">Hi ${user.name},</h2>
          <p style="color: #555;">You have ${summary} in the last few minutes:</p>
          <ul style="color: #333;">
            ${payloads.map((p) => `<li>${JSON.stringify(p)}</li>`).join("")}
          </ul>
          <p style="color: #999; font-size: 12px;">This is a batched digest from Notifly.</p>
        </div>
      `,
    });
  }

  await saveNotification({
    userId, eventType, channel,
    payload: { digest: true, count, items: payloads },
    idempotencyKey: `digest:${userId}:${eventType}:${channel}:${Date.now()}`,
    status: "sent",
  });

  console.log(`[Worker] ✓ Digest delivered: ${summary} via ${channel} to user ${userId}`);
};

// Uses SCAN instead of KEYS — non-blocking, safe at scale
const flushDueDigests = async () => {
  let cursor = "0";
  const dueMetaKeys = [];

  do {
    const [nextCursor, keys] = await redis.scan(cursor, "MATCH", "digest:meta:*", "COUNT", 100);
    cursor = nextCursor;
    for (const key of keys) {
      const startedAt = parseInt(await redis.get(key), 10);
      if (Date.now() - startedAt >= DIGEST_WINDOW_MS) dueMetaKeys.push(key);
    }
  } while (cursor !== "0");

  for (const metaKey of dueMetaKeys) {
    const [, , userId, eventType, channel] = metaKey.split(":");
    const listKey = `digest:list:${userId}:${eventType}:${channel}`;

    const items = await redis.lrange(listKey, 0, -1);
    await redis.del(listKey);
    await redis.del(metaKey);

    if (items.length === 0) continue;

    const payloads = items.map((i) => JSON.parse(i));
    try {
      await deliverDigest(userId, eventType, channel, payloads);
    } catch (err) {
      console.error(`[Worker] Digest delivery failed for ${userId}:`, err.message);
    }
  }
};

// ── Channel delivery dispatch ────────────────────────────────────
const deliverChannel = async (channel, userId, eventType, payload) => {
  if (channel === "in_app") return deliverInApp(userId, eventType, payload);
  if (channel === "email") return deliverEmail(userId, eventType, payload);
  throw new Error(`Unknown channel: ${channel}`);
};

const processChannel = async (channel, job) => {
  const { type, userId, data, idempotencyKey, attempts = 0 } = job;
  const channelIdemKey = `${idempotencyKey}:${channel}`;

  const pref = await getPreference(userId, type, channel);

  if (!pref.enabled) {
    console.log(`[Worker] ⊘ ${channel} muted for user ${userId} on ${type} — skipping`);
    return;
  }

  if (pref.batch) {
    await pushToDigest(userId, type, channel, data);
    console.log(`[Worker] ⏱ Queued for digest: ${channel} for user ${userId} on ${type}`);
    return;
  }

  try {
    await deliverChannel(channel, userId, type, data);
    await saveNotification({
      userId, eventType: type, channel, payload: data,
      idempotencyKey: channelIdemKey, status: "sent",
    });
    console.log(`[Worker] ✓ ${channel} delivered to user ${userId}`);
  } catch (err) {
    console.error(`[Worker] ✗ ${channel} failed for user ${userId} (attempt ${attempts + 1}):`, err.message);

    if (attempts + 1 >= MAX_ATTEMPTS) {
      await saveNotification({
        userId, eventType: type, channel, payload: data,
        idempotencyKey: channelIdemKey, status: "failed", error: err.message,
      });
      await sendToDeadLetter({
        eventType: type, userId, payload: data, idempotencyKey: channelIdemKey,
        channel, attempts: attempts + 1, lastError: err.message,
      });
    } else {
      throw err;
    }
  }
};

const requeueWithBackoff = async (channel, job) => {
  const nextAttempt = (job.attempts || 0) + 1;
  const delayMs = Math.min(1000 * 2 ** nextAttempt, 30000);

  console.log(`[Worker] ↻ Retrying ${channel} for user ${job.userId} in ${delayMs}ms (attempt ${nextAttempt + 1})`);

  setTimeout(async () => {
    try {
      await processChannel(channel, { ...job, attempts: nextAttempt });
    } catch (err) {
      await requeueWithBackoff(channel, { ...job, attempts: nextAttempt });
    }
  }, delayMs);
};

const processMessage = async (msg, channel) => {
  let job;
  try {
    job = JSON.parse(msg.content.toString());
  } catch (err) {
    console.error("[Worker] Malformed message, discarding:", err.message);
    channel.nack(msg, false, false);
    return;
  }

  const { type, userId, idempotencyKey } = job;
  console.log(`[Worker] Processing: ${type} for user ${userId}`);

  if (await isAlreadyProcessed(idempotencyKey)) {
    console.log(`[Worker] Duplicate detected — skipping ${idempotencyKey}`);
    channel.ack(msg);
    return;
  }

  const channels = ["in_app", "email"];
  await Promise.all(
    channels.map(async (ch) => {
      try {
        await processChannel(ch, job);
      } catch (err) {
        await requeueWithBackoff(ch, job);
      }
    })
  );

  await markAsProcessed(idempotencyKey);
  channel.ack(msg);
  console.log(`[Worker] ✓ Done: ${type} for user ${userId}`);
};

// ── Main ───────────────────────────────────────────────────────────
const start = async () => {
  try {
    console.log("[Worker] Starting...");
    const connection = await amqp.connect(RABBITMQ_URL);
    const ch = await connection.createChannel();

    await ch.assertQueue(QUEUE, { durable: true });
    ch.prefetch(1);

    console.log("[Worker] Waiting for messages...");

    ch.consume(QUEUE, (msg) => {
      if (msg !== null) processMessage(msg, ch);
    });

    // Digest flush loop — checks every 5s for batches whose window has closed
    setInterval(flushDueDigests, 5000);
    console.log("[Worker] Digest flush loop started (checking every 5s)");

    process.on("SIGINT", async () => {
      console.log("[Worker] Shutting down...");
      await ch.close();
      await connection.close();
      process.exit(0);
    });
  } catch (err) {
    console.error("[Worker] Failed to start:", err.message);
    setTimeout(start, 5000);
  }
};

start();