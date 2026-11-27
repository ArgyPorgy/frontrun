import { STOCK_MARKETS } from "@frontrun/core";
import { encodeAbiParameters, keccak256 } from "viem";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgres://localhost/unused";
  process.env.REDIS_URL ??= "redis://localhost:6379/15";
});

const { marketParamsFor, oraclePriceUsd, sharesToAssetsDown, sharesToAssetsUp } = await import("../src/lending/markets");
const { agentEvmRules, evmRules } = await import("../src/trading/policy");

describe("Morpho reads", () => {
  it("prices one share from a Morpho oracle", () => {
    // Read from the NVDAc market's oracle, with the feed at $155.26074030.
    expect(oraclePriceUsd(1_552_607_403_000_000_000_000_000_000_000_000_000n, 8)).toBeCloseTo(155.26074, 5);
  });

  it("rounds supply down and debt up, with virtual shares", () => {
    const totalAssets = 1_000_000_000n;
    const totalShares = 990_000_000_000_000n;
    const shares = 99_000_000_000_000n;
    const down = sharesToAssetsDown(shares, totalAssets, totalShares);
    const up = sharesToAssetsUp(shares, totalAssets, totalShares);
    expect(Number(down)).toBeCloseTo(100_000_000, -2);
    expect(up - down).toBeLessThanOrEqual(1n);
    expect(up).toBeGreaterThanOrEqual(down);
  });

  it("every market id is the hash of its params", () => {
    for (const m of STOCK_MARKETS) {
      const p = marketParamsFor(m);
      const id = keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }], [p.loanToken, p.collateralToken, p.oracle, p.irm, p.lltv]));
      expect(id).toBe(m.id);
    }
  });
});

describe("signer policy", () => {
  it("lets wallets reach Aave, Morpho and the vaults, for users and agents alike", () => {
    for (const rules of [evmRules(), agentEvmRules("0x0000000000000000000000000000000000000001")]) {
      const routers = rules.find((r) => r.name.startsWith("Call known routers"))!.conditions[0]!.value as string[];
      const spenders = rules.find((r) => r.name.startsWith("Approve known spenders"))!.conditions[0]!.value as string[];
      for (const a of ["0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", "0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61"]) {
        expect(routers).toContain(a.toLowerCase());
        expect(spenders).toContain(a.toLowerCase());
      }
    }
  });
});
