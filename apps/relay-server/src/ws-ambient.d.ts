declare module 'ws' {
  import { EventEmitter } from 'node:events';
  import type { IncomingMessage } from 'node:http';
  import type { Duplex } from 'node:stream';

  export type RawData = Buffer | ArrayBuffer | Buffer[];

  export class WebSocket extends EventEmitter {
    static readonly OPEN: number;
    readonly readyState: number;
    send(data: string | Buffer | ArrayBuffer | ArrayBufferView): void;
    close(code?: number, data?: string | Buffer): void;
    on(event: 'message', listener: (data: RawData, isBinary: boolean) => void): this;
    on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    once(event: 'close', listener: (code: number, reason: Buffer) => void): this;
    once(event: 'error', listener: (error: Error) => void): this;
  }

  export class WebSocketServer extends EventEmitter {
    readonly clients: Set<WebSocket>;
    constructor(options?: {
      noServer?: boolean;
      maxPayload?: number;
      perMessageDeflate?: boolean;
    });
    handleUpgrade(
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      callback: (socket: WebSocket) => void
    ): void;
    on(event: 'connection', listener: (socket: WebSocket, request: IncomingMessage) => void): this;
    close(callback?: (error?: Error) => void): void;
  }
}
