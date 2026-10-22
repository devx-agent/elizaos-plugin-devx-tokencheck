import { describe, it, expect, vi } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import type { Action, IAgentRuntime, Memory } from "@elizaos/core";
import plugin, { checkTokenAction, withTokenCheckGuard, guardPluginActions, getTokenCheckClient } from "../src/index";
import { fakeServer } from "./helpers";

const DEGEN = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";
const RANDOM = "0x1111111111111111111111111111111111111111";

function runtime(settings: Record<string, string | undefined>, fetchImpl?: typeof fetch, actions: Action[] = []) {
  const rt = { getSetting: (k: string) => settings[k], actions, logger: { info: vi.fn(), warn: vi.fn() } } as unknown as IAgentRuntime;
  if (fetchImpl) vi.stubGlobal("fetch", fetchImpl);
  return rt;
}
const msg = (text: string) => ({ content: { text } }) as unknown as Memory;

function swapAction(): Action & { calls: number } {
  const a: any = {
    name: "EVM_SWAP_TOKENS", description: "swap", similes: [], examples: [], calls: 0,
    validate: async () => true,
    handler: async () => { a.calls++; return { success: true, text: "swapped" }; },
  };
  return a;
}

describe("plugin shape", () => {
  it("exports an ElizaOS plugin with CHECK_TOKEN", () => {
    expect(plugin.name).toBe("devx-tokencheck");
    expect(plugin.actions?.map((a) => a.name)).toEqual(["CHECK_TOKEN"]);
    expect(typeof plugin.init).toBe("function");
    expect(checkTokenAction.examples?.length).toBeGreaterThan(0);
  });
});

describe("CHECK_TOKEN", () => {
  it("validates only messages with an address", async () => {
    const rt = runtime({});
    expect(await checkTokenAction.validate(rt, msg(`check ${DEGEN}`))).toBe(true);
    expect(await checkTokenAction.validate(rt, msg("gm"))).toBe(false);
  });
  it("free demo path without a wallet", async () => {
    const s = fakeServer();
    const rt = runtime({}, s.fetch);
    const cb = vi.fn(async () => []);
    const r: any = await checkTokenAction.handler(rt, msg(`is ${DEGEN} safe?`), undefined, {}, cb);
    expect(r.success).toBe(true);
    expect(r.values.tokenCheckVerdict).toBe("caution");
    expect(r.data.tokenCheck.source).toBe("demo");
    expect(cb).toHaveBeenCalledOnce();
    expect((cb.mock.calls[0] as any)[0].text).toContain("CAUTION");
  });
  it("paid path with the agent's EVM_PRIVATE_KEY", async () => {
    const s = fakeServer();
    const rt = runtime({ EVM_PRIVATE_KEY: generatePrivateKey() }, s.fetch);
    const r: any = await checkTokenAction.handler(rt, msg(`check ${RANDOM} on arbitrum`), undefined, {});
    expect(r.success).toBe(true);
    expect(r.data.tokenCheck.source).toBe("paid");
    expect(s.calls[0].url).toContain("chain=arbitrum");
    expect(s.calls[1].headers["payment-signature"]).toBeTruthy();
  });
  it("explicit options override text", async () => {
    const s = fakeServer();
    const rt = runtime({ DEVX_TOKENCHECK_PRIVATE_KEY: generatePrivateKey() }, s.fetch);
    await checkTokenAction.handler(rt, msg("check this"), undefined, { chain: "polygon", address: RANDOM });
    expect(s.calls[0].url).toContain("chain=polygon");
  });
  it("no key + non-demo token gives a clear message and no charge", async () => {
    const s = fakeServer();
    const rt = runtime({}, s.fetch);
    const r: any = await checkTokenAction.handler(rt, msg(`check ${RANDOM}`), undefined, {});
    expect(r.success).toBe(false);
    expect(r.error).toBe("payment_not_configured");
    expect(s.calls).toHaveLength(0);
  });
  it("caches one client per runtime", () => {
    const rt = runtime({});
    expect(getTokenCheckClient(rt)).toBe(getTokenCheckClient(rt));
  });
});

describe("pre-swap guard", () => {
  it("blocks a swap into a danger token", async () => {
    const s = fakeServer();
    const rt = runtime({ EVM_PRIVATE_KEY: generatePrivateKey() }, s.fetch);
    const a = swapAction();
    const g = withTokenCheckGuard(a);
    const r: any = await g.handler(rt, msg(`swap 0.1 ETH for ${RANDOM} on base`), undefined, {});
    expect(r.success).toBe(false);
    expect(r.error).toBe("blocked_by_token_check");
    expect(a.calls).toBe(0);
  });
  it("lets a caution token through by default, blocks it when configured", async () => {
    const s = fakeServer();
    const a = swapAction();
    const g = withTokenCheckGuard(a);
    await g.handler(runtime({}, s.fetch), msg(`buy ${DEGEN}`), undefined, {});
    expect(a.calls).toBe(1);
    const r: any = await g.handler(runtime({ DEVX_TOKENCHECK_GUARD_BLOCK_ON: "danger,caution" }, s.fetch), msg(`buy ${DEGEN}`), undefined, {});
    expect(r.error).toBe("blocked_by_token_check");
    expect(a.calls).toBe(1);
  });
  it("reads the output token from action options", async () => {
    const s = fakeServer();
    const a = swapAction();
    await withTokenCheckGuard(a).handler(runtime({ EVM_PRIVATE_KEY: generatePrivateKey() }, s.fetch), msg("do the swap"), undefined, { outputToken: RANDOM, chain: "base" });
    expect(a.calls).toBe(0);
  });
  it("fails open without a verdict unless fail-closed is set", async () => {
    const s = fakeServer();
    const a = swapAction();
    const g = withTokenCheckGuard(a);
    await g.handler(runtime({}, s.fetch), msg(`swap for ${RANDOM}`), undefined, {});
    expect(a.calls).toBe(1);
    const r: any = await g.handler(runtime({ DEVX_TOKENCHECK_GUARD_FAIL_CLOSED: "true" }, s.fetch), msg(`swap for ${RANDOM}`), undefined, {});
    expect(r.error).toBe("blocked_by_token_check");
    expect(a.calls).toBe(1);
  });
  it("guardPluginActions wraps named actions only", () => {
    const p = guardPluginActions({ name: "evm", description: "", actions: [swapAction(), { ...swapAction(), name: "TRANSFER" }] }, ["EVM_SWAP_TOKENS"]);
    expect((p.actions![0] as any).__devxGuarded).toBe(true);
    expect((p.actions![1] as any).__devxGuarded).toBeUndefined();
  });
  it("init wraps already-registered actions named in DEVX_TOKENCHECK_GUARD_ACTIONS", async () => {
    const actions: Action[] = [swapAction()];
    const rt = runtime({ DEVX_TOKENCHECK_GUARD_ACTIONS: "EVM_SWAP_TOKENS" }, undefined, actions);
    await plugin.init!({}, rt);
    expect((actions[0] as any).__devxGuarded).toBe(true);
  });
});
