const { Router } = require("express");
const { authenticate } = require("../middleware/auth");
const { ingestEvent } = require("../controllers/eventsController");

const router = Router();
router.post("/", authenticate, ingestEvent);

module.exports = router;