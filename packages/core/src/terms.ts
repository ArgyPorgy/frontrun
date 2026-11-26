/** Bump when the terms change in a way people need to agree to again. */
export const TERMS_VERSION = "2026-11-26";

/** What someone confirms before they can trade. The full terms are at /legal/terms. */
export const ELIGIBILITY_CONFIRMATIONS: readonly string[] = [
  "I'm 18 or older, and using this app is lawful where I live.",
  "I'm not a US person and I'm not trading from the United States. Tokenized stocks are only offered to people in eligible places outside the US.",
  "I'm not in, or a resident of, a country or region under US sanctions, and I'm not on a sanctions list.",
  "I understand trading tokens, tokenized stocks and leveraged perps can lose some or all of what I put in, and AI agents I run can make losing trades on their own.",
  "Nothing in this app is financial, investment, legal or tax advice.",
];
