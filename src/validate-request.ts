import { AiError, UnsupportedCapabilityError } from './error.js';
import type { ModelCapabilities, ModelRequest } from './model.js';

export function validateModelRequest(
  request: ModelRequest,
  capabilities: ModelCapabilities,
  providerId: string,
  streaming: boolean,
): void {
  if (request.model.provider !== providerId) {
    throw new AiError(
      'invalid_request',
      `Request provider ${request.model.provider} does not match provider ${providerId}.`,
      { code: 'provider_mismatch' },
    );
  }

  if (request.messages.length === 0) {
    throw new AiError('invalid_request', 'A model request must contain at least one message.', {
      code: 'messages_empty',
    });
  }

  if (streaming && !capabilities.streaming) {
    throw new UnsupportedCapabilityError('streaming', request.model.model);
  }

  for (const message of request.messages) {
    for (const part of message.content) {
      assertContentCapability(part.type, request.model.model, capabilities);
    }
  }

  if ((request.tools?.length ?? 0) > 0 && !capabilities.tools.calls) {
    throw new UnsupportedCapabilityError('tool calls', request.model.model);
  }

  if (
    request.responseFormat !== undefined &&
    request.responseFormat.type !== 'text' &&
    !capabilities.output.structured
  ) {
    throw new UnsupportedCapabilityError('structured output', request.model.model);
  }

  if (
    request.responseFormat?.type === 'json_schema' &&
    request.responseFormat.strict === true &&
    !capabilities.tools.strictSchemas
  ) {
    throw new UnsupportedCapabilityError('strict JSON Schema output', request.model.model);
  }
}

function assertContentCapability(
  partType: 'audio' | 'document' | 'image' | 'refusal' | 'text' | 'tool_call' | 'tool_result',
  model: string,
  capabilities: ModelCapabilities,
): void {
  const supported =
    partType === 'audio'
      ? capabilities.input.audio
      : partType === 'document'
        ? capabilities.input.documents
        : partType === 'image'
          ? capabilities.input.images
          : partType === 'text' || partType === 'refusal'
            ? capabilities.input.text
            : capabilities.tools.calls;

  if (!supported) {
    throw new UnsupportedCapabilityError(`${partType} input`, model);
  }
}
