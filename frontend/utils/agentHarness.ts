export interface AgentFunctionCall {
  name: string;
  args?: unknown;
}

export interface AgentFunctionResponsePart {
  functionResponse: {
    name: string;
    response: Record<string, unknown>;
  };
}

export interface AgentToolDefinition {
  name: string;
  maxExecutions: number;
  allowRepeatedSignature?: boolean;
  unavailableCode: string;
  execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<Record<string, unknown>>;
}

export interface AgentHarnessBudget {
  maxRounds: number;
  maxCallsPerRound: number;
  maxTotalCalls: number;
  maxTotalResponseBytes: number;
}

export interface AgentToolTrace {
  round: number;
  name: string;
  status: "executed" | "failed" | "duplicate" | "limited" | "unknown";
  durationMs: number;
}

export interface AgentHarnessState {
  totalCalls: number;
  totalResponseBytes: number;
  seenCalls: Set<string>;
  executionsByTool: Map<string, number>;
  trace: AgentToolTrace[];
}

export class AgentHarnessLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentHarnessLimitError";
  }
}

export const DEFAULT_AGENT_HARNESS_BUDGET: AgentHarnessBudget = {
  maxRounds: 3,
  maxCallsPerRound: 3,
  maxTotalCalls: 6,
  maxTotalResponseBytes: 96 * 1024,
};
const MAX_TOOL_RESPONSE_JSON_BYTES = 64 * 1024;

export function createAgentHarnessState(): AgentHarnessState {
  return {
    totalCalls: 0,
    totalResponseBytes: 0,
    seenCalls: new Set(),
    executionsByTool: new Map(),
    trace: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function callSignature(call: AgentFunctionCall): string {
  try {
    return `${call.name}:${stableJson(call.args ?? {})}`;
  } catch {
    return `${call.name}:<invalid-args>`;
  }
}

function normalizeToolResponse(
  value: unknown,
  unavailableCode: string,
): { response: Record<string, unknown>; byteLength: number } {
  try {
    const serialized = JSON.stringify(value);
    const byteLength = serialized ? new TextEncoder().encode(serialized).byteLength : 0;
    if (!serialized || byteLength > MAX_TOOL_RESPONSE_JSON_BYTES) {
      const response = { ok: false, code: "tool_response_too_large" };
      return { response, byteLength: JSON.stringify(response).length };
    }
    const parsed: unknown = JSON.parse(serialized);
    const response = isRecord(parsed)
      ? parsed
      : { ok: false, code: unavailableCode };
    return { response, byteLength };
  } catch {
    const response = { ok: false, code: unavailableCode };
    return { response, byteLength: JSON.stringify(response).length };
  }
}

function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(
      signal.reason instanceof Error
        ? signal.reason
        : new DOMException("The agent request was stopped.", "AbortError"),
    );
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export async function executeAgentToolCalls(params: {
  calls: AgentFunctionCall[];
  registry: Map<string, AgentToolDefinition>;
  state: AgentHarnessState;
  round: number;
  budget?: AgentHarnessBudget;
  signal?: AbortSignal;
}): Promise<{ responses: AgentFunctionResponsePart[]; executed: boolean }> {
  const budget = params.budget ?? DEFAULT_AGENT_HARNESS_BUDGET;
  params.signal?.throwIfAborted();
  if (params.round < 1 || params.round > budget.maxRounds) {
    throw new AgentHarnessLimitError("agent_round_limit");
  }
  if (params.calls.length > budget.maxCallsPerRound) {
    throw new AgentHarnessLimitError("agent_calls_per_round_limit");
  }
  if (params.state.totalCalls + params.calls.length > budget.maxTotalCalls) {
    throw new AgentHarnessLimitError("agent_total_call_limit");
  }

  params.state.totalCalls += params.calls.length;
  let executed = false;
  const responses: AgentFunctionResponsePart[] = [];
  for (const call of params.calls) {
    params.signal?.throwIfAborted();
    const startedAt = Date.now();
    const definition = params.registry.get(call.name);
    const signature = callSignature(call);
    let status: AgentToolTrace["status"];
    let response: Record<string, unknown>;

    if (!definition) {
      status = "unknown";
      response = { ok: false, code: "unknown_tool" };
    } else if (!definition.allowRepeatedSignature && params.state.seenCalls.has(signature)) {
      status = "duplicate";
      response = { ok: false, code: "duplicate_tool_call" };
    } else {
      const executionCount = params.state.executionsByTool.get(call.name) ?? 0;
      if (executionCount >= definition.maxExecutions) {
        status = "limited";
        response = { ok: false, code: "tool_execution_limit" };
      } else {
        params.state.seenCalls.add(signature);
        params.state.executionsByTool.set(call.name, executionCount + 1);
        executed = true;
        try {
          const normalized = normalizeToolResponse(
            await awaitWithAbort(
              definition.execute(isRecord(call.args) ? call.args : {}, params.signal),
              params.signal,
            ),
            definition.unavailableCode,
          );
          if (params.state.totalResponseBytes + normalized.byteLength > budget.maxTotalResponseBytes) {
            status = "limited";
            response = { ok: false, code: "agent_total_response_limit" };
          } else {
            status = "executed";
            response = normalized.response;
          }
          params.signal?.throwIfAborted();
        } catch (error) {
          if (params.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
          status = "failed";
          response = { ok: false, code: definition.unavailableCode };
        }
      }
    }

    params.state.totalResponseBytes += new TextEncoder().encode(JSON.stringify(response)).byteLength;
    params.state.trace.push({
      round: params.round,
      name: call.name,
      status,
      durationMs: Math.max(0, Date.now() - startedAt),
    });
    responses.push({
      functionResponse: {
        name: call.name,
        response,
      },
    });
  }
  return { responses, executed };
}
