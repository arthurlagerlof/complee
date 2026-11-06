# VERIFY: values that are not yet checked against the official text

Policy: no rule value is trusted until a team member has compared it with the official source.
Until then the rule keeps `"verified": false` in `rules.json`, and the UI shows the tag
*"Rule value not yet verified against official text"* on every result that uses it.
`npm test` fails if a rule with `verified: false` is missing from this file.

How to verify a rule:
1. Open the official source below (or the copy provided by Meyer Turku / the class society).
2. Check the **value**, the **unit**, the **clause number** and the **applicability** (ship type, size, area).
3. Replace `text` with the verbatim clause text and set `"text_status": "verbatim"`.
4. Set `"verified": true` and add your initials and the date in the `clause` or a `verified_by` field.

## Rules

| Rule id | Value to check | Check against | Notes |
| --- | --- | --- | --- |
| `FSS-13-CORRIDOR` | corridor clear width ≥ 900 mm | FSS Code Ch. 13 (means of escape) / SOLAS II-2/13 | Clause number unknown. FSS Ch. 13 may size corridors like stairways (persons-based). |
| `FSS-13-STAIR` | stair clear width ≥ 900 mm | FSS Code Ch. 13, para 2 (stairways) | Width grows with the number of persons; only the minimum is checked. |
| `SOLAS-II-2-13-ESCAPE-ACCOM` | ≥ 2 means of escape per accommodation section/zone | SOLAS II-2/13.3 (passenger), 13.4 (cargo) | "Widely separated" is not checked geometrically. Research vessel: check SPS Code applicability. |
| `SOLAS-II-2-13-ESCAPE-MACH` | ≥ 2 means of escape from category A machinery spaces | SOLAS II-2/13.4.2 (cargo) / 13.3.? (passenger) | One may be an escape trunk; check the exact conditions. |
| `SOLAS-II-2-13-DEADEND-PAX` | dead-end corridor ≤ 13 m (passenger ships) | SOLAS II-2/13.3.1 | Value from memory. |
| `SOLAS-II-2-13-DEADEND-CARGO` | dead-end corridor ≤ 7 m (cargo ships) | SOLAS II-2/13.4.? ; SPS Code for research vessels | Value from memory; applying cargo-ship rules to a research vessel is our interpretation (`basis: interpretation`). |
| `ADA-403.5.1` | walking surface ≥ 36 in (915 mm) | ADA 2010 Standards 403.5.1; PVAG (36 CFR Part 1196) | **Unit question:** the governing value is 36 in = 914.4 mm. With 915 mm, a design of exactly 36 in fails by 0.6 mm (see test "edge: 36 in"). Decide whether to store 36 in. |
| `ADA-404.2.3` | door clear width ≥ 32 in (815 mm) | ADA 2010 Standards 404.2.3; PVAG | Same unit question: 32 in = 812.8 mm. |
| `ADA-405.2` | ramp slope ≤ 1:12 (0.0833) | ADA 2010 Standards 405.2; PVAG | 0.0833 is 1/12 rounded; 1/12 = 0.08333. |
| `IGF-LNG-LOCATION` | LNG tank not adjacent to passenger spaces | IGF Code Part A-1, Ch. 5 (ship design and arrangement) | **Simplified.** Not a literal clause; based on mentor guidance (design practice). |
| `IGF-5.3.3-SIDE` | tank ≥ min(B/5, 11.5 m) from the ship side | IGF Code 5.3.3 | Official text measures at the summer load line, at right angles to the centreline; we measure on the deck plan. Probabilistic alternative (5.3.4) is not modelled. |
| `LL-REG12-SILL` | door sill ≥ 380 mm | ICLL 1966 Annex I, Reg. 12(2) | Applies to doors in end bulkheads of enclosed superstructures; companionways (Reg. 18) differ: 600 mm / 380 mm by position. |
| `LL-REG25-GUARDRAIL` | guard rail / bulwark ≥ 1 m | ICLL 1966 Annex I, Reg. 25(2) | Also limits openings (lowest course ≤ 230 mm, others ≤ 380 mm), not yet checked. |
| `DNV-GUARDRAIL` | guard rail ≥ 1.0 m | DNV Rules for Classification of Ships (Veracity portal), hull equipment chapter | Part/chapter/section unknown. Example of a class rule overlapping a statutory rule. |
| `MARPOL-I-12-SLUDGE` | sludge tank required from 400 GT | MARPOL Annex I, Reg. 12 | Only checks that a sludge tank exists, not its capacity. |

Reference URLs in `rules.json` point to the convention overview pages (IMO, US Access Board, DNV) and must also be checked.

## Ship particulars (RCRV, `ships/rcrv/ship.json`)

| Value | Used | Check against |
| --- | --- | --- |
| Length overall about 60.65 m (199 ft) | Load Line applicability (≥ 24 m) | OSU / UNOLS particulars. **Conflict:** OSU press material says 193 ft. Either value is above 24 m, so the result does not change. |
| Beam 12.5 m (41 ft) | hull outline, IGF B/5 (not applied: MGO) | OSU RCRV ship design page |
| Draft about 3.81 m | display only | OSU RCRV ship design page |
| Berths 31 (16 science, 2 technicians, 13 crew) | display only | OSU / UNOLS |
| Diesel-electric propulsion | display only | OSU |
| Gross tonnage 1200 | MARPOL Annex I applicability (≥ 400 GT) | **Estimated.** Find the official GT; any value above 400 gives the same result. |
| Class society DNV | DNV class rule applicability | **Assumed for the demo.** Check the real class society of the RCRV. |

## Layout (RCRV)

All deck outlines, rooms, corridors, stairs, doors and tanks are `"source": "estimated"`: no GA drawing PDF was available
when the model was built. To improve: put the GA sheets into `source/`, take dimensions from them, and change the
element's `source` to `"GA drawing <sheet>"`. Planted values (`"source": "planted test case (fictional value)"`) are
deliberate test cases and must stay as they are, or `tests/expected/rcrv.json` must be updated with them.
