const { Router } = require("express");
const { authenticate } = require("../middleware/auth");
const pool = require("../config/db");

const router = Router();

router.get("/", authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         status,
         channel,
         COUNT(*) as count
       FROM notifications
       WHERE user_id = $1
       GROUP BY status, channel`,
      [req.user.id]
    );
    res.json({ stats: result.rows });
  } catch (err) {
    console.error("[Analytics] Error:", err.message);
    res.status(500).json({ error: "Failed to fetch analytics" });
  }
});

module.exports = router;