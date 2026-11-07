# VERIFY: values that are not yet checked against the official text

Policy: no rule value is trusted until a team member has compared it with the official source.
Until then the rule keeps `"verified": false` in `rules.json`, and the UI shows the tag
*"Rule value not yet verified against official text"* on every result that uses it.
`npm test` fails if a rule with `verified: false` is missing from this file.

**Review status (Meyer mentors, Q&A 7 Nov):** the mentors reviewed how every rule value is shown and found it fine. Each rule therefore carries
`"review_status": "reviewed by Meyer mentors (Q&A, 7 Nov)"` next to `"verified": false`, and the UI and report show it. This is a review of the
presentation, **not** a verification against the official text: `verified` stays `false` until a team member has checked the value as described below.

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

### Rules for the real RCRV 3D model (`rcrv-3d`, ShipConstructor data via APS)

| Rule id | Value to check | Check against | Notes |
| --- | --- | --- | --- |
| `IACS-W11-HULL-GRADE` | Hull steel grades A, B, D, E, A/D/E/F 32, 36, 40 ("H" may be added: AH36 = A36) | IACS UR W11 Rev.9, 1.1-1.4 and the grade table, note 1 | Text extracted from a mirror copy of the IACS PDF (turkloydu.org); compare with iacs.org.uk. **Interpretation:** requiring SWBS 1xx carbon-steel parts to be a W11 grade (unless specially approved, W11 1.4) is our reading of class practice. Finds 6 stiffeners made of 12" pipe (ASTM A106 Gr B, API 5L X-52): ask whether class approved them. |
| `IACS-S6-T7-GRADE-THICKNESS` | Table 7 bands and grades (t ≤ 15 / 20 / 25 / 30 / 35 / 40 / 50 mm; Classes I, II, III; MS and HT) | IACS UR S6 Rev.9, S6.1, Table 1, Table 7 | **UR S6 is for ships ≥ 90 m; RCRV is about 60 m.** Applied as the closest published table. Material class (Table 1) is not in the model, so results stay *not enough info* until the engineer sets `material_class`. Grade A/AH outside 0.4L amidships is not evaluated (no position reference). |
| `MIN-THK-SWBS` | *(no value)* minimum plate thickness per structural group | ABS Rules for vessels under 90 m, or DNV Pt.3 (minimum thickness formulas) | **Draft, not run.** No official value is in the project, so none is guessed. Closest check the data supports: every plate has a parsed thickness. |
| `IGC-3.5.3.1.2-HATCH-OPENING` | clear opening ≥ 600 × 600 mm | IGC Code 3.5.3.1.2 (quoted in IACS UI GC16); 46 CFR 154.340 | **Interpretation:** a gas-carrier access rule used as the reference minimum. Sizes come from item names (30"X36" = 762 × 914.4 mm). Round manholes (15", 18") are not checked. |
| `SOLAS-II-2-4.2.2.5.1-FO-PIPE` | oil fuel pipes, valves, fittings of steel or other approved material | SOLAS II-2/4.2.2.5.1 | Paraphrase; get the consolidated text. Non-steel items (5083 aluminium pipe, hoses, ductile iron and bronze valves, "STAINLEESS") are *not enough info*: approval is not in the model. Does SOLAS apply to the RCRV at all (46 CFR Subchapter U)? |
| `DQ-DESIGN-STATUS` | VFI must be "Final" | internal data-quality check (no official value) | 2,459 items are "Preliminary". |
| `DQ-ERROR-VALUES` | no field may hold "Error" / "---" | internal data-quality check (no official value) | 4 raised manholes (032-LDRMHS.dwg). |

**ShipCheck classifications to review** (in `src/parts-model.mjs`, applied to the model's text fields):
- Material family: `CS …` and `ASTM A36/A53/A106/A131/A500` = carbon steel; `AL …` = aluminium; `SS …` = stainless; `DETA`, `FABREEKA`, `ASTM E-84` = non-structural (deck covering, resilient pads, fire-test standard). Anything else (`AIR AIR` on 21 superpanel plates) = unknown.
- Pipe material family from `MC` (steel, copper alloy, plastic, flexible, cast iron, aluminium, insulation).
- Oil fuel systems: `sys`/`pli` containing FUEL OIL, FO, F.O., DIESEL OIL, MGO, MDO.
- SWBS groups use the first code: 114 → 110, 1001 → 100, "100,150" → 100. Group names are the ESWBS 1xx titles.

### Data that does not support a requested check

- **Escape routes, corridors, rooms:** the production model has no spaces, so `SOLAS-II-2-13-*`, `FSS-13-*` and ADA rules cannot run on `rcrv-3d`. Closest supported check: hatch clear openings from item names. The layout rules run on the cruise example deck and on the layout test fixture.
- **Minimum thickness per structural group:** data supports it (thickness + SWBS on 10,008 plates), but the rule value is missing (see `MIN-THK-SWBS`).
- **Piping material per system:** only oil fuel has an official text in the project (SOLAS II-2/4.2.2.5.1). Other systems (sea water, bilge, potable water) are not checked until a rule text is supplied.

## Answered by the Meyer mentors (Q&A, 7 Nov)

- **Class society: DNV** (confirmed by Meyer mentors (Q&A, 7 Nov)). The model still names materials with ABS grade designations ("CS ABS A"); the hull steel grades of IACS UR W11 are the same under DNV.
- **Rule values:** how they are shown was reviewed and found fine (see *Review status* above). They stay `verified: false`.
- **Example decks:** approved. Passenger-ship rules (accessibility, LNG) are shown on an example deck because the RCRV research vessel has no passenger areas or LNG.
- **Drawing codes** in the drawing names: not needed; not used by any rule.

## Open mentor questions

1. Which DNV steel-grade table applies to a vessel under 90 m? Is UR S6 Table 7 an acceptable reference?
2. Origin and direction of LCG / TCG / VCG (frame 0, AP, midship?), so that "within 0.4L amidships" can be computed.
3. Were the 12" pipe stiffeners (ASTM A106 Gr B, API 5L X-52, drawings 022-D10-00_TTP SUPERPANEL and 091-SSH) specially approved as hull material?
4. What is the minimum clear opening for escape hatches on the RCRV (46 CFR Subchapter U, DNV)?
5. Does SOLAS II-2 apply to the RCRV, and are the 5083 aluminium oil fuel pipes approved?
6. Is "AIR AIR" the placeholder material of superpanel plates, or a modelling error?

## Ship particulars (RCRV: `ships/rcrv/rcrv-3d.meta.json`, and the layout test fixture `tests/fixtures/rcrv-layout.json`)

| Value | Used | Check against |
| --- | --- | --- |
| Length overall about 60.65 m (199 ft) | Load Line applicability (≥ 24 m) | OSU / UNOLS particulars. **Conflict:** OSU press material says 193 ft. Either value is above 24 m, so the result does not change. |
| Beam 12.5 m (41 ft) | hull outline, IGF B/5 (not applied: MGO) | OSU RCRV ship design page |
| Draft about 3.81 m | display only | OSU RCRV ship design page |
| Berths 31 (16 science, 2 technicians, 13 crew) | display only | OSU / UNOLS |
| Diesel-electric propulsion | display only | OSU |
| Gross tonnage 1200 | MARPOL Annex I applicability (≥ 400 GT) | **Estimated.** Find the official GT; any value above 400 gives the same result. |
| Class society DNV | class rule applicability | Confirmed by Meyer mentors (Q&A, 7 Nov). |

## Layout test fixture (RCRV, `tests/fixtures/rcrv-layout.json`)

All deck outlines, rooms, corridors, stairs, doors and tanks are `"source": "estimated"`: no GA drawing PDF was available
when the model was built. To improve: put the GA sheets into `source/`, take dimensions from them, and change the
element's `source` to `"GA drawing <sheet>"`. Planted values (`"source": "planted test case (fictional value)"`) are
deliberate test cases and must stay as they are, or `tests/expected/rcrv-layout.json` must be updated with them.
