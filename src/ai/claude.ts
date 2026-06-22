// Anthropic SDK wrapper with model tiering per §4.
// Use classify() for fast classification, reason() for default work, escalate() for ambiguous cases.

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// §4 model tiering
export const MODELS = {
  classify: "claude-haiku-4-5",   // fast, cheap — classification
  default:  "claude-sonnet-4-6",  // standard — naming, briefs
  escalate: "claude-opus-4-8",    // heavy — ambiguous or high-stakes
} as const;

export type ModelTier = keyof typeof MODELS;

async function callClaude(
  model: string,
  prompt: string,
  maxTokens = 1024
): Promise<string> {
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });
  const block = response.content[0];
  if (block.type !== "text") {
    throw new Error(`Unexpected Claude content block type: ${block.type}`);
  }
  return block.text;
}

/** Haiku — fast classification tasks. */
export async function classify(prompt: string): Promise<string> {
  return callClaude(MODELS.classify, prompt, 1024);
}

/** Sonnet — default reasoning, naming corrections, brief drafting. */
export async function reason(prompt: string, maxTokens = 2048): Promise<string> {
  return callClaude(MODELS.default, prompt, maxTokens);
}

/** Opus — escalation path for low-confidence or ambiguous cases. */
export async function escalate(prompt: string, maxTokens = 4096): Promise<string> {
  return callClaude(MODELS.escalate, prompt, maxTokens);
}
