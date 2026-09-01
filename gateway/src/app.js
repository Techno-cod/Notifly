require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const Redis = require("ioredis");

const { connect: connectRabbitMQ } = require("./config/rabbitmq");
const { connect: connectRedis } = require("./config/redis");

const authRoutes = require("./routes/authRoutes");
const eventsRoutes = require("./routes/eventsRoutes");
const preferencesRoutes = require("./routes/preferencesRoutes");
const notificationsRoutes = require("./routes/notificationsRoutes");
const analyticsRoutes = require("./routes/analyticsRoutes");

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" },
});

app.set("io", io);

app.use(helmet());
app.use(cors());
app.use(morgan("dev"));
app.use(express.json());

app.use("/api/auth", authRoutes);
app.use("/api/events", eventsRoutes);
app.use("/api/preferences", preferencesRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/analytics", analyticsRoutes);

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "gateway", instance: PORT, ts: new Date().toISOString() });
});

io.on("connection", (socket) => {
  console.log(`[Gateway:${PORT}] Client connected: ${socket.id}`);

  socket.on("subscribe", (userId) => {
    socket.join(`user:${userId}`);
    console.log(`[Gateway:${PORT}] User ${userId} subscribed to this instance`);
  });

  socket.on("disconnect", () => {
    console.log(`[Gateway:${PORT}] Client disconnected: ${socket.id}`);
  });
});

// Redis subscriber — every instance runs its own, but only the one
// holding the actual socket for a user will find a non-empty room.
const subscriber = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: process.env.REDIS_PORT || 6379,
});

subscriber.psubscribe("user:*", (err) => {
  if (err) console.error(`[Gateway:${PORT}] Redis subscribe error:`, err.message);
  else console.log(`[Gateway:${PORT}] Subscribed to user notification channels`);
});

subscriber.on("pmessage", (pattern, channel, message) => {
  const userId = channel.split(":")[1];
  const data = JSON.parse(message);

  const room = io.sockets.adapter.rooms.get(`user:${userId}`);
  const hasLocalSocket = room && room.size > 0;

  if (hasLocalSocket) {
    io.to(`user:${userId}`).emit("notification", data);
    console.log(`[Gateway:${PORT}] ✓ Delivered to user ${userId} — local socket found on this instance`);
  } else {
    console.log(`[Gateway:${PORT}] · No local socket for user ${userId} — another instance will handle it`);
  }
});

const start = async () => {
  await connectRabbitMQ();
  connectRedis();

  server.listen(PORT, () => {
    console.log(`[Gateway:${PORT}] Running`);
  });
};

start();