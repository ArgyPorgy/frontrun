"use client";

import { formatPrice, type Candle, type ChainKey, type ThesisView, type Timeframe } from "@frontrun/core";
import { useQuery } from "@tanstack/react-query";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useLivePrice } from "@/lib/socket";
import { Avatar } from "./ui";

const TF_SECONDS: Record<Timeframe, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
const TIMEFRAMES = Object.keys(TF_SECONDS) as Timeframe[];

const toBar = (c: Candle): CandlestickData<UTCTimestamp> => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close });

/** Thesis pins sit on the chart at (post time, price at post). Plain trades never appear here. */
function ThesisPins({
  chart,
  series,
  pins,
  tfSeconds,
  onOpen,
  width,
  height,
}: {
  chart: IChartApi;
  series: ISeriesApi<"Candlestick">;
  pins: ThesisView[];
  tfSeconds: number;
  onOpen(pin: ThesisView): void;
  width: number;
  height: number;
}) {
  const nodes = useRef(new Map<string, HTMLButtonElement>());

  // Pins are absolutely placed DOM nodes. Positions follow pan, zoom and price-scale changes, and
  // writing to style directly each frame keeps this cheap without re-rendering React.
  useEffect(() => {
    let frame = 0;
    const update = () => {
      const time = chart.timeScale();
      for (const pin of pins) {
        const node = nodes.current.get(pin.id);
        if (!node) continue;
        const bar = (Math.floor(Date.parse(pin.ts) / 1000 / tfSeconds) * tfSeconds) as UTCTimestamp;
        const x = time.timeToCoordinate(bar);
        const y = series.priceToCoordinate(Number(pin.priceAtPost));
        if (x === null || y === null || x < 0 || y < 0 || x > width - 40 || y > height) {
          node.style.display = "none";
        } else {
          node.style.display = "block";
          node.style.transform = `translate(${x - 13}px, ${y - 13}px)`;
        }
      }
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [chart, series, pins, tfSeconds, width, height]);

  return (
    // z-10 because the chart's canvases set their own z-index, which would otherwise swallow taps.
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      {pins.map((pin) => (
        <button
          key={pin.id}
          ref={(el) => {
            if (el) nodes.current.set(pin.id, el);
            else nodes.current.delete(pin.id);
          }}
          onClick={() => onOpen(pin)}
          aria-label={`Thesis by ${pin.author.username} at ${formatPrice(pin.priceAtPost)}`}
          title={`${pin.author.username}: ${pin.body.slice(0, 60)}`}
          className={`pointer-events-auto absolute top-0 left-0 hidden rounded-full border-2 ${pin.verified ? "border-signal" : "border-faint"} bg-bg`}
        >
          <Avatar user={pin.author} size={22} />
        </button>
      ))}
    </div>
  );
}

export function PriceChart({
  chain,
  address,
  pins,
  onOpenPin,
}: {
  chain: ChainKey;
  address: string;
  pins: ThesisView[];
  onOpenPin(pin: ThesisView): void;
}) {
  const [tf, setTf] = useState<Timeframe>("15m");
  const container = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lastBar = useRef<CandlestickData<UTCTimestamp> | null>(null);
  const [ready, setReady] = useState<{ chart: IChartApi; series: ISeriesApi<"Candlestick"> } | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const candles = useQuery({
    queryKey: ["candles", chain, address, tf],
    queryFn: () => api.candles(chain, address, tf),
    refetchInterval: 45_000,
    retry: 5,
    retryDelay: (attempt) => Math.min(4000 * 2 ** attempt, 30_000),
  });

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#8d9299",
        fontFamily: "var(--font-geist-mono), monospace",
        fontSize: 10,
        // Lightweight Charts' license requires attribution, and this logo satisfies it.
        attributionLogo: true,
      },
      grid: { vertLines: { color: "#14151a" }, horzLines: { color: "#14151a" } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { priceFormatter: (price: number) => formatPrice(price).replace("$", "") },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#35db98",
      downColor: "#eb5271",
      borderVisible: false,
      wickUpColor: "#35db98",
      wickDownColor: "#eb5271",
      priceFormat: { type: "custom", minMove: 1e-12, formatter: (price: number) => formatPrice(price).replace("$", "") },
    });
    chartRef.current = chart;
    seriesRef.current = series;
    setReady({ chart, series });
    const observer = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }));
    observer.observe(el);
    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      setReady(null);
    };
  }, []);

  // Between candle refreshes, the live 1-second price patches the newest bar.
  const tick = useLivePrice(chain, address);
  const tickRef = useRef(tick);
  tickRef.current = tick;

  const applyTick = useCallback(() => {
    const series = seriesRef.current;
    const current = tickRef.current;
    if (!series || !current) return;
    const price = Number(current.priceUsd);
    if (!Number.isFinite(price) || price <= 0) return;
    const seconds = TF_SECONDS[tf];
    const barTime = (Math.floor(Date.now() / 1000 / seconds) * seconds) as UTCTimestamp;
    const last = lastBar.current;
    if (last && barTime < last.time) return;
    const bar: CandlestickData<UTCTimestamp> =
      last && last.time === barTime
        ? { ...last, high: Math.max(last.high, price), low: Math.min(last.low, price), close: price }
        : { time: barTime, open: last?.close ?? price, high: price, low: price, close: price };
    lastBar.current = bar;
    series.update(bar);
  }, [tf]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !candles.data) return;
    const bars = candles.data.candles.map(toBar);
    series.setData(bars);
    lastBar.current = bars[bars.length - 1] ?? null;
    if (bars.length) chartRef.current?.timeScale().fitContent();
    // Candles lag the live feed, so the newest price goes back on top straight away. Without this
    // the chart flickers to a stale close on every refresh.
    applyTick();
  }, [candles.data, applyTick]);

  useEffect(applyTick, [tick, applyTick]);

  const empty = candles.isSuccess && candles.data.candles.length === 0;
  const waiting = candles.isError || candles.isLoading;

  return (
    <div>
      <div className="relative h-[300px] w-full md:h-[420px]">
        <div ref={container} className="absolute inset-0" />
        {ready && <ThesisPins chart={ready.chart} series={ready.series} pins={pins} tfSeconds={TF_SECONDS[tf]} onOpen={onOpenPin} width={size.width} height={size.height} />}
        {(waiting || empty) && !tick && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <p className="rounded-lg bg-bg/80 px-3 py-1.5 text-xs text-muted">{candles.isLoading ? "Loading chart…" : "Chart data is catching up"}</p>
          </div>
        )}
      </div>
      <div className="flex items-center justify-between px-3 pt-1">
        <div className="flex gap-0.5" role="tablist" aria-label="Timeframe">
          {TIMEFRAMES.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={t === tf}
              onClick={() => setTf(t)}
              className={`num rounded-md px-2 py-1 text-xs font-medium ${t === tf ? "bg-raised text-ink" : "text-faint"}`}
            >
              {t}
            </button>
          ))}
        </div>
        <a href="https://www.geckoterminal.com" target="_blank" rel="noreferrer" className="text-[10px] text-faint">
          {candles.data?.attribution ?? "Data from GeckoTerminal"}
        </a>
      </div>
    </div>
  );
}
