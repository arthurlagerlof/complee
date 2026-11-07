# Demo script

## Before recording

1. In `shipcheck/`: `npm install` (once), then `npm start`, and open http://localhost:8080/index.html full screen (1920×1080 works best). Close the dev tools.
2. The default scenario is **RCRV: real 3D model (ShipConstructor via APS)**. Wait until the badge in the 3D view says
   **"Autodesk APS viewer · real RCRV model"** (30-60 s). The demo waits for it if you start earlier, but the timing below assumes it is loaded.
   If it never finishes, reload: a load that did not finish clears the viewer's local model cache automatically (`?clearcache` forces it).
3. Run `npm test` once in a terminal you can show later.
4. No internet, or APS is down: open http://localhost:8080/?noaps. The 3D view switches to the saved screenshots and the findings
   still come from the local check. Every caption and step stays the same.
5. `?demo` starts the run-through on load. **Esc** stops it.
6. **Full model** (top bar, on by default): after the checked parts, the rest of the ship loads in the background (badge
   "full model … MB") and appears in grey in the overview once all filter chips are on. It never changes a colour or count; the
   rule and component steps hide the grey parts, keeping the compliance view clear.

## Presenting live (recommended)

- Full screen, 1920×1080 (below about 800 px width the 3D view has no room). Use the local viewer (default), not `?viewer=aps`.
- Open `/inspection/index.html?scenario=rcrv-3d&demo&present`: the demo first waits until the whole ship is loaded
  (caption "Loading the real 3D model…"), then stops at every step. **Space**, **→**, **Page Down** or **Enter** (a presentation
  clicker) goes to the next step, **Esc** ends the demo. Without `&present` it plays by itself; the first key press switches
  it to step-by-step.
- The technical loading badge is hidden while the demo runs.

## The "Demo run-through" button (about 60 s autoplay, or step by step)

The captions are generated from the data, so the numbers are always correct.

| Step | On screen | Caption | Voice-over (suggestion) |
| --- | --- | --- | --- |
| 1 | The real RCRV model, whole ship, neutral | "OSU RCRV: real ShipConstructor production model. 330,760 objects in the model, 35,328 parts checked, inches converted to mm" | "This is the real production model of the OSU research vessel, straight from ShipConstructor." |
| 2 | Parts turn green / amber / red group by group | "Checking 6 rules on real design data: IACS, SOLAS, IGC Code, data quality" | "We check it against IACS steel rules, SOLAS and the data quality itself." |
| 3 | Summary and ground-truth box pulse | "6 non-compliant, 3,651 not enough info, 19,875 compliant. Ground truth: 13/13 …, 0 false alarms" | "Every result is checked against a ground truth: no false alarms." |
| 4 | The first red part (P1770) isolated, rule card pulses | "P1770: ASTM A106 in hull structure (SWBS 100)" + UR W11 quote | "This hull stiffener is a 12-inch pipe of ASTM A106, not a hull steel grade." |
| 5 | **Rule view** in the real ship: all 22 hatches through a see-through hull | "Rule view: 22 hatches: 4 pass, 0 fail, 18 not enough info" | "Or start from the requirement: every hatch it applies to." |
| 6 | **Into the ship:** the ship is cut open above deck level 4, the camera dives into the real deckhouse | "Inside the ship: one corridor on deck level 4" | "Now inside: one corridor with its door, stair and the rail outside, placed in the real deckhouse." |
| 7 | The 4 components in colour: corridor red, guard rail red, door and stair green | "4 components checked: 3 non-compliant, 3 compliant" + ground truth 3/3 | "Four components, checked the same way." |
| 8 | **Component view:** the corridor, label "850 mm · required ≥ 900 mm" | "Deckhouse corridor: clear width 850 mm, required ≥ 900 mm" + FSS quote | "The corridor is 5 cm too narrow for an escape route." |
| 9 | The rule card pulses: source and review status | "The card shows the rule, its source and review status" | "Each result quotes its rule and says how far it is verified." |
| 10 | **What-if:** 1000 typed into the clear width; the corridor turns green | "C1 is now compliant (what-if, not in model)" | "The engineer tries a width; it is marked as a what-if, never written into the model." |
| 11 | The guard rail outside, label "950 mm (37.4 in)" | "Guard rail: 37.4 in (950 mm) fails 2 overlapping rules: Load Line + DNV" | "Drawn in inches, converted, and it fails two rules at once." |
| 12 | Back to the scene overview; Report and CSV pulse | "Export the findings: HTML report and CSV" | "And exports the findings with the traceability table for the class review." |

The corridor scene (`ships/rcrv/inside.json`) is a simplified, estimated example placed in the real deckhouse: the ship
around it is the real model, the four components and their values are fictional test values (labelled as such in the app).
The cruise deck is no longer part of the run-through; it stays in the scenario menu.

**Why the hatch is amber, not red, and why its rule is IGC:** the real model has no failing hatch (4 pass; 18 have no size in their names),
and no DNV or SOLAS hatch-opening value is in the project yet. The demo shows the real state and uses a what-if, labelled as such,
instead of an invented failing value. When the mentors give the DNV escape-hatch value, only `rules.json` changes.

**Things to click by hand after the run-through (real model):**
- **Simple view** (top bar): only the shell, the decks and the checked parts; then a **deck cut** (e.g. Deck level 3) for a plan view.
- **Rules** list in the sidebar: click a rule to light up all its parts; click a part in the list to open its component view.
- **Traceability** (top bar): parts × rules; click a cell to jump to that part in 3D and its rule card.

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
- `npm test` (48+ tests): ground truth for every planted case (cruise 7/7, RCRV layout 8/8) and for the real model (13 hand-checked
  findings, plus every bulk count recomputed by an independent scan of the source data), 0 false alarms, edge cases and
  boundary values (UR S6 table bands, 36 in vs 915 mm).
- No invented rule values: every value is marked *not yet verified*, interpretations are labelled (UR S6 is for ships of 90 m and above,
  and the RCRV is about 60 m), and unknown values stay empty.
- Works offline: the check runs locally; precomputed results and screenshots cover a missing 3D viewer.

**5. Roadmap (20 s).** Verify the rule values against the official DNV/IMO texts with Meyer's rule experts; add the member category (UR S6 Table 1); add spaces and escape routes from the GA/OCX data; integrate into the design tool so issues are flagged as the
design changes, before the class review.

**6. Ask (10 s).** A verified rule set for one area (hull materials or means of escape) and an anonymised cruise model, to run a
pilot with one design team.

Viewport streaming: the real-model overview loads hull/decks; zooming requests nearby full-quality tiles, and selecting a finding fetches only the tiles containing that component. The rest of the ship remains on the model server.
The selector also includes **Simplified research vessel (example)**: use it for the lightweight five-deck layout demonstration (8/8 expected findings). `MODEL_BASE_URL` can point the app at the separate read-only model host; see `docs/model-serving.md`.
