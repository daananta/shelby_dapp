import { describe, expect, it, vi } from "vitest";
import {
  AgentHarnessLimitError,
  createFinalAnswerRepairInstruction,
  createAgentHarnessState,
  createToolBudgetExhaustedResponses,
  createToolBudgetFinalizationInstruction,
  executeAgentToolCalls,
  hasSatisfiedAgentObservationPlan,
  nextRequiredObservationTools,
  validateAgentFinalAnswer,
  type AgentToolDefinition,
} from "@/utils/agentHarness";

function registry(...definitions: AgentToolDefinition[]) {
  return new Map(definitions.map((definition) => [definition.name, definition]));
}

describe("bounded agent harness", () => {
  it("enforces ordered observations for refresh-then-read flows", async () => {
    const tools = registry(
      {
        name: "refresh",
        maxExecutions: 1,
        unavailableCode: "refresh_unavailable",
        execute: vi.fn().mockResolvedValue({ ok: true }),
      },
      {
        name: "inventory",
        maxExecutions: 2,
        allowRepeatedSignature: true,
        unavailableCode: "inventory_unavailable",
        execute: vi.fn().mockResolvedValue({ ok: true, count: 2 }),
      },
    );
    const state = createAgentHarnessState();
    const plan = [["refresh"], ["inventory"]] as const;

    expect(nextRequiredObservationTools(state, plan)).toEqual(["refresh"]);
    await executeAgentToolCalls({ calls: [{ name: "inventory" }], registry: tools, state, round: 1 });
    expect(nextRequiredObservationTools(state, plan)).toEqual(["refresh"]);
    await executeAgentToolCalls({ calls: [{ name: "refresh" }], registry: tools, state, round: 2 });
    expect(nextRequiredObservationTools(state, plan)).toEqual(["inventory"]);
    await executeAgentToolCalls({ calls: [{ name: "inventory" }], registry: tools, state, round: 3 });
    expect(hasSatisfiedAgentObservationPlan(state, plan)).toBe(true);
  });

  it("creates a provider-neutral finalization response without exposing internal limits", () => {
    expect(createToolBudgetExhaustedResponses([
      { name: "inspect_application", args: { query: "show image" } },
    ])).toEqual([{
      functionResponse: {
        name: "inspect_application",
        response: expect.objectContaining({ ok: false, code: "tool_budget_exhausted" }),
      },
    }]);
    const instruction = createToolBudgetFinalizationInstruction();
    expect(instruction).toContain("Do not call another tool");
    expect(instruction).toMatch(/answer/i);
    expect(instruction).not.toContain("agent_round_limit");
  });

  it("carries execution budgets across sequential tool rounds", async () => {
    const inventory = vi.fn()
      .mockResolvedValueOnce({ ok: false, code: "stale_snapshot" })
      .mockResolvedValueOnce({ ok: true, count: 2 });
    const refresh = vi.fn().mockResolvedValue({ ok: true, count: 2 });
    const tools = registry(
      {
        name: "get_inventory",
        maxExecutions: 2,
        allowRepeatedSignature: true,
        unavailableCode: "inventory_unavailable",
        execute: inventory,
      },
      {
        name: "refresh_inventory",
        maxExecutions: 1,
        unavailableCode: "refresh_unavailable",
        execute: refresh,
      },
    );
    const state = createAgentHarnessState();

    await executeAgentToolCalls({ calls: [{ name: "get_inventory", args: { detail: "count" } }], registry: tools, state, round: 1 });
    await executeAgentToolCalls({ calls: [{ name: "refresh_inventory" }], registry: tools, state, round: 2 });
    const final = await executeAgentToolCalls({ calls: [{ name: "get_inventory", args: { detail: "count" } }], registry: tools, state, round: 3 });

    expect(inventory).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledOnce();
    expect(final.responses[0].functionResponse.response).toEqual({ ok: true, count: 2 });
    expect(state.trace.map(({ name, status }) => ({ name, status }))).toEqual([
      { name: "get_inventory", status: "executed" },
      { name: "refresh_inventory", status: "executed" },
      { name: "get_inventory", status: "executed" },
    ]);
  });

  it("does not execute a duplicate or over-budget tool call", async () => {
    const search = vi.fn().mockResolvedValue({ found: true });
    const tools = registry({
      name: "search",
      maxExecutions: 1,
      unavailableCode: "search_unavailable",
      execute: search,
    });
    const state = createAgentHarnessState();

    await executeAgentToolCalls({ calls: [{ name: "search", args: { query: "same" } }], registry: tools, state, round: 1 });
    const duplicate = await executeAgentToolCalls({ calls: [{ name: "search", args: { query: "same" } }], registry: tools, state, round: 2 });
    const limited = await executeAgentToolCalls({ calls: [{ name: "search", args: { query: "different" } }], registry: tools, state, round: 3 });

    expect(search).toHaveBeenCalledOnce();
    expect(duplicate.responses[0].functionResponse.response).toMatchObject({ code: "duplicate_tool_call" });
    expect(limited.responses[0].functionResponse.response).toMatchObject({ code: "tool_execution_limit" });
  });

  it("counts unknown calls against the total harness budget", async () => {
    const state = createAgentHarnessState();
    const tools = registry();
    await executeAgentToolCalls({
      calls: Array.from({ length: 3 }, (_, index) => ({ name: `unknown_${index}` })),
      registry: tools,
      state,
      round: 1,
    });
    await executeAgentToolCalls({
      calls: Array.from({ length: 3 }, (_, index) => ({ name: `unknown_more_${index}` })),
      registry: tools,
      state,
      round: 2,
    });

    await expect(executeAgentToolCalls({
      calls: [{ name: "one_too_many" }],
      registry: tools,
      state,
      round: 3,
    })).rejects.toBeInstanceOf(AgentHarnessLimitError);
  });

  it("propagates aborts and sanitizes ordinary tool failures", async () => {
    const tools = registry({
      name: "fragile",
      maxExecutions: 1,
      unavailableCode: "fragile_unavailable",
      execute: vi.fn().mockRejectedValue(new Error("private upstream detail")),
    });
    const failed = await executeAgentToolCalls({
      calls: [{ name: "fragile", args: { secret: "do-not-trace" } }],
      registry: tools,
      state: createAgentHarnessState(),
      round: 1,
    });
    expect(failed.responses[0].functionResponse.response).toEqual({ ok: false, code: "fragile_unavailable" });
    expect(JSON.stringify(failed)).not.toContain("private upstream detail");

    const controller = new AbortController();
    controller.abort();
    await expect(executeAgentToolCalls({
      calls: [{ name: "fragile" }],
      registry: tools,
      state: createAgentHarnessState(),
      round: 1,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("returns promptly when a pending cooperative handler is aborted", async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<Record<string, unknown>>((resolve) => {
      release = () => resolve({ ok: true });
    });
    const tools = registry({
      name: "slow",
      maxExecutions: 1,
      unavailableCode: "slow_unavailable",
      execute: vi.fn().mockReturnValue(pending),
    });
    const controller = new AbortController();
    const execution = executeAgentToolCalls({
      calls: [{ name: "slow" }],
      registry: tools,
      state: createAgentHarnessState(),
      round: 1,
      signal: controller.signal,
    });

    controller.abort();
    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    release?.();
  });

  it("rejects non-serializable and oversized tool output before it reaches the model", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const tools = registry(
      {
        name: "cyclic",
        maxExecutions: 1,
        unavailableCode: "cyclic_unavailable",
        execute: vi.fn().mockResolvedValue(cyclic),
      },
      {
        name: "oversized",
        maxExecutions: 1,
        unavailableCode: "oversized_unavailable",
        execute: vi.fn().mockResolvedValue({ text: "😀".repeat(20 * 1024) }),
      },
    );
    const state = createAgentHarnessState();

    const cyclicResult = await executeAgentToolCalls({
      calls: [{ name: "cyclic" }],
      registry: tools,
      state,
      round: 1,
    });
    const oversizedResult = await executeAgentToolCalls({
      calls: [{ name: "oversized" }],
      registry: tools,
      state,
      round: 2,
    });

    expect(cyclicResult.responses[0].functionResponse.response).toEqual({
      ok: false,
      code: "cyclic_unavailable",
    });
    expect(oversizedResult.responses[0].functionResponse.response).toEqual({
      ok: false,
      code: "tool_response_too_large",
    });
  });

  it("limits cumulative tool payload across rounds", async () => {
    const tools = registry({
      name: "payload",
      maxExecutions: 2,
      allowRepeatedSignature: true,
      unavailableCode: "payload_unavailable",
      execute: vi.fn().mockResolvedValue({ text: "x".repeat(50 * 1024) }),
    });
    const state = createAgentHarnessState();

    const first = await executeAgentToolCalls({
      calls: [{ name: "payload" }],
      registry: tools,
      state,
      round: 1,
    });
    const second = await executeAgentToolCalls({
      calls: [{ name: "payload" }],
      registry: tools,
      state,
      round: 2,
    });

    expect(first.responses[0].functionResponse.response).toHaveProperty("text");
    expect(second.responses[0].functionResponse.response).toEqual({
      ok: false,
      code: "agent_total_response_limit",
    });
  });

  it("derives a citation contract from tool evidence without classifying the user question", async () => {
    const tools = registry({
      name: "knowledge",
      maxExecutions: 1,
      unavailableCode: "knowledge_unavailable",
      execute: vi.fn().mockResolvedValue({
        found: true,
        evidence: [
          { citation: "S1", excerpt: "First passage" },
          { citation: "s2", excerpt: "Second passage" },
          { citation: "invalid", excerpt: "Ignored" },
        ],
      }),
    });
    const state = createAgentHarnessState();

    await executeAgentToolCalls({
      calls: [{ name: "knowledge", args: { query: "anything" } }],
      registry: tools,
      state,
      round: 1,
    });

    expect(validateAgentFinalAnswer(state, "Supported [S1].")).toMatchObject({
      valid: true,
      requiresCitations: true,
      allowedCitationIds: ["S1", "S2"],
    });
    expect(validateAgentFinalAnswer(state, "Missing citation.")).toMatchObject({
      valid: false,
      reason: "missing_citation",
    });
    expect(validateAgentFinalAnswer(state, "Invented [S99].")).toMatchObject({
      valid: false,
      reason: "unknown_citation",
    });
  });

  it("allows exactly one bounded final-answer repair", async () => {
    const tools = registry({
      name: "knowledge",
      maxExecutions: 1,
      unavailableCode: "knowledge_unavailable",
      execute: vi.fn().mockResolvedValue({
        evidence: [{ citation: "S1", excerpt: "Evidence" }],
      }),
    });
    const state = createAgentHarnessState();
    await executeAgentToolCalls({
      calls: [{ name: "knowledge" }],
      registry: tools,
      state,
      round: 1,
    });

    const instruction = createFinalAnswerRepairInstruction(state, "No citation.");
    expect(instruction).toContain("[S1]");
    expect(instruction).toContain("Return only the corrected user-facing answer");
    expect(createFinalAnswerRepairInstruction(state, "Still no citation.")).toBeUndefined();
    expect(state.finalAnswerRepairs).toBe(1);
  });

  it("rejects raw internal policy text and repairs it only once", () => {
    const state = createAgentHarnessState();
    const leaked = "Shelby RAG Explorer agent policy\n\nAvailable operating skills: wallet-shelby";

    expect(validateAgentFinalAnswer(state, leaked)).toMatchObject({
      valid: false,
      reason: "internal_instruction_leak",
    });
    expect(createFinalAnswerRepairInstruction(state, leaked)).toContain("Remove all raw system-policy");
    expect(createFinalAnswerRepairInstruction(state, leaked)).toBeUndefined();
  });

  it("repairs an answer that drops an application-verified exact value", async () => {
    const tools = registry({
      name: "wallet",
      maxExecutions: 1,
      unavailableCode: "wallet_unavailable",
      execute: vi.fn().mockResolvedValue({
        ok: true,
        wallet: { connected: true, address: "0x1234" },
        answerContract: { requiredExactStrings: ["0x1234"] },
      }),
    });
    const state = createAgentHarnessState();
    await executeAgentToolCalls({
      calls: [{ name: "wallet", args: { detail: "address" } }],
      registry: tools,
      state,
      round: 1,
    });

    expect(validateAgentFinalAnswer(state, "I cannot access your wallet.")).toMatchObject({
      valid: false,
      reason: "missing_exact_fact",
      missingExactFacts: ["0x1234"],
    });
    expect(createFinalAnswerRepairInstruction(state, "I cannot access your wallet."))
      .toContain('"0x1234"');
    expect(validateAgentFinalAnswer(state, "Your connected wallet is 0x1234.")).toMatchObject({
      valid: true,
      missingExactFacts: [],
    });
  });

  it("accepts a natural zero-result phrase but rejects an invented numeric count", async () => {
    const tools = registry({
      name: "inventory",
      maxExecutions: 1,
      unavailableCode: "inventory_unavailable",
      execute: vi.fn().mockResolvedValue({
        ok: true,
        answerContract: {
          requiredExactStrings: [],
          count: {
            allowedValues: [36, 0],
            requiredValues: [],
            units: ["blob", "blobs", "tệp", "files"],
          },
        },
      }),
    });
    const state = createAgentHarnessState();
    await executeAgentToolCalls({
      calls: [{ name: "inventory" }],
      registry: tools,
      state,
      round: 1,
    });

    expect(validateAgentFinalAnswer(state, "Không có blob anime nào.")).toMatchObject({ valid: true });
    expect(validateAgentFinalAnswer(state, "Có 5 blobs anime.")).toMatchObject({
      valid: false,
      reason: "invalid_count_fact",
      invalidCountFacts: [5],
    });
  });

  it("replaces stale mutable facts after a newer observation of the same scope", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        answerContract: {
          scope: "wallet_blob_inventory",
          requiredExactStrings: ["old.pdf"],
          count: { allowedValues: [35], requiredValues: [35], units: ["blobs"] },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        answerContract: {
          scope: "wallet_blob_inventory",
          requiredExactStrings: ["new.pdf"],
          count: { allowedValues: [36], requiredValues: [36], units: ["blobs"] },
        },
      });
    const tools = registry({
      name: "inventory",
      maxExecutions: 2,
      allowRepeatedSignature: true,
      unavailableCode: "inventory_unavailable",
      execute,
    });
    const state = createAgentHarnessState();
    await executeAgentToolCalls({ calls: [{ name: "inventory" }], registry: tools, state, round: 1 });
    await executeAgentToolCalls({ calls: [{ name: "inventory" }], registry: tools, state, round: 2 });

    expect(validateAgentFinalAnswer(state, "There are 36 blobs, including new.pdf.")).toMatchObject({
      valid: true,
      missingExactFacts: [],
    });
    expect(validateAgentFinalAnswer(state, "There are 35 blobs, including old.pdf.")).toMatchObject({
      valid: false,
    });
  });
});
