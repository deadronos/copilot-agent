import type { ChannelAdapter } from '../types.js';
import type {
  StreamSink,
  InboundMessage,
  OutboundMessage,
  PermissionPrompt,
  PermissionResponse,
  ChannelCapabilities,
} from '../../types.js';

export abstract class BaseChannelAdapter implements ChannelAdapter {
  protected messageHandler: ((msg: InboundMessage) => Promise<void>) | null =
    null;
  protected permissionResponseHandler:
    | ((response: PermissionResponse) => Promise<void>)
    | null = null;

  abstract readonly id: string;
  abstract readonly capabilities: ChannelCapabilities;

  abstract start(): Promise<void>;

  async stop(): Promise<void> {
    // no-op by default
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  onPermissionResponse(
    handler: (response: PermissionResponse) => Promise<void>,
  ): void {
    this.permissionResponseHandler = handler;
  }

  async send(_message: OutboundMessage): Promise<void> {
    throw new Error(`send() not implemented for channel "${this.id}"`);
  }

  async startStream(_replyToMessageId?: string, _context?: Record<string, unknown>): Promise<StreamSink> {
    throw new Error(`startStream() not implemented for channel "${this.id}"`);
  }

  async promptPermission(
    _prompt: PermissionPrompt,
  ): Promise<PermissionResponse> {
    throw new Error(
      `promptPermission() not implemented for channel "${this.id}"`,
    );
  }
}
