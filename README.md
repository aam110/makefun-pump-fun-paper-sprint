# Pump.fun Paper Sprint — Early Sniper

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/aam110/makefun-pump-fun-paper-sprint/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/aam110/makefun-pump-fun-paper-sprint/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Entry for **Pump.fun Paper Sprint: Any Bot Can Win** — a paper-trading bot that
replays 6 hours of pump.fun bonding-curve data. Highest net PnL wins the $2 pot.

## Strategy: Early Sniper

Snipe freshly created coins as early as the order-size cap allows: small,
equal-sized stakes of **0.02 SOL** the moment a coin's real SOL reserve
reaches 2 SOL, while it is still barely above its creation price, then
exit with discipline:

- **Entry** — a coin first seen within the last ~900 slots, with at least
  2 trades, at least 2 buys, buy volume ahead of sell volume, price up at
  least **+2%** vs its creation price, and real SOL reserves of at least
  2 SOL (so the 0.02 SOL order fits the 1%-of-reserve size cap).
- **Exit** — take profit at **+30%**, stop loss at **−15%**, trailing stop
  **−10%** from the peak since entry, or a time exit after ~1200 slots.
  One entry per mint, at most 5 open positions at a time, so the bot cycles
  through many coins and clears the ≥ 20 distinct-coin guardrail.
- **Costs** — every round trip pays ~1.25% in curve fees plus 105,000
  lamports of fixed transaction fees, so the +30% / −15% exits are sized
  far above the fee floor and the bot never churns.

## Determinism

Every decision comes only from the market events in each batch, the bot's
own constants, and bigint price-ratio comparisons. No randomness, no clock,
no environment reads — two executions produce byte-identical action logs.

## Files

- `main.ts` — the strategy (Node 22, erasable TypeScript only).
- `vendor/makefun-bot.ts` — the house bot shim (`agent-fun/replay/v2`).
- `LICENSE` — MIT.

## How it runs

The harness (`agent-fun/replay/v2`) streams `hello`, `batch`, and `done`
messages over stdin; the bot answers each batch with at most 16 orders
(buys and sells) and the harness fills them two slots later. Starting
capital is 10 SOL, maximum 5 open positions, no shorts, no leverage.
