import { describe, expect, it, vi } from "vitest";
import {
  clearJudgeModeState,
  createJudgeModeState,
  judgeModeProgress,
  readJudgeModeState,
  reduceJudgeModeState,
  writeJudgeModeState,
} from "@/utils/judgeMode";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe("Judge Mode", () => {
  it("moves through four explicit steps without skipping work", () => {
    let state = createJudgeModeState(1);
    expect(state.currentStep).toBe(0);
    expect(judgeModeProgress(state)).toBe(0);

    state = reduceJudgeModeState(state, { type: "NEXT", now: 2 });
    expect(state.currentStep).toBe(1);
    expect(state.completedSteps).toEqual([true, false, false, false]);
    expect(judgeModeProgress(state)).toBe(25);

    state = reduceJudgeModeState(state, { type: "NEXT", now: 3 });
    state = reduceJudgeModeState(state, { type: "NEXT", now: 4 });
    state = reduceJudgeModeState(state, { type: "NEXT", now: 5 });
    expect(state.currentStep).toBe(3);
    expect(state.completedSteps).toEqual([true, true, true, true]);
    expect(state.finished).toBe(true);
    expect(judgeModeProgress(state)).toBe(100);
  });

  it("supports back, direct navigation and reset deterministically", () => {
    let state = reduceJudgeModeState(createJudgeModeState(1), { type: "GO_TO", step: 3, now: 2 });
    expect(state.currentStep).toBe(3);
    state = reduceJudgeModeState(state, { type: "BACK", now: 3 });
    expect(state.currentStep).toBe(2);
    state = reduceJudgeModeState(state, { type: "RESET", now: 4 });
    expect(state).toEqual(createJudgeModeState(4));
  });

  it("stores only tour progress in session-compatible storage", () => {
    const storage = memoryStorage();
    const state = reduceJudgeModeState(createJudgeModeState(1), { type: "NEXT", now: 2 });
    expect(writeJudgeModeState(storage, state, "judge-test")).toBe(true);
    expect(readJudgeModeState(storage, "judge-test")).toEqual(state);
    expect(clearJudgeModeState(storage, "judge-test")).toBe(true);
    expect(readJudgeModeState(storage, "judge-test")).toBeNull();
  });

  it("rejects corrupt or obsolete persisted state", () => {
    const storage = memoryStorage();
    storage.setItem("bad", JSON.stringify({ version: 0, currentStep: 99 }));
    expect(readJudgeModeState(storage, "bad")).toBeNull();
    storage.setItem("bad", "not-json");
    expect(readJudgeModeState(storage, "bad")).toBeNull();
  });

  it("fails closed when browser storage is unavailable", () => {
    const storage = {
      getItem: vi.fn(() => { throw new Error("blocked"); }),
      setItem: vi.fn(() => { throw new Error("blocked"); }),
      removeItem: vi.fn(() => { throw new Error("blocked"); }),
    };
    const state = createJudgeModeState(1);
    expect(readJudgeModeState(storage)).toBeNull();
    expect(writeJudgeModeState(storage, state)).toBe(false);
    expect(clearJudgeModeState(storage)).toBe(false);
  });
});
