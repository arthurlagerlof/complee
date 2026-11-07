# Claude Code handoff - 7 Nov 2026

## Update (evening, 7 Nov): source fidelity resolved for detail tiles; browser regressions green

- All handoff WIP below is now COMMITTED on dev (small commits); a pre-commit snapshot is kept at `refs/wip/handoff-2026-11-07`.
- New `tools/export/export-tiles-hp.mjs` rebuilds the 851 detail tiles straight from the retained SVF with float32 positions
  relative to each tile (no position quantization) into `model/stream-hp/` (500 MB). `tools/export/audit-hp.mjs` PASSES:
  50,843,045 triangles = SVF source (the old packed GLBs had 3,330 fewer), all 133,994 dbIds, per-id triangle counts
  identical, bounds within 0.0004 mm, mean centroids within 0.0003 mm, areas within the float32 rounding bound.
  Zero-area triangles: source 3,470, hp tiles 5,793 (sub-micron slivers; old tiles: ~4.9 M). Report: `model/stream-hp/audit.json`.
- The app serves `stream-hp/manifest.json` when that audit passed (`server.mjs streamManifest()`); `MODEL_MANIFEST=stream/manifest.json`
  rolls back. The far exterior OVERVIEW tiles are still reused from `model/stream` (16-bit source) until re-baked with
  `prepare-overview.mjs` from the hp tiles: open item.
- `tools/export/browser-regressions.cjs` (committed, portable): 8/8 pass headless - pages, centred overview, Simple/Full/cut sync
  (bug fixed: cut selector now resets), rule view + component + what-if (P3522 24 in -> compliant), forced WebGL context
  loss/recovery, tall portrait resize, APS (headless: hit its own 180 s load timeout -> clean screenshot fallback), full demo.
  Ignored `work/lifecycle-regressions.cjs`: 7/7 pass (its manifest route now matches `stream*/manifest.json`).
- Materials: the original marks ~1.58 M triangles (5,035 objects) transparent (e.g. rescue-boat launch envelope, layer ENV_,
  opacity 0.04). The hp tiles now carry per-vertex source opacity (`_OPACITY`, normal's 4th byte); the viewer draws them in a
  see-through pass; overview tiles use `manifest.opacity_by_dbid` (uniform parts only). audit-hp checks opacity exactly.
  The previous opaque hp set is kept in `model/stream-hp-prev/`.
- Demo readiness (7 Nov, late): presenter mode (`?demo&present`, Space/→/PageDown/Enter = next step, Esc = stop; first key
  press during autoplay switches to step-by-step), ready gate (demo starts when the overview is fully loaded), technical badge
  hidden during the demo, ship framed by the overview tiles' corners (centred, large; `fitPerspectiveBox(..., { points })`),
  component views with room around the part (margin 1.8), rule view: hull as a 15 % ghost + neutral, only the rule's parts
  coloured; cruise element framed from above (margin 2.6); demo ends on the deck overview. Frame capture:
  `tools/export/work/demo-frames.cjs` (ignored). Video backup needs Playwright ffmpeg (not installed; user to record).
- Scene inside the real ship (7 Nov, night): scenario `rcrv-inside` = 4 example components with `geom3d` in the stream
  manifest frame (corridor x -19..-7 m, z -3.4..-2.6 m at deck level 4, y -1.5 m; door, stair up, guard rail on the bow
  deck). viewer-stream scene mode: real ship neutral, cut at deck+1.5 m (below the real ceilings), two-phase entry (cut,
  then fly), overlay shapes from `public/viewer-scene.js`, picking/select/what-if; Simple/Full/cut controls hidden. Demo:
  real ship (overview, check, P1770, 22-hatch rule view) -> scene (corridor fail -> what-if green, guard rail inch).
- Known layout limit: below ~800 px width the fixed 330 px + 420 px side columns leave no room for the 3D pane (existing design).
- `tests/tile-audit.test.mjs` no longer needs the export tools installed (tile-model.mjs loads meshoptimizer lazily). npm test: 91/91.

Read this before modifying anything. There is substantial UNCOMMITTED work that must be preserved.

## Workspace and non-negotiable constraints

- Workspace: `C:\Users\Philipp\Downloads\planb_code`; Windows 11 ARM, PowerShell, Node 20.18. Use `npm.cmd` if PowerShell's npm wrapper misbehaves.
- Git branch: `main` ONLY (Philipp's instruction, 7 Nov evening: commit and push to main, not dev); remote: `complee` (`https://github.com/arthurlagerlof/complee.git`). Never force-push. Fetch/merge remote main before pushing. Stop and show conflicts in teammates' code before resolving them.
- Never print/log/commit actual `.env`, `deploy.env`, credentials, server addresses or SSH secrets. Do not delete existing files or `shipcheck/tools/export/work/svf`.
- Preserve UI design and teammates' work. Rules/checker/thresholds must remain deterministic and unchanged; no LLM pass/fail, no invented rule values, no verified=true changes.
- No Python/Navisworks/Blender requirement. No cloud deployment, new account/service, AI orchestrator or FreeCAD work. A teammate's AI updates were merged intact; do not remove or develop that work as part of this task.
- Stop model exports below 3 GB free. Last observed C: free space was about 11.6 GB.
- Requested commit trailer from the session: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Active user goals

1. Restore the simplified ship as a third example alongside real RCRV and fictional cruise deck.
2. Real geometry should live on a model server and be requested on demand, without loading all ~330,760 hierarchy objects into the browser at once.
3. Fix incomplete/off-center ship display and recent startup failures; inspect for other regressions.
4. Verify whether the original model is complete. Do NOT claim this is fully proven: the newest audit found a serious source-to-GLB fidelity issue (below).
5. The user is now explicitly handing further coding back to Claude Code. All audit agents have stopped; no audit process remains running.

## Committed and pushed work

Latest pushed/local HEAD at handoff: `508b527`; dev and cached complee/dev match.

- `436524e`: restored `rcrv-layout` scenario, production copy `shipcheck/ships/rcrv/layout.json`, original 8/8 planted findings, estimated-example provenance. Original fixture retained.
- `6d82ec1`: separate read-only `shipcheck/model-server.mjs`, optional `MODEL_BASE_URL`, app `GET /api/model/config`, CORS/Range/cache/path-safety tests, Docker support and `shipcheck/docs/model-serving.md`.
- `c742bc8`: 851 lossless spatial detail tiles, viewport request policy, bounded residency, cancellation/eviction, worker picking, Full model toggle, property cards, screenshot documentation. This committed version has the hull-only overview defect; local uncommitted work repairs it.
- `499f84e`: `scripts/start-dev.ps1` for durable Windows startup/restart/stop, logs in ignored `.run/`, same-origin model route by default. Stopping/interruption of the old assistant command sessions had left NO server listening on 5173.
- `508b527`: merged teammate dev commits `5ca08db` / `60528a7` (API AI updates) without conflicts. Their backend and React AI workspace changes were preserved. No backend/AI service was started by us.
- Earlier full-model work was completed/committed before these: four rest chunks, corrected SVF-copy-to-SVF2 ID mapping, full geometry export, deploy scaffolding and tests. The SVF copy numbers nodes differently; never assume raw SVF dbIds equal APS objectids.

## Current running app / recovery

The app is running independently of the assistant command session on port 5173 (last PID 4720). Both pages and all three scenarios passed a real browser startup check after the teammate merge.

- Landing: `http://localhost:5173/landing`
- Inspection: `http://localhost:5173/inspection/index.html`
- Simplified example: append `?scenario=rcrv-layout`
- Real model: append `?scenario=rcrv-3d`
- Root PowerShell: `.\scripts\start-dev.ps1`; optional `-Restart` / `-Stop`.
- Default local operation serves model files from the same app. A second process on 8081 is NOT required. It is currently stopped.
- To host models separately, run `shipcheck/model-server.mjs` and configure the app process's `MODEL_BASE_URL`; see the existing model-serving docs. This has been tested on separate local origins but not deployed to Vultr.
- Vite 8.3.6 prints a Node-version warning on Node 20.18, but the landing page and inspection actually ran without browser runtime errors. Do not assume that warning was the reproduced outage; the confirmed immediate cause was no listening dev server.

## Uncommitted repairs already saved locally

Do not git restore/reset these files. Inspect git diff and finish/validate them.

- `shipcheck/public/app.js`: scenario generations + AbortController; shared in-flight local/APS viewer creation; stale continuations cannot overwrite/deactivate a newer scenario; guarded picking; hides unsupported real-model Decks/Exploded selector; clears cut UI on component/overview; synchronizes Simple/Full buttons.
- `shipcheck/src/view-framing.mjs` (new) and `tests/view-framing.test.mjs`: dependency-free tight perspective fitting that centers projected bounding-box corners, handles portrait/hidden panes and conservative depth ranges.
- `shipcheck/public/viewer3d.js`: uses that framing helper for fictional/simplified views, resets damping, handles resizing and interrupted camera flights.
- `shipcheck/src/viewport-policy.mjs`: Full model uses an exterior surface representation in overview; complete raw component requests are atomic (oversize gives an explicit message instead of a silently incomplete part); removed arbitrary distance rejection of frustum-visible detail; retains request budgets.
- `shipcheck/public/viewer-stream.js`: integrates complete exterior coverage and framing; default Full model on / Simple off; resets actual clipping on build, selection and overview; corrects camera depth precision/near clipping; unique picker keys per tile incarnation; stale-ray guards; worker-error/query handling; status reports deferred/complete view honestly.
- Most recent viewer edits also add graphics-context loss/recovery by evicting/re-requesting geometry, since transferred CPU arrays cannot simply reupload after GPU context restoration. These handlers have NOT yet been browser-tested. Run a controlled WEBGL_lose_context test or remove/revise if broken.
- `shipcheck/public/index.html`: corrected Full model/deck-cut tooltips; same visual design.
- `shipcheck/tools/export/tile-model.mjs`: `--overview` mode copies existing source faces/attributes without further quantization, preserves original detail tiles/GLBs, atomically updates the streaming manifest and checks visibility-source identity.
- New `bake-overview.html` and `prepare-overview.mjs`: portable bounded-memory exterior preparation with Playwright as an EXPORT-ONLY dev dependency. The helper serves its own local assets, needs no running app/Autodesk keys, and transfers visibility bits in small base64 chunks (returning millions of numbers through Playwright previously stalled). `--smoke --visible` passed without changing model assets.
- `tools/export/package.json` and lock: Playwright 1.65.0 added as a dev dependency; meshoptimizer 0.22.0 remains the encoder/decoder tooling dependency. Runtime app dependencies unchanged.
- New `audit-source-geometry.mjs`, `audit-tiles.mjs`, `tests/tile-audit.test.mjs` (details below).
- `tests/viewport-stream.test.mjs`: new overview/component-budget/frustum coverage tests.

Pre-existing untracked `.claude/` and root `model-full-test.png` were left untouched. Do not stage them blindly. No latest repair/audit changes above have been committed or pushed yet.

## Geometry/data layout and overview fix

All large assets/reports are gitignored under `shipcheck/model/` / `tools/export/work/`; teammates need them uploaded/copied separately.

- Original ten packed GLBs: 226.5 MB total, 50,839,715 actual decoded triangles.
- Six main chunks: context, openings, structure-findings, piping, access, structure.
- Four rest files: rest-01..04, about 29-31 MB each.
- `model/stream/manifest.json.chunks`: 851 DETAIL tiles, 352.4 MB. Every packed source triangle is retained in these (EXACT audit passed).
- `manifest.overview.chunks`: 706 additional EXTERIOR tiles, 29.5 MB, 3,436,255 triangles, estimated resident data ~280 MB. These are a visibility-sampled subset of original faces, NOT replacement/simplified geometry and NOT the full-model completeness basis. Full source detail remains in the 851 detail tiles.
- `model/props/`: 1,269 on-demand property shards (~56.7 MB).
- `tools/export/work/svf`: retained Autodesk SVF cache, must not be deleted or re-downloaded unnecessarily.

The old viewport code deliberately rendered only context above 24 m view span even with Full model enabled (102 tiles / 6.66 M triangles), but aimed at all-model bounds. That permanently hid deckhouse/mast/equipment and displaced the visible hull ~2.63 m sideways and 5.86 m downward relative to the camera target.

The new exterior overview visibly includes the deckhouse, mast, equipment and hull, with the ship centered. Browser screenshot measurements: rendered bounds center was ~2.4% off horizontal and ~0.9% off vertical center, with no clipping. Geometry loaded in ~2.8-3.3 s after viewer creation on the warmed laptop. Hatch P3522 isolated into one 176.7 KB detail tile / ~1.85 MB resident estimate; cut plane reset to zero and the 24 in what-if became compliant.

Screenshots/current diagnostics are in ignored `tools/export/work/fixed-overview.png`, `fixed-component.png`, `overview-fix-browser.json`.

## CRITICAL completeness findings - do not overclaim

### Packed GLBs -> detail tiles: EXACT PASS

New offline `tools/export/audit-tiles.mjs` checks exact oriented triangle multisets over complete decoded attribute bytes, transforms, materials, file/content hashes and duplicate multiplicities. Hashes only locate candidates; exact comparisons resolve collisions.

Result: all 851 DETAIL tiles exactly preserve all 50,839,715 packed-GLB triangles. Zero missing/extra triangles, dbId-count mismatches or file errors. Seven focused regression tests passed. Runtime ~41.7 s, peak RSS ~1,029 MiB.

Generated report: `model/tile-integrity.json` (~8.9 MB). Overview tiles intentionally excluded.

### Retained SVF -> original packed GLBs: part coverage PASS, geometric fidelity NOT established

New `tools/export/audit-source-geometry.mjs` found:

- 303,504 nonempty mesh fragments, 50,843,045 original SVF triangles.
- All 133,994 assigned geometry IDs appear in packed GLBs; no fully absent assigned part ID.
- Zero per-ID bounds failures within half the quantization step + 0.02 mm tolerance.
- Packed GLBs have 3,330 fewer triangles; 174 IDs have count differences.
- Source exact zero-area triangles: 4,703 (2,091 coincident-vertex triangles).
- AFTER the old export quantization, 4,894,094 retained packed triangles have zero area (4,398,268 with coincident vertices). This is a serious fidelity issue: complete part coverage DOES NOT prove unchanged detail.
- Only 497 missing triangles across 71 IDs were conclusively reconciled on the reconstructed quantization grid; all collapse there, but just 85 were zero-area in original source coordinates. Remaining losses still need classification due rounding ambiguity.
- Detailed loss matching skipped IDs 46158 and 50370 under its memory guard; their counts/bounds were still audited.

Generated report: `model/source-coverage.json` (~186 MB). Do not load the entire report into an LLM context; inspect summaries or stream selected per-ID data.

The original global-chunk 16-bit position quantization is a likely reason for collapsed fine geometry. Investigate before claiming nothing is missing. Consider a new versioned lossless/higher-precision export from retained SVF, with local-coordinate small tiles; preserve existing GLBs and cached SVF instead of overwriting/deleting them. Also inspect Float32 transform/export rounding. Do not change rule thresholds or hide this issue with simplified geometry.

These audits validate the RETAINED SVF DERIVATIVE, not native `.nwd` equivalence. Native Navisworks cannot run on this laptop. 330,760 is the SVF2 hierarchy count, not the number of visible meshes. About 28,053 fragments use nearest-matched-ancestor IDs; eleven prepared parts lack direct mapping. Exact leaf-level identity/native-NWD parity remain unproven.

## Commands / tests / current difficulties

From repo root:

```powershell
.\scripts\start-dev.ps1
npm.cmd --prefix shipcheck test
node --expose-gc --max-old-space-size=4096 shipcheck/tools/export/audit-tiles.mjs
node --max-old-space-size=6144 shipcheck/tools/export/audit-source-geometry.mjs
node shipcheck/tools/export/prepare-overview.mjs --smoke --visible
```

For full exterior rebuild, omit `--smoke`; install export-tool deps inside `shipcheck/tools/export/` first. Do not automatically re-export the ten originals until the fidelity issue is understood.

Last complete suite: 78 tests passed BEFORE the newest depth/policy/audit/GPU edits. Focused framing/viewport checks subsequently passed; the seven tile-audit regressions also passed. The full combined suite must be rerun now; do not claim the final suite has passed yet.

An existing ignored real-browser regression harness is `tools/export/work/lifecycle-regressions.cjs` (7/7 passed for delayed scenario responses, ABA switching, single viewer construction, stale callbacks, cruise editing and noaps). It contains a machine-specific cached Playwright require path: use the installed export-tool Playwright for portable tests.

Other ignored browser harnesses: `startup-check.cjs`, `overview-fix-browser.cjs`, `viewport-browser.cjs`. The older viewport harness explicitly expects hull-only context and must be updated for the new exterior overview. A full demo passed on the earlier streaming implementation, but must be rerun after the current exterior/GPU repairs. Explicit APS was previously functional; retest latest lifecycle behavior. Noaps fallback passed.

New `tests/tile-audit.test.mjs` currently imports the export audit, which imports meshoptimizer from tools/export/node_modules. On a fresh app-only install this may break `npm test`; make the pure matcher test independent of optional export dependencies or handle the optional tooling cleanly. Do not silently weaken the real audit.

The latest graphics-context recovery handlers, near-plane behavior while zooming inside, Simple/Full/cut UI synchronization, and narrow/portrait real-model resize still need final regression testing. One noted small UI concern: toggling Simple/Full clears the real clip plane, so the cut dropdown should also reset (app already resets it for component/overview). Check this before release.

## Suggested continuation order

1. Preserve WIP and inspect status/diffs. Confirm both pages and all scenarios still run via the durable launcher.
2. Finish/review current viewer/lifecycle/camera fixes; test forced GPU context loss/recovery, fast scenario switches, cuts, component/rule view, what-if, noaps/APS and full demo. Keep startup working.
3. Investigate source-to-packed quantization collapse and unclassified losses. Do not state original geometry is unchanged until this is resolved or clearly qualified.
4. If replacing export precision, write versioned output and independently audit source coverage/fidelity, then regenerate detail/exterior assets as needed. Never delete old source/cache assets.
5. Update docs and compact audit summaries; do not commit generated reports/model files. Run complete tests, check browser screenshots, commit in small pieces, merge remote dev safely, then push dev only.
