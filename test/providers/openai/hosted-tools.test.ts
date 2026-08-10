import { describe, expect, it } from 'vitest';

import { openAIWebSearch } from '../../../src/providers/openai/hosted-tools.js';
import { mapOpenAIRequest } from '../../../src/providers/openai/request-mapper.js';
import { request } from './fixtures.js';

describe('OpenAI hosted tools', () => {
  it('creates the minimal hosted tool when no search options are supplied', () => {
    expect(openAIWebSearch()).toEqual({ provider: 'openai', type: 'web_search' });
    expect(
      mapOpenAIRequest({ ...request, hostedTools: [openAIWebSearch()], tools: [] }, false).tools,
    ).toEqual([{ type: 'web_search' }]);
  });

  it('maps web search options to the Responses API tool shape', () => {
    expect(
      mapOpenAIRequest(
        {
          ...request,
          hostedTools: [
            openAIWebSearch({
              allowedDomains: ['inara.cz', 'edsm.net'],
              searchContextSize: 'high',
            }),
          ],
          tools: [],
        },
        false,
      ).tools,
    ).toEqual([
      {
        filters: { allowed_domains: ['inara.cz', 'edsm.net'] },
        search_context_size: 'high',
        type: 'web_search',
      },
    ]);
  });

  it('maps each optional web-search setting independently', () => {
    expect(
      mapOpenAIRequest(
        {
          ...request,
          hostedTools: [openAIWebSearch({ allowedDomains: ['inara.cz'] })],
          tools: [],
        },
        false,
      ).tools,
    ).toEqual([{ filters: { allowed_domains: ['inara.cz'] }, type: 'web_search' }]);
    expect(
      mapOpenAIRequest(
        {
          ...request,
          hostedTools: [openAIWebSearch({ searchContextSize: 'low' })],
          tools: [],
        },
        false,
      ).tools,
    ).toEqual([{ search_context_size: 'low', type: 'web_search' }]);
  });

  it('rejects foreign and malformed hosted tools at the provider boundary', () => {
    expect(() =>
      mapOpenAIRequest(
        {
          ...request,
          hostedTools: [{ provider: 'other', type: 'web_search' }],
          tools: [],
        },
        false,
      ),
    ).toThrow(expect.objectContaining({ code: 'openai_hosted_tool_unsupported' }));
    expect(() =>
      mapOpenAIRequest(
        {
          ...request,
          hostedTools: [
            {
              configuration: { allowedDomains: 'inara.cz' },
              provider: 'openai',
              type: 'web_search',
            },
          ],
          tools: [],
        },
        false,
      ),
    ).toThrow(expect.objectContaining({ code: 'openai_web_search_domains_invalid' }));
    expect(() =>
      mapOpenAIRequest(
        {
          ...request,
          hostedTools: [
            {
              configuration: { searchContextSize: 'huge' },
              provider: 'openai',
              type: 'web_search',
            },
          ],
          tools: [],
        },
        false,
      ),
    ).toThrow(expect.objectContaining({ code: 'openai_web_search_context_size_invalid' }));
  });
});
