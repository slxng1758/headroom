import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  start: vi.fn(async () => "http://127.0.0.1:8787"),
  stop: vi.fn(async () => undefined),
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("headroom-ai", () => ({
  compress: vi.fn(),
}));

vi.mock("../src/proxy-manager.js", () => ({
  ProxyManager: class {
    start = mocked.start;
    stop = mocked.stop;
  },
  defaultLogger: mocked.logger,
}));

import { compress } from "headroom-ai";
import { HeadroomContextEngine } from "../src/engine.js";

const HEADROOM_COMPRESSION_NOTICE =
  "[Headroom is compressing tool outputs in this session. Use headroom_retrieve if you need the original, uncompressed content.]";

afterEach(() => {
  mocked.start.mockReset();
  mocked.start.mockResolvedValue("http://127.0.0.1:8787");
  mocked.stop.mockClear();
  mocked.logger.debug.mockClear();
  mocked.logger.error.mockClear();
  mocked.logger.info.mockClear();
  mocked.logger.warn.mockClear();
});

describe("HeadroomContextEngine proxy startup helpers", () => {
  it("bootstraps by scheduling proxy startup when enabled", async () => {
    const engine = new HeadroomContextEngine();

    await expect(
      engine.bootstrap({
        sessionId: "session-1",
        sessionFile: "session.jsonl",
      }),
    ).resolves.toEqual({
      bootstrapped: true,
      reason: "proxy startup scheduled",
    });
    expect(mocked.start).toHaveBeenCalledTimes(1);
  });

  it("removes unsubscribed proxy listeners before notifying readiness", async () => {
    const engine = new HeadroomContextEngine();
    const first = vi.fn();
    const second = vi.fn();

    const unsubscribeFirst = engine.onProxyReady(first);
    engine.onProxyReady(second);
    unsubscribeFirst();

    engine.ensureProxyStarted();
    await engine.ensureProxyUrl();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("http://127.0.0.1:8787");
  });

  it("returns the existing proxy URL without starting again", async () => {
    const engine = new HeadroomContextEngine();

    (engine as { proxyUrl: string | null }).proxyUrl = "http://127.0.0.1:8787";

    await expect(engine.ensureProxyUrl()).resolves.toBe("http://127.0.0.1:8787");
    expect(mocked.start).not.toHaveBeenCalled();
  });

  it("throws when proxy startup is disabled", async () => {
    const engine = new HeadroomContextEngine({ enabled: false });

    await expect(engine.ensureProxyUrl()).rejects.toThrow("Headroom proxy startup is disabled");
    expect(mocked.start).not.toHaveBeenCalled();
  });

  it("does not emit an unhandledRejection when fire-and-forget startup fails", async () => {
    mocked.start.mockReset();
    mocked.start.mockRejectedValue(new Error("proxy boom"));

    const engine = new HeadroomContextEngine();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      // Fire-and-forget: caller intentionally does not await.
      engine.ensureProxyStarted();
      // Let the startup promise settle and any microtasks/macrotasks flush.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandled).toEqual([]);
      expect(mocked.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Headroom proxy unavailable"),
      );
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("stores the startup failure in getProxyStartupError()", async () => {
    const failure = new Error("proxy boom");
    mocked.start.mockReset();
    mocked.start.mockRejectedValue(failure);

    const engine = new HeadroomContextEngine();
    expect(engine.getProxyStartupError()).toBeNull();

    engine.ensureProxyStarted();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(engine.getProxyStartupError()).toBe(failure);
  });

  it("allows retrying startup after a failure", async () => {
    mocked.start.mockReset();
    mocked.start
      .mockRejectedValueOnce(new Error("proxy boom"))
      .mockResolvedValueOnce("http://127.0.0.1:8787");

    const engine = new HeadroomContextEngine();

    engine.ensureProxyStarted();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(engine.getProxyStartupError()).toBeInstanceOf(Error);

    // A second attempt is possible once the failed promise has cleared.
    const url = await engine.ensureProxyUrl();
    expect(url).toBe("http://127.0.0.1:8787");
    expect(engine.getProxyStartupError()).toBeNull();
    expect(mocked.start).toHaveBeenCalledTimes(2);
  });

  it("ensureProxyUrl rejects cleanly on startup failure without unhandledRejection", async () => {
    const failure = new Error("proxy boom");
    mocked.start.mockReset();
    mocked.start.mockRejectedValue(failure);

    const engine = new HeadroomContextEngine();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      await expect(engine.ensureProxyUrl()).rejects.toBe(failure);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("isolates and logs proxy-ready listener rejections", async () => {
    const engine = new HeadroomContextEngine();
    const failing = vi.fn(async () => {
      throw new Error("listener boom");
    });
    const healthy = vi.fn();

    engine.onProxyReady(failing);
    engine.onProxyReady(healthy);

    engine.ensureProxyStarted();
    // ensureProxyUrl must still resolve despite the listener throwing.
    await expect(engine.ensureProxyUrl()).resolves.toBe("http://127.0.0.1:8787");

    expect(failing).toHaveBeenCalled();
    expect(healthy).toHaveBeenCalledWith("http://127.0.0.1:8787");
    expect(mocked.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Headroom proxy ready listener failed"),
    );
    expect(engine.getProxyStartupError()).toBeNull();
  });

  it("schedules startup and returns original messages when assembling before proxy readiness", async () => {
    const engine = new HeadroomContextEngine();
    const messages = [{ role: "user", content: "hello" }];

    await expect(
      engine.assemble({
        sessionId: "session-1",
        messages,
      }),
    ).resolves.toEqual({
      messages,
      estimatedTokens: 0,
    });
    expect(mocked.start).toHaveBeenCalledTimes(1);
  });
});

describe("HeadroomContextEngine assemble() compression notice", () => {
  const messages = [{ role: "user", content: "hello" }];

  function mockCompressResult(overrides: Partial<{
    compressed: boolean;
    tokensSaved: number;
    tokensBefore: number;
    tokensAfter: number;
  }>) {
    const tokensSaved = overrides.tokensSaved ?? 0;
    return {
      compressed: overrides.compressed ?? tokensSaved > 0,
      messages: [{ role: "user", content: "hello" }],
      tokensBefore: overrides.tokensBefore ?? 1000,
      tokensAfter: overrides.tokensAfter ?? 1000 - tokensSaved,
      tokensSaved,
      compressionRatio: 0,
      transformsApplied: [],
      ccrHashes: [],
    };
  }

  function readyEngine(config?: { announceCompression?: boolean }) {
    const engine = new HeadroomContextEngine(config);
    (engine as unknown as { proxyUrl: string | null }).proxyUrl = "http://127.0.0.1:8787";
    return engine;
  }

  it("returns the static notice, with no interpolated count, once tokensSaved crosses the threshold", async () => {
    vi.mocked(compress).mockResolvedValueOnce(mockCompressResult({ tokensSaved: 150 }));

    const engine = readyEngine();
    const result = await engine.assemble({ sessionId: "s1", messages });

    expect(result.systemPromptAddition).toBe(HEADROOM_COMPRESSION_NOTICE);
  });

  it("returns byte-identical notices across turns with different tokensSaved amounts", async () => {
    vi.mocked(compress)
      .mockResolvedValueOnce(mockCompressResult({ tokensSaved: 150 }))
      .mockResolvedValueOnce(mockCompressResult({ tokensSaved: 9000 }));

    const engine = readyEngine();
    const first = await engine.assemble({ sessionId: "s1", messages });
    const second = await engine.assemble({ sessionId: "s1", messages });

    expect(first.systemPromptAddition).toBe(HEADROOM_COMPRESSION_NOTICE);
    expect(second.systemPromptAddition).toBe(first.systemPromptAddition);
  });

  it("keeps the notice present on a later turn that has nothing to compress", async () => {
    vi.mocked(compress)
      .mockResolvedValueOnce(mockCompressResult({ tokensSaved: 150 }))
      .mockResolvedValueOnce(mockCompressResult({ compressed: false, tokensSaved: 0 }));

    const engine = readyEngine();
    const first = await engine.assemble({ sessionId: "s1", messages });
    const second = await engine.assemble({ sessionId: "s1", messages });

    expect(first.systemPromptAddition).toBe(HEADROOM_COMPRESSION_NOTICE);
    expect(second.systemPromptAddition).toBe(HEADROOM_COMPRESSION_NOTICE);
  });

  it("never returns a notice when announceCompression is false", async () => {
    vi.mocked(compress).mockResolvedValueOnce(mockCompressResult({ tokensSaved: 500 }));

    const engine = readyEngine({ announceCompression: false });
    const result = await engine.assemble({ sessionId: "s1", messages });

    expect(result.systemPromptAddition).toBeUndefined();
  });

  it("does not announce for compression below the noise threshold", async () => {
    vi.mocked(compress).mockResolvedValueOnce(mockCompressResult({ tokensSaved: 50 }));

    const engine = readyEngine();
    const result = await engine.assemble({ sessionId: "s1", messages });

    expect(result.systemPromptAddition).toBeUndefined();
  });
});
