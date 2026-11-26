import { describe, expect, it } from "vitest";
import { FRONTRUN_BUILDER_CODE, builderCodeSuffix, builderCodesIn, withBuilderCode } from "../src";

const MARKER = "80218021802180218021802180218021";

describe("Builder Codes", () => {
  it("encodes a code exactly as Base's docs do", () => {
    expect(builderCodeSuffix(["bc_b7k3p9da"])).toBe("0x62635f62376b33703964610b0080218021802180218021802180218021");
  });

  it("carries Front Run's code by default", () => {
    expect(builderCodesIn(builderCodeSuffix())).toEqual([FRONTRUN_BUILDER_CODE]);
    expect(builderCodeSuffix()).toBe(`0x${Buffer.from(FRONTRUN_BUILDER_CODE).toString("hex")}0b00${MARKER}`);
  });

  it("puts the app's and an agent's codes side by side", () => {
    const suffix = builderCodeSuffix([FRONTRUN_BUILDER_CODE, "bc_agent123"]);
    expect(builderCodesIn(suffix)).toEqual([FRONTRUN_BUILDER_CODE, "bc_agent123"]);
    expect(suffix.slice(-36, -32)).toBe("1700");
  });

  it("appends to calldata without touching it, and only once", () => {
    const approve = "0x095ea7b3000000000000000000000000000000000000000000000000000000000000dead00000000000000000000000000000000000000000000000000000000000003e8";
    const tagged = withBuilderCode(approve);
    expect(tagged.startsWith(approve)).toBe(true);
    expect(tagged.endsWith(MARKER)).toBe(true);
    expect(withBuilderCode(tagged)).toBe(tagged);
    expect(builderCodesIn(tagged)).toEqual([FRONTRUN_BUILDER_CODE]);
  });

  it("tags a plain transfer with no calldata", () => {
    expect(withBuilderCode(undefined)).toBe(builderCodeSuffix());
    expect(withBuilderCode("0x")).toBe(builderCodeSuffix());
  });

  it("finds nothing in calldata without a code", () => {
    expect(builderCodesIn("0x095ea7b3")).toBeNull();
  });
});
