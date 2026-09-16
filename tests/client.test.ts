import { describe, expect, it, vi } from "vitest";
import { HestiaApiError, HestiaClient } from "../src/client.js";

function client(fetchMock: typeof fetch): HestiaClient {
  return new HestiaClient({
    apiUrl: new URL("https://panel.example.test:8083/api/"),
    accessKey: "access-id",
    secretKey: "top-secret",
    timeoutMs: 5_000,
    tlsRejectUnauthorized: true,
    maxResponseBytes: 10_000,
    fetch: fetchMock
  });
}

describe("HestiaClient", () => {
  it("sends access keys and positional arguments as JSON", async () => {
    const mock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{"admin":{"ROLE":"admin"}}', {
        status: 200,
        headers: { "content-type": "application/json", "hestia-exit-code": "0" }
      })
    );
    const result = await client(mock).execute("v-list-user", ["admin", "json"]);
    const [, init] = mock.mock.calls[0] ?? [];
    const requestBody = init?.body;
    if (typeof requestBody !== "string") {
      throw new Error("Expected a string request body");
    }
    expect(JSON.parse(requestBody)).toEqual({
      access_key: "access-id",
      secret_key: "top-secret",
      cmd: "v-list-user",
      arg1: "admin",
      arg2: "json"
    });
    expect(result.data).toEqual({ admin: { ROLE: "admin" } });
  });

  it("surfaces Hestia exit codes and messages", async () => {
    const mock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("Error: user does not exist", {
        status: 400,
        headers: { "hestia-exit-code": "3" }
      })
    );
    await expect(client(mock).execute("v-list-user", ["missing", "json"]))
      .rejects.toMatchObject({ exitCode: 3, httpStatus: 400 } satisfies Partial<HestiaApiError>);
  });

  it("rejects oversized responses before reading the body", async () => {
    const mock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("x", { status: 200, headers: { "content-length": "10001" } })
    );
    await expect(client(mock).execute("v-list-users", ["json"]))
      .rejects.toThrow("exceeds 10000 bytes");
  });

  it("stops reading a chunked response as soon as the byte limit is exceeded", async () => {
    const chunks = [
      new Uint8Array(6_000),
      new Uint8Array(6_000),
      new Uint8Array(6_000)
    ];
    let chunksRead = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[chunksRead];
        chunksRead += 1;
        if (chunk === undefined) {
          controller.close();
        } else {
          controller.enqueue(chunk);
        }
      }
    });
    const mock = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 200 }));

    await expect(client(mock).execute("v-list-users", ["json"]))
      .rejects.toThrow("exceeds 10000 bytes");
    expect(chunksRead).toBeLessThan(chunks.length + 1);
  });

  it("rejects unrecognized command syntax", async () => {
    const mock = vi.fn<typeof fetch>();
    await expect(client(mock).execute("rm -rf", [])).rejects.toThrow("Invalid HestiaCP command");
    expect(mock).not.toHaveBeenCalled();
  });

  it("marks a request timeout as an unknown remote outcome", async () => {
    const mock = vi.fn<typeof fetch>().mockRejectedValue(
      new DOMException("request timed out", "TimeoutError")
    );
    const request = client(mock).execute(
      "v-backup-user",
      ["admin", "no"],
      { timeoutMs: 900_000 }
    );
    await expect(request).rejects.toMatchObject({
      command: "v-backup-user",
      outcomeUnknown: true
    } satisfies Partial<HestiaApiError>);
    await expect(request).rejects.toThrow("verify state before retrying");
  });
});
