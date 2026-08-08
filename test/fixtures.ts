import type { ConversationMessage, ModelCapabilities, ModelResponse } from '../src/index.js';

export const capabilities: ModelCapabilities = {
  input: {
    audio: false,
    documents: false,
    images: false,
    text: true,
  },
  output: {
    audio: false,
    structured: true,
    text: true,
  },
  realtime: false,
  speechSynthesis: false,
  streaming: true,
  tools: {
    calls: true,
    parallelCalls: true,
    strictSchemas: true,
  },
  transcription: false,
};

export const userMessage: ConversationMessage = {
  content: [{ source: 'typed', text: 'Hello', type: 'text' }],
  conversationId: 'conversation-1',
  createdAt: '2026-08-07T12:00:00.000Z',
  id: 'message-user-1',
  role: 'user',
};

const assistantMessage: ConversationMessage = {
  content: [{ source: 'generated', text: 'Hello back', type: 'text' }],
  conversationId: 'conversation-1',
  createdAt: '2026-08-07T12:00:01.000Z',
  id: 'message-assistant-1',
  role: 'assistant',
};

export const response: ModelResponse = {
  finishReason: 'stop',
  id: 'response-1',
  message: assistantMessage,
  model: { model: 'test-model', provider: 'test' },
  usage: { inputTokens: 2, outputTokens: 2 },
};
