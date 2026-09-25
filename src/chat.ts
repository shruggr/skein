// OpenAI-compatible chat shapes: what the loop program builds and the
// inference service sends. Plain data, so they travel inside message bodies.

export interface ToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
export interface ToolDef { type: "function"; function: { name: string; description?: string; parameters: Record<string, unknown> } }
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export type Thinking = "off" | "low" | "medium" | "high";
export const THINKING: Thinking[] = ["off", "low", "medium", "high"];

export interface Usage { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
