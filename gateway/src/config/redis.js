const Redis = require("ioredis");

let redis = null;

const connect = () => {
  redis = new Redis({
    host: process.env.REDIS_HOST || "localhost",
    port: process.env.REDIS_PORT || 6379,
    retryStrategy: (times) => Math.min(times * 100, 2000),
  });

  redis.on("connect", () => console.log("[Redis] Connected"));
  redis.on("error", (err) => console.error("[Redis] Error:", err.message));

  return redis;
};

const getRedis = () => redis;

module.exports = { connect, getRedis };