export { defaultOpenAIModelCapabilities } from './configuration.js';
export {
  createOpenAISpeechSynthesisProvider,
  createOpenAITranscriptionProvider,
  OpenAISpeechSynthesisProvider,
  OpenAITranscriptionProvider,
} from './audio-provider.js';
export { OpenAIFileAdapter } from './file-adapter.js';
export { createOpenAIProvider } from './provider.js';
export {
  createOpenAIRealtimeClientSecretIssuer,
  OpenAIRealtimeClientSecretIssuer,
} from './realtime-client-secret.js';
export { createOpenAIRealtimeTransport } from './realtime-transport.js';

export type { OpenAIConnectionOptions, OpenAIProviderOptions } from './configuration.js';
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
export type {
  OpenAIRealtimeTransport,
  OpenAIRealtimeTransportConnection,
  OpenAIRealtimeTransportConnectRequest,
  OpenAIRealtimeTransportEvent,
  OpenAIRealtimeTransportOptions,
} from './realtime-transport.js';
export type {
  OpenAIRealtimeAudioFormat,
  OpenAIRealtimeClientSecretDependencies,
  OpenAIRealtimeClientSecretOptions,
  OpenAIRealtimeClientSecretTransport,
  OpenAIRealtimeClientSecretTransportRequest,
  OpenAIRealtimeClientSecretTransportResult,
  OpenAIRealtimeTranscriptionConfig,
} from './realtime-client-secret.js';
export type {
  OpenAIFileAdapterDependencies,
  OpenAIFileAdapterOptions,
  OpenAIFileCreateRequest,
  OpenAIFileCreateResult,
  OpenAIFilePurpose,
  OpenAIFileTransport,
} from './file-adapter.js';
