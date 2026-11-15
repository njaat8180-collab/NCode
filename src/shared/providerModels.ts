export interface ProviderModelEntry {
  id: string;
  name?: string;
  tools?: boolean;
  contextLength?: number;
  streaming?: boolean;
  reasoning?: boolean;
}

export type ProviderModelCategory = 'coding' | 'reasoning' | 'speed' | 'quality' | 'vision' | 'audio' | 'embedding' | 'general';
export const PROVIDER_MODEL_CATEGORY_LABELS: Record<ProviderModelCategory, string> = {
  coding: 'Coding', reasoning: 'Reasoning / Thinking', speed: 'Speed / Efficient', quality: 'High capability',
  vision: 'Vision', audio: 'Audio', embedding: 'Embeddings', general: 'General / Other',
};

/**
 * Provider model catalogs rarely publish comparable use-case tags. These
 * categories are therefore deliberately inferred from the model ID and any
 * explicit reasoning flag, and are only a discovery aid, not a benchmark.
 */
export function providerModelCategories(model: ProviderModelEntry | string): ProviderModelCategory[] {
  const id = (typeof model === 'string' ? model : `${model.name || ''} ${model.id}`).toLocaleLowerCase();
  const categories: ProviderModelCategory[] = [];
  if (/\b(?:coder|coding|code|devstral|codestral|starcoder)\b|deepseek-coder/.test(id)) categories.push('coding');
  if ((typeof model !== 'string' && model.reasoning === true) || /reason(?:ing|er)|thinking|think|(?:^|[\s/._-])(?:r1|qwq|o1|o3|o4)(?:$|[\s/._-])/.test(id)) categories.push('reasoning');
  if (/\b(?:mini|flash|haiku|instant|turbo|lite|small|fast|spark)\b/.test(id)) categories.push('speed');
  if (/\b(?:pro|opus|max|ultra|large)\b/.test(id)) categories.push('quality');
  if (/\b(?:vision|visual|vl|multimodal)\b/.test(id)) categories.push('vision');
  if (/\b(?:audio|speech|tts|whisper|voice)\b/.test(id)) categories.push('audio');
  if (/\b(?:embed|embedding|embeddings)\b/.test(id)) categories.push('embedding');
  return categories.length ? categories : ['general'];
}

/** Show unknown metadata explicitly so a bare model ID is not mistaken for a
 * verified coding/tool-capability declaration.
 */
export function formatProviderModelLabel(model: ProviderModelEntry): string {
  const identity = model.name ? `${model.name} (${model.id})` : model.id;
  const reportedFeatureFlags = [model.tools, model.streaming, model.reasoning].filter(value => typeof value === 'boolean').length;
  const capabilities = [
    model.tools === true ? 'tools' : model.tools === false ? 'no tools' : '',
    model.streaming === true ? 'streaming' : model.streaming === false ? 'no streaming' : '',
    model.reasoning === true ? 'reasoning' : '',
    model.reasoning === false ? 'no reasoning' : '',
    reportedFeatureFlags === 0 ? 'capabilities unknown' : reportedFeatureFlags < 3 ? `${3 - reportedFeatureFlags} capability flags unknown` : '',
    model.contextLength ? `${Math.round(model.contextLength / 1000)}k context` : '',
  ].filter(Boolean);
  return capabilities.length ? `${identity} · ${capabilities.join(' · ')}` : identity;
}
