import type { Action, ActionResult, HandlerCallback, IAgentRuntime, Memory, Plugin, State } from "@elizaos/core";
import {
  TokenCheckClient,
  extractToken,
  guardDecision,
  summarize,
  usdcToAtomic,
  SUPPORTED_CHAINS,
  type GuardPolicy,
  type TokenCheckResult,
  type Verdict,
} from "./tokencheck";

export * from "./tokencheck";

const clients = new WeakMap<object, TokenCheckClient>();

function setting(runtime: IAgentRuntime, key: string): string | undefined {
  const v = runtime.getSetting(key);
  return v == null || v === "" ? undefined : String(v);
}

/** One TokenCheckClient per runtime, built from agent settings. */
export function getTokenCheckClient(runtime: IAgentRuntime): TokenCheckClient {
  let c = clients.get(runtime);
  if (c) return c;
  const max = setting(runtime, "DEVX_TOKENCHECK_MAX_PRICE_USDC");
  c = new TokenCheckClient({
    privateKey: setting(runtime, "DEVX_TOKENCHECK_PRIVATE_KEY") ?? setting(runtime, "EVM_PRIVATE_KEY"),
    baseUrl: setting(runtime, "DEVX_TOKENCHECK_BASE_URL"),
    maxPriceAtomic: max ? usdcToAtomic(max) : undefined,
    demoOnly: /^(1|true|yes)$/i.test(setting(runtime, "DEVX_TOKENCHECK_DEMO_ONLY") ?? ""),
  });
  clients.set(runtime, c);
  return c;
}

function guardPolicy(runtime: IAgentRuntime): GuardPolicy {
  const blockOn = (setting(runtime, "DEVX_TOKENCHECK_GUARD_BLOCK_ON") ?? "danger")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) as Verdict[];
  const failClosed = /^(1|true|yes)$/i.test(setting(runtime, "DEVX_TOKENCHECK_GUARD_FAIL_CLOSED") ?? "");
  return { blockOn, failClosed };
}

function defaultChain(runtime: IAgentRuntime): string {
  return setting(runtime, "DEVX_TOKENCHECK_DEFAULT_CHAIN") ?? "base";
}

function resultData(r: TokenCheckResult): Record<string, unknown> {
  const { raw: _raw, ...rest } = r;
  return { ...rest, raw: r.raw };
}

export const checkTokenAction: Action = {
  name: "CHECK_TOKEN",
  similes: ["TOKEN_CHECK", "CHECK_TOKEN_RISK", "RUG_CHECK", "HONEYPOT_CHECK", "TOKEN_SAFETY_CHECK", "TOKEN_VERDICT"],
  description:
    "Check a token contract for rug/honeypot risk with DevX Token Check before buying or swapping. Returns safe/caution/danger with reasons " +
    "(simulated buy/sell taxes, mint, blacklist, pause, proxy, owner, liquidity, age). Chains: " + SUPPORTED_CHAINS.join(", ") +
    ". Costs $0.01 USDC on Base via x402 from the agent wallet; Base USDC/WETH/DEGEN/AERO are free (demo).",
  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = message?.content?.text ?? "";
    return extractToken(text) !== null || /[1-9A-HJ-NP-Za-km-z]{32,44}/.test(text);
  },
  handler: async (runtime, message, _state?: State, options?: Record<string, unknown>, callback?: HandlerCallback): Promise<ActionResult> => {
    const opt = (options ?? {}) as { chain?: string; address?: string; tokenAddress?: string };
    let chain = opt.chain;
    let address = opt.address ?? opt.tokenAddress;
    if (!address) {
      const found = extractToken(message?.content?.text ?? "", opt.chain ?? defaultChain(runtime));
      if (found) { chain = chain ?? found.chain; address = found.address; }
    }
    if (!address) {
      const text = "Send a token contract address (and optionally a chain) to check, e.g. \"check 0x... on base\".";
      await callback?.({ text, actions: ["CHECK_TOKEN"] });
      return { success: false, text, error: "no_token_address" };
    }
    const r = await getTokenCheckClient(runtime).check(chain ?? defaultChain(runtime), address);
    const text = summarize(r);
    await callback?.({ text, actions: ["CHECK_TOKEN"], source: message?.content?.source });
    return {
      success: r.ok,
      text,
      values: { tokenCheckVerdict: r.verdict, tokenCheckRiskScore: r.riskScore, tokenCheckAddress: r.address, tokenCheckChain: r.chain },
      data: { actionName: "CHECK_TOKEN", tokenCheck: resultData(r) },
      error: r.ok ? undefined : r.error,
    };
  },
  examples: [
    [
      { name: "{{user1}}", content: { text: "Is 0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed safe to buy on base?" } },
      { name: "{{agent}}", content: { text: "Checking that token with DevX Token Check.", actions: ["CHECK_TOKEN"] } },
    ],
    [
      { name: "{{user1}}", content: { text: "rug check 0x940181a94a35a4569E4529A3CDfB74e38FD98631" } },
      { name: "{{agent}}", content: { text: "Running a token risk check first.", actions: ["CHECK_TOKEN"] } },
    ],
  ],
};

export type TokenExtractor = (
  runtime: IAgentRuntime, message: Memory, state: State | undefined, options: Record<string, unknown> | undefined,
) => { chain?: string; address: string } | null | Promise<{ chain?: string; address: string } | null>;

/** Default: look for the bought token in action options, else the last address in the message text. */
export const defaultTokenExtractor: TokenExtractor = (runtime, message, _state, options) => {
  const o = (options ?? {}) as Record<string, unknown>;
  for (const k of ["outputToken", "toToken", "tokenOut", "buyToken", "toTokenAddress", "outputMint"]) {
    const v = o[k];
    if (typeof v === "string" && v.length >= 32) return { chain: (o.chain as string) ?? (o.toChain as string) ?? undefined, address: v };
  }
  return extractToken(message?.content?.text ?? "", (o.chain as string) ?? defaultChain(runtime));
};

export interface GuardOptions extends GuardPolicy {
  getToken?: TokenExtractor;
}

/**
 * Wrap an existing swap/buy action so it runs DevX Token Check on the output token first and
 * refuses to run when the verdict is in blockOn (default: danger).
 */
export function withTokenCheckGuard(action: Action, opts: GuardOptions = {}): Action {
  if ((action as any).__devxGuarded) return action;
  const inner = action.handler;
  const guarded: Action = {
    ...action,
    __devxGuarded: true,
    description: `${action.description} (Guarded: DevX Token Check runs on the output token first.)`,
    handler: async (runtime, message, state, options, callback, responses) => {
      const token = await (opts.getToken ?? defaultTokenExtractor)(runtime, message, state, options as any);
      const policy: GuardPolicy = { ...guardPolicy(runtime), ...(opts.blockOn ? { blockOn: opts.blockOn } : {}), ...(opts.failClosed != null ? { failClosed: opts.failClosed } : {}) };
      if (token) {
        const r = await getTokenCheckClient(runtime).check(token.chain ?? defaultChain(runtime), token.address);
        const d = guardDecision(r, policy);
        if (!d.allow) {
          const text = `Swap blocked by DevX Token Check guard. ${d.reason}`;
          await callback?.({ text, actions: [action.name] });
          return { success: false, text, error: "blocked_by_token_check", data: { tokenCheck: resultData(r) } };
        }
        if (!r.ok) runtime.logger?.warn?.(`[devx-tokencheck] guard could not get a verdict, continuing: ${d.reason}`);
      } else if (policy.failClosed) {
        const text = "Swap blocked by DevX Token Check guard: could not identify the output token.";
        await callback?.({ text, actions: [action.name] });
        return { success: false, text, error: "blocked_by_token_check" };
      }
      return inner(runtime, message, state, options, callback, responses);
    },
  };
  return guarded;
}

/** Wrap the named actions of another plugin before registering it, e.g. guardPluginActions(evmPlugin, ["EVM_SWAP_TOKENS"]). */
export function guardPluginActions(plugin: Plugin, actionNames: string[], opts: GuardOptions = {}): Plugin {
  const names = new Set(actionNames.map((n) => n.toUpperCase()));
  return { ...plugin, actions: (plugin.actions ?? []).map((a) => (names.has(a.name.toUpperCase()) ? withTokenCheckGuard(a, opts) : a)) };
}

export const tokenCheckPlugin: Plugin = {
  name: "devx-tokencheck",
  description:
    "DevX Token Check: rug/honeypot risk verdict (safe/caution/danger) before a swap, on 7 chains. $0.01 USDC per check via x402 on Base, free demo tokens. By Made by DevX.",
  config: {
    DEVX_TOKENCHECK_PRIVATE_KEY: process.env.DEVX_TOKENCHECK_PRIVATE_KEY ?? null,
    DEVX_TOKENCHECK_MAX_PRICE_USDC: process.env.DEVX_TOKENCHECK_MAX_PRICE_USDC ?? "0.01",
    DEVX_TOKENCHECK_DEMO_ONLY: process.env.DEVX_TOKENCHECK_DEMO_ONLY ?? "false",
    DEVX_TOKENCHECK_GUARD_ACTIONS: process.env.DEVX_TOKENCHECK_GUARD_ACTIONS ?? "",
    DEVX_TOKENCHECK_GUARD_BLOCK_ON: process.env.DEVX_TOKENCHECK_GUARD_BLOCK_ON ?? "danger",
    DEVX_TOKENCHECK_GUARD_FAIL_CLOSED: process.env.DEVX_TOKENCHECK_GUARD_FAIL_CLOSED ?? "false",
    DEVX_TOKENCHECK_DEFAULT_CHAIN: process.env.DEVX_TOKENCHECK_DEFAULT_CHAIN ?? "base",
  },
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    const names = (setting(runtime, "DEVX_TOKENCHECK_GUARD_ACTIONS") ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (!names.length || !Array.isArray((runtime as any).actions)) return;
    const acts: Action[] = (runtime as any).actions;
    for (let i = 0; i < acts.length; i++) {
      if (names.includes(acts[i].name.toUpperCase())) acts[i] = withTokenCheckGuard(acts[i]);
    }
    const wrapped = acts.filter((a) => (a as any).__devxGuarded).map((a) => a.name);
    runtime.logger?.info?.(`[devx-tokencheck] pre-swap guard on: ${wrapped.join(", ") || "(none found; list this plugin after your swap plugin, or use guardPluginActions)"}`);
  },
  actions: [checkTokenAction],
};

export default tokenCheckPlugin;
