const { Router } = require("express");
const { authenticate } = require("../middleware/auth");
const pool = require("../config/db");

const router = Router();

router.get("/", authenticate, async (req, res) => {
  try {
    const userId = req.user.id;

    // Overall delivery stats
    const overall = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'sent') AS sent,
         COUNT(*) FILTER (WHERE status = 'failed') AS failed,
         COUNT(*) FILTER (WHERE status = 'read') AS read,
         COUNT(*) AS total
       FROM notifications
       WHERE user_id = $1`,
      [userId]
    );

    // Breakdown by channel
    const byChannel = await pool.query(
      `SELECT
         channel,
         COUNT(*) FILTER (WHERE status = 'sent') AS sent,
         COUNT(*) FILTER (WHERE status = 'failed') AS failed,
         COUNT(*) AS total
       FROM notifications
       WHERE user_id = $1
       GROUP BY channel`,
      [userId]
    );

    // Breakdown by event type
    const byEventType = await pool.query(
      `SELECT
         event_type,
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE status = 'sent') AS sent
       FROM notifications
       WHERE user_id = $1
       GROUP BY event_type
       ORDER BY total DESC`,
      [userId]
    );

    // Average latency (queued → sent), in milliseconds
    const latency = await pool.query(
      `SELECT
         AVG(EXTRACT(EPOCH FROM (sent_at - queued_at)) * 1000) AS avg_latency_ms,
         MAX(EXTRACT(EPOCH FROM (sent_at - queued_at)) * 1000) AS max_latency_ms,
         MIN(EXTRACT(EPOCH FROM (sent_at - queued_at)) * 1000) AS min_latency_ms
       FROM notifications
       WHERE user_id = $1 AND status = 'sent' AND sent_at IS NOT NULL`,
      [userId]
    );

    // Digest vs immediate delivery breakdown
    const digestStats = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE payload->>'digest' = 'true') AS digest_count,
         COUNT(*) FILTER (WHERE payload->>'digest' IS NULL) AS immediate_count
       FROM notifications
       WHERE user_id = $1 AND status = 'sent'`,
      [userId]
    );

    // Dead letter count (permanently failed)
    const deadLetters = await pool.query(
      `SELECT COUNT(*) AS total FROM dead_letters WHERE user_id = $1`,
      [userId]
    );

    // Recent activity timeline (last 20 notifications)
    const recent = await pool.query(
      `SELECT event_type, channel, status, queued_at, sent_at, error
       FROM notifications
       WHERE user_id = $1
       ORDER BY queued_at DESC
       LIMIT 20`,
      [userId]
    );

    const totalCount = parseInt(overall.rows[0].total, 10);
    const sentCount = parseInt(overall.rows[0].sent, 10);
    const failedCount = parseInt(overall.rows[0].failed, 10);

    res.json({
      summary: {
        total: totalCount,
        sent: sentCount,
        failed: failedCount,
        read: parseInt(overall.rows[0].read, 10),
        deliveryRate: totalCount > 0 ? ((sentCount / totalCount) * 100).toFixed(1) : "0.0",
        failureRate: totalCount > 0 ? ((failedCount / totalCount) * 100).toFixed(1) : "0.0",
      },
      byChannel: byChannel.rows,
      byEventType: byEventType.rows,
      latency: {
        avgMs: latency.rows[0].avg_latency_ms ? Math.round(latency.rows[0].avg_latency_ms) : null,
        maxMs: latency.rows[0].max_latency_ms ? Math.round(latency.rows[0].max_latency_ms) : null,
        minMs: latency.rows[0].min_latency_ms ? Math.round(latency.rows[0].min_latency_ms) : null,
      },
      digest: {
        digestCount: parseInt(digestStats.rows[0].digest_count, 10),
        immediateCount: parseInt(digestStats.rows[0].immediate_count, 10),
      },
      deadLetterCount: parseInt(deadLetters.rows[0].total, 10),
      recentActivity: recent.rows,
    });
  } catch (err) {
    console.error("[Analytics] Error:", err.message);
    res.status(500).json({ error: "Failed to fetch analytics" });
  }
});

module.exports = router;