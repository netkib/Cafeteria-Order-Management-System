import { describe, expect, test } from "@jest/globals";
import {
  CreateOrderSchema,
  computeOrderId,
  computeRequestHash,
  isIdempotencyPayloadMismatch,
} from "../src/orderLogic";

describe("Gateway Order Validation Logic (unit)", () => {
  test("CreateOrderSchema: valid payload passes", () => {
    const parsed = CreateOrderSchema.safeParse({ itemId: "ITEM01", quantity: 1 });
    expect(parsed.success).toBe(true);
  });

  test("CreateOrderSchema: rejects invalid quantity", () => {
    expect(CreateOrderSchema.safeParse({ itemId: "ITEM01", quantity: 0 }).success).toBe(false);
    expect(CreateOrderSchema.safeParse({ itemId: "ITEM01", quantity: -1 }).success).toBe(false);
    expect(CreateOrderSchema.safeParse({ itemId: "ITEM01", quantity: 1.1 }).success).toBe(false);
  });

  test("CreateOrderSchema: rejects missing/empty itemId", () => {
    expect(CreateOrderSchema.safeParse({ itemId: "", quantity: 1 }).success).toBe(false);
    expect(CreateOrderSchema.safeParse({ quantity: 1 } as any).success).toBe(false);
  });

  test("computeOrderId: deterministic for same studentId + idempotencyKey", () => {
    const a = computeOrderId("student1", "idem-1");
    const b = computeOrderId("student1", "idem-1");
    expect(a).toBe(b);
  });

  test("computeOrderId: changes if studentId or idempotencyKey changes", () => {
    const base = computeOrderId("student1", "idem-1");
    expect(computeOrderId("student2", "idem-1")).not.toBe(base);
    expect(computeOrderId("student1", "idem-2")).not.toBe(base);
  });

  test("computeRequestHash: deterministic for same payload, changes when payload changes", () => {
    const h1 = computeRequestHash("ITEM01", 1);
    const h2 = computeRequestHash("ITEM01", 1);
    expect(h1).toBe(h2);

    expect(computeRequestHash("ITEM02", 1)).not.toBe(h1);
    expect(computeRequestHash("ITEM01", 2)).not.toBe(h1);
  });

  test("isIdempotencyPayloadMismatch: detects mismatch correctly", () => {
    const existing = computeRequestHash("ITEM01", 1);
    const same = computeRequestHash("ITEM01", 1);
    const different = computeRequestHash("ITEM01", 2);

    expect(isIdempotencyPayloadMismatch(existing, same)).toBe(false);
    expect(isIdempotencyPayloadMismatch(existing, different)).toBe(true);
  });
});