import IORedis from "ioredis";
import type { RedisOptions } from "ioredis";
import { env } from "../config/env";

let redis: IORedis | undefined;

export function getRedis(): IORedis {
  if (!redis) {
    redis = new IORedis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false
    });
  }
  return redis;
}

export async function closeRedis(): Promise<void> {
  if (!redis) return;
  await redis.quit();
  redis = undefined;
}

export function getBullMQConnectionOptions(): RedisOptions {
  const url = new URL(env.REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    tls: url.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: null
  };
}

export async function markWebhookEventProcessed(
  eventId: string,
  ttlSeconds = 60 * 60
): Promise<boolean> {
  const result = await getRedis().set(`webhook:processed:${eventId}`, "1", "EX", ttlSeconds, "NX");
  return result === "OK";
}

export async function checkPhoneRateLimit(phone: string, limit: number): Promise<boolean> {
  const key = `rate:${phone}:${Math.floor(Date.now() / 60_000)}`;
  const count = await getRedis().incr(key);
  if (count === 1) {
    await getRedis().expire(key, 65);
  }
  return count <= limit;
}
