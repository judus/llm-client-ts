import type { CallOptions } from './call-options.js';
import type { ConversationMessage } from './message.js';
import type { ModelSelector } from './model.js';
import type { ToolCall } from './tool.js';
import type { ToolResultPart } from './content.js';
import type { SerializedAiError } from './error.js';
import type { JsonObject } from './json.js';
import type { Usage } from './usage.js';

export type RealtimeAudioEncoding = 'aac' | 'g711_alaw' | 'g711_ulaw' | 'mp3' | 'opus' | 'pcm16';

export interface RealtimeAudioFormat {
  readonly channels?: number;
  readonly encoding: RealtimeAudioEncoding;
  readonly mimeType: string;
  readonly sampleRateHz?: number;
}

export interface RealtimeAudioChunk {
  readonly bytes: Uint8Array;
  readonly durationMs?: number;
}

export type RealtimeTurnDetection =
  | { readonly type: 'manual' }
  | {
      readonly createResponse?: boolean;
      readonly interruptResponse?: boolean;
      readonly prefixPaddingMs?: number;
      readonly silenceDurationMs?: number;
      readonly threshold?: number;
      readonly type: 'server_vad';
    };

export interface RealtimeVoiceSessionConfig {
  readonly conversationId?: string;
  readonly inputAudio: RealtimeAudioFormat;
  readonly instructions?: string;
  readonly metadata?: JsonObject;
  readonly model: ModelSelector;
  readonly outputAudio: RealtimeAudioFormat;
  readonly turnDetection: RealtimeTurnDetection;
  readonly voice?: string;
}

export interface RealtimeVoiceCapabilities {
  readonly clientSecrets: boolean;
  readonly inputAudioEncodings: readonly RealtimeAudioEncoding[];
  readonly interruption: boolean;
  readonly manualCommit: boolean;
  readonly maxAudioChunkBytes?: number;
  readonly outputAudioEncodings: readonly RealtimeAudioEncoding[];
  readonly serverVad: boolean;
  readonly textInput: boolean;
  readonly toolCalls: boolean;
}

export type RealtimeVoiceSessionState = 'closed' | 'closing' | 'failed' | 'open';

export interface RealtimeVoiceProvider {
  capabilities(model: ModelSelector): Promise<RealtimeVoiceCapabilities>;
  connect(config: RealtimeVoiceSessionConfig, options?: CallOptions): Promise<RealtimeVoiceSession>;
}

export interface RealtimeVoiceSession {
  readonly id: string;
  readonly state: RealtimeVoiceSessionState;
  close(): Promise<void>;
  commitInput(): Promise<void>;
  events(): AsyncIterable<RealtimeVoiceEvent>;
  interrupt(): Promise<void>;
  sendAudio(chunk: RealtimeAudioChunk): Promise<void>;
  sendText(text: string): Promise<void>;
  sendToolResult(result: ToolResultPart): Promise<void>;
}

export interface RealtimeVoiceEventBase {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly sequence: number;
  readonly sessionId: string;
}

export interface RealtimeSessionStartedEvent extends RealtimeVoiceEventBase {
  readonly config: RealtimeVoiceSessionConfig;
  readonly type: 'realtime.session.started';
}

export interface RealtimeInputAudioStartedEvent extends RealtimeVoiceEventBase {
  readonly itemId: string;
  readonly type: 'realtime.input_audio.started';
}

export interface RealtimeInputAudioStoppedEvent extends RealtimeVoiceEventBase {
  readonly audioDurationMs?: number;
  readonly itemId: string;
  readonly type: 'realtime.input_audio.stopped';
}

export interface RealtimeInputTranscriptDeltaEvent extends RealtimeVoiceEventBase {
  readonly delta: string;
  readonly itemId: string;
  readonly type: 'realtime.input_transcript.delta';
}

export interface RealtimeInputTranscriptCompletedEvent extends RealtimeVoiceEventBase {
  readonly itemId: string;
  readonly transcript: string;
  readonly type: 'realtime.input_transcript.completed';
}

export interface RealtimeConversationMessageCommittedEvent extends RealtimeVoiceEventBase {
  readonly message: ConversationMessage;
  readonly type: 'realtime.conversation.message_committed';
}

export interface RealtimeResponseStartedEvent extends RealtimeVoiceEventBase {
  readonly responseId: string;
  readonly type: 'realtime.response.started';
}

export interface RealtimeOutputTranscriptDeltaEvent extends RealtimeVoiceEventBase {
  readonly delta: string;
  readonly responseId: string;
  readonly type: 'realtime.output_transcript.delta';
}

export interface RealtimeOutputTranscriptCompletedEvent extends RealtimeVoiceEventBase {
  readonly responseId: string;
  readonly transcript: string;
  readonly type: 'realtime.output_transcript.completed';
}

export interface RealtimeOutputAudioDeltaEvent extends RealtimeVoiceEventBase {
  /** Media payload for playback. Trace exporters must redact this field by default. */
  readonly chunk: RealtimeAudioChunk;
  readonly responseId: string;
  readonly type: 'realtime.output_audio.delta';
}

export interface RealtimeOutputAudioCompletedEvent extends RealtimeVoiceEventBase {
  readonly audioDurationMs?: number;
  readonly responseId: string;
  readonly type: 'realtime.output_audio.completed';
}

export interface RealtimeToolCallProposedEvent extends RealtimeVoiceEventBase {
  readonly call: ToolCall;
  readonly responseId: string;
  readonly type: 'realtime.tool_call.proposed';
}

export interface RealtimeToolResultAcceptedEvent extends RealtimeVoiceEventBase {
  readonly callId: string;
  readonly type: 'realtime.tool_result.accepted';
}

export interface RealtimeResponseInterruptedEvent extends RealtimeVoiceEventBase {
  readonly deliveredAudioMs?: number;
  readonly deliveredTranscript?: string;
  readonly responseId: string;
  readonly type: 'realtime.response.interrupted';
}

export interface RealtimeUsageUpdatedEvent extends RealtimeVoiceEventBase {
  readonly type: 'realtime.usage.updated';
  readonly usage: Usage;
}

export interface RealtimeSessionFailedEvent extends RealtimeVoiceEventBase {
  readonly error: SerializedAiError;
  readonly recoverable: boolean;
  readonly type: 'realtime.session.failed';
}

export interface RealtimeSessionClosedEvent extends RealtimeVoiceEventBase {
  readonly reason: 'cancelled' | 'client_closed' | 'provider_closed' | 'timeout';
  readonly type: 'realtime.session.closed';
}

export type TerminalRealtimeVoiceEvent = RealtimeSessionClosedEvent | RealtimeSessionFailedEvent;

export type RealtimeVoiceEvent =
  | RealtimeConversationMessageCommittedEvent
  | RealtimeInputAudioStartedEvent
  | RealtimeInputAudioStoppedEvent
  | RealtimeInputTranscriptCompletedEvent
  | RealtimeInputTranscriptDeltaEvent
  | RealtimeOutputAudioCompletedEvent
  | RealtimeOutputAudioDeltaEvent
  | RealtimeOutputTranscriptCompletedEvent
  | RealtimeOutputTranscriptDeltaEvent
  | RealtimeResponseInterruptedEvent
  | RealtimeResponseStartedEvent
  | RealtimeSessionClosedEvent
  | RealtimeSessionFailedEvent
  | RealtimeSessionStartedEvent
  | RealtimeToolCallProposedEvent
  | RealtimeToolResultAcceptedEvent
  | RealtimeUsageUpdatedEvent;
