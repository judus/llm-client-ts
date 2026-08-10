import type { HostedTool } from '../../index.js';

export interface OpenAIWebSearchOptions {
  readonly allowedDomains?: readonly string[];
  readonly searchContextSize?: 'low' | 'medium' | 'high';
}

/** Enables OpenAI's hosted web search tool for a request. */
export function openAIWebSearch(options: OpenAIWebSearchOptions = {}): HostedTool {
  const configuration = {
    ...(options.allowedDomains === undefined
      ? {}
      : { allowedDomains: [...options.allowedDomains] }),
    ...(options.searchContextSize === undefined
      ? {}
      : { searchContextSize: options.searchContextSize }),
  };

  return {
    ...(Object.keys(configuration).length === 0 ? {} : { configuration }),
    provider: 'openai',
    type: 'web_search',
  };
}
