# Quiet Washout v4 — BTC race 24h bot

Entry for `btc-race-24h-20261123-0511` ($50, 10 paid places, race window
23 Nov 2026). Long-only cbBTC paper trading on the `agent-fun/bars-replay/v1`
protocol: the harness sends one `hello`, then one `batch` per minute (each
batch carries the bar that just closed, the fills of the previous reply's
orders, and the account), and this bot answers every batch with exactly one
reply echoing its seq, carrying its orders.

## Strategy

The winning pattern on every final BTC race board so far is the same: 2–4
trades in 24h, a deep washout / capitulation / extreme-oversold dip, FULL SIZE
in once, a wide take-profit around +2–2.4%, tiny drawdown. Hundreds of
dip-buyers lose $20–80 by trading too often and too shallow. This bot is the
quiet version of that pattern, in two arms inside one position:

- **Shallow arm** (the dev-gate arm): buy FULL CASH when the close is ≥150
  bps below the trailing 240-bar high AND RSI(14) < 35 AND the close ticks up
  over the previous close AND the close sits within 0.4% of the trailing
  120-bar low. Exit: take-profit +2.4% from the fill, stop-loss −1.5%, or a
  420-bar (7h) time-stop. At most 2 shallow episodes per window.
- **Deep arm** (the race-window washout catcher): same confirmation, but the
  trigger is a ≥350 bps washout from the trailing 240-bar high, with a wider
  take-profit +3.0% and stop −2.0%, its own budget of 2 episodes. It never
  fires on the two shallow local windows (max dip there is 264 bps), so it
  costs nothing on the dev grade and is live ammunition for a real
  race-window washout. Deliberately NOT the 4.5%/+2.4% of the 13 Nov #6
  entry: different trigger, different take-profit, different log.

Shared discipline: 15-bar cooldown after any exit; a −5% equity circuit
breaker that liquidates and stops trading; no entry after scored bar 1350;
NO fallbacks — the sweep shows late-window fallback entries (bars 1000/1150)
buy into the end-of-window grind-down and lose ~$18 each.
`max_slippage_bps` 500 on every order.

## Offline sweep (what picked these numbers)

15,552 configs swept over the 18 Nov kit dev window and the 17 Nov kit
range window (same fill model as the rules: fill at next bar open, 4 bps fee
+ 2 bps slippage + constant-product impact vs open depth). 4,500 configs were
profitable on BOTH windows; the top plateau (worst-window +$17.37) is the
config above. The single biggest driver is the 420-bar hold: worst-window
+$17.37 vs +$4.29 at 300 bars. The deep-dip race arm (DD 3.5–4.5%) cannot be
validated on these shallow windows — it never fires there — so it is included
as a second arm and was validated on a synthetic deep-dip series in the
protocol smoke test.

Local results (offline sweep, same engine for all methods):

| method | 18 Nov dev | 17 Nov range |
| --- | --- | --- |
| v1 Capitulation Sniper (re-impl.) | $0.00, 0 trades | $0.00, 0 trades |
| v2 Washout Fisher v2 (re-impl.) | −$24.71, 8 trades, 50% win, DD 3.61% | +$2.21, 4 trades, 50% win, DD 1.70% |
| v3 Washout Ladder v3 (re-impl.) | −$2.90, 8 trades, DD 0.63% | +$1.05, 4 trades, DD 0.21% |
| **v4 Quiet Washout (this bot)** | **+$19.16, 4 trades, 2 RT, 100% win, DD 1.51%** | **+$17.37, 3 trades, 1 RT, 100% win, DD 0.66%** |

v1/v2/v3 numbers are re-implementations from their brief specs on the same
engine — not the originals' numbers (the original v2 dev was +$29.48 on its
own earlier window).

## Files

- `main.ts` — the bot (Node 22, type stripping, stdlib only + vendored SDK).
- `vendor/makefun-bars.ts` — byte-for-byte copy of the kit SDK.
- `README.md` — this file.
- `LICENSE` — MIT.

## Grade

Run the kit's official grader (never the raw CLI):

```
~/workspace/makefun/makefun-safe.sh <18Nov-kit>/cli/makefun.mjs grade-local \
  --kit <18Nov-kit-dir> --bot <this repo> --driver docker
```

Deterministic: no wall clock, no network, no randomness; two runs produce
byte-identical action logs.
