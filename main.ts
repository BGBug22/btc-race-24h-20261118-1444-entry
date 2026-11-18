// Two-mode tranche racer for cbBTC/USDC (agent-fun/bars-replay/v1).
//
// Idea, in one paragraph: the market spends most of its time chopping inside a
// range and occasionally trends hard for an hour or two. So the bot has two
// modes. In a ranging market (the 60-minute return is small) it scalps: it
// buys a small tranche every time the price falls a step below the trailing
// peak and sells each tranche when it recovers a take-profit above its own
// cost — but only once the last five minutes have stopped falling — never
// holding more than $400 of the $1,000 at once. In a trending
// market it only rides momentum: it buys a full tranche when the 60-minute
// return is strongly positive and the last few minutes have stalled their
// fall, and it dumps everything when the 60-minute return turns negative.
// It never buys into a falling market, never buys in the last 60 bars (no
// time left to exit), and it never chases: every order is sized, capped and
// given a 100 bps max slippage. All decisions come from the bars and fills
// on the wire only; nothing is random and nothing reads the clock.
//
// Parameters were picked by backtesting the published dev window with an
// exact replica of the harness fill model, then checked for robustness on
// transformed copies of that window (reversed, hour-shuffled, an added
// uptrend, an added downtrend, a flattened copy). The chosen set is the one
// that stayed positive on the dev window with the smallest drawdown, not
// the one that squeezed the dev window hardest.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- tunable parameters (all in basis points or USDC) -----------------------
const STEP_BPS = 25; // grid buy: price this far below the trailing peak
const TP_BPS = 60; // take-profit above a tranche's own fill price
const TRANCHE_USDC = 50; // grid buy size
const MAX_POS_USDC = 400; // cap on the total position value
const RANGE_BPS = 40; // |60m return| below this counts as "ranging"
const MOM_ENTER_BPS = 60; // 60m return above this arms a momentum buy
const MOM_EXIT_BPS = -20; // 60m return below this dumps everything
const MOM_TRANCHE_USDC = 400; // momentum buy size
const STALL_BPS = 10; // momentum buy needs the last 5m return above -10 bps
const BRAKE_USD = 10; // stop new grid buys while unrealised loss is worse
const TAIL_BARS = 60; // no new buys in the last 60 bars of the window
const MAX_SLIPPAGE_BPS = 100;
const UNIT = 1_000_000n; // quote units per USDC

// Floor division for bigints (JS / truncates toward zero; the backtest used
// floor division, so keep the two identical at the decision boundaries).
function floordiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && ((a < 0n) !== (b < 0n)) ? q - 1n : q;
}

interface Lot {
  qty: bigint;
  price: bigint;
}

const closes: bigint[] = [];
const lots: Lot[] = [];
let peak: bigint | null = null;

function retBps(now: bigint, ago: bigint): bigint {
  return floordiv((now - ago) * 10_000n, ago);
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    // Find this batch's CBBTC bar, if it has one.
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return []; // gap minute: nothing to decide on

    const close = BigInt(bar.c);
    closes.push(close);
    if (peak === null || close > peak) peak = close;

    // Fold the fills of the previous batch's orders into the lot book.
    for (const f of batch.fills) {
      if (f.status !== 'filled' || f.symbol !== SYMBOL) continue;
      if (f.side === 'buy') {
        lots.push({ qty: BigInt(f.qty), price: BigInt(f.price) });
      } else {
        let left = BigInt(f.qty);
        while (left > 0n && lots.length > 0) {
          const first = lots[0]!;
          const take = left < first.qty ? left : first.qty;
          first.qty -= take;
          left -= take;
          if (first.qty === 0n) lots.shift();
        }
      }
    }

    if (state.warmingUp) return [];

    const orders: { side: 'buy' | 'sell'; symbol: string; notional_quote_units?: bigint; qty?: bigint; max_slippage_bps: number }[] = [];

    // Position value at the latest close, per lot floored like the backtest.
    const posValue = (): bigint =>
      lots.reduce((s, l) => s + floordiv(l.qty * close, 10_000_000n), 0n);
    // Unrealised P&L of the open lots, in quote units.
    const unreal = (): bigint =>
      lots.reduce((s, l) => s + floordiv((close - l.price) * l.qty, 10_000_000n), 0n);

    const n60 = closes.length > 60 ? retBps(close, closes[closes.length - 61]!) : null;
    const n5 = closes.length > 5 ? retBps(close, closes[closes.length - 6]!) : null;

    // --- exits: take-profit per lot --------------------------------------
    let tpQty = 0n;
    const keep: Lot[] = [];
    for (const l of lots) {
      const tp = floordiv(l.price * BigInt(10_000 + TP_BPS), 10_000n);
      if (close >= tp) tpQty += l.qty;
      else keep.push(l);
    }
    if (tpQty > 0n) {
      orders.push({ side: 'sell', symbol: SYMBOL, qty: tpQty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      lots.length = 0;
      lots.push(...keep);
    }

    // --- exit: momentum has turned ---------------------------------------
    if (lots.length > 0 && n60 !== null && n60 < BigInt(MOM_EXIT_BPS)) {
      const all = lots.reduce((s, l) => s + l.qty, 0n);
      orders.push({ side: 'sell', symbol: SYMBOL, qty: all, max_slippage_bps: MAX_SLIPPAGE_BPS });
      lots.length = 0;
    }

    // --- entries -----------------------------------------------------------
    // The window is 1,440 one-minute bars; stop opening in the last hour.
    if (state.seq < 1440 - TAIL_BARS) {
      const ranging = n60 !== null && n60 < BigInt(RANGE_BPS) && n60 > BigInt(-RANGE_BPS);
      let tranche = 0n;
      if (ranging) {
        // Grid scalp: price a step below the trailing peak, only once the
        // last five minutes have stopped falling, and only while the open
        // lots are not deeply underwater.
        const buyBelow = floordiv(peak! * BigInt(10_000 - STEP_BPS), 10_000n);
        const stallOk = n5 !== null && n5 >= 0n;
        const brakeOk = unreal() > BigInt(-BRAKE_USD) * UNIT;
        if (close <= buyBelow && stallOk && brakeOk) {
          tranche = BigInt(TRANCHE_USDC) * UNIT;
          peak = close; // next rung needs another step down from here
        }
      } else if (n60 !== null && n60 > BigInt(MOM_ENTER_BPS) && n5 !== null && n5 > BigInt(-STALL_BPS)) {
        // Momentum: the hour is strongly up and the last minutes stalled.
        tranche = BigInt(MOM_TRANCHE_USDC) * UNIT;
      }
      if (tranche > 0n && state.cash >= tranche && posValue() + tranche <= BigInt(MAX_POS_USDC) * UNIT) {
        orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: tranche, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
    }

    return orders;
  },
});
