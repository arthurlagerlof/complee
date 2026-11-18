// Voice-over of the demo run-through, one line per caption, in "rally English" (the English of Finnish rally
// drivers: no voiced b/d/g, w as v, deadpan). The demo shows a caption, then window.__demoVoice('<chapter>|<caption>')
// plays the line whose `match` fits (and whose `chapter` number fits, when given); the demo waits for it to end.
// Spelling is phonetic on purpose; numbers on screen are said as shown. Used by demo-voiceover.mjs (generate) and
// record-demo-video.mjs --voice (record). `intro` plays over the title card before the demo starts.
export const VOICE = { name: 'Jussi - Strong and Silly', model: 'eleven_multilingual_v2', settings: { stability: 0.45, similarity_boost: 1.0, style: 0.3, use_speaker_boost: true, speed: 1.12 } };

export const NARRATION = [
  { id: 'intro', intro: true, text: 'No niin. This is Komplee. Kompliance shekks for ship tesigns. Let us co.' },

  // 1 Drawing → 3D
  { id: 'd1-drawing', chapter: 1, match: '^It starts with a drawing', text: 'It all starts vith a trawing. A PDF cheneral arrankement. Like in the olt tays.' },
  { id: 'd1-views', chapter: 1, match: 'views found on the sheet', text: 'Komplee fints eight views on the sheet. Two profiles, one section, ant five teck plans. The scale, one to one huntret, it reats py itself.' },
  { id: 'd1-convert', chapter: 1, match: '^Converting', text: 'Now ve konvert. Rooms from the valls, toors from the svink arks, tecks from the profile.' },
  { id: 'd1-recognised', chapter: 1, match: '^Recognised on the drawing', text: 'Here is vhat it recoknised. Sixty-nine rooms, thirty-one toors, six stairs. Every kolour is a kint of room.' },
  { id: 'd1-evidence', chapter: 1, match: '^Every element keeps', text: 'Ant every element remempers the lines it vas reat from. Here the stair. In oranch.' },
  { id: 'd1-decks', chapter: 1, match: '^From 2D to 3D', text: 'Ant then, from two-tee to tree-tee. Five teck plans pecome five tecks.' },
  { id: 'd1-converted', chapter: 1, match: '^Converted to 3D', text: 'Four huntret fifty-five elements. Ant all of them shekked akainst the rules. Immeteately.' },
  { id: 'd1-stair', chapter: 1, match: 'measured from the drawing, required', text: 'This stair is seven huntret fifty-one millimetres vite. The rule says nine huntret. Not kood.' },
  { id: 'd1-confirm', chapter: 1, match: '^The engineer checks the value', text: 'But it is measured from a trawing. So the encineer shekks it, ant konfirms it vith his name. Only then it kounts.' },

  // 2 Design review
  { id: 'd2-model', chapter: 2, match: '^The full review on a design model', text: 'Now the full revieu. A research vessel. Five tecks, eighty-one elements.' },
  { id: 'd2-check', chapter: 2, match: '^Checking \\d+ rules', text: 'Nine rules. Shekked right here in the provser. No AI is teciting anything.' },
  { id: 'd2-summary', chapter: 2, match: 'non-compliant', text: 'Seven non-kompliant, thirty-one okay.' },

  // 3 A finding and its rule
  { id: 'd3-door', chapter: 3, match: 'required', text: 'This toor. The sill is three huntret millimetres, the rule vants three huntret eighty. Ant here is the rule text.' },

  // 4 AI explanation
  { id: 'd4-ask', chapter: 4, match: 'Explain', text: 'Now ve ask the AI to explain it. In normal lankuage.' },
  { id: 'd4-answer', chapter: 4, match: '^AI answer', text: 'Raise the sill py eighty millimetres. Very kood. The AI explains. But the shekker tecites.' },

  // 5 What-if
  { id: 'd5-rail', chapter: 5, match: 'overlapping rule', text: 'This kuard rail is nine huntret fifty millimetres. Two rules vant one metre.' },
  { id: 'd5-try', chapter: 5, match: '^What-if', text: 'So ve try. One thousant millimetres.' },
  { id: 'd5-ok', chapter: 5, match: 'is now', text: 'Joo. Now it is okay. The real motel, ve tit not touch.' },

  // 6 Escape plan
  { id: 'd6-plan', chapter: 6, match: '^Escape plan', text: 'The eskape plan. From every room to the muster station. Kalkulated from the layout.' },
  { id: 'd6-room', chapter: 6, match: 'single route only', text: 'The launtry has only one vay out. Sixty-five metres. Petter not have a fire there.' },

  // 7 Findings register
  { id: 'd7-register', chapter: 7, match: '^Findings register', text: 'The fintinks register. Who fixes vhat, ant vhy.' },

  // 8 Traceability
  { id: 'd8-matrix', chapter: 8, match: '^Traceability', text: 'Tracepility. Every part, akainst every rule.' },
  { id: 'd8-cell', chapter: 8, match: 'what-if value', text: 'One klick on a cell, ant you are at the part ant the rule.' },

  // 9 Report
  { id: 'd9-report', chapter: 9, match: '^Export the findings', text: 'Ant the report, for the klass society. HTML ant CSV. No more Excel hell.' },

  // 10 Real production model
  { id: 'd10-real', chapter: 10, match: '^Now the real ship', text: 'Ant now, the real ship. The full ShipKonstruktor production motel.' },
  { id: 'd10-model', chapter: 10, match: '^OSU RCRV', text: 'Almost tventy-nine thousant parts. Inches konverted to millimetres. Pecause Americans.' },
  { id: 'd10-summary', chapter: 10, match: 'non-compliant', text: 'Six non-kompliant. Seven thousant vith missing tata. Tventy-one thousant okay.' },
  { id: 'd10-part', chapter: 10, match: 'hull structure', text: 'ASTM steel. Not an approved hull krade, only vith special approval.' },

  // 11 Rule view
  { id: 'd11-rule', chapter: 11, match: '^Rule view', text: 'Rule view. Tventy-two hatches, all koloured py one rule.' },

  // 12 Summary
  { id: 'd12-end', chapter: 12, match: '^Complee', text: 'So. Trawing in, tree-tee motel out. The AI explains, the shekker tecites. Leave me alone, Komplee knows vhat it is toing. Hyvä.' },
];

// The line for a caption key "<n> / 12 · Title|Caption text", or null (that caption stays silent).
export function lineFor(key, lines = NARRATION) {
  const [chapterPart, ...rest] = String(key).split('|');
  const text = rest.join('|');
  const n = Number(/^(\d+)\s*\//.exec(chapterPart)?.[1]);
  return lines.find((l) => !l.intro && (l.chapter == null || l.chapter === n) && new RegExp(l.match).test(text)) ?? null;
}
