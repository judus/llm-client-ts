export { defaultOpenAIModelCapabilities } from './configuration.js';
export { OpenAIFileAdapter } from './file-adapter.js';
export { createOpenAIProvider } from './provider.js';

export type { OpenAIProviderOptions } from './configuration.js';
export type {
  OpenAIFileAdapterDependencies,
  OpenAIFileAdapterOptions,
  OpenAIFileCreateRequest,
  OpenAIFileCreateResult,
  OpenAIFilePurpose,
  OpenAIFileTransport,
} from './file-adapter.js';
