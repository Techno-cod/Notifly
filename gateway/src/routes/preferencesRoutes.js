const { Router } = require("express");
const { authenticate } = require("../middleware/auth");
const { getPreferences, updatePreference } = require("../controllers/preferencesController");

const router = Router();

router.get("/", authenticate, getPreferences);
router.put("/", authenticate, updatePreference);

module.exports = router;