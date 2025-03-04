import { Redis } from "ioredis";

const client = new Redis(6379, "host.docker.internal");

client.on("error", (err) => console.log("Redis Client Error:", err));

export default client;
