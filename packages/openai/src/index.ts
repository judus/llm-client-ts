export { defaultOpenAIModelCapabilities } from './configuration.js';
export {
  createOpenAISpeechSynthesisProvider,
  createOpenAITranscriptionProvider,
  OpenAISpeechSynthesisProvider,
  OpenAITranscriptionProvider,
} from './audio-provider.js';
export { createOpenAIProvider, openAI } from './provider.js';

export type { OpenAIConnectionOptions, OpenAIProviderOptions } from './configuration.js';
export type { OpenAIClientOptions } from './provider.js';
export type {
  OpenAISpeechSynthesisProviderDependencies,
  OpenAISpeechSynthesisProviderOptions,
  OpenAITranscriptionProviderDependencies,
  OpenAITranscriptionProviderOptions,
} from './audio-provider.js';
export type {
  OpenAISpeechFormat,
  OpenAISpeechTransport,
  OpenAISpeechTransportRequest,
  OpenAISpeechTransportResult,
  OpenAITranscriptionTransport,
  OpenAITranscriptionTransportEvent,
  OpenAITranscriptionTransportRequest,
  OpenAITranscriptionTransportResult,
  OpenAITranscriptionTransportUsage,
} from './audio-transport.js';
export type { OpenAITransportCallOptions } from './transport.js';
