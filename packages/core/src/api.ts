import type { ChainKey } from "./chains";
import type { OrderType } from "./routing";
import type {
  ApiErrorBody,
  BalanceView,
  Candle,
  LeaderboardRow,
  MeView,
  NotificationView,
  OrderView,
  Page,
  PortfolioView,
  ProfileView,
  PublicConfig,
  QuoteView,
  ReplyView,
  SignerStatus,
  StepResult,
  TapeTrade,
  ThesisProof,
  StatsView,
  TrackerPostKind,
  TrackerPostView,
  TrackerSource,
  ThesisView,
  Timeframe,
  TokenDetail,
  TokenListItem,
  TraderResult,
  TradeView,
} from "./types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  getToken?: () => Promise<string | null> | string | null;
  fetch?: typeof fetch;
}

type Query = Record<string, string | number | boolean | undefined | null>;

/** Typed client for the API. No DOM or Node dependencies, so a later Expo app reuses it as is. */
export class ApiClient {
  constructor(private readonly options: ApiClientOptions) {}

  private async request<T>(method: string, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
    const url = new URL(path, this.options.baseUrl);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const token = await this.options.getToken?.();
    if (token) headers.authorization = `Bearer ${token}`;
    const doFetch = this.options.fetch ?? fetch;
    const res = await doFetch(url.toString(), {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      throw new ApiError(res.status, "bad_response", "The server sent an unreadable response.");
    }
    if (!res.ok) {
      const err = (json as ApiErrorBody | undefined)?.error;
      throw new ApiError(res.status, err?.code ?? "error", err?.message ?? `Request failed (${res.status})`, err?.details);
    }
    return json as T;
  }

  config = () => this.request<PublicConfig>("GET", "/v1/config");

  devLogin = (handle: string) => this.request<{ token: string }>("POST", "/v1/auth/dev", { body: { handle } });
  me = () => this.request<MeView>("GET", "/v1/me");
  syncMe = () => this.request<MeView>("POST", "/v1/me/sync", { body: {} });
  updateMe = (body: { username?: string; avatarUrl?: string | null }) => this.request<MeView>("PATCH", "/v1/me", { body });
  balance = () => this.request<BalanceView>("GET", "/v1/me/balance");

  marketList = (query: { tab: "trending" | "new"; chain?: ChainKey }) =>
    this.request<{ items: TokenListItem[]; attribution: string }>("GET", "/v1/market/tokens", { query });
  search = (q: string, chain?: ChainKey) =>
    this.request<{ items: TokenListItem[] }>("GET", "/v1/market/search", { query: { q, chain } });
  searchUsers = (q: string) => this.request<{ items: TraderResult[] }>("GET", "/v1/users/search", { query: { q } });
  token = (chain: ChainKey, address: string) => this.request<TokenDetail>("GET", `/v1/tokens/${chain}/${address}`);
  candles = (chain: ChainKey, address: string, tf: Timeframe) =>
    this.request<{ candles: Candle[]; attribution: string }>("GET", `/v1/tokens/${chain}/${address}/candles`, { query: { tf } });
  tape = (chain: ChainKey, address: string) =>
    this.request<{ items: TapeTrade[] }>("GET", `/v1/tokens/${chain}/${address}/trades`);
  myPosition = (chain: ChainKey, address: string) =>
    this.request<{ position: PortfolioView["open"][number] | null }>("GET", `/v1/tokens/${chain}/${address}/position`);

  quote = (body: { chain: ChainKey; address: string; side: "buy" | "sell"; amountUsd?: string; sellPct?: number; copyThesisId?: string }) =>
    this.request<QuoteView>("POST", "/v1/quotes", { body });
  executeTrade = (body: { quoteId: string; idempotencyKey: string; confirmed?: boolean }) =>
    this.request<TradeView>("POST", "/v1/trades", { body });
  submitSteps = (tradeId: string, results: StepResult[]) =>
    this.request<TradeView>("POST", `/v1/trades/${tradeId}/steps`, { body: { results } });
  trade = (id: string) => this.request<TradeView>("GET", `/v1/trades/${id}`);
  trades = (query: { cursor?: string } = {}) => this.request<Page<TradeView>>("GET", "/v1/trades", { query });

  portfolio = () => this.request<PortfolioView>("GET", "/v1/portfolio");

  stats = () => this.request<StatsView>("GET", "/v1/stats");

  tracker = (source: TrackerSource, opts: { before?: string; kind?: TrackerPostKind } = {}) =>
    this.request<{ items: TrackerPostView[]; configured: boolean }>("GET", `/v1/trackers/${source}`, { query: opts });

  orders = (query: { status?: "open" | "all"; chain?: ChainKey; address?: string } = {}) =>
    this.request<{ items: OrderView[] }>("GET", "/v1/orders", { query });
  createOrder = (body: { chain: ChainKey; address: string; type: OrderType; triggerPriceUsd: string; amountUsd?: string; sellPct?: number }) =>
    this.request<OrderView>("POST", "/v1/orders", { body });
  cancelOrder = (id: string) => this.request<OrderView>("DELETE", `/v1/orders/${id}`);

  theses = (query: {
    tab?: "top" | "recent" | "following";
    chain?: ChainKey;
    address?: string;
    username?: string;
    minPosition?: number;
    sort?: "liked" | "recent";
    includeUnverified?: boolean;
    cursor?: string;
    limit?: number;
  }) => this.request<Page<ThesisView>>("GET", "/v1/theses", { query });
  thesis = (id: string) => this.request<ThesisView>("GET", `/v1/theses/${id}`);
  thesisProof = (id: string) => this.request<ThesisProof>("GET", `/v1/theses/${id}/proof`);
  createThesis = (body: { chain: ChainKey; address: string; body: string }) =>
    this.request<ThesisView>("POST", "/v1/theses", { body });
  deleteThesis = (id: string) => this.request<void>("DELETE", `/v1/theses/${id}`);
  likeThesis = (id: string) => this.request<void>("POST", `/v1/theses/${id}/like`, { body: {} });
  unlikeThesis = (id: string) => this.request<void>("DELETE", `/v1/theses/${id}/like`);
  replies = (id: string) => this.request<{ items: ReplyView[] }>("GET", `/v1/theses/${id}/replies`);
  reply = (id: string, body: string) => this.request<ReplyView>("POST", `/v1/theses/${id}/replies`, { body: { body } });
  deleteReply = (thesisId: string, replyId: string) =>
    this.request<void>("DELETE", `/v1/theses/${thesisId}/replies/${replyId}`);

  profile = (username: string) => this.request<ProfileView>("GET", `/v1/users/${username}`);
  userPositions = (username: string) => this.request<{ open: PortfolioView["open"]; closed: PortfolioView["closed"] }>("GET", `/v1/users/${username}/positions`);
  follow = (username: string) => this.request<void>("POST", `/v1/users/${username}/follow`, { body: {} });
  unfollow = (username: string) => this.request<void>("DELETE", `/v1/users/${username}/follow`);
  block = (username: string) => this.request<void>("POST", `/v1/users/${username}/block`, { body: {} });
  unblock = (username: string) => this.request<void>("DELETE", `/v1/users/${username}/block`);
  blocks = () => this.request<{ items: Array<{ id: string; username: string; avatarUrl: string | null }> }>("GET", "/v1/me/blocks");
  report = (body: { thesisId?: string; username?: string; reason: "spam" | "scam" | "abuse" | "other"; note?: string }) =>
    this.request<void>("POST", "/v1/reports", { body });

  leaderboard = () => this.request<{ items: LeaderboardRow[]; minResolved: number }>("GET", "/v1/leaderboard");

  notifications = () => this.request<{ items: NotificationView[]; unread: number }>("GET", "/v1/notifications");
  markNotificationsRead = () => this.request<void>("POST", "/v1/notifications/read", { body: {} });
  pushSubscribe = (body: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    this.request<void>("POST", "/v1/push/subscribe", { body });
  pushUnsubscribe = (endpoint: string) => this.request<void>("DELETE", "/v1/push/subscribe", { query: { endpoint } });

  signer = () => this.request<SignerStatus>("GET", "/v1/signer");
  grantSigner = (body: { perTradeCapUsd?: string; dailyCapUsd?: string }) =>
    this.request<SignerStatus>("POST", "/v1/signer/grant", { body });
  approveFlash = () => this.request<SignerStatus>("POST", "/v1/signer/approve", { body: {} });
  updateCaps = (body: { perTradeCapUsd: string; dailyCapUsd: string }) =>
    this.request<SignerStatus>("PATCH", "/v1/signer/caps", { body });
  revokeSigner = () => this.request<SignerStatus>("DELETE", "/v1/signer");
  revokeApprovals = () => this.request<{ txHash: string | null; steps: unknown[] }>("POST", "/v1/signer/revoke-approvals", { body: {} });

  paperWithdraw = (body: { to: string; amountUsd: string }) => this.request<BalanceView>("POST", "/v1/paper/withdraw", { body });
  paperDeposit = () => this.request<BalanceView>("POST", "/v1/paper/deposit", { body: {} });
}
