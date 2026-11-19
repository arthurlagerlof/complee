// Voice-over of the demo run-through, one line per caption. The demo shows a caption, then
// window.__demoVoice('<chapter>|<caption>') plays the line whose `match` fits (and whose `chapter` number fits, when
// given); the demo waits for it to end. Numbers on screen are said as shown. Used by demo-voiceover.mjs (generate) and
// record-demo-video.mjs --voice (record). `intro` plays over the title card before the demo starts.

// A calm American narrator (ElevenLabs "Matilda"), plain English. Spelled for speech where a written form would be
// read wrongly ("two-D", "A-S-T-M A-one-oh-six", "one to one hundred").
export const VOICE = { name: 'Matilda', model: 'eleven_multilingual_v2', settings: { stability: 0.55, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true } };

export const NARRATION = [
  { id: 'intro', intro: true, text: 'This is Complee. Class and regulatory compliance checks for ship designs, from the first drawing to the real production model.' },

  // 1 Drawing → 3D
  { id: 'd1-drawing', chapter: 1, match: '^It starts with a drawing', text: 'Every project starts with a drawing. Here, the general arrangement of a twenty-eight metre research vessel, as a PDF.' },
  { id: 'd1-views', chapter: 1, match: 'views found on the sheet', text: 'Complee splits the sheet into eight views: two profiles, one section and five deck plans. The scale, one to one hundred, is read from the drawing itself.' },
  { id: 'd1-convert', chapter: 1, match: '^Converting', text: 'The conversion reads rooms from the walls, doors from their swing arcs, and deck heights from the profile.' },
  { id: 'd1-recognised', chapter: 1, match: '^Recognised on the drawing', text: 'This is what was recognised: sixty-nine rooms, thirty-one doors and six stairs, with every room coloured by its use.' },
  { id: 'd1-evidence', chapter: 1, match: '^Every element keeps', text: 'Every element keeps the line work it was read from. Here, the treads of the stair, highlighted in orange.' },
  { id: 'd1-decks', chapter: 1, match: '^From 2D to 3D', text: 'From two-D to three-D: the five deck plans become decks, placed at the heights measured in the profile.' },
  { id: 'd1-converted', chapter: 1, match: '^Converted to 3D', text: 'Four hundred and fifty-five elements, checked against the rule set the moment the model exists.' },
  { id: 'd1-stair', chapter: 1, match: 'measured from the drawing, required', text: 'This stair measures seven hundred and fifty-one millimetres. The rule requires at least nine hundred.' },
  { id: 'd1-confirm', chapter: 1, match: '^The engineer checks the value', text: 'Because the value comes from a drawing, the result stays a pre-check until an engineer confirms it, with name and date.' },

  // 2 Design review
  { id: 'd2-model', chapter: 2, match: '^The full review on a design model', text: 'Next, the full design review, on a research vessel model with five decks and eighty-one elements.' },
  { id: 'd2-check', chapter: 2, match: '^Checking \\d+ rules', text: 'Nine rules run directly in the browser. The checker is deterministic: the same input always gives the same result.' },
  { id: 'd2-summary', chapter: 2, match: 'non-compliant', text: 'Seven checks are non-compliant, one lacks information, and thirty-one show no deviation.' },

  // 3 A finding and its rule
  { id: 'd3-door', chapter: 3, match: 'required', text: 'This weathertight door has a sill of three hundred millimetres, where three hundred and eighty are required. The card shows the rule text and its source.' },

  // 4 AI explanation
  { id: 'd4-ask', chapter: 4, match: 'Explain', text: 'One click asks the AI for a plain-language explanation.' },
  { id: 'd4-answer', chapter: 4, match: '^AI answer', text: 'It summarises the finding and proposes a concrete fix. The AI explains; the result itself always comes from the checker.' },

  // 5 What-if
  { id: 'd5-rail', chapter: 5, match: 'overlapping rule', text: 'This guard rail is nine hundred and fifty millimetres high, and fails two overlapping rules that require one metre.' },
  { id: 'd5-try', chapter: 5, match: '^What-if', text: 'A what-if lets the engineer try a new value.' },
  { id: 'd5-ok', chapter: 5, match: 'is now', text: 'At one thousand millimetres, the rail complies. The design model itself stays unchanged.' },

  // 6 Escape plan
  { id: 'd6-plan', chapter: 6, match: '^Escape plan', text: 'The escape plan traces a route from every room to the muster station, computed from the same layout.' },
  { id: 'd6-room', chapter: 6, match: 'single route only', text: 'The laundry has a single route only: sixty-five metres to the muster station.' },

  // 7 Findings register
  { id: 'd7-register', chapter: 7, match: '^Findings register', text: 'The findings register records how each finding is handled, by whom, and why.' },

  // 8 Traceability
  { id: 'd8-matrix', chapter: 8, match: '^Traceability', text: 'Traceability shows every part against every rule.' },
  { id: 'd8-cell', chapter: 8, match: 'what-if value', text: 'One click on a cell opens the part, and the rule card behind the result.' },

  // 9 Report
  { id: 'd9-report', chapter: 9, match: '^Export the findings', text: 'The report for the class review lists every finding with its rule reference, the measured and required values, and where each value came from.' },

  // 10 Real production model
  { id: 'd10-real', chapter: 10, match: '^Now the real ship', text: 'The same checks run on the real ShipConstructor production model.' },
  { id: 'd10-model', chapter: 10, match: '^OSU RCRV', text: 'More than three hundred thousand objects. Over thirty-five thousand parts are checked, with inch values converted to millimetres.' },
  { id: 'd10-summary', chapter: 10, match: 'non-compliant', text: 'All thirteen hand-checked findings are detected, with no false alarms.' },
  { id: 'd10-part', chapter: 10, match: 'hull structure', text: 'This part is specified as A-S-T-M A-one-oh-six: not an approved hull steel grade without special approval by the class society.' },

  // 11 Rule view
  { id: 'd11-rule', chapter: 11, match: '^Rule view', text: 'The rule view colours all twenty-two hatches by one rule, across the entire ship.' },

  // 12 Summary
  { id: 'd12-end', chapter: 12, match: '^Complee', text: 'Complee. From drawing to checked three-D model, with every result traceable to its rule, its source and its design value. The AI explains. The checker decides.' },
];

export const VARIANTS = {
  pro: { voice: VOICE, lines: NARRATION, out: 'tools/drawing/out/voiceover-pro' },
};

// The line for a caption key "<n> / 12 · Title|Caption text", or null (that caption stays silent).
export function lineFor(key, lines = NARRATION) {
  const [chapterPart, ...rest] = String(key).split('|');
  const text = rest.join('|');
  const n = Number(/^(\d+)\s*\//.exec(chapterPart)?.[1]);
  return lines.find((l) => !l.intro && (l.chapter == null || l.chapter === n) && new RegExp(l.match).test(text)) ?? null;
}
