import redis from "redis";

export async function connectToRedis() {
  const redisClient = redis.createClient({
    socket: {
      host: "127.0.0.1", // Replace with your Redis host
      port: 6379, // Replace with your Redis port if it's not the default
    },
  });

  redisClient.on("error", (err) => console.log("Redis Client Error", err));

  return await redisClient.connect();
}
