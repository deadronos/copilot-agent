import type {
  ChannelAdapter,
  InboundMessage,
  OutboundMessage,
  StreamSink,
  PermissionPrompt,
  PermissionResponse,
} from './types.js';
import type { ChannelCapabilities } from '../types.js';

const NOOP_CAPABILITIES: ChannelCapabilities = {
  streaming: false,
  inlineButtons: false,
  messageEdit: false,
  messageHistory: false,
  unlimitedLength: false,
};

const noopStreamSink: StreamSink = {
  append: async () => {},
  replace: async () => {},
  finish: async () => {},
  abort: async () => {},
};

export class NoopChannelAdapter implements ChannelAdapter {
  readonly id: string;
  readonly capabilities = NOOP_CAPABILITIES;

  constructor(id = 'noop') {
    this.id = id;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  onMessage(_handler: (msg: InboundMessage) => Promise<void>): void {}
  onPermissionResponse(
    _handler: (response: PermissionResponse) => Promise<void>,
  ): void {}

  async send(_message: OutboundMessage): Promise<void> {}
  async startStream(_replyToMessageId?: string): Promise<StreamSink> {
    return noopStreamSink;
  }

  async promptPermission(
    prompt: PermissionPrompt,
  ): Promise<PermissionResponse> {
    // Default to deny
    return {
      toolCallId: prompt.toolCallId,
      choice: { kind: 'deny' },
    };
  }
}
