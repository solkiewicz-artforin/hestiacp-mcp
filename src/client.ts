import { Agent } from "undici";
import type { Config } from "./config.js";

export type HestiaResult = {
  command: string;
  exitCode: number;
  data: unknown;
};

export class HestiaApiError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly httpStatus?: number,
    readonly exitCode?: number,
    readonly outcomeUnknown = false
  ) {
    super(message);
    this.name = "HestiaApiError";
  }
}

export type HestiaClientOptions = Pick<
  Config,
  | "apiUrl"
  | "accessKey"
  | "secretKey"
  | "timeoutMs"
  | "tlsRejectUnauthorized"
  | "maxResponseBytes"
> & {
  fetch?: typeof fetch;
};

export type HestiaRequestOptions = {
  timeoutMs?: number;
};

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

async function readBoundedText(
  response: Response,
  maximumBytes: number,
  command: string
): Promise<string> {
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
      await response.body?.cancel();
      throw new HestiaApiError(
        `HestiaCP response exceeds ${String(maximumBytes)} bytes`,
        command,
        response.status
      );
    }
  }

  if (response.body === null) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";

  try {
    let chunk = await reader.read();
    while (!chunk.done) {
      bytesRead += chunk.value.byteLength;
      if (bytesRead > maximumBytes) {
        await reader.cancel();
        throw new HestiaApiError(
          `HestiaCP response exceeds ${String(maximumBytes)} bytes`,
          command,
          response.status
        );
      }
      text += decoder.decode(chunk.value, { stream: true });
      chunk = await reader.read();
    }
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof HestiaApiError) {
      throw error;
    }
    process.stderr.write(`[HestiaClient] Stream read error for command "${command}": ` +
      `${error instanceof Error ? error.message : String(error)}\n`);
    throw new HestiaApiError(
      isTimeoutError(error)
        ? "HestiaCP response timed out; the remote command outcome is unknown, so verify state before retrying"
        : `Failed to read HestiaCP response: ${error instanceof Error ? error.message : "stream error"}`,
      command,
      response.status,
      undefined,
      isTimeoutError(error)
    );
  } finally {
    reader.releaseLock();
  }
}

export class HestiaClient {
  readonly #options: HestiaClientOptions;
  readonly #fetch: typeof fetch;
  readonly #dispatcher: Agent;

  constructor(options: HestiaClientOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
    this.#dispatcher = new Agent({
      connect: { rejectUnauthorized: options.tlsRejectUnauthorized }
    });
  }

  async close(): Promise<void> {
    await this.#dispatcher.close();
  }

  async execute(
    command: string,
    args: readonly string[],
    requestOptions: HestiaRequestOptions = {}
  ): Promise<HestiaResult> {
    if (!/^v-[a-z0-9-]+$/.test(command)) {
      throw new HestiaApiError("Invalid HestiaCP command name", command);
    }
    if (args.length > 13) {
      throw new HestiaApiError("HestiaCP accepts at most 13 command arguments", command);
    }

    const body: Record<string, string> = {
      access_key: this.#options.accessKey,
      secret_key: this.#options.secretKey,
      cmd: command
    };
    args.forEach((argument, index) => {
      body[`arg${String(index + 1)}`] = argument;
    });

    let response: Response;
    const timeoutMs = requestOptions.timeoutMs ?? this.#options.timeoutMs;
    try {
      response = await this.#fetch(this.#options.apiUrl, {
        method: "POST",
        headers: {
          accept: "application/json, text/plain;q=0.9",
          "content-type": "application/json",
          "user-agent": "hestiacp-mcp/0.1.0"
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
        dispatcher: this.#dispatcher
      } as RequestInit);
    } catch (error) {
      process.stderr.write(`[HestiaClient] Request failed for command "${command}": ` +
        `${error instanceof Error ? error.message : String(error)}\n`);
      const message =
        isTimeoutError(error)
          ? `HestiaCP request timed out after ${String(timeoutMs)}ms; the remote command outcome is unknown, so verify state before retrying`
          : `HestiaCP request failed: ${error instanceof Error ? error.message : "network error"}`;
      throw new HestiaApiError(message, command, undefined, undefined, isTimeoutError(error));
    }

    const text = await readBoundedText(
      response,
      this.#options.maxResponseBytes,
      command
    );

    const exitCodeHeader = response.headers.get("hestia-exit-code");
    const exitCode = exitCodeHeader === null ? (response.ok ? 0 : response.status) : Number(exitCodeHeader);
    if (!response.ok || !Number.isFinite(exitCode) || exitCode !== 0) {
      throw new HestiaApiError(
        text.trim() || `HestiaCP returned HTTP ${String(response.status)}`,
        command,
        response.status,
        Number.isFinite(exitCode) ? exitCode : undefined
      );
    }

    let data: unknown = text.trim();
    if (text.trim()) {
      try {
        data = JSON.parse(text) as unknown;
      } catch {
        // HestiaCP commands can legitimately return plain text.
      }
    }
    return { command, exitCode, data };
  }
}
