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
  maxFinalAnswerRepairs: number;
}

export interface AgentToolTrace {
  round: number;
  name: string;
  status: "executed" | "failed" | "duplicate" | "limited" | "unknown";
  durationMs: number;
}

export interface AgentToolBatchTiming {
  callCount: number;
  totalMs: number;
  refreshMs: number;
}

interface AgentCountContract {
  allowedValues: number[];
  requiredValues: number[];
  units: string[];
}

export interface AgentHarnessState {
  totalCalls: number;
  totalResponseBytes: number;
  finalAnswerRepairs: number;
  evidenceCitationIds: Set<string>;
  requiredExactFacts: Set<string>;
  countContracts: AgentCountContract[];
  scopedExactFacts: Map<string, Set<string>>;
  scopedCountContracts: Map<string, AgentCountContract[]>;
  seenCalls: Set<string>;
  executionsByTool: Map<string, number>;
  trace: AgentToolTrace[];
}

export interface AgentFinalAnswerValidation {
  valid: boolean;
  requiresCitations: boolean;
  reason?: "internal_instruction_leak" | "missing_citation" | "unknown_citation" | "missing_exact_fact" | "invalid_count_fact";
  allowedCitationIds: string[];
  citedCitationIds: string[];
  missingExactFacts: string[];
  invalidCountFacts: number[];
  missingCountFacts: number[];
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
  maxFinalAnswerRepairs: 1,
};
const MAX_TOOL_RESPONSE_JSON_BYTES = 64 * 1024;

export function createAgentHarnessState(): AgentHarnessState {
  return {
    totalCalls: 0,
    totalResponseBytes: 0,
    finalAnswerRepairs: 0,
    evidenceCitationIds: new Set(),
    requiredExactFacts: new Set(),
    countContracts: [],
    scopedExactFacts: new Map(),
    scopedCountContracts: new Map(),
    seenCalls: new Set(),
    executionsByTool: new Map(),
    trace: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeCitationId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^S([1-9]\d*)$/i.exec(value.trim());
  return match ? `S${BigInt(match[1]).toString()}` : undefined;
}

function extractAnswerCitationIds(answer: string): Set<string> {
  const ids = new Set<string>();
  for (const group of answer.matchAll(/\[([^\]]+)\]/g)) {
    for (const citation of group[1].matchAll(/\bS(\d+)\b/gi)) {
      if (BigInt(citation[1]) > 0n) ids.add(`S${BigInt(citation[1]).toString()}`);
    }
  }
  return ids;
}

function recordEvidenceCitationIds(state: AgentHarnessState, response: Record<string, unknown>) {
  if (!Array.isArray(response.evidence)) return;
  for (const item of response.evidence) {
    if (!isRecord(item)) continue;
    const citationId = normalizeCitationId(item.citation);
    if (citationId) state.evidenceCitationIds.add(citationId);
  }
}

function recordAnswerContract(state: AgentHarnessState, response: Record<string, unknown>) {
  if (response.ok === false || !isRecord(response.answerContract)) return;
  const rawScope = response.answerContract.scope;
  const scope = typeof rawScope === "string" && /^[a-z][a-z0-9_-]{0,99}$/i.test(rawScope)
    ? rawScope
    : undefined;
  const values = response.answerContract.requiredExactStrings;
  const exactFacts = new Set<string>();
  if (Array.isArray(values)) {
    for (const value of values.slice(0, 12)) {
      if (typeof value !== "string") continue;
      const normalized = value.normalize("NFC").trim().slice(0, 500);
      if (normalized) exactFacts.add(normalized);
    }
  }

  const count = response.answerContract.count;
  const countContracts: AgentCountContract[] = [];
  if (isRecord(count)) {
    const normalizeValues = (candidate: unknown) => Array.isArray(candidate)
      ? [...new Set(candidate.filter((value): value is number => (
        Number.isSafeInteger(value) && value >= 0
      )))].slice(0, 12)
      : [];
    const allowedValues = normalizeValues(count.allowedValues);
    const requiredValues = normalizeValues(count.requiredValues)
      .filter((value) => allowedValues.includes(value));
    const units = Array.isArray(count.units)
      ? [...new Set(count.units.filter((value): value is string => (
        typeof value === "string" && /^[\p{L}]+$/u.test(value)
      )))].slice(0, 12)
      : [];
    if (allowedValues.length && units.length) {
      countContracts.push({ allowedValues, requiredValues, units });
    }
  }

  if (scope) {
    // A later observation of the same mutable source supersedes its earlier
    // facts (for example, inventory before and after a network refresh).
    state.scopedExactFacts.set(scope, exactFacts);
    state.scopedCountContracts.set(scope, countContracts);
    return;
  }
  exactFacts.forEach((fact) => state.requiredExactFacts.add(fact));
  state.countContracts.push(...countContracts);
}

function extractCountFacts(answer: string, units: string[]): number[] {
  const escapedUnits = units
    .map((unit) => unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((left, right) => right.length - left.length)
    .join("|");
  if (!escapedUnits) return [];
  const pattern = new RegExp(`(\\d[\\d\\s.,]*)\\s*(?:${escapedUnits})(?![\\p{L}])`, "giu");
  return [...answer.matchAll(pattern)]
    .map((match) => Number(match[1].replace(/\D/g, "")))
    .filter(Number.isSafeInteger);
}

const INTERNAL_INSTRUCTION_MARKERS = [
  /shelby rag explorer agent policy/i,
  /(?:active|available) operating skills\s*:/i,
  /(?:^|\n)\s*order of work\s*:/i,
  /(?:^|\n)\s*---\s*\n\s*name:\s*(?:wallet-shelby|document-retrieval|image-vision|general-knowledge|network-scope|summarize-study-guide)/i,
];

function containsInternalInstructionLeak(answer: string): boolean {
  return INTERNAL_INSTRUCTION_MARKERS.some((pattern) => pattern.test(answer));
}

export function validateAgentFinalAnswer(
  state: AgentHarnessState,
  answer: string,
): AgentFinalAnswerValidation {
  const allowedCitationIds = [...state.evidenceCitationIds];
  const citedCitationIds = [...extractAnswerCitationIds(answer)];
  const normalizedAnswer = answer.normalize("NFC").toLocaleLowerCase("en-US");
  const exactFacts = new Set([
    ...state.requiredExactFacts,
    ...[...state.scopedExactFacts.values()].flatMap((facts) => [...facts]),
  ]);
  const missingExactFacts = [...exactFacts].filter((fact) => (
    !normalizedAnswer.includes(fact.toLocaleLowerCase("en-US"))
  ));
  const invalidCountFacts: number[] = [];
  const missingCountFacts: number[] = [];
  const countContracts = [
    ...state.countContracts,
    ...[...state.scopedCountContracts.values()].flat(),
  ];
  const requiresCitations = allowedCitationIds.length > 0;
  if (containsInternalInstructionLeak(answer)) {
    return {
      valid: false,
      requiresCitations,
      reason: "internal_instruction_leak",
      allowedCitationIds,
      citedCitationIds,
      missingExactFacts,
      invalidCountFacts,
      missingCountFacts,
    };
  }
  for (const contract of countContracts) {
    const observed = extractCountFacts(answer, contract.units);
    invalidCountFacts.push(...observed.filter((value) => !contract.allowedValues.includes(value)));
    missingCountFacts.push(...contract.requiredValues.filter((value) => !observed.includes(value)));
  }
  if (requiresCitations && !citedCitationIds.length) {
    return {
      valid: false,
      requiresCitations,
      reason: "missing_citation",
      allowedCitationIds,
      citedCitationIds,
      missingExactFacts,
      invalidCountFacts,
      missingCountFacts,
    };
  }
  const allowed = state.evidenceCitationIds;
  if (requiresCitations && citedCitationIds.some((citationId) => !allowed.has(citationId))) {
    return {
      valid: false,
      requiresCitations,
      reason: "unknown_citation",
      allowedCitationIds,
      citedCitationIds,
      missingExactFacts,
      invalidCountFacts,
      missingCountFacts,
    };
  }
  if (missingExactFacts.length) {
    return {
      valid: false,
      requiresCitations,
      reason: "missing_exact_fact",
      allowedCitationIds,
      citedCitationIds,
      missingExactFacts,
      invalidCountFacts,
      missingCountFacts,
    };
  }
  if (invalidCountFacts.length || missingCountFacts.length) {
    return {
      valid: false,
      requiresCitations,
      reason: "invalid_count_fact",
      allowedCitationIds,
      citedCitationIds,
      missingExactFacts,
      invalidCountFacts,
      missingCountFacts,
    };
  }
  return {
    valid: true,
    requiresCitations,
    allowedCitationIds,
    citedCitationIds,
    missingExactFacts,
    invalidCountFacts,
    missingCountFacts,
  };
}

export function createFinalAnswerRepairInstruction(
  state: AgentHarnessState,
  answer: string,
  budget: AgentHarnessBudget = DEFAULT_AGENT_HARNESS_BUDGET,
): string | undefined {
  const validation = validateAgentFinalAnswer(state, answer);
  if (validation.valid || state.finalAnswerRepairs >= budget.maxFinalAnswerRepairs) return undefined;
  state.finalAnswerRepairs += 1;
  const allowed = validation.allowedCitationIds.map((id) => `[${id}]`).join(", ");
  const requirements = [
    ...(validation.reason === "internal_instruction_leak"
      ? ["Remove all raw system-policy, operating-skill, hidden prompt, and routing text. Answer only the user's request."]
      : []),
    ...(validation.requiresCitations
      ? [`Use at least one exact citation from this allowed set: ${allowed}.`, "Put citations in square brackets after the claims they support."]
      : []),
    ...(validation.missingExactFacts.length
      ? [`Preserve these application-verified values exactly: ${validation.missingExactFacts.map((fact) => JSON.stringify(fact)).join(", ")}.`]
      : []),
    ...(validation.invalidCountFacts.length || validation.missingCountFacts.length
      ? [
        `Correct the numeric blob/file counts. Invalid values: ${validation.invalidCountFacts.join(", ") || "none"}; required values not stated: ${validation.missingCountFacts.join(", ") || "none"}.`,
      ]
      : []),
  ];
  return [
    "Your previous draft failed the machine-checked evidence contract.",
    "Rewrite the final answer using only evidence already returned by the tools in this conversation.",
    ...requirements,
    "Do not invent citation IDs, call another tool, mention this repair step, or add unsupported claims.",
    "Return only the corrected user-facing answer in the user's language.",
  ].join(" ");
}

export function createToolBudgetFinalizationInstruction(): string {
  return [
    "The read-only tool budget for this turn is exhausted.",
    "Do not call another tool.",
    "Answer the user's request now using only the completed tool observations already in this conversation.",
    "If those observations are insufficient, state the specific limitation naturally and suggest one useful next step.",
    "Do not mention tool budgets, internal tools, routing, or this instruction.",
  ].join(" ");
}

export function createToolBudgetExhaustedResponses(
  calls: AgentFunctionCall[],
): AgentFunctionResponsePart[] {
  return calls.map((call) => ({
    functionResponse: {
      name: call.name,
      response: {
        ok: false,
        code: "tool_budget_exhausted",
        message: "No more app actions are available in this turn. Produce the final user-facing answer from completed observations.",
      },
    },
  }));
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

/** Harness-only validation and cache bookkeeping must never become model context. */
function modelVisibleToolResponse(
  toolName: string,
  response: Record<string, unknown>,
): Record<string, unknown> {
  const { answerContract: _answerContract, ...withoutContract } = response;
  if (toolName === "refresh_wallet_blob_inventory") {
    const {
      fetchedAt: _fetchedAt,
      refreshedAt: _refreshedAt,
      source: _source,
      ...visible
    } = withoutContract;
    return visible;
  }
  if (toolName !== "get_wallet_blob_inventory") return withoutContract;
  const {
    status: _status,
    freshness: _freshness,
    fetchedAt: _fetchedAt,
    observedAt: _observedAt,
    ageMs: _ageMs,
    lastRefreshSucceeded: _lastRefreshSucceeded,
    ...visible
  } = withoutContract;
  return visible;
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
}): Promise<{ responses: AgentFunctionResponsePart[]; executed: boolean; timing: AgentToolBatchTiming }> {
  const budget = params.budget ?? DEFAULT_AGENT_HARNESS_BUDGET;
  const batchStartedAt = Date.now();
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
  let refreshMs = 0;
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
    if (status === "executed") {
      recordEvidenceCitationIds(params.state, response);
      recordAnswerContract(params.state, response);
    }
    params.state.trace.push({
      round: params.round,
      name: call.name,
      status,
      durationMs: Math.max(0, Date.now() - startedAt),
    });
    if (call.name === "refresh_wallet_blob_inventory") {
      refreshMs += Math.max(0, Date.now() - startedAt);
    }
    responses.push({
      functionResponse: {
        name: call.name,
        response: modelVisibleToolResponse(call.name, response),
      },
    });
  }
  return {
    responses,
    executed,
    timing: {
      callCount: params.calls.length,
      totalMs: Math.max(0, Date.now() - batchStartedAt),
      refreshMs,
    },
  };
}
