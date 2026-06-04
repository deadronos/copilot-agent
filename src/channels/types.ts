import type {
  StreamSink,
  ChannelCapabilities,
  InboundMessage,
  OutboundMessage,
  PermissionPrompt,
  PermissionResponse,
} from '../types.js';

export type {
  StreamSink,
  ChannelCapabilities,
  InboundMessage,
  OutboundMessage,
  PermissionPrompt,
  PermissionResponse,
};

export interface ChannelAdapter {
  readonly id: string;
  readonly capabilities: ChannelCapabilities;

  start(): Promise<void>;
  stop(): Promise<void>;

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void;
  onPermissionResponse(
    handler: (response: PermissionResponse) => Promise<void>,
  ): void;

  send(message: OutboundMessage): Promise<void>;
  startStream(replyToMessageId?: string): Promise<StreamSink>;

  promptPermission(prompt: PermissionPrompt): Promise<PermissionResponse>;
}
