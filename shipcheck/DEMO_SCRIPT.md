# Demo script

## Before recording

1. `npm install` (once), then `npm start`, and open http://localhost:8080 full screen (1920×1080 works best). Close the dev tools.
2. The default scenario is **RCRV: real 3D model (ShipConstructor via APS)**. Wait until the badge in the 3D view says
   **"Autodesk APS viewer · real RCRV model"** (about 20 s the first time). The demo waits for it if you start earlier, but the 28 s timing assumes it is loaded.
3. Role: **Engineer**. Run `npm test` once in a terminal you can show later.
4. No internet, or APS is down: open http://localhost:8080/?noaps. The 3D view switches to the saved screenshots and the findings
   still come from the local check. Every caption and step stays the same.
5. `?demo` starts the run-through on load. **Esc** stops it.

## Opening shot: the "Demo run-through" button (about 27 s)

The captions are generated from the data, so the numbers are always correct.

| Time | On screen | Caption | Voice-over (suggestion) |
| --- | --- | --- | --- |
| 0-3 s | The real RCRV model, neutral | "OSU RCRV: real ShipConstructor production model. 330,760 objects in the model, 35,328 parts checked, inches converted to mm" | "This is the real production model of the OSU research vessel, straight from ShipConstructor." |
| 3-6 s | Parts turn green / amber / red group by group | "Checking 6 rules on real design data: IACS unified requirements, SOLAS, IGC Code, data quality" | "We check it against IACS steel rules, SOLAS and the data quality itself." |
| 6-9 s | Summary and ground-truth box pulse | "6 non-compliant, 3,651 not enough info, 19,875 compliant. Ground truth: 13/13 hand-checked findings, 6/6 counts match an independent scan, 0 false alarms" | "Every result is checked against a ground truth: no false alarms." |
| 9-14 s | Camera isolates the first red part (P1770, the rest dimmed); its rule card pulses | "P1770: ASTM A106 in hull structure (SWBS 100)", plus the UR W11 1.4 quote | "This hull stiffener is a 12-inch pipe of ASTM A106. That is not a hull steel grade, so it needs special approval from class. The tool quotes the rule." |
| 14-16 s | Switch to the cruise deck (Three.js view) | "Cruise passenger deck: same checker, passenger rules" | "Same checker, a passenger deck." |
| 16-20 s | Corridor C2 selected; both failing rule cards and the governing note pulse | "C2 fails 2 overlapping rules: FSS-13-CORRIDOR (≥ 900 mm) + ADA-403.5.1 (≥ 915 mm). The strictest governs: ≥ 915 mm" | "800 mm fails SOLAS and the ADA at once, and the tool shows which value governs." |
| 20-24 s | "1000" is typed into clear_width; C2 turns green | "C2 is now compliant with both rules. Re-checked in < 1 ms, logged as a session edit" | "The engineer fixes it and gets the answer instantly." |
| 24-27 s | Report and CSV buttons pulse | "Export the findings: HTML report and CSV" | "And exports the findings for the class review." |

Backup if anything fails: pick **Cruise passenger deck (fictional)** and click C2 by hand. It is the same story without the 3D model.

## Pitch: 2-3 minutes

**1. Problem (20 s).** Ships must comply with SOLAS, MARPOL, Load Line, class rules, ADA and PVAG. Checking is manual,
needs years of experience, and issues found in the 3-4 week class review come back late, often after the design has moved on.

**2. Solution (20 s).** ShipCheck reads the design model, as it comes out of the design tool (here a real ShipConstructor model
via Autodesk APS, in inches), applies a rule database and flags issues while the engineer works. Every finding shows what
was measured, what is required, the rule text, and where each value came from (5/16" = 7.94 mm).

**3. Live demo (60 s).** The run-through above, then live:
- In the RCRV model, open an amber Grade A shell plate (e.g. **P977**, 5/8" = 15.88 mm). UR S6 Table 7 passes for Class I/II
  but not Class III. The material class is not in the model, so the tool says *not enough info* instead of guessing. Set
  `material_class` to III: it turns red. Set it to I: green.
- Show the oil fuel system: 5083 aluminium pipes and hoses are amber. SOLAS allows "other approved material", and the
  approval is not in the model.
- Show **MIN-THK-SWBS**: a draft rule that is listed but never run, because no official value is in the project yet.
- Show VERIFY.md: what the Meyer mentors confirmed (DNV, reviewed rule values) and the open questions (steel-grade table under 90 m, LCG origin).

**4. Trust (30 s).**
- Pass/fail comes only from the deterministic checker: same input, same result. No LLM is involved in it.
- `npm test` (48 tests): ground truth for every planted case (cruise 7/7, RCRV layout 8/8) and for the real model (13 hand-checked
  findings, plus every bulk count recomputed by an independent scan of the source data), 0 false alarms, edge cases and
  boundary values (UR S6 table bands, 36 in vs 915 mm).
- No invented rule values: every value is marked *not yet verified*, interpretations are labelled (UR S6 is for ships of 90 m and above,
  and the RCRV is about 60 m), and unknown values stay empty.
- Works offline: the check runs locally; precomputed results and screenshots cover a missing 3D viewer.

**5. Roadmap (20 s).** Verify the rule values against the official DNV/IMO texts with Meyer's rule experts; add the member category (UR S6 Table 1); add spaces and escape routes from the GA/OCX data; integrate into the design tool so issues are flagged as the
design changes, before the class review.

**6. Ask (10 s).** A verified rule set for one area (hull materials or means of escape) and an anonymised cruise model, to run a
pilot with one design team.
