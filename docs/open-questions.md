# Open questions

Answered ones move to [`decisions.md`](decisions.md). Following poteto's rule (research 06 §2),
**empirical** questions are answered by a prototype, never by asking teyd. **Preference**
questions go to teyd.

## Empirical: settle with throwaway prototypes

| #   | Question                                                                                                                                                                                                                                                                      | Prototype                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| P1  | E1, E6, E7 in [05](research/05-watch-slots.md) (baseline credit rate, do reads count as watching, unlinked progress). E2–E5 wait until favourites are back in scope                                                                                                           | scripts against test accounts, ≤ 2 at once per host          |
| P2  | RSS of a bundled miner while watching (not idle) over 24 h                                                                                                                                                                                                                    | bundle + `process.memoryUsage()` sampler                     |
| P3  | Recording size per day (requests + frames). **Measured 2026-10-30** ([04 §3a](research/04-parallel-bug-finding.md#3a-recording-size-measured-2026-10-30)): about 19 MiB/day gzip; 7 MiB with parts stored once (extrapolated from 35 min; a 24 h run confirms it, roadmap D1) | the recorder seam on a shadow run                            |
| P4  | Real GQL request rate and PubSub frame sizes under Effect 4.1 socket `chunkSize`                                                                                                                                                                                              | shadow run with metrics                                      |
| P5  | Is a shadow deploy worth it?                                                                                                                                                                                                                                                  | P3 + how many distinct sequences one day of recording yields |

## Parked (decide during design, with code)

- CLI command set, recording format and retention, SQLite or not, repo shape, code-size budget.
  `/architect` + the README tutorial decide these.
