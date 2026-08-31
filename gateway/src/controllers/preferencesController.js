const pool = require("../config/db");

const DEFAULT_EVENT_TYPES = ["order.placed", "order.shipped", "user.welcome", "password.reset"];
const DEFAULT_CHANNELS = ["in_app", "email"];

// GET /api/preferences — returns user's prefs, seeded with defaults if none exist
const getPreferences = async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM notification_preferences WHERE user_id = $1",
      [req.user.id]
    );

    if (result.rows.length === 0) {
      // No preferences set yet — return defaults (all enabled, immediate)
      const defaults = [];
      for (const eventType of DEFAULT_EVENT_TYPES) {
        for (const channel of DEFAULT_CHANNELS) {
          defaults.push({
            event_type: eventType,
            channel,
            enabled: true,
            batch: false,
            batch_frequency: "immediate",
          });
        }
      }
      return res.json({ preferences: defaults, isDefault: true });
    }

    return res.json({ preferences: result.rows, isDefault: false });
  } catch (err) {
    console.error("[Preferences] Get error:", err.message);
    return res.status(500).json({ error: "Failed to fetch preferences" });
  }
};

// PUT /api/preferences — upsert a single preference row
const updatePreference = async (req, res) => {
  try {
    const { eventType, channel, enabled, batch, batchFrequency } = req.body;

    if (!eventType || !channel) {
      return res.status(400).json({ error: "eventType and channel are required" });
    }

    const result = await pool.query(
      `INSERT INTO notification_preferences
         (user_id, event_type, channel, enabled, batch, batch_frequency)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, event_type, channel)
       DO UPDATE SET
         enabled = EXCLUDED.enabled,
         batch = EXCLUDED.batch,
         batch_frequency = EXCLUDED.batch_frequency
       RETURNING *`,
      [
        req.user.id,
        eventType,
        channel,
        enabled ?? true,
        batch ?? false,
        batchFrequency || "immediate",
      ]
    );

    return res.json({ preference: result.rows[0] });
  } catch (err) {
    console.error("[Preferences] Update error:", err.message);
    return res.status(500).json({ error: "Failed to update preference" });
  }
};

module.exports = { getPreferences, updatePreference };