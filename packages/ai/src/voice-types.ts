import type { AgentDefinition, AgentResult, RunLimits } from './agent-types.js';
import type { AudioPart } from './content.js';
import type { SerializedAiError } from './error.js';
import type { JsonObject } from './json.js';
import type { RunEvent } from './run-event.js';
import type { Usage } from './usage.js';

export interface TranscriptionRequest {
  readonly audio: AudioPart;
  readonly language?: string;
  readonly prompt?: string;
}

export type TranscriptionEvent =
  | { readonly delta: string; readonly type: 'transcription.text.delta' }
  | { readonly transcription: Transcription; readonly type: 'transcription.completed' };

export interface Transcription {
  readonly durationMs?: number;
  readonly language?: string;
  readonly providerMetadata?: JsonObject;
  readonly text: string;
  readonly usage: Usage;
}

export interface TranscriptionProvider {
  transcribe(
    request: TranscriptionRequest,
    options?: VoiceOperationOptions,
  ): AsyncIterable<TranscriptionEvent>;
}

export interface SpeechSynthesisOptions {
  readonly instructions?: string;
  readonly outputMimeType?: string;
  readonly speed?: number;
  readonly voice?: string;
}

export interface SpeechSynthesisRequest extends SpeechSynthesisOptions {
  readonly text: string;
}

export interface SpeechSynthesis {
  readonly audio: AudioPart;
  readonly providerMetadata?: JsonObject;
  readonly usage: Usage;
}

export interface SpeechSynthesisProvider {
  synthesize(
    request: SpeechSynthesisRequest,
    options?: VoiceOperationOptions,
  ): Promise<SpeechSynthesis>;
}

export interface VoiceOperationOptions {
  readonly signal?: AbortSignal;
}

export interface VoiceRetentionOptions {
  readonly inputAudio: boolean;
  readonly outputAudio: boolean;
}

export interface ComposedVoiceTurnRequest {
  readonly agent: AgentDefinition;
  readonly audio: AudioPart;
  readonly context?: JsonObject;
  readonly conversationId?: string;
  readonly language?: string;
  readonly limits?: Partial<RunLimits>;
  readonly prompt?: string;
  readonly synthesis?: false | SpeechSynthesisOptions;
}

export type ComposedVoiceTurnStatus =
  'agent_failed' | 'completed' | 'persistence_failed' | 'synthesis_failed' | 'transcription_failed';

export interface ComposedVoiceTurnResult {
  readonly agentResult?: AgentResult;
  readonly assistantTranscript?: string;
  readonly error?: SerializedAiError;
  readonly inputAudioArtifactId?: string;
  readonly outputAudioArtifactId?: string;
  readonly status: ComposedVoiceTurnStatus;
  readonly synthesis?: SpeechSynthesis;
  readonly transcription?: Transcription;
  readonly turnId: string;
  readonly usage: Usage;
}

export interface VoiceTurnEventBase {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly sequence: number;
  readonly turnId: string;
}

export interface VoiceTurnStartedEvent extends VoiceTurnEventBase {
  readonly type: 'voice.turn.started';
}

export interface VoiceTranscriptDeltaEvent extends VoiceTurnEventBase {
  readonly delta: string;
  readonly type: 'voice.transcript.delta';
}

export interface VoiceTranscriptCompletedEvent extends VoiceTurnEventBase {
  readonly transcription: Transcription;
  readonly type: 'voice.transcript.completed';
}

export interface VoiceAgentEvent extends VoiceTurnEventBase {
  readonly event: RunEvent;
  readonly type: 'voice.agent.event';
}

export interface VoiceSynthesisCompletedEvent extends VoiceTurnEventBase {
  readonly artifactId?: string;
  readonly durationMs?: number;
  readonly mimeType: string;
  readonly type: 'voice.synthesis.completed';
}

export interface VoiceTurnCompletedEvent extends VoiceTurnEventBase {
  readonly result: ComposedVoiceTurnResult;
  readonly type: 'voice.turn.completed';
}

export interface VoiceTurnFailedEvent extends VoiceTurnEventBase {
  readonly error: SerializedAiError;
  readonly result: ComposedVoiceTurnResult;
  readonly type: 'voice.turn.failed';
}

export type VoiceTurnEvent =
  | VoiceAgentEvent
  | VoiceSynthesisCompletedEvent
  | VoiceTranscriptCompletedEvent
  | VoiceTranscriptDeltaEvent
  | VoiceTurnCompletedEvent
  | VoiceTurnFailedEvent
  | VoiceTurnStartedEvent;

export type TerminalVoiceTurnEvent = VoiceTurnCompletedEvent | VoiceTurnFailedEvent;
