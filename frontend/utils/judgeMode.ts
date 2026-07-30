export const JUDGE_MODE_STORAGE_KEY = "shelby-rag-explorer:judge-mode:v1";

export const JUDGE_MODE_QUESTION_EN =
  "Summarize the most important information in my data and cite sources so I can verify it.";

export const JUDGE_MODE_QUESTION =
  "Tóm tắt nội dung quan trọng nhất trong dữ liệu của tôi và dẫn nguồn để tôi kiểm chứng.";

export const JUDGE_MODE_STEPS = [
  {
    id: "sources",
    titleEn: "Select real data",
    title: "Chọn dữ liệu thật",
    descriptionEn: "Show the judges the files owned by the connected wallet. Demo mode never adds sample data.",
    description: "Cho giám khảo thấy các tệp đang thuộc ví hiện tại. Chế độ demo không thêm dữ liệu mẫu.",
    actionLabelEn: "Open library",
    actionLabel: "Mở thư viện",
    target: "library",
    timingEn: "0–15 sec",
    timing: "0–15 giây",
  },
  {
    id: "knowledge",
    titleEn: "Show the knowledge base",
    title: "Cho thấy kho tri thức",
    descriptionEn: "Open Backups to show the RAG copy on this device or Shelby, including whether it is up to date.",
    description: "Mở khu Sao lưu để chỉ ra bản RAG trên máy hoặc bản đã lưu trên Shelby, cùng trạng thái mới/cũ.",
    actionLabelEn: "Open backups",
    actionLabel: "Mở khu sao lưu",
    target: "backup",
    timingEn: "15–35 sec",
    timing: "15–35 giây",
  },
  {
    id: "answer",
    titleEn: "Ask a verifiable question",
    title: "Hỏi một câu có thể kiểm chứng",
    descriptionEn: "Fill the chat box with a sample question. You still decide when to send it to the AI.",
    description: "Điền câu hỏi mẫu vào ô chat. Bạn vẫn là người quyết định thời điểm gửi câu hỏi cho AI.",
    actionLabelEn: "Fill sample question",
    actionLabel: "Điền câu hỏi mẫu",
    target: "chat",
    timingEn: "35–65 sec",
    timing: "35–65 giây",
  },
  {
    id: "receipt",
    titleEn: "Open the answer evidence",
    title: "Mở bằng chứng câu trả lời",
    descriptionEn: "After the AI answers, open the Answer Receipt to compare its sources, retrieved passages, and file fingerprint.",
    description: "Sau khi AI trả lời, mở Phiếu kiểm chứng để đối chiếu nguồn, phần dữ liệu đã đọc và mã tệp.",
    actionLabelEn: "Go to answer",
    actionLabel: "Tới câu trả lời",
    target: "receipt",
    timingEn: "65–90 sec",
    timing: "65–90 giây",
  },
] as const;

export type JudgeModeStepIndex = 0 | 1 | 2 | 3;
export type JudgeModeTarget = (typeof JUDGE_MODE_STEPS)[number]["target"];
export type JudgeModeCompletedSteps = [boolean, boolean, boolean, boolean];

export interface JudgeModeState {
  version: 1;
  currentStep: JudgeModeStepIndex;
  completedSteps: JudgeModeCompletedSteps;
  finished: boolean;
  updatedAt: number;
}

export type JudgeModeAction =
  | { type: "NEXT"; now?: number }
  | { type: "BACK"; now?: number }
  | { type: "GO_TO"; step: JudgeModeStepIndex; now?: number }
  | { type: "RESET"; now?: number };

type JudgeModeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function createJudgeModeState(now = Date.now()): JudgeModeState {
  return {
    version: 1,
    currentStep: 0,
    completedSteps: [false, false, false, false],
    finished: false,
    updatedAt: now,
  };
}

function nextCompletedSteps(state: JudgeModeState): JudgeModeCompletedSteps {
  const completed = [...state.completedSteps] as JudgeModeCompletedSteps;
  completed[state.currentStep] = true;
  return completed;
}

export function reduceJudgeModeState(state: JudgeModeState, action: JudgeModeAction): JudgeModeState {
  const now = action.now ?? Date.now();
  if (action.type === "RESET") return createJudgeModeState(now);
  if (action.type === "BACK") {
    return {
      ...state,
      currentStep: Math.max(0, state.currentStep - 1) as JudgeModeStepIndex,
      finished: false,
      updatedAt: now,
    };
  }
  if (action.type === "GO_TO") {
    return { ...state, currentStep: action.step, finished: false, updatedAt: now };
  }

  const completedSteps = nextCompletedSteps(state);
  if (state.currentStep === JUDGE_MODE_STEPS.length - 1) {
    return { ...state, completedSteps, finished: true, updatedAt: now };
  }
  return {
    ...state,
    currentStep: (state.currentStep + 1) as JudgeModeStepIndex,
    completedSteps,
    finished: false,
    updatedAt: now,
  };
}

export function judgeModeProgress(state: JudgeModeState): number {
  return Math.round(
    (state.completedSteps.filter(Boolean).length / JUDGE_MODE_STEPS.length) * 100,
  );
}

function parseStoredState(value: string | null): JudgeModeState | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return null;
    const candidate = parsed as Partial<JudgeModeState>;
    if (candidate.version !== 1) return null;
    if (![0, 1, 2, 3].includes(candidate.currentStep as number)) return null;
    if (!Array.isArray(candidate.completedSteps) || candidate.completedSteps.length !== 4) return null;
    if (!candidate.completedSteps.every((entry) => typeof entry === "boolean")) return null;
    if (typeof candidate.finished !== "boolean") return null;
    if (typeof candidate.updatedAt !== "number" || !Number.isFinite(candidate.updatedAt)) return null;
    return {
      version: 1,
      currentStep: candidate.currentStep as JudgeModeStepIndex,
      completedSteps: [...candidate.completedSteps] as JudgeModeCompletedSteps,
      finished: candidate.finished,
      updatedAt: candidate.updatedAt,
    };
  } catch {
    return null;
  }
}

export function readJudgeModeState(
  storage: JudgeModeStorage | null | undefined,
  key = JUDGE_MODE_STORAGE_KEY,
): JudgeModeState | null {
  if (!storage) return null;
  try {
    return parseStoredState(storage.getItem(key));
  } catch {
    return null;
  }
}

export function writeJudgeModeState(
  storage: JudgeModeStorage | null | undefined,
  state: JudgeModeState,
  key = JUDGE_MODE_STORAGE_KEY,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function clearJudgeModeState(
  storage: JudgeModeStorage | null | undefined,
  key = JUDGE_MODE_STORAGE_KEY,
): boolean {
  if (!storage) return false;
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
