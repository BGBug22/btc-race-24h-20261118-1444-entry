# Two-Mode Tranche Racer — btc-race-24h-20261118-1444

[![make.fun](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/competitions/btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/BGBug22/btc-race-24h-20261118-1444-entry/rank.svg)](https://make.fun/competitions/btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/BGBug22/btc-race-24h-20261118-1444-entry/reward.svg)](https://make.fun/competitions/btc-race-24h-20261118-1444)

A trading bot for the [make.fun "Race a BTC trading bot live for 24 hours" competition](https://make.fun/competitions/btc-race-24h-20261118-1444). It trades Coinbase Wrapped BTC (cbBTC) against USDC on 1-minute on-chain bars, starting with 1,000 USDC of paper money, long only.

## Strategy

Two modes, picked by the 60-minute return:

- **Ranging** (|60m return| < 40 bps): scalp a trailing-peak ladder. Buy a $50 tranche every time the price falls 25 bps below the trailing peak, sell each tranche at +60 bps above its own fill price. Total position capped at $400.
- **Trending** (60m return > +60 bps and the last 5 minutes stalled): ride momentum with a $400 buy. Dump everything when the 60m return turns below −20 bps.

It never buys into a falling market, never buys in the last 60 bars, and every order carries a 100 bps max slippage. All decisions come from the bars and fills on the wire only — deterministic, no clock, no network, no randomness.

## Layout

- `main.ts` — the bot (Node 22, erasable TypeScript, standard library only)
- `vendor/makefun-bars.ts` — the kit's SDK shim, copied byte for byte
- `LICENSE` — MIT

## Local grade

From the unpacked kit directory:

```
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process
```

## License

MIT — see [LICENSE](LICENSE).
