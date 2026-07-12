require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

const { connect: connectRabbitMQ } = require("./config/rabbitmq");
const { connect: connectRedis } = require("./config/redis");

const authRoutes = require("./routes/authRoutes");
const eventsRoutes = require("./routes/eventsRoutes");

const app = express();
const server = http.createServer(app);

// Socket.io setup
const io = new Server(server, {
  cors: { origin: "*" },
});

// Make io available to controllers
app.set("io", io);

// Middleware
app.use(helmet());
app.use(cors());
app.use(morgan("dev"));
app.use(express.json());

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/events", eventsRoutes);

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "gateway", ts: new Date().toISOString() });
});

// Socket.io connection
io.on("connection", (socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`);

  // Client sends their userId to subscribe to their notifications
  socket.on("subscribe", (userId) => {
    socket.join(`user:${userId}`);
    console.log(`[Socket] User ${userId} subscribed`);
  });

  socket.on("disconnect", () => {
    console.log(`[Socket] Client disconnected: ${socket.id}`);
  });
});

// Start
const PORT = process.env.PORT || 3000;

const start = async () => {
  await connectRabbitMQ();
  connectRedis();

  server.listen(PORT, () => {
    console.log(`[Gateway] Running on port ${PORT}`);
  });
};

start();