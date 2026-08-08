import type { CallOptions } from './call-options.js';
import type { ModelStreamEvent } from './event.js';
import type { ModelCapabilities, ModelRequest, ModelResponse, ModelSelector } from './model.js';
import type { SpeechSynthesisProvider, TranscriptionProvider } from './voice-types.js';

/** Provider adapter contract. Implementations normalize all external values before returning. */
export interface ModelProvider {
  readonly id: string;
  capabilities(model: ModelSelector): Promise<ModelCapabilities>;
  generate(request: ModelRequest, options?: CallOptions): Promise<ModelResponse>;
  stream(request: ModelRequest, options?: CallOptions): AsyncIterable<ModelStreamEvent>;
}

/** A provider bound to the model and optional media services used by the fluent client. */
export interface ConfiguredProvider extends ModelProvider {
  readonly model: string;
  readonly speechSynthesis?: SpeechSynthesisProvider;
  readonly transcription?: TranscriptionProvider;
}
