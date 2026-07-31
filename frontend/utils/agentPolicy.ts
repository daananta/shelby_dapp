import type { QueryIntent } from "@/utils/queryRouter";
import agentPolicy from "../../agent/AGENT.md?raw";
import generalKnowledge from "../../agent/skills/general-knowledge/SKILL.md?raw";
import documentRetrieval from "../../agent/skills/document-retrieval/SKILL.md?raw";
import walletShelby from "../../agent/skills/wallet-shelby/SKILL.md?raw";
import imageVision from "../../agent/skills/image-vision/SKILL.md?raw";
import summarizeStudyGuide from "../../agent/skills/summarize-study-guide/SKILL.md?raw";

const SKILLS: Record<QueryIntent, string[]> = {
  general: [generalKnowledge],
  wallet: [walletShelby],
  inventory: [walletShelby, documentRetrieval],
  metadata: [documentRetrieval],
  exact_quote: [documentRetrieval],
  page_lookup: [documentRetrieval],
  story_lookup: [documentRetrieval],
  image: [imageVision],
  document_semantic: [documentRetrieval],
  summarize_study_guide: [documentRetrieval, summarizeStudyGuide],
};

const INTERNAL_GUIDE_FILE = /(?:^|[/\\])(?:agents?|skills?)\.md$/i;

export function isInternalGuideSource(value: string): boolean {
  return INTERNAL_GUIDE_FILE.test(value.trim());
}

function removeFrontmatter(markdown: string): string {
  return markdown.replace(/^---[\s\S]*?---\s*/m, "").trim();
}

/** RAG evidence is deliberately excluded: this is durable agent behavior, not memory. */
export function buildAgentSystemInstruction(intent: QueryIntent): string {
  const skills = SKILLS[intent].map(removeFrontmatter).join("\n\n");
  return `${agentPolicy.trim()}\n\nActive operating skills:\n${skills}`;
}

/**
 * Lets the model decide whether user-owned knowledge is needed. The local
 * keyword router remains a fallback for offline/deterministic app actions, not
 * the authority for normal Cloud conversations.
 */
export function buildAdaptiveAgentSystemInstruction(): string {
  const skills = [generalKnowledge, walletShelby, documentRetrieval, imageVision]
    .map(removeFrontmatter)
    .join("\n\n");
  return `${agentPolicy.trim()}\n\nAvailable operating skills:\n${skills}`;
}
