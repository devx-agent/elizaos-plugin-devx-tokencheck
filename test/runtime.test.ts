import { it, expect } from "vitest";
import { AgentRuntime } from "@elizaos/core";
import plugin from "../src/index";

it("registers in a real @elizaos/core AgentRuntime", async () => {
  const swap: any = { name: "EVM_SWAP_TOKENS", description: "swap", validate: async () => true, handler: async () => ({ success: true }) };
  const rt = new AgentRuntime({ character: { name: "t", bio: "t", settings: { DEVX_TOKENCHECK_GUARD_ACTIONS: "EVM_SWAP_TOKENS" } } as any });
  await rt.registerPlugin({ name: "fake-evm", description: "x", actions: [swap] });
  await rt.registerPlugin(plugin);
  const names = rt.actions.map((a) => a.name);
  expect(names).toContain("CHECK_TOKEN");
  expect((rt.actions.find((a) => a.name === "EVM_SWAP_TOKENS") as any).__devxGuarded).toBe(true);
});
