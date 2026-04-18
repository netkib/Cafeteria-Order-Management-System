import { describe, expect, test } from "@jest/globals";
import {
  DecrementSchema,
  idemToken,
  processedPathForToken,
  buildDecrementFilter,
  buildDecrementUpdatePipeline,
} from "../src/stockLogic";

describe("Stock Deduction Logic (unit)", () => {
  test("DecrementSchema: valid payload passes", () => {
    const parsed = DecrementSchema.safeParse({ itemId: "ITEM01", quantity: 1 });
    
    expect(parsed.success).toBe(true);
  });

  test("DecrementSchema: invalid quantity fails", () => {
    const parsed0 = DecrementSchema.safeParse({ itemId: "ITEM01", quantity: 0 });

    expect(parsed0.success).toBe(false);

    const parsedNeg = DecrementSchema.safeParse({ itemId: "ITEM01", quantity: -1 });

    expect(parsedNeg.success).toBe(false);

    const parsedFloat = DecrementSchema.safeParse({ itemId: "ITEM01", quantity: 1.2 });

    expect(parsedFloat.success).toBe(false);
  });

  test("DecrementSchema: invalid itemId fails", () => {
    const parsed = DecrementSchema.safeParse({ itemId: "", quantity: 1 });

    expect(parsed.success).toBe(false);
  });

  test("idemToken: stable for same inputs, different across different itemId or key", () => {
    const t1 = idemToken("key-1", "ITEM01");
    const t2 = idemToken("key-1", "ITEM01");

    expect(t1).toBe(t2);

    const t3 = idemToken("key-1", "ITEM02");

    expect(t3).not.toBe(t1);

    const t4 = idemToken("key-2", "ITEM01");

    expect(t4).not.toBe(t1);
  });

  test("processedPathForToken: formats processed.<token>", () => {
    const token = "abc123";
    const path = processedPathForToken(token);

    expect(path).toBe("processed.abc123");
  });

  test("buildDecrementFilter: includes itemId, quantity>=, and processed token must not exist", () => {
    const processedPath = "processed.someToken";
    const filter = buildDecrementFilter("ITEM01", 2, processedPath);

    expect(filter.itemId).toBe("ITEM01");
    expect(filter.quantity).toEqual({ $gte: 2 });
    expect(filter[processedPath]).toEqual({ $exists: false });
  });

  test("buildDecrementUpdatePipeline: creates pipeline that decrements quantity and writes processed ledger", () => {
    const token = "token123";
    const now = new Date("2026-02-27T00:00:00Z");
    const pipeline = buildDecrementUpdatePipeline(token, 3, now);

    expect(Array.isArray(pipeline)).toBe(true);
    expect(pipeline.length).toBeGreaterThan(0);

    const stage0 = pipeline[0];

    expect(stage0).toHaveProperty("$set");

    const setObj = stage0.$set;

    expect(setObj).toHaveProperty("quantity");
    expect(setObj.quantity).toEqual({ $subtract: ["$quantity", 3] });

    expect(setObj).toHaveProperty("updatedAt");
    expect(setObj.updatedAt).toEqual(now);

    expect(setObj).toHaveProperty("processed");
    expect(setObj.processed).toHaveProperty("$setField");
    expect(setObj.processed.$setField.field).toBe(token);

    const value = setObj.processed.$setField.value;

    expect(value.qty).toBe(3);
    expect(value.at).toEqual(now);
    expect(value.remaining).toEqual({ $subtract: ["$quantity", 3] });
  });
});