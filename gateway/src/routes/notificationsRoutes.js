const { Router } = require("express");
const { authenticate } = require("../middleware/auth");
const pool = require("../config/db");

const router = Router();

router.get("/", authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM notifications WHERE user_id = $1 ORDER BY queued_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({ notifications: result.rows });
  } catch (err) {
    console.error("[Notifications] List error:", err.message);
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

module.exports = router;