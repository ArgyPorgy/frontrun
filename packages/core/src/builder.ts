/**
 * Base Builder Codes (ERC-8021). Every transaction this app sends carries this suffix, so Base can credit the
 * activity to Front Run. Contracts ignore trailing calldata, so it changes nothing about what a call does.
 * https://docs.base.org/specifications/builder-codes/overview
 */
export const FRONTRUN_BUILDER_CODE = "bc_oxe9mzh6";

/** Sixteen bytes of 0x8021 that mark the end of calldata as carrying attribution. */
const ERC_8021_MARKER = "80218021802180218021802180218021";
/** Schema 0: codes read against Base's canonical registry. */
const SCHEMA_CANONICAL = "00";

function asciiHex(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code > 0x7e || code < 0x20) throw new Error(`Builder codes are plain ASCII, and this isn't: ${text}`);
    out += code.toString(16).padStart(2, "0");
  }
  return out;
}

/** The suffix for these codes: the codes joined by commas, their length, the schema, then the marker. */
export function builderCodeSuffix(codes: readonly string[] = [FRONTRUN_BUILDER_CODE]): `0x${string}` {
  const joined = asciiHex([...new Set(codes)].join(","));
  const length = joined.length / 2;
  if (!length || length > 255) throw new Error("Builder codes have to fit in 255 bytes.");
  return `0x${joined}${length.toString(16).padStart(2, "0")}${SCHEMA_CANONICAL}${ERC_8021_MARKER}`;
}

/** Calldata with the suffix on the end. Safe to call twice: data that already carries one is left alone. */
export function withBuilderCode(data: string | undefined, codes: readonly string[] = [FRONTRUN_BUILDER_CODE]): `0x${string}` {
  const body = (data ?? "0x").replace(/^0x/, "");
  if (body.toLowerCase().endsWith(ERC_8021_MARKER)) return `0x${body}`;
  return `0x${body}${builderCodeSuffix(codes).slice(2)}`;
}

/** The codes a transaction's calldata carries, or null if it carries none. For checking our own work. */
export function builderCodesIn(data: string): string[] | null {
  const hex = data.replace(/^0x/, "").toLowerCase();
  if (!hex.endsWith(ERC_8021_MARKER) || hex.length < ERC_8021_MARKER.length + 4) return null;
  const head = hex.slice(0, -ERC_8021_MARKER.length);
  if (head.slice(-2) !== SCHEMA_CANONICAL) return null;
  const length = parseInt(head.slice(-4, -2), 16);
  const codesHex = head.slice(-4 - length * 2, -4);
  if (codesHex.length !== length * 2) return null;
  let text = "";
  for (let i = 0; i < codesHex.length; i += 2) text += String.fromCharCode(parseInt(codesHex.slice(i, i + 2), 16));
  return text.split(",");
}
