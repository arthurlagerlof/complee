# Full RCRV export and verification

The model is exported from the cached SVF in `work/svf`, which is retained. No simplification, small-part filtering, or rotation-dependent detail reduction is used. Meshopt compression with 16-bit position quantization is the same permitted compression as the main chunks. Geometry is merged into one draw call per chunk; GPU instancing is not implemented.

| Chunk | MB (decimal) | Parts | Source triangles |
| --- | ---: | ---: | ---: |
| context | 20.0 | 3,222 | 6,663,411 |
| openings | 11.2 | 244 | 2,529,097 |
| structure-findings | 9.5 | 879 | 2,021,402 |
| piping | 54.2 | 9,208 | 12,095,639 |
| access | 3.8 | 908 | 903,910 |
| structure | 8.8 | 13,948 | 1,782,976 |
| rest-01 | 29.1 | 22,133 | 5,864,049 |
| rest-02 | 30.6 | 41,243 | 6,170,460 |
| rest-03 | 29.7 | 18,000 | 6,432,423 |
| rest-04 | 29.8 | 24,209 | 6,379,678 |
| **Total** | **226.5** | | **50,843,045** |

The six main chunks total 107.4 MB; the four rest chunks total 119.1 MB. Part counts are chunk membership counts, not the 330,760-node hierarchy count. On-demand names and properties add 56.7 MB in 1,269 shards; they are not downloaded with the overview.

## Coverage and identity correction

`audit-model.mjs` enumerates every source fragment and checks the partition counts against the generated manifest: all 303,504 non-empty triangle fragments are assigned, with zero unmapped geometry fragments. Files and layers in the 330,760-node hierarchy do not each have geometry. The packed files contain 50,839,715 triangles (3,330 fewer than the raw source count after gltfpack cleanup/quantization; no simplification option is used). Visual checks show the complete bow, stern, deckhouse, mast, railings and equipment, without apparent export holes. This is not a vertex-for-vertex geometric equivalence proof.

The original six chunks had to be regenerated: the SVF copy and APS SVF2 translation use different node numbering, so the old direct dbId assumption linked much geometry to the wrong parts. `map-ids.mjs` matches source DWG + entity handle + name, then matched parents and sibling positions. `verify-ids.mjs` checks ShipConstructor centres of gravity against mapped geometry boxes: 23,037 / 23,102 (99.7%) lie inside. This is a useful independent check, not a certification of every mapping.

For rest geometry, 97,106 fragments use their own matched APS dbId, 41,901 are grouped under a prepared part, and 28,053 use the nearest matched ancestor because the translations expose different subentity trees. Thus every triangle carries an APS objectid, but exact leaf-level identity is not available for every source subentity. Geometry is retained in all three cases; the click card shows the mapped object/assembly and its properties. Eleven of the 69,993 prepared parts have no direct match, and the mapping summary reports two name/file/handle conflicts; these remain limitations for individual-object identity review.

## Measured locally (7 Nov)

Chrome, 1680 x 1000 window, device pixel ratio 1, HTTP from the laptop. Latest warmed run: first picture 0.66 s, six main chunks 2.97 s, full model 4.55 s. An earlier first run was 0.76 / 14.97 / 20.35 s respectively. These are local disk/network results, not Vultr download predictions. The model GLBs transfer 226.5 MB, plus manifest and application/part metadata.

A controlled 60-frame rotation, one render per animation frame with GPU completion, measured 19.4 FPS with the full model (10 draw calls, 50.84 million packed triangles) and 31.9 FPS without rest (6 calls, 25.99 million triangles). Earlier measurements during background indexing were about 10 / 20 FPS. Picking is built in a worker and was ready at about 38 s in the earlier run; it does not delay the first picture. Full geometry is expensive on this laptop: use a faster GPU for smoother full-model rotation, or the existing Full model toggle for the compliance view. Repeated-fragment instancing is a possible further memory optimization (325 MB estimated raw reuse), but would not remove visible triangles and has not been implemented.

All 55 Node tests pass; the explicit `?viewer=aps` route also finished loading in the browser with zero page errors. The checked workflow passed in the browser: rest selection/property card, findings filter, hatch rule view, what-if edit, deck cut, cruise C2 live edit and the full demo run-through. A simulated missing rest chunk shows an explicit incomplete-download message; it is not reported as a successful full load. `?noaps` still opens the screenshot fallback. Server tests cover all rest files, manifest coverage, cache/MIME, health counts and HTTP 206.

Screenshots: [full overview](../../docs/full-model/full-overview.png), [Full model off, same camera](../../docs/full-model/compliance-overview.png), [rest part selected](../../docs/full-model/rest-selected.png).

## Rebuild

Ordinary rebuilds use the retained cache without requesting credentials. For a fresh machine without that cache, the original one-time download remains available explicitly via `--download-svf` (after the SVF job finishes); it is never automatic.

Run the mapping and main export once when correcting or replacing the source. Then run `export-rest.mjs --plan`, each `--chunk N` in its own Node process (up to `--max-old-space-size=12288`), `--props`, and `audit-model.mjs`, in that order. The rest exporter never rewrites the six main GLBs. Each rest run checks disk space and reserves at least 3 GB while writing its temporary files. Only temporary raw files for the completed compression are deleted; the cached SVF remains. Model files and working data stay outside Git. Deployment scripts archive the entire model folder and print the total upload size; they have not been run.
