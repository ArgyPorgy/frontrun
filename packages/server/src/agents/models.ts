import type { AgentModelView } from "@frontrun/core";
import { env } from "../env";
import { fetchJson } from "../http";
import { cachedJson } from "../redis";

/**
 * Every agent's model goes through one gateway, so an owner can pick from hundreds of models, open-source
 * ones included, without this app holding an account with each provider.
 */
const GATEWAY = "https://openrouter.ai/api/v1";
const MODELS_TTL_SECONDS = 3600;

/** Shown first. A mix of cheap and strong, closed and open. */
const RECOMMENDED = [
  "anthropic/claude-opus-5.5",
  "anthropic/claude-sonnet-5.5",
  "anthropic/claude-haiku-5.5",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
  "google/gemini-3.8-flash",
];

/** Publishers whose models have published weights. A few also sell closed ones, which `OPEN_EXCEPT` catches. */
const OPEN_PREFIXES = ["meta-llama/", "deepseek/", "qwen/", "moonshotai/", "z-ai/", "nousresearch/", "openai/gpt-oss", "google/gemma", "microsoft/phi", "minimax/", "tencent/", "allenai/", "arcee-ai/", "ibm-granite/", "mistralai/mixtral", "mistralai/devstral", "mistralai/mistral-small"];
const OPEN_EXCEPT = [/-max\b/, /qwen-plus/, /qwen-turbo/];

export function isOpenSourceModel(id: string): boolean {
  return OPEN_PREFIXES.some((p) => id.startsWith(p)) && !OPEN_EXCEPT.some((p) => p.test(id));
}

interface GatewayModel {
  id: string;
  name?: string;
  supported_parameters?: string[];
  pricing?: { prompt?: string; completion?: string };
}

/** Only models that can call tools can trade, and a negative price is the gateway's own auto-router. */
export function toModelViews(models: GatewayModel[]): AgentModelView[] {
  const views: AgentModelView[] = [];
  for (const m of models) {
    if (!m.supported_parameters?.includes("tools")) continue;
    const prompt = Number(m.pricing?.prompt ?? NaN);
    const completion = Number(m.pricing?.completion ?? NaN);
    if (!Number.isFinite(prompt) || !Number.isFinite(completion) || prompt < 0 || completion < 0) continue;
    views.push({
      id: m.id,
      name: m.name?.replace(/^[^:]+:\s*/, "") ?? m.id,
      provider: m.id.split("/")[0]!,
      openSource: isOpenSourceModel(m.id),
      promptPrice: prompt * 1_000_000,
      completionPrice: completion * 1_000_000,
      free: prompt === 0 && completion === 0,
      recommended: RECOMMENDED.includes(m.id),
    });
  }
  const rank = (v: AgentModelView) => {
    const i = RECOMMENDED.indexOf(v.id);
    return i >= 0 ? i : RECOMMENDED.length;
  };
  return views.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export async function agentModels(): Promise<AgentModelView[]> {
  return cachedJson("agents:models", MODELS_TTL_SECONDS, async () => {
    const { data } = await fetchJson<{ data: GatewayModel[] }>(`${GATEWAY}/models`, { timeoutMs: 15_000, retries: 1 });
    return toModelViews(data);
  });
}

export function modelGatewayConfigured(): boolean {
  return !!env().OPENROUTER_API_KEY;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatResult {
  message: ChatMessage;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

interface GatewayResponse {
  choices?: Array<{ message?: ChatMessage }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string };
}

/** One step of a model's reasoning. It either answers, or asks for tools to be run. */
export async function chatWithModel(model: string, messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatResult> {
  const e = env();
  if (!e.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set.");
  const res = await fetchJson<GatewayResponse>(`${GATEWAY}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${e.OPENROUTER_API_KEY}`, "x-title": "Front Run" },
    body: { model, messages, tools, tool_choice: "auto", max_tokens: 1500, usage: { include: true } },
    timeoutMs: 120_000,
    retries: 1,
  });
  // The gateway can answer 200 with the provider's error inside.
  const message = res.choices?.[0]?.message;
  if (!message) throw new Error(res.error?.message ?? "The model didn't answer.");
  return {
    message: { role: "assistant", content: message.content ?? null, ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}) },
    inputTokens: res.usage?.prompt_tokens ?? 0,
    outputTokens: res.usage?.completion_tokens ?? 0,
    costUsd: res.usage?.cost ?? 0,
  };
}
