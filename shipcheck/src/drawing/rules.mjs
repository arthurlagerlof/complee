// Switches for the recognition rules added after the first version, so each one can be measured on its own
// (tools/drawing/ablation.mjs turns one off at a time and compares). All are on in normal use; nothing in the app
// turns them off.
export const RULES = {
  frameStrips: true,      // views.mjs: a sheet frame drawn as separate thin strips is a frame
  floorPlans: true,       // views.mjs: a large drawing with door swings and labels is a plan without ship cues
  symbolPlans: true,      // views.mjs: a small or flat "plan" without a deck name is a symbol, not a deck
  drawnSymmetry: true,    // views.mjs: symmetry counts only for drawings with line work
  unitLabels: true,       // vocab.mjs: "Whg. D", "App. A" are unit names, kept apart from the room name
  areaUnderNumber: true,  // plan-read.mjs: a printed area under a room number belongs to the named room
  dedupeSwings: true,     // plan-read.mjs: a door swing drawn twice is one swing
  doublePairing: true,    // plan-read.mjs: two leaves pair only when they open to one side and no partition ends there
  drawnClosure: true,     // plan-read.mjs: no extra lines where the drawing closes a door gap itself
  crossMarks: true,       // plan-read.mjs: a corner-to-corner cross does not cut a space into triangles
  hatchStairs: true,      // plan-read.mjs: stair candidates in step on one grid are a hatch
  openDeckNeedsInfo: true, // interpret.mjs: no open deck without a deck plan above or a profile
};
const DEFAULTS = { ...RULES };

/** Turn rules off (or on) by name: setRules({ crossMarks: false }). Unknown names throw. */
export function setRules(values) {
  for (const [k, v] of Object.entries(values)) {
    if (!(k in RULES)) throw new Error(`unknown rule "${k}" (known: ${Object.keys(RULES).join(', ')})`);
    RULES[k] = !!v;
  }
}

export function resetRules() { Object.assign(RULES, DEFAULTS); }
