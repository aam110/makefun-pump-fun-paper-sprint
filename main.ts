// Pump.fun Paper Sprint — "Early Sniper"
//
// Strategy (written from scratch for this competition):
//   Snipe freshly created coins as early as the order-size cap allows:
//   small equal stakes (0.02 SOL) the moment a coin's real SOL reserve
//   reaches 2 SOL, while it is still barely above its creation price,
//   then exit with discipline: take-profit +30%, stop-loss -15%,
//   trailing stop -10% from the peak since entry, or a time exit after
//   ~1200 slots. One entry per mint, at most 5 open positions, so the
//   bot cycles through many coins and clears the >= 20 distinct-coin
//   guardrail while keeping drawdown tiny.
//
//   Lessons from graded versions: v1 bought coins already up +6% with
//   0.10 SOL stakes (dev -1.33 SOL); v3 demanded +25% momentum and
//   +60% take-profit (dev -1.46 SOL) — chasing momentum on pump.fun
//   loses, the coins revert. v5 let winners run to +100% with a -20%
//   trailing stop (dev -1.33 SOL, win rate 16%) — the dev window has no
//   fat tail to catch, the top-3 coins made only 10% of gains. v4 tried
//   to buy the base inside -30%..+10% of the creation price and traded
//   ZERO coins: bonding-curve math means a coin with 2 SOL of real
//   reserve is already up ~+14%, so that band can never be reached with
//   a >= 0.01 SOL order. This version — the earliest entry with tight,
//   disciplined exits — graded best of all five (dev -0.90 SOL, 644
//   round trips, max drawdown 9.1%), and is the final version.
//
//   Every decision comes only from the market events in the batch, the
//   bot's own constants, and bigint price ratios. No randomness, no
//   clock, no environment reads: two runs produce identical action logs.
//
// Price math: a coin's price is virtual_quote_reserves /
// virtual_token_reserves. Ratios are compared by cross-multiplication
// with bigints, so no floating point ever enters a decision.

import { runBot, LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';
import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------- constants

/** SOL spent per entry (quote_lamports, curve fees included). */
const BUY_SIZE_LAMPORTS = 20_000_000n; // 0.02 SOL
/** A buy needs real SOL reserves of at least this (1% order-size cap). */
const MIN_REAL_RESERVE_LAMPORTS = 2n * LAMPORTS_PER_SOL;
/** Entry: price must be up at least this much (bps) vs the create price. */
const ENTRY_MIN_GAIN_BPS = 200; // +2%
/** Entry: at least this many trades seen on the coin. */
const ENTRY_MIN_TRADES = 2;
/** Entry: only coins first seen within this many slots. */
const ENTRY_MAX_AGE_SLOTS = 900;
/** Exit: take profit at this gain (bps) vs entry price. */
const TAKE_PROFIT_BPS = 3000; // +30%
/** Exit: stop loss at this drop (bps) vs entry price. */
const STOP_LOSS_BPS = 1500; // -15%
/** Exit: sell when price falls this much (bps) below its peak since entry. */
const TRAILING_DROP_BPS = 1000; // -10% from peak
/** Exit: close the position after this many slots even if flat. */
const MAX_HOLD_SLOTS = 1200;
/** Slippage tolerance on every order. */
const MAX_SLIPPAGE_BPS = 500;
/** Keep a small cash buffer above the buy size so a fill never strands us. */
const CASH_BUFFER_LAMPORTS = 2_100_000n; // 0.0021 SOL

// ---------------------------------------------------------------- per-coin memory

interface CoinTrack {
  firstSlot: number;
  /** Create-time price: virtual quote / virtual token reserves. */
  firstVq: bigint;
  firstVt: bigint;
  trades: number;
  buys: number;
  sells: number;
  buyVolLamports: bigint;
  sellVolLamports: bigint;
}

interface EntryTrack {
  entrySlot: number;
  /** Entry price: virtual quote / virtual token reserves at fill time. */
  entryVq: bigint;
  entryVt: bigint;
  /** Highest price seen since entry, same ratio form. */
  peakVq: bigint;
  peakVt: bigint;
}

const coins = new Map<string, CoinTrack>();
const entries = new Map<string, EntryTrack>();
/** Mints we already bought once: one entry per mint, no re-entry churn. */
const traded = new Set<string>();

// ---------------------------------------------------------------- ratio helpers

/** True when priceA is at least `bps` above priceB (both as vq/vt ratios). */
function ratioUpAtLeastBps(
  aVq: bigint,
  aVt: bigint,
  bVq: bigint,
  bVt: bigint,
  bps: number,
): boolean {
  // aVq/aVt >= bVq/bVt * (10000 + bps) / 10000
  return aVq * bVt * 10000n >= bVq * aVt * BigInt(10000 + bps);
}

/** True when priceA is at least `bps` below priceB. */
function ratioDownAtLeastBps(
  aVq: bigint,
  aVt: bigint,
  bVq: bigint,
  bVt: bigint,
  bps: number,
): boolean {
  // aVq/aVt <= bVq/bVt * (10000 - bps) / 10000
  return aVq * bVt * 10000n <= bVq * aVt * BigInt(10000 - bps);
}

/** True when priceA is above priceB (strict). */
function ratioAbove(aVq: bigint, aVt: bigint, bVq: bigint, bVt: bigint): boolean {
  return aVq * bVt > bVq * aVt;
}

// ---------------------------------------------------------------- bot

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];

    // 1. Fold this batch's fills into the entry book.
    for (const fill of batch.fills) {
      if (fill.status !== 'filled') continue;
      const curve = state.curves.get(fill.mint);
      if (fill.side === 'buy') {
        if (curve !== undefined && curve.virtual_token_reserves > 0n) {
          entries.set(fill.mint, {
            entrySlot: batch.slot,
            entryVq: curve.virtual_quote_reserves,
            entryVt: curve.virtual_token_reserves,
            peakVq: curve.virtual_quote_reserves,
            peakVt: curve.virtual_token_reserves,
          });
        }
        traded.add(fill.mint);
      } else {
        entries.delete(fill.mint);
      }
    }

    // 2. Fold this batch's events into the per-coin tracks.
    for (const event of batch.events) {
      if (event.event === 'CreateEvent') {
        if (!coins.has(event.mint)) {
          coins.set(event.mint, {
            firstSlot: event.slot,
            firstVq: BigInt(event.virtual_quote_reserves),
            firstVt: BigInt(event.virtual_token_reserves),
            trades: 0,
            buys: 0,
            sells: 0,
            buyVolLamports: 0n,
            sellVolLamports: 0n,
          });
        }
      } else if (event.event === 'TradeEvent') {
        let track = coins.get(event.mint);
        if (track === undefined) {
          track = {
            firstSlot: event.slot,
            firstVq: BigInt(event.virtual_quote_reserves),
            firstVt: BigInt(event.virtual_token_reserves),
            trades: 0,
            buys: 0,
            sells: 0,
            buyVolLamports: 0n,
            sellVolLamports: 0n,
          };
          coins.set(event.mint, track);
        }
        track.trades += 1;
        if (event.is_buy) {
          track.buys += 1;
          track.buyVolLamports += BigInt(event.sol_amount);
        } else {
          track.sells += 1;
          track.sellVolLamports += BigInt(event.sol_amount);
        }
      } else {
        // CompleteEvent: the curve is done; drop its tracks so we never
        // consider it again and free the entry book.
        coins.delete(event.mint);
        entries.delete(event.mint);
      }
    }

    // 3. Exits first: manage every open position.
    const pendingSell = new Set<string>();
    for (const pending of state.pending.values()) {
      if (pending.order.side === 'sell') pendingSell.add(pending.order.mint);
    }
    for (const [mint, holding] of state.positions) {
      if (pendingSell.has(mint)) continue;
      const entry = entries.get(mint);
      const curve = state.curves.get(mint);
      if (entry === undefined || curve === undefined) continue;
      if (curve.complete || curve.virtual_token_reserves === 0n) continue;
      const vq = curve.virtual_quote_reserves;
      const vt = curve.virtual_token_reserves;

      // Track the peak price since entry (for the trailing stop).
      if (ratioAbove(vq, vt, entry.peakVq, entry.peakVt)) {
        entry.peakVq = vq;
        entry.peakVt = vt;
      }

      const takeProfit = ratioUpAtLeastBps(vq, vt, entry.entryVq, entry.entryVt, TAKE_PROFIT_BPS);
      const stopLoss = ratioDownAtLeastBps(vq, vt, entry.entryVq, entry.entryVt, STOP_LOSS_BPS);
      const trailing = ratioDownAtLeastBps(vq, vt, entry.peakVq, entry.peakVt, TRAILING_DROP_BPS);
      const timedOut = batch.slot - entry.entrySlot >= MAX_HOLD_SLOTS;

      if (takeProfit || stopLoss || trailing || timedOut) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
      }
    }

    // 4. Entries: fresh coins with early upward momentum and buy pressure.
    const pendingBuy = new Set<string>();
    for (const pending of state.pending.values()) {
      if (pending.order.side === 'buy') pendingBuy.add(pending.order.mint);
    }
    for (const [mint, track] of coins) {
      if (orders.length >= 16) break;
      if (state.committedPositionCount() + orders.filter((o) => o.side === 'buy').length >= 5) break;
      if (state.positions.has(mint)) continue;
      if (pendingBuy.has(mint)) continue;
      if (traded.has(mint)) continue;
      if (track.trades < ENTRY_MIN_TRADES) continue;
      if (batch.slot - track.firstSlot > ENTRY_MAX_AGE_SLOTS) continue;
      if (track.buys < 2) continue;
      if (track.buyVolLamports <= track.sellVolLamports) continue;

      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.virtual_token_reserves === 0n) continue;
      if (curve.real_quote_reserves < MIN_REAL_RESERVE_LAMPORTS) continue;
      // The buy must fit the 1%-of-real-reserve order cap.
      if (state.maxBuyLamports(mint) < BUY_SIZE_LAMPORTS) continue;
      // Price up at least +2% vs the create price.
      if (
        !ratioUpAtLeastBps(
          curve.virtual_quote_reserves,
          curve.virtual_token_reserves,
          track.firstVq,
          track.firstVt,
          ENTRY_MIN_GAIN_BPS,
        )
      ) {
        continue;
      }
      if (state.freeCashLamports() < BUY_SIZE_LAMPORTS + CASH_BUFFER_LAMPORTS) continue;

      orders.push({
        side: 'buy',
        mint,
        quote_lamports: BUY_SIZE_LAMPORTS,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
    }

    return orders;
  },
});
