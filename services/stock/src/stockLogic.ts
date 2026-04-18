import { z } from "zod";
import crypto from "crypto";

export const DecrementSchema = z.object({
  itemId: z.string().trim().min(1).max(64),
  quantity: z.number().int().min(1).max(10),
});

function sha256Hex(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function idemToken(idempotencyKey: string, itemId: string) {
  return sha256Hex(`${idempotencyKey}:${itemId}`);
}

export function processedPathForToken(token: string) {
  return `processed.${token}`;
}

export function buildDecrementFilter(itemId: string, quantity: number, processedPath: string) {
  return {
    itemId,
    quantity: { $gte: quantity },
    [processedPath]: { $exists: false },
  } as Record<string, any>;
}

export function buildDecrementUpdatePipeline(token: string, quantity: number, now: Date) {
  return [
    {
      $set: {
        quantity: { $subtract: ["$quantity", quantity] },
        updatedAt: now,
        processed: {
          $setField: {
            field: token,
            input: { $ifNull: ["$processed", {}] },
            value: {
              qty: quantity,
              at: now,
              remaining: { $subtract: ["$quantity", quantity] },
            },
          },
        },
      },
    },
  ] as any[];
}