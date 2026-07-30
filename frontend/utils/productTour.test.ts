import { describe, expect, it, vi } from "vitest";
import {
  clearProductTourState,
  createProductTourState,
  productTourProgress,
  readProductTourState,
  reduceProductTourState,
  writeProductTourState,
} from "@/utils/productTour";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe("Product tour", () => {
  it("moves through four explicit steps without skipping work", () => {
    let state = createProductTourState(1);
    expect(state.currentStep).toBe(0);
    expect(productTourProgress(state)).toBe(0);

    state = reduceProductTourState(state, { type: "NEXT", now: 2 });
    expect(state.currentStep).toBe(1);
    expect(state.completedSteps).toEqual([true, false, false, false]);
    expect(productTourProgress(state)).toBe(25);

    state = reduceProductTourState(state, { type: "NEXT", now: 3 });
    state = reduceProductTourState(state, { type: "NEXT", now: 4 });
    state = reduceProductTourState(state, { type: "NEXT", now: 5 });
    expect(state.currentStep).toBe(3);
    expect(state.completedSteps).toEqual([true, true, true, true]);
    expect(state.finished).toBe(true);
    expect(productTourProgress(state)).toBe(100);
  });

  it("supports back, direct navigation and reset deterministically", () => {
    let state = reduceProductTourState(createProductTourState(1), { type: "GO_TO", step: 3, now: 2 });
    expect(state.currentStep).toBe(3);
    state = reduceProductTourState(state, { type: "BACK", now: 3 });
    expect(state.currentStep).toBe(2);
    state = reduceProductTourState(state, { type: "RESET", now: 4 });
    expect(state).toEqual(createProductTourState(4));
  });

  it("stores only tour progress in session-compatible storage", () => {
    const storage = memoryStorage();
    const state = reduceProductTourState(createProductTourState(1), { type: "NEXT", now: 2 });
    expect(writeProductTourState(storage, state, "tour-test")).toBe(true);
    expect(readProductTourState(storage, "tour-test")).toEqual(state);
    expect(clearProductTourState(storage, "tour-test")).toBe(true);
    expect(readProductTourState(storage, "tour-test")).toBeNull();
  });

  it("rejects corrupt or obsolete persisted state", () => {
    const storage = memoryStorage();
    storage.setItem("bad", JSON.stringify({ version: 0, currentStep: 99 }));
    expect(readProductTourState(storage, "bad")).toBeNull();
    storage.setItem("bad", "not-json");
    expect(readProductTourState(storage, "bad")).toBeNull();
  });

  it("fails closed when browser storage is unavailable", () => {
    const storage = {
      getItem: vi.fn(() => { throw new Error("blocked"); }),
      setItem: vi.fn(() => { throw new Error("blocked"); }),
      removeItem: vi.fn(() => { throw new Error("blocked"); }),
    };
    const state = createProductTourState(1);
    expect(readProductTourState(storage)).toBeNull();
    expect(writeProductTourState(storage, state)).toBe(false);
    expect(clearProductTourState(storage)).toBe(false);
  });
});
