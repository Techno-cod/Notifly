const { v4: uuidv4 } = require("uuid");
const { getChannel } = require("../config/rabbitmq");
const pool = require("../config/db");

const ingestEvent = async (req, res) => {
  try {
    const { type, userId, data } = req.body;

    if (!type || !userId) {
      return res.status(400).json({ error: "type and userId are required" });
    }

    // Generate idempotency key if not provided
    const idempotencyKey = req.headers["x-idempotency-key"] || uuidv4();

    // Log event to DB
    await pool.query(
      `INSERT INTO events_log (event_type, payload, idempotency_key, received_at)
       VALUES ($1, $2, $3, NOW())`,
      [type, JSON.stringify({ userId, ...data }), idempotencyKey]
    );

    // Publish to RabbitMQ
    const channel = getChannel();
    const message = JSON.stringify({
      type,
      userId,
      data,
      idempotencyKey,
      queuedAt: new Date().toISOString(),
    });

    channel.sendToQueue("notifications", Buffer.from(message), {
      persistent: true, // survives RabbitMQ restart
    });

    console.log(`[Events] Ingested: ${type} for user ${userId}`);

    return res.status(202).json({
      message: "Event accepted",
      idempotencyKey,
    });
  } catch (err) {
    console.error("[Events] Ingest error:", err.message);
    return res.status(500).json({ error: "Failed to ingest event" });
  }
};

module.exports = { ingestEvent };