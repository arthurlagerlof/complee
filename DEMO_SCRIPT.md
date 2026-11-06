# Demo script

## Before recording

1. `npm install` (once, with internet), then `npm start`. Everything runs offline after that (Three.js comes from `node_modules`).
2. Open http://localhost:8080 in a full-screen browser window (1920×1080 works best). Close the browser's dev tools.
3. Scenario: **RCRV research vessel (reconstructed)**. Decks: **All decks**. Role: **Engineer**.
4. Optional: `http://localhost:8080/?demo` starts the run-through on load. **Esc** stops it.
5. Run `npm test` once in a terminal you can show later (32 tests, both scenarios 100 % of the ground truth).

## Opening shot: first 25-30 seconds (the "Demo run-through" button)

The button plays exactly this sequence (about 28 s). The captions are generated from the data, so the numbers are always correct.

| Time | On screen | Caption | Voice-over (suggestion) |
| --- | --- | --- | --- |
| 0-3 s | Ship loads, all elements grey | "Loading OSU Regional Class Research Vessel (RCRV) - 5 decks, 67 elements" | "This is the RCRV research vessel, rebuilt as a multi-deck model." |
| 3-6 s | Elements turn red/amber/green, deck by deck | "Checking 15 rules: SOLAS/FSS, Load Line, IGF, ADA/PVAG, MARPOL, class rules" | "We check it against SOLAS, Load Line, IGF, accessibility and class rules." |
| 6-10 s | Summary and ground-truth box pulse | "7 non-compliant, 1 missing value, 23 compliant - 8/8 expected findings detected, 0 false alarms" | "Every planted issue is found, with no false alarms." |
| 10-13 s | Camera flies to guard rail 01-GR1 | "Flying to 01-GR1: Guard rail, 01 level aft" | "Here is one." |
| 13-17 s | Both failing rule cards pulse | "Fails 2 overlapping rules: LL-REG25-GUARDRAIL + DNV-GUARDRAIL" | "37.4 inches is 950 mm. It fails the Load Line convention and the class rule." |
| 17-21 s | "Also required" section | "Also required: related rules and where they are checked" | "And it shows what else applies, with the rule text quoted." |
| 21-25 s | Value typed into the editor, element turns green | "01-GR1 is now compliant - re-checked in < 1 ms" | "The engineer fixes it and gets the answer instantly." |
| 25-28 s | Report / CSV buttons pulse | "Export the findings report for review or class submission" | "Then exports the findings for the class review." |

Backup if anything fails: switch to **Cruise passenger deck (fictional)**. Its demo flies to corridor C2, which fails SOLAS/FSS 900 mm **and** ADA 915 mm (the governing value is 915 mm), and fixes it to 1000 mm.

## Pitch: 2-3 minutes

**1. Problem (20 s).** Cruise ships must comply with SOLAS, MARPOL, Load Line, class rules, ADA and PVAG. Checking is manual,
needs a lot of experience, and issues found in the 3-4 week class review come back late, often after the design has moved on.
Rules overlap, and some are not written down at all.

**2. Solution (20 s).** ShipCheck reads the design model (decks, spaces, doors, stairs, tanks), applies a rule database and
flags issues while the engineer works. Every finding says what was measured, what is required, quotes the rule, and shows
where each value came from.

**3. Live demo (60 s).** The run-through above, then live:
- Click **01-Z1** (science berthing area): only one escape route. Add `01-EXT1` to `escape_routes`: it turns green.
- Click **01-C2**: a 7.5 m dead end fails the 7 m cargo/SPS rule. Show *Considered, not applicable*: the 13 m passenger rule
  and ADA are not applied to a research vessel, and the tool says why.
- Click **MD-D2**: the sill height is missing, so the result is *not enough info*. The tool never guesses.
- Switch to the cruise scenario: the LNG tank fails the IGF distance from the ship side (computed from geometry: 0 mm vs 6.4 m)
  and borders a passenger cabin (the unwritten "LNG outside passenger areas" practice from the mentors).

**4. Trust (30 s).**
- The pass/fail decision comes from a deterministic checker: same input, same result. No LLM is involved in it.
- `npm test`: 32 tests, ground truth for every planted case, 0 false alarms, plus edge cases (unit conversion, missing values,
  applicability by ship type, operating area, size and class society).
- Every rule quotes its text and source. Unchecked values are marked *not yet verified* in the UI and listed in VERIFY.md.
- Provenance on every value: public particulars, estimated, planted test case, or edited by the engineer.
- AI is optional (EU-hosted Mistral, Anthropic, or a local model). It drafts rules from pasted regulation text, only with a
  verbatim quote and values that appear in the text, and an engineer approves each draft before it is used.

**5. Roadmap (20 s).**
- Read real 3D data: APS/Navisworks extraction (script exists), OCX/IFC import, units converted automatically.
- More rules, verified against the official texts with Meyer's rule experts; class rule packages (DNV).
- EU hosting on partner servers, or fully local on a 32 GB engineering laptop.
- Integration into the design tool, so issues are flagged as the design changes, before the class review.

**6. Ask (10 s).** Access to a real (anonymised) cruise deck model and a verified rule set for one area such as means of escape,
to run a pilot with one design team.
