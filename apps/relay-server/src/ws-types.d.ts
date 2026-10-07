declare module 'ws' {
  import type { IncomingMessage } from 'node:http';
  import type { Duplex } from 'node:stream';

  export type RawData = Buffer | ArrayBuffer | Buffer[] | Uint8Array;

  export class WebSocket {
    static readonly OPEN: number;
    readonly readyState: number;
    send(data: string | Buffer | Uint8Array): void;
    close(code?: number, reason?: string): void;
    on(event: 'message', listener: (data: RawData, isBinary: boolean) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
    once(event: 'close', listener: () => void): this;
    once(event: string, listener: (...args: unknown[]) => void): this;
  }

  export interface WebSocketServerOptions {
    noServer?: boolean;
    maxPayload?: number;
    perMessageDeflate?: boolean;
  }

  export class WebSocketServer {
    readonly clients: Set<WebSocket>;
    constructor(options?: WebSocketServerOptions);
    handleUpgrade(
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      callback: (socket: WebSocket) => void
    ): void;
    emit(event: 'connection', socket: WebSocket, request: IncomingMessage): boolean;
    on(event: 'connection', listener: (socket: WebSocket, request: IncomingMessage) => void): this;
    close(callback?: () => void): void;
  }
}
