import { z } from "zod";
import crypto from "crypto";

export const CreateOrderSchema = z.object({
  itemId: z.string().trim().min(1).max(64),
  quantity: z.number().int().min(1).max(10),
});

function sha256Hex(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function computeOrderId(studentId: string, idempotencyKey: string) {
  return sha256Hex(`${studentId}:${idempotencyKey}`);
}

export function computeRequestHash(itemId: string, quantity: number) {
  return sha256Hex(`${itemId}:${quantity}`);
}

export function isIdempotencyPayloadMismatch(existingRequestHash: string, newRequestHash: string) {
  return existingRequestHash !== newRequestHash;
}