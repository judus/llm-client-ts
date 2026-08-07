import type { CallOptions } from './call-options.js';
import type { ModelStreamEvent } from './event.js';
import type { ModelCapabilities, ModelRequest, ModelResponse, ModelSelector } from './model.js';

/** Provider adapter contract. Implementations normalize all external values before returning. */
export interface ModelProvider {
  readonly id: string;
  capabilities(model: ModelSelector): Promise<ModelCapabilities>;
  generate(request: ModelRequest, options?: CallOptions): Promise<ModelResponse>;
  stream(request: ModelRequest, options?: CallOptions): AsyncIterable<ModelStreamEvent>;
}
