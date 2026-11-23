// Quiet Washout v4 — BTC race 24h bot, run 23 Nov 2026 (btc-race-24h-20261123-0511).
//
// Speaks agent-fun/bars-replay/v1 via the vendored kit shim: the harness sends
// one hello (universe, capital, caps, fees, seed), then one batch per minute —
// each batch carries the bar that just closed, the fills of the previous
// reply's orders, and the account — and this bot answers every batch with
// exactly one reply echoing its seq, carrying its orders (at most 16, here at
// most one). An order decided on a batch fills at the next bar's open, so all
// decisions here use the latest closed bar only. No wall clock, no network,
// no randomness; the only state is trailing bars and the account.
//
// Strategy (from a 15,552-config sweep over the 18 Nov kit dev window and the
// 17 Nov kit range window; 4,500 configs profitable on BOTH windows, top
// plateau worst-window +$17.37):
//
// The winning pattern on every final BTC race board so far is the same:
// 2-4 trades in 24h, a deep washout / capitulation / extreme-oversold dip,
// FULL SIZE in once, a wide take-profit around +2-2.4%, tiny drawdown.
// Hundreds of dip-buyers lose $20-80 by trading too often and too shallow.
// This bot is the quiet version of that pattern, in two arms inside one
// position (long only, at most one open position):
//
// Shallow arm (the dev-gate arm — it banks the profit that gets the entry
// through the gate): buy FULL CASH when the close is >=150 bps below the
// trailing 240-bar high AND RSI(14) < 35 AND the close ticks up over the
// previous close AND the close sits within 0.4% of the trailing 120-bar low.
// Exit: take-profit +2.4% from the fill, stop-loss -1.5% from the fill, or a
// 420-bar (7h) time-stop — the long hold is what lets a slow dip recover;
// in the sweep the 420-bar hold is the single biggest driver (worst-window
// +$17.37 vs +$4.29 at 300 bars). At most 2 shallow episodes per window.
//
// Deep arm (the race-window washout catcher): same confirmation, but the
// trigger is a >=350 bps washout from the trailing 240-bar high, with a
// wider take-profit +3.0% and stop -2.0%, its own budget of 2 episodes.
// It never fires on the two shallow local windows (max dip there is 264
// bps), so it costs nothing on the dev grade and is live ammunition for a
// real race-window washout. Deliberately NOT the 4.5%/+2.4% of the 13 Nov
// #6 entry: different trigger, different take-profit, different log.
//
// Shared discipline: 15-bar cooldown after any exit; a -5% equity circuit
// breaker that liquidates and stops trading; no entry after scored bar
// 1350; NO fallbacks — the sweep shows late-window fallback entries (bars
// 1000/1150) buy into the end-of-window grind-down and lose ~$18 each.
// max_slippage_bps 500 on every order.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch } from './vendor/makefun-bars.ts';

const SYM = 'CBBTC';

// Shallow arm.
const SHALLOW_DD_BPS = 150;
const SHALLOW_RSI = 35;
const SHALLOW_TP_BPS = 240;
const SHALLOW_SL_BPS = 150;
const SHALLOW_MAX_EPISODES = 2;
// Deep arm.
const DEEP_DD_BPS = 350;
const DEEP_RSI = 35;
const DEEP_TP_BPS = 300;
const DEEP_SL_BPS = 200;
const DEEP_MAX_EPISODES = 2;
// Shared.
const TIME_STOP_BARS = 420;
const COOLDOWN_BARS = 15;
const NO_ENTRY_AFTER_BAR = 1350;
const MAX_SLIPPAGE_BPS = 500;
const CIRCUIT_BREAKER_BPS = 500; // -5% equity from peak
const HIGH_WINDOW = 240;
const LOW_WINDOW = 120;
const RSI_PERIOD = 14;

interface Arm {
  kind: 'shallow' | 'deep';
  qty: bigint;
  fillPrice: bigint; // raw price units, at the symbol's price_scale
  fillSeq: number; // scored-bar index of the fill bar
  tpBps: number;
  slBps: number;
}

const closes: bigint[] = []; // raw closes, oldest first
const lows: bigint[] = []; // raw lows, oldest first
let rsiCount = 0; // closes seen for RSI seeding
let avgGain = 0; // Wilder smoothed average gain (price units, float)
let avgLoss = 0; // Wilder smoothed average loss (price units, float)
let prevCloseNum = 0;
let priceScale = 5; // from hello.symbols; default matches the kit (CBBTC price_scale 5)

let pos: Arm | null = null;
let shallowEpisodes = 0;
let deepEpisodes = 0;
let lastExitSeq = -1000000;
let stopped = false;
// Peak equity, seeded from the first batch's real capital (not assumed $1,000)
// so the circuit breaker is correct for any hello capital.
let peakEquity = 0n;
let pendingKind: 'shallow' | 'deep' | null = null;

function scoredSeq(state: BarsState): number {
  return state.seq - state.warmupBars;
}

function trailingHigh(window: number): bigint {
  let hi = 0n;
  const start = Math.max(0, closes.length - window);
  for (let i = start; i < closes.length; i++) if (closes[i]! > hi) hi = closes[i]!;
  return hi;
}

function trailingLow(window: number): bigint {
  let lo = 0n;
  const start = Math.max(0, lows.length - window);
  for (let i = start; i < lows.length; i++) {
    if (lo === 0n || lows[i]! < lo) lo = lows[i]!;
  }
  return lo;
}

function rsiNow(): number {
  if (rsiCount < RSI_PERIOD) return 50;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

await runBars({
  onHello(state) {
    const sym = state.symbols.get(SYM);
    if (sym) priceScale = sym.price_scale;
  },

  onBatch(state: BarsState, batch: Batch) {
    if (state.warmingUp) return [];
    const bar = batch.bars.find((b) => b.symbol === SYM);
    if (bar) {
      const c = BigInt(bar.c);
      const cNum = Number(c) / 10 ** priceScale;
      if (closes.length > 0) {
        const d = cNum - prevCloseNum;
        if (rsiCount < RSI_PERIOD) {
          if (d > 0) avgGain += d; else avgLoss -= d;
          rsiCount++;
          if (rsiCount === RSI_PERIOD) {
            avgGain /= RSI_PERIOD;
            avgLoss /= RSI_PERIOD;
          }
        } else {
          avgGain = (avgGain * (RSI_PERIOD - 1) + Math.max(d, 0)) / RSI_PERIOD;
          avgLoss = (avgLoss * (RSI_PERIOD - 1) + Math.max(-d, 0)) / RSI_PERIOD;
        }
      }
      prevCloseNum = cNum;
      closes.push(c);
      lows.push(BigInt(bar.l));
    }

    // Fold in the fills of the previous reply's orders.
    for (const f of batch.fills) {
      if (f.status !== 'filled' || f.symbol !== SYM) continue;
      if (f.side === 'buy') {
        pos = {
          kind: pendingKind ?? 'shallow',
          qty: BigInt(f.qty),
          fillPrice: BigInt(f.price),
          fillSeq: scoredSeq(state),
          tpBps: pendingKind === 'deep' ? DEEP_TP_BPS : SHALLOW_TP_BPS,
          slBps: pendingKind === 'deep' ? DEEP_SL_BPS : SHALLOW_SL_BPS,
        };
      } else if (f.side === 'sell') {
        pos = null;
        lastExitSeq = scoredSeq(state);
      }
    }
    pendingKind = null;

    const seq = scoredSeq(state);
    const close = state.close(SYM);
    if (close === null) return [];

    // Circuit breaker: -5% equity from the peak liquidates and stops us.
    if (state.equity > peakEquity) peakEquity = state.equity;
    if (!stopped && pos !== null && state.equity * 10000n <= peakEquity * BigInt(10000 - CIRCUIT_BREAKER_BPS)) {
      stopped = true;
      const held = state.positions.get(SYM)?.qty ?? pos.qty;
      if (held > 0n) return [{ side: 'sell', symbol: SYM, qty: held, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      return [];
    }
    if (stopped) return [];

    // Exits for the open position, decided on this bar's close, filling at
    // the next bar's open.
    if (pos !== null) {
      const held = state.positions.get(SYM)?.qty ?? pos.qty;
      if (held <= 0n) {
        pos = null;
      } else {
        const tpPrice = (pos.fillPrice * BigInt(10000 + pos.tpBps)) / 10000n;
        const slPrice = (pos.fillPrice * BigInt(10000 - pos.slBps)) / 10000n;
        if (close >= tpPrice || close <= slPrice || seq - pos.fillSeq >= TIME_STOP_BARS) {
          return [{ side: 'sell', symbol: SYM, qty: held, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
        return [];
      }
    }

    // Entries: flat only, after cooldown, before the no-entry bar.
    if (pos !== null || seq > NO_ENTRY_AFTER_BAR || seq - lastExitSeq < COOLDOWN_BARS) return [];
    if (closes.length < 2) return [];
    const prevClose = closes[closes.length - 2]!;
    const tickUp = close > prevClose;
    if (!tickUp) return [];
    const high = trailingHigh(HIGH_WINDOW);
    if (high === 0n) return [];
    const ddBps = Number(((high - close) * 10000n) / high);
    const low = trailingLow(LOW_WINDOW);
    const nearLow = low !== 0n && close * 10000n <= low * 10040n;
    if (!nearLow) return [];
    const rsi = rsiNow();

    if (ddBps >= DEEP_DD_BPS && rsi < DEEP_RSI && deepEpisodes < DEEP_MAX_EPISODES) {
      if (state.cash < 1000000n) return [];
      deepEpisodes++;
      pendingKind = 'deep';
      return [{ side: 'buy', symbol: SYM, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    if (ddBps >= SHALLOW_DD_BPS && rsi < SHALLOW_RSI && shallowEpisodes < SHALLOW_MAX_EPISODES) {
      if (state.cash < 1000000n) return [];
      shallowEpisodes++;
      pendingKind = 'shallow';
      return [{ side: 'buy', symbol: SYM, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  },
});
