import type { AICompletionOptions, AIProvider } from './qwen.js';
import type { ToolCall, ToolDefinition } from '../shared/types.js';
import type { NCodeSettings } from '../shared/types.js';
import { UniversalProvider } from './universal.js';
import type { ProviderModelEntry } from '../shared/providerModels.js';

export type NCodeFreeSource = 'ovhcloud' | 'blockrun' | 'jarvisclaw' | 'mlvoca';
const SOURCES: Record<Exclude<NCodeFreeSource,'mlvoca'>, { endpoint: string; label: string }> = {
  ovhcloud: { endpoint: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', label: 'OVHcloud AI Endpoints' },
  blockrun: { endpoint: 'https://blockrun.ai/api/v1', label: 'BlockRun' },
  jarvisclaw: { endpoint: 'https://api.jarvisclaw.ai/v1', label: 'JarvisClaw' },
};

export function ncodeFreeSourceLabel(source: NCodeFreeSource): string {
  return source === 'mlvoca' ? 'Free LLM API (mlvoca)' : SOURCES[source].label;
}

export async function discoverNCodeFreeModels(source: NCodeFreeSource): Promise<ProviderModelEntry[]> {
  if (source === 'mlvoca') return [
    { id: 'tinyllama', name: 'TinyLlama 1.1B · fast, short answers' },
    { id: 'deepseek-r1:1.5b', name: 'DeepSeek R1 1.5B · reasoning' },
  ];
  const endpoint = SOURCES[source].endpoint;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`${endpoint}/models`, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) throw new Error(`${SOURCES[source].label} model discovery failed (HTTP ${response.status}).`);
    const payload = await response.json() as { data?: unknown[]; models?: unknown[] };
    const rows = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
    const models: ProviderModelEntry[] = [];
    for (const value of rows) {
      if (!value || typeof value !== 'object') continue;
      const row = value as Record<string, unknown>;
      const id = typeof row.id === 'string' ? row.id.trim() : typeof row.name === 'string' ? row.name.trim() : '';
      if (!id) continue;
      // These public catalogs also include paid models. Never expose them in
      // NCode Free; only accept explicit free metadata or the free-only alias.
      const pricing = row.pricing && typeof row.pricing === 'object' ? row.pricing as Record<string, unknown> : undefined;
      const tags = Array.isArray(row.tags) ? row.tags : [];
      const declaredPrices = pricing ? ['input','output','flat'].map(key => pricing[key]).filter(value => value !== undefined) : [];
      const zeroPrice = declaredPrices.length > 0 && declaredPrices.every(value => Number(value) === 0);
      const free = source === 'ovhcloud' || row.billing_mode === 'free' || row.free === true || row.is_free === true || id === 'auto/free' || tags.includes('free') || zeroPrice;
      if (!free) continue;
      const context = Number(row.context_length ?? row.context_window ?? row.contextLength);
      models.push({ id, ...(typeof row.name === 'string' && row.name !== id ? { name: row.name } : {}),
        ...(Number.isFinite(context) && context > 0 ? { contextLength: Math.round(context) } : {}),
        ...(typeof row.supports_reasoning === 'boolean' ? { reasoning: row.supports_reasoning } : {}),
      });
    }
    if (!models.length && source === 'jarvisclaw') models.push({ id: 'auto/free', name: 'Automatic free model pool' });
    if (!models.length) throw new Error(`${SOURCES[source].label} did not return any models marked as free.`);
    return models;
  } finally { clearTimeout(timer); }
}

class MlvocaFreeProvider implements AIProvider {
  readonly capabilities = { tools: false, streaming: false, reasoning: true };
  constructor(private readonly getSettings: () => NCodeSettings) {}
  getSelectedModel(): string { return this.getSettings().ncodeFreeModel || ''; }
  async generateText(prompt: string, options: AICompletionOptions = {}): Promise<string> {
    const settings = this.getSettings();
    const model = options.model || settings.ncodeFreeModel || '';
    if (!['tinyllama','deepseek-r1:1.5b'].includes(model)) throw new Error('Choose a model from the Free LLM API (mlvoca) catalog.');
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error('Mlvoca request timed out.')), Math.min(300_000, Math.max(10_000, (options.timeoutSeconds || 120) * 1000)));
    try {
      const response = await fetch('https://mlvoca.com/api/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ model, prompt, system: options.systemInstruction, stream: false, options: { temperature: options.temperature ?? 0.2, num_predict: Math.min(options.maxOutputTokens || 512, 2048) } }),
      });
      if (!response.ok) throw new Error(`Free LLM API (mlvoca) request failed (HTTP ${response.status}).`);
      const data = await response.json() as { response?: unknown };
      if (typeof data.response !== 'string' || !data.response.trim()) throw new Error('Free LLM API (mlvoca) returned an empty response.');
      return data.response;
    } finally { clearTimeout(timeout); options.signal?.removeEventListener('abort', abort); }
  }
  async generateStream(prompt: string, options: AICompletionOptions, onChunk: (chunk: string) => void): Promise<string> {
    const text = await this.generateText(prompt, options); onChunk(text); return text;
  }
  async chatWithTools(messages: Array<{role:'user'|'assistant'|'system'|'tool';content:string;toolCallId?:string;name?:string;toolCalls?:ToolCall[]}>, _tools: ToolDefinition[], options: AICompletionOptions = {}): Promise<{text:string;toolCalls?:ToolCall[]}> {
    const prompt = messages.map(message => `${message.role.toUpperCase()}: ${message.content}`).join('\n\n');
    return { text: await this.generateText(prompt, options), toolCalls: [] };
  }
  async chatWithToolsStream(messages: Array<{role:'user'|'assistant'|'system'|'tool';content:string;toolCallId?:string;name?:string;toolCalls?:ToolCall[]}>, tools: ToolDefinition[], options: AICompletionOptions, onToken: (token:string)=>void): Promise<{text:string;toolCalls?:ToolCall[]}> {
    const result = await this.chatWithTools(messages, tools, options); if (result.text) onToken(result.text); return result;
  }
}

export function createNCodeFreeProvider(getSettings: () => NCodeSettings): AIProvider {
  const settings = getSettings();
  const source = settings.ncodeFreeProvider || 'ovhcloud';
  if (source === 'mlvoca') return new MlvocaFreeProvider(getSettings);
  const endpoint = SOURCES[source].endpoint;
  return new UniversalProvider(() => ({
    protocol: 'openai', endpoint, model: getSettings().ncodeFreeModel || '', offlineMode: false,
    auth: { type: 'none' }, capabilities: { tools: true, streaming: true, reasoning: true },
    requestBudget: { maxInputChars: 32_000, maxOutputTokens: 4_096, minRequestIntervalMs: source === 'ovhcloud' ? 30_000 : 2_000, maxConcurrentRequests: 1 },
  }), () => '');
}
