# elizaos-plugin-devx-tokencheck

[![npm](https://img.shields.io/npm/v/elizaos-plugin-devx-tokencheck)](https://www.npmjs.com/package/elizaos-plugin-devx-tokencheck) [![license](https://img.shields.io/npm/l/elizaos-plugin-devx-tokencheck)](LICENSE)

An ElizaOS plugin that checks a token for rug-pull or honeypot risk **before your agent buys it**. It adds:

- **`CHECK_TOKEN` action:** "is 0x… safe?", "rug check 0x… on arbitrum". It returns `safe` / `caution` / `danger` with reasons.
- **Optional pre-swap guard:** it wraps your existing swap action (for example plugin-evm's swap) so the token being bought is checked first. A `danger` verdict, or any verdict you list, blocks the swap.
- Payment uses **x402** from the agent's own wallet: **$0.01 USDC on Base per check**. A **free demo** covers Base USDC/WETH/DEGEN/AERO and is the fallback when no wallet is set.

Built for ElizaOS **1.x** (`@elizaos/core` ^1.0.0; tested with 1.7.2).

## What the service checks

[DevX Token Check](https://tokencheck.madebydevx.com) returns a verdict of `safe`, `caution` or `danger`. Each verdict comes with a risk score, a confidence value (capped at 0.95) and a list of reasons. It reads only public on-chain data (public RPCs, Multicall3, Chainlink and Sourcify):

- **Honeypot simulation (EVM):** a real buy, transfer and sell against the token's own pool via `eth_simulateV1` / `eth_call` state override, with measured buy, sell and transfer tax. It covers Uniswap v2/v3, Aerodrome (+Slipstream), PancakeSwap v3, Sushi and Camelot.
- **Contract surface:** bytecode selector scan for mint, blacklist, pause, fee setter, trading switch, max-tx/wallet and ownership reclaim. It also checks owner and renounce status, EIP-1967/beacon/1167 proxies and whether the implementation is verified on Sourcify.
- **Market and holders:** liquidity in USD, owner and creator holdings, deployer and contract age.
- **Chains:** Base, Ethereum, Arbitrum, Optimism, Polygon, Robinhood Chain, Solana.
- **Solana:** mint and freeze authority plus Token-2022 extensions. Market data comes from Jupiter. There is no trade simulation on Solana.

Known gaps:
- No Uniswap v4 pools (a token whose only pools are v4 shows "no liquidity").
- No full top-holder list on EVM chains.
- Heuristics can miss risks and can flag safe tokens.

**This is informational only, not financial advice.** Treat `danger` as a strong signal and `safe` as "no red flags found", not as a guarantee.

## Price and payment

- **$0.01 USDC per check**, paid on **Base** with the [x402](https://x402.org) protocol (v2, `exact` scheme). The agent's own wallet signs a USDC `transferWithAuthorization`, so it needs a little USDC on Base. It does not need ETH; the facilitator pays gas.
- **Free demo:** Base USDC, WETH, DEGEN and AERO go to `/v1/token/demo` at no cost, even when a wallet is configured.
- **Failed checks are not charged.** The service returns 400/422/502 before settling for bad input, non-tokens or RPC failure.
- **Spend safety in this client:** it signs only if the 402 asks for Base USDC, payable to the DevX address `0xe30c4544eC57ac44d8586eB49e49e267fc2d40DB`, at or below your cap (default $0.01). Any other request is refused without signing.
- The payment goes to Made by DevX, the operator of the service. This package is the client for a paid API we run.

## Install

```bash
bun add elizaos-plugin-devx-tokencheck
# or: npm install elizaos-plugin-devx-tokencheck
```

npm: https://www.npmjs.com/package/elizaos-plugin-devx-tokencheck. To get the latest unreleased code, use `bun add github:devx-agent/elizaos-plugin-devx-tokencheck`.

## Use

```ts
import { tokenCheckPlugin } from "elizaos-plugin-devx-tokencheck";

export const character = {
  name: "Trader",
  plugins: ["@elizaos/plugin-evm", "elizaos-plugin-devx-tokencheck"], // list it AFTER your swap plugin to use the guard
  settings: {
    secrets: { EVM_PRIVATE_KEY: process.env.EVM_PRIVATE_KEY },        // the agent wallet; needs a little Base USDC
    DEVX_TOKENCHECK_GUARD_ACTIONS: "EVM_SWAP_TOKENS",                  // optional pre-swap guard
  },
};
```

Or pass the plugin object (`plugins: [evmPlugin, tokenCheckPlugin]`).

### Settings

| Setting | Default | Meaning |
|---|---|---|
| `EVM_PRIVATE_KEY` | – | Agent wallet (shared with plugin-evm). Without a key, only the free demo tokens work. |
| `DEVX_TOKENCHECK_PRIVATE_KEY` | – | Separate key for Token Check payments only. It overrides `EVM_PRIVATE_KEY`. |
| `DEVX_TOKENCHECK_MAX_PRICE_USDC` | `0.01` | Highest price the plugin will sign for. |
| `DEVX_TOKENCHECK_DEMO_ONLY` | `false` | Never pay. |
| `DEVX_TOKENCHECK_GUARD_ACTIONS` | – | Comma-separated action names to guard, e.g. `EVM_SWAP_TOKENS`. |
| `DEVX_TOKENCHECK_GUARD_BLOCK_ON` | `danger` | Verdicts that block, e.g. `danger,caution`. |
| `DEVX_TOKENCHECK_GUARD_FAIL_CLOSED` | `false` | Block the swap when no verdict is available (no wallet funds, API down). By default the swap continues and a warning is logged. |
| `DEVX_TOKENCHECK_DEFAULT_CHAIN` | `base` | Chain used when the message names none. |

### Guarding a swap action in code

```ts
import { guardPluginActions, withTokenCheckGuard } from "elizaos-plugin-devx-tokencheck";
import evmPlugin from "@elizaos/plugin-evm";

const guardedEvm = guardPluginActions(evmPlugin, ["EVM_SWAP_TOKENS"], { blockOn: ["danger"] });
// or wrap a single action: withTokenCheckGuard(myBuyAction, { getToken: (rt, msg, st, opts) => ({ chain: "base", address: opts.tokenOut }) })
```

The guard reads the bought token from the action options (`outputToken`, `toToken`, `tokenOut`, `buyToken`, `toTokenAddress`, `outputMint`). If none is set, it uses the last address in the message text. Pass `getToken` when your swap action stores the token somewhere else.

### Without ElizaOS

`TokenCheckClient` is exported too:

```ts
import { TokenCheckClient, summarize } from "elizaos-plugin-devx-tokencheck";
const r = await new TokenCheckClient({ privateKey: process.env.EVM_PRIVATE_KEY }).check("base", "0x…");
console.log(r.verdict, summarize(r));
```

## Tests

```bash
npm install
npm test          # unit + mocked x402 flow + real @elizaos/core AgentRuntime + 2 live calls (no money moves)
LIVE=0 npm test   # offline only
```

The paid-path tests sign real x402 payloads with a random, unfunded key against a mocked server. One live test sends such an unfunded payment to production and checks that it is rejected and nothing is charged.

## About

Made by DevX ([madebydevx.com](https://madebydevx.com)) builds and maintains this package. JuniorX, DevX's AI agent, wrote it, and it is published from DevX's agent GitHub account (`devx-agent`). Please report issues on GitHub; a human at DevX reviews them.

License: MIT. The client code is open source. The Token Check API it calls is a hosted, paid service and is not open source.
