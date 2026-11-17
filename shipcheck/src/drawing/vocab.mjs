// Vocabulary of ship drawings: view titles, deck names (with a vertical rank), room labels, title-block words and the
// text patterns for scale, principal dimensions, elevations and frames. English and German first, plus the common
// Dutch, Norwegian, Swedish and Finnish words. Pure functions: browser, Web Worker and Node.
//
// Everything works on normalised text: upper case, umlauts spelled out (Ä→AE), accents and punctuation removed,
// abbreviations unified (DK→DECK, LVL→LEVEL), ordinals as two-digit levels (1ST→01).
import { RULES } from './rules.mjs';

/** Upper case, ASCII, words separated by single spaces. "F'cle Deck" → "FCLE DECK", "Brückendeck" → "BRUECKENDECK". */
export function normText(s) {
  let t = String(s ?? '').toUpperCase()
    .replace(/Ä/g, 'AE').replace(/Ö/g, 'OE').replace(/Ü/g, 'UE').replace(/ß/g, 'SS').replace(/Å/g, 'AA').replace(/Ø/g, 'OE').replace(/Æ/g, 'AE')
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
  t = t.replace(/(\w)'(\w)/g, '$1$2').replace(/([A-Z])\.(?=[A-Z])/g, '$1 ').replace(/[^A-Z0-9.,+\-/#: ]+/g, ' ').replace(/[.,:/]+(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/\bDK\b/g, 'DECK').replace(/\bLVL\b/g, 'LEVEL').replace(/\bLEV\b/g, 'LEVEL');
  t = t.replace(/\b0*(\d)(?:ST|ND|RD|TH)\b/g, '0$1');
  return t;
}

// ---------- decks ----------

// [canonical key, short id, rank (bottom → top), pattern on normalised text, display name]
const DECKS = [
  ['double_bottom', 'DB', 0, /\b(DOUBLE BOTTOM|DOPPELBODEN|DUBBELE BODEM|DOBBELBUNN|DUBBELBOTTEN|KAKSOISPOHJA)\b/, 'Double bottom'],
  ['tank_top', 'TT', 1, /\b(TANK ?TOP|INNER BOTTOM|TANKDECKE|TANKDEK|TANKTOPP)\b/, 'Tank top'],
  ['hold', 'HD', 1.5, /^(HOLD|LADERAUM|RUIM)$/, 'Hold'],
  ['platform', 'PF', 2, /\b(\d* ?PLATFORM(?: DECK)?|PLATTFORM(?:DECK)?)\b/, 'Platform'],
  ['lower_deck', 'LD', 2.5, /\b(LOWER DECK|UNTERDECK|BENEDENDEK|UNDERDAEKK|NEDRE DEKK)\b/, 'Lower deck'],
  ['tween_deck', 'TW', 3, /\b(TWEEN ?DECK|ZWISCHENDECK|TUSSENDEK|MELLANDAECK|MELLOMDEKK)\b/, 'Tween deck'],
  ['main_deck', 'MD', 4, /\b(MAIN DECK|HAUPTDECK|HOOFDDEK|HOVEDDEKK|HUVUDDAECK|PAEAEKANSI|PAAKANSI|BULKHEAD DECK|SCHOTTENDECK)\b/, 'Main deck'],
  ['shelter_deck', 'SD', 4.8, /\b(SHELTER DECK|SHELTERDECK)\b/, 'Shelter deck'],
  ['upper_deck', 'UD', 5, /\b(UPPER DECK|OBERDECK|BOVENDEK|OEVRE DEKK|OEVERDAECK|YLAEKANSI)\b/, 'Upper deck'],
  ['forecastle', 'FC', 5.5, /\b(FORECASTLE(?: DECK)?|FCLE(?: DECK)?|FOCSLE(?: DECK)?|BACKDECK|BAKDEK|BAKKDEKK|BACK)\b/, 'Forecastle deck'],
  ['poop', 'PP', 5.5, /\b(POOP(?: ?DECK)?|POOPDEK)\b/, 'Poop deck'],
  ['boat_deck', 'BT', 6.5, /\b(BOAT DECK|BOOTSDECK|SLOEPENDEK|BAATDAECK|BAATDEKK|VENEKANSI)\b/, 'Boat deck'],
  ['bridge_deck', 'BD', 9, /\b(BRIDGE DECK|NAVIGATION DECK|NAV DECK|NAVIGATING BRIDGE DECK|WHEEL ?HOUSE DECK|BRUECKENDECK|NAVIGATIONSDECK|STUURHUISDEK|BRUGDEK|BROODEKK|KOMENTOSILTA)\b/, 'Bridge deck'],
  ['top', 'TOP', 10, /\b(WHEEL ?HOUSE TOP|TOP OF WHEEL ?HOUSE|MONKEY ISLAND|MONKEY BRIDGE|COMPASS DECK|PEILDECK|PEILDEK|STEUERHAUSDACH)\b/, 'Wheelhouse top'],
  ['wheelhouse', 'WH', 9, /^(WHEEL ?HOUSE|WHEELHOUSE LEVEL|STEUERHAUS|STUURHUIS|BRIDGE)$/, 'Wheelhouse'],
];
const LEVEL_RE = /\b(?:0(\d)|(\d{1,2})) ?(?:DECK|LEVEL|DEK|DEKK|DAECK|KANSI)\b|\b(?:DECK|LEVEL) 0?(\d{1,2})\b/;

/**
 * Deck name in a text → { key, id, rank, name, below } or null. "Below Main Deck" (a plan of the space under the main
 * deck) gives the main deck's key with below: true and a rank half a level lower.
 */
export function deckOf(text) {
  const t = normText(text);
  if (!t || t.length > 60) return null;
  const below = /^(BELOW|UNDER|UNTER|ONDER|UNDER) /.test(t) || / (BELOW|UNTER)$/.test(t);
  const core = t.replace(/^(BELOW|UNDER|UNTER|ONDER) /, '').replace(/ (PLAN|ARRANGEMENT|DRAUFSICHT|GRUNDRISS)$/, '').replace(/^(PLAN OF|ARRANGEMENT OF|PLAN) /, '');
  let hit = null;
  for (const [key, id, rank, re, name] of DECKS) if (re.test(core)) { hit = { key, id, rank, name }; break; }
  if (!hit) {
    const m = LEVEL_RE.exec(core);
    if (m) {
      const n = Number(m[1] ?? m[2] ?? m[3]);
      if (n >= 0 && n <= 20) hit = { key: `level_${n}`, id: String(n).padStart(2, '0'), rank: 5 + n, name: `${String(n).padStart(2, '0')} deck` };
    }
  }
  if (!hit) return null;
  if (below) return { ...hit, key: `below_${hit.key}`, id: `B${hit.id}`, rank: hit.rank - 0.5, below: hit.key, name: String(text).trim() };
  return { ...hit, name: String(text).trim() };
}

// ---------- view titles ----------

const VIEW_WORDS = [
  // transverse views first: "Outboard profile seen from forward" is an end view
  ['section', /\b(SEEN FROM (FORWARD|AFT|FWD|BOW|STERN)|LOOKING (FORWARD|AFT|FWD)|VIEW FROM (FORWARD|AFT)|FRONT VIEW|END VIEW|STERN VIEW|BOW VIEW|MIDSHIP SECTION|MIDSHIPS SECTION|CROSS SECTION|TRANSVERSE SECTION|BODY PLAN|SECTION|SECT|HAUPTSPANT|SPANT|QUERSCHNITT|SCHNITT|DWARSDOORSNEDE|SPANTENRISS|VORANSICHT|HECKANSICHT)\b/],
  ['profile', /\b(INBOARD PROFILE|OUTBOARD PROFILE|PROFILE|ELEVATION|SIDE VIEW|LONGITUDINAL SECTION|SEITENANSICHT|LAENGSSCHNITT|ZIJAANZICHT|LANGSDOORSNEDE|PROFIL|SIVUKUVA|SIDOVY|SIDERISS|LENGDESNITT)\b/],
  ['plan', /\b(PLAN|DECK PLAN|DRAUFSICHT|GRUNDRISS|DEKPLAN|DECKSPLAN)\b/],
];

/** View title → { kind, profile: 'inboard' | 'outboard' | null, frame } or null. */
export function viewTitleOf(text) {
  const t = normText(text);
  if (!t || t.length > 70) return null;
  for (const [kind, re] of VIEW_WORDS) {
    if (!re.test(t)) continue;
    if (kind === 'plan' && /GENERAL|ARRANGEMENT$|CAPACITY/.test(t)) continue;
    const fr = /\b(?:FR|FRAME|SPANT|SP)\.? ?(-?\d+)\b/.exec(t);
    return { kind, profile: kind === 'profile' ? (/INBOARD|LAENGSSCHNITT|LONGITUDINAL|LANGSDOORSNEDE/.test(t) ? 'inboard' : /OUTBOARD|ANSICHT|SIDE VIEW|ZIJAANZICHT/.test(t) ? 'outboard' : null) : null, frame: fr ? Number(fr[1]) : null };
  }
  const deck = deckOf(text);
  if (deck) return { kind: 'plan', deck, profile: null, frame: null };
  return null;
}

// ---------- title block ----------

const TITLE_BLOCK = /\b(DRAWN|CHECKED|APPROVED|DESIGNED|SCALE|DWG ?NO|DRG ?NO|DRAWING NO|DRAWING NUMBER|DATE|REV|REVISION|SHEET|TITLE|PROJECT|CLIENT|OWNER|YARD|HULL NO|NEWBUILDING|GENERAL ARRANGEMENT|GENERALPLAN|GENERAL PLAN|ZEICHNUNG|ZEICHNUNGS[ -]?NR|PLAN[ -]?NR|PROJEKT|PROGETTO|PROJET|DISEGNO|N DISEGNO|DESSIN|N DE DESSIN|N DE PLAN|MASSSTAB|MASSTAB|SCALA|ECHELLE|ESCALA|GEZ|GEPR|GEPRUEFT|BLATT|DATUM|BAUNUMMER|WERFT|ALGEMEEN PLAN|TEKENING|SCHAAL|YLEISJAERJESTELY|GENERALARRANGEMANG|NAVAL ARCHITECTS|CONSULTING|SHIPYARD|LTD|GMBH|A S|AB|OY|BV|INC)\b/;
export const isTitleBlockWord = (text) => TITLE_BLOCK.test(normText(text));

// ---------- rooms ----------

// Ordered: specific before general ("fuel oil tank" before "tank", "engine control room" before "engine room").
const ROOMS = [
  [/^(UP|DN|DOWN|AUF|AB|OP|NED|VENT|VENTS|CASING|HATCH|FLUSH HATCH|DOOR|WINDOW|EMG|EXIT|EMG EXIT|EMERGENCY EXIT|NOTAUSGANG|DUCT|TRUNK FOR CABLES|MANHOLE|BELOW|ABOVE|OPEN|CL|C L|BL|AP|FP|FWD|AFT|PS|SB|STB)$/, null],
  [/\b(ENGINE CONTROL|ECR|CONTROL ROOM|CONTROL STATION|MASCHINENKONTROLL|MASCHINENLEITSTAND)\b/, 'space', 'control'],
  [/\b(FUEL OIL|F ?O TANK|FO TANK|FUEL TANK|FUEL|DAY TANK|SETTLING|SETTLINGS|MGO|MDO|HFO|DIESEL ?OIL|BUNKER|BRENNSTOFF|KRAFTSTOFF|DIESELOEL|BRANDSTOF|POLTTOAINE)\b/, 'fuel_tank', 'tank'],
  [/\b(BALLAST|FRESH WATER|F ?W TANK|FW TANK|DRINKING WATER|POTABLE|TRINKWASSER|FRISCHWASSER|SUESSWASSER|DRINKWATER|LUB ?OIL|LUBE OIL|HYDR ?OIL|HYDRAULIC OIL|WASTE OIL|SLUDGE|SEWAGE|SLOP|BILGE|GREY WATER|GRAY WATER|BLACK WATER|VOID|COFFERDAM|FORE ?PEAK|AFT ?PEAK|PEAK TANK|SEA CHEST|SEEKASTEN|ROLL DAMP|ANTI ?ROLL|HEELING|TANK|TANKS|BALLASTTANK|WASSERTANK)\b/, 'tank', 'tank'],
  [/\b(ENGINE ROOM|ENGINEROOM|MACHINERY|MACHINE ROOM|MOTOR ROOM|THRUSTER|GENERATOR|STEERING GEAR|STEERING ROOM|PUMP ROOM|PROPULSION|SWITCHBOARD|SWITCH BOARD|MASCHINENRAUM|HILFSMASCHINEN|RUDERMASCHINE|RUDERMASCH|MACHINEKAMER|KONEHUONE|MASKINRUM|MASKINROM|E ?R)\b/, 'machinery_space', 'machinery'],
  [/\b(WHEEL ?HOUSE|BRIDGE|PILOT ?HOUSE|CHART ROOM|RADIO ROOM|NAVIGATION|STEUERHAUS|BRUECKE|STUURHUT|STUURHUIS|STYRHUS|KOMENTOSILTA|SERVERS?|RACK|SRO|HMI|OPERATIONS|OPS ROOM)\b/, 'space', 'control'],
  [/\b(CORRIDOR|PASSAGE|PASSAGEWAY|ALLEYWAY|ALLEY|GANG|GANGWAY|FLUR|KORRIDOR|GAANG|KAEYTAEVAE)\b/, 'corridor', 'circulation'],
  [/\b(STAIR|STAIRS|STAIRWAY|STAIRCASE|STAIR TRUNK|TREPPE|TREPPENHAUS|TRAPPENHUIS|TRAPPA|TRAPP|TRAPPEROM|PORTAAT)\b/, 'stair', 'circulation'],
  [/\b(VERT ?LADDER|LADDER|LDR|LEITER|LEIDER|STEGE)\b/, 'ladder', 'circulation'],
  [/\b(MUSTER|ASSEMBLY STATION|ASSEMBLY|SAMMELPLATZ|SAMMELSTATION|VERZAMELPLAATS|MOENSTRING|KOKOONTUMIS)\b/, 'muster_station', 'open_deck'],
  [/\b(LIFE ?RAFTS?|RETTUNGSINSEL|REDDINGSVLOT|REDNINGSFLOTTE|LIVFLAATE|PELASTUSLAUTTA)\b/, 'liferaft', 'open_deck'],
  [/\b(RESCUE BOAT|FRC|FAST RESCUE|CRANE|A ?FRAME|WINCH|CAPSTAN|WINDLASS|DAVIT|KRAN|KRAAN|WINDE|LIER|CONTAINER|HIAB|ANCHOR|MOORING)\b/, 'equipment', null],
  [/\b(OPEN DECK|WORKING DECK|WORK DECK|AFT DECK|WEATHER DECK|ARBEITSDECK|WERKDEK|ARBETSDAECK|ARBEIDSDEKK|SUN DECK|PROMENADE)\b/, 'space', 'open_deck'],
  [/\b(WET LAB|DRY LAB|LAB|LABS|LABORATORY|LABORATORIES|HANGAR|SCIENCE|SCIENTIFIC|CHEM|CHEMICAL|LABOR|LABORATORIUM)\b/, 'space', 'lab'],
  [/\b(WORKSHOP|WINCH ROOM|DECK STORE|BOSUN|BOATSWAIN|CARGO HOLD|HOLD|WERKSTATT|WERKPLAATS|VERKSTAD|VERKSTED|KORJAAMO|ROPE STORE|PAINT STORE|LOCKER ROOM|DAMAGE CONTROL)\b/, 'space', 'working'],
  [/\b(GALLEY|PANTRY|LAUNDRY|STORE|STORES|PROVISION|PROVISIONS|COLD ROOM|COOL ROOM|FRIDGE|FRDG|FREEZER|FRZE|DRY PROV|TOILET|TOILETS|WC|HEAD|HEADS|SHOWER|BATH|WASH|WASHROOM|CHANGING|CHANGE ROOM|LINEN|DRYING|KOMBUESE|KUECHE|WAESCHEREI|PROVIANT|LAGER|VORRAT|TOILETTE|DUSCHE|KEUKEN|KOMBUIS|WASSERIJ|BYSSA|BYSSE|KEITTIOE|PESULA|VASKERI|TVAETTSTUGA|GARBAGE|WASTE|INCINERATOR|AC ROOM|A C ROOM|FAN ROOM|HVAC)\b/, 'space', 'service'],
  [/\b(MESS|MESSROOM|MESS ROOM|LOUNGE|DAY ?ROOM|CLASS ?ROOM|CONFERENCE|MEETING|RECREATION|GYM|SAUNA|OFFICE|LIBRARY|SALOON|MESSE|AUFENTHALT|SALON|DAGVERBLIJF|MESSI|OLESKELU|DAGLIGROM|DAGRUM)\b/, 'space', 'accommodation'],
  [/\b(CABIN|CABINS|STATEROOM|BERTH|BERTHS|CREW|OFFICER|OFFICERS|STUDENT|STUDENTS|CAPTAIN|MASTER|CHIEF|SCIENTIST|SCIENTISTS|PERSON|PERSONS|PAX|HOSPITAL|INFIRMARY|KAMMER|KABINE|KAJUETE|HUT|LUGAR|HYTT|HYTTI|SLAAPHUT|ACCOMMODATION|UNTERKUNFT|SINGLE|DOUBLE|SPARE|PILOT CABIN|OWNER)\b/, 'space', 'accommodation'],
  [/\b(HALL|LOBBY|FOYER|VESTIBULE|ENTRANCE|DIELE|VORRAUM|HAL|EINGANG)\b/, 'space', 'circulation'],
];

// Words of things that stand in a room (machines, fittings, furniture, deck equipment): a label made only of these
// (and numbers) names an object, not a room: "Frdg", "Frze", "Servers and 19" rack", "SRO/HMI", "Wash" / "Dry".
const EQUIPMENT_WORDS = new Set(('FRDG FRZE FRIDGE FREEZER REFRIGERATOR WASH DRY DRYER WASHER WASHING MACHINE TUMBLE STINK CHEM FUME ' +
  'CUPBOARD HOOD SINK BASIN SRO HMI SRO/HMI SWITCHBOARD MSB ESB RACK RACKS SERVER SERVERS AND CONTAINER CONTAINERS TMP KG CRANE ' +
  'WINCH A FRAME A-FRAME DAVIT CAPSTAN WINDLASS HIAB ANCHOR MOORING RESCUE BOAT FRC CABINET BUNK BED ' +
  'BEDS TABLE DESK SOFA CHAIR CHAIRS COOKER STOVE OVEN DISHWASHER BOLLARD FAIRLEAD REEL DRUM COMPRESSOR PUMP PUMPS ' +
  'KUEHLSCHRANK GEFRIERSCHRANK WASCHMASCHINE TROCKNER SPUELE HERD').split(' '));
// these make a label a room even when the rest are object words ("Switchboard room", "Winch room", "Chem lab")
const ROOM_HINT = /\b(ROOM|ROOMS|STORE|STORES|SPACE|HOLD|LAB|LABS|CABIN|DECK|STATION|TANK|LOCKER)\b/;

/** A label that names a thing in a room (a fridge, a server rack, a switchboard, a crane), not the room itself. */
export function isEquipmentLabel(text) {
  const t = normText(text);
  if (!t || ROOM_HINT.test(t)) return false;
  const words = t.split(/[\s/]+/).filter((w) => w && !/\d/.test(w));
  return words.length > 0 && words.every((w) => EQUIPMENT_WORDS.has(w));
}

/**
 * Room label → { type, zone, words } or null when the text is not a room name (a number, an area, "Up", "Vent").
 * "2 crew 6,4 m²" → space/accommodation.
 */
export function roomOf(text) {
  const raw = String(text ?? '');
  const t = normText(raw.replace(/\d+(?:[.,]\d+)?\s*m\s*[²2³3?�]/gi, ' ').replace(/\b\d+(?:[.,]\d+)?\s*(?:mm|m)\b/gi, ' '));
  if (!t || !/[A-Z]{2,}/.test(t)) return null;
  if (isEquipmentLabel(raw)) return { type: 'equipment', zone: null };
  for (const [re, type, zone] of ROOMS) {
    if (!re.test(t)) continue;
    if (!type) return null;
    return { type, zone: zone ?? null };
  }
  return null;
}

/** A word that is clearly not a room name but a drawing annotation (stair direction, vent, hatch, …). */
export function isAnnotationWord(text) {
  const t = normText(text);
  return /^(UP|DN|DOWN|AUF|AB|OP|NED|VENT|CASING|HATCH|FLUSH HATCH|DOOR|WINDOW|EMG|EXIT|EMG EXIT|EMERGENCY EXIT|CL|C L|BL|AP|FP|PS|SB|FWD|AFT)$/.test(t)
    || (RULES.unitLabels && isUnitLabel(t));
}

/**
 * The name of a dwelling or unit written over its first room ("Whg. D", "App. A", "Apartment 3", "Unit 12", "Flat B"):
 * which unit the rooms belong to, not a room name. Kept apart from the room name under it.
 */
export function isUnitLabel(text) {
  return /^(WHG|WOHNUNG|APP|APPT|APT|APPARTEMENT|APPARTAMENTO|APARTMENT|UNIT|FLAT|LOGEMENT|EINHEIT|SUITE)\s*[A-Z0-9]{1,3}$/.test(normText(text));
}

/** Stair direction words: 'up' | 'down' | null. */
export function stairWord(text) {
  const t = normText(text);
  if (/^(UP|AUF|OP|OPP|YLOES|HOCH)$/.test(t)) return 'up';
  if (/^(DN|DOWN|AB|NED|ALAS|RUNTER)$/.test(t)) return 'down';
  return null;
}

// ---------- numbers, scale, dimensions ----------

/** "28,00" / "6.500" / "3 800" → number (comma or point as decimal mark; space as thousands separator). */
export function parseNumber(s) {
  const t = String(s).trim().replace(/(\d)\s(?=\d{3}\b)/g, '$1');
  if (!/^[+-]?\d+(?:[.,]\d+)?$/.test(t)) return null;
  return Number(t.replace(',', '.'));
}

/** A text that is only a number (a dimension value, a frame number). */
export function numericText(text) {
  return parseNumber(String(text).replace(/\s*mm$/i, ''));
}

/** "SCALE 1:100", "M 1:50", "Maßstab 1:100", "Échelle 1:200", "1:100", "1:100 (A3)", '1/8" = 1\'-0"' → { n, labelled } or null. */
export function scaleOf(text) {
  const raw = String(text);
  const imp = /(\d+)\s*\/\s*(\d+)\s*(?:"|''|IN)\s*=\s*1\s*'\s*-?\s*0?\s*"?/i.exec(raw);
  if (imp) return { n: (12 * Number(imp[2])) / Number(imp[1]), labelled: /SCALE/i.test(raw) };
  const t = normText(raw);
  const m = /(?:\b(SCALE|MASSSTAB|MASSTAB|MASZSTAB|SCHAAL|SKALA|SKALE|MITTAKAAVA|SCALA|ECHELLE|ESCALA|M)\b\s*[:=]?\s*)?\b1\s*[:/]\s*(\d+(?:[.,]\d+)?)\b/.exec(t);
  if (!m) return null;
  const n = Number(m[2].replace(',', '.'));
  if (!(n >= 1 && n <= 5000)) return null;
  // a bare ratio is accepted only when it is the whole text (a ratio inside other words is a slope, a gear ratio…),
  // optionally with the paper size it holds for ("1:100 (A3)", "1:50 @ A1")
  if (!m[1] && !/^\s*\(?1\s*[:/]\s*\d+(?:[.,]\d+)?\)?(?:\s*(?:@|AT)?\s*\(?(?:ISO\s*)?(?:A[0-5]|B[0-5]|LETTER|TABLOID|ANSI\s*[A-E])\)?)?\s*$/.test(t)) return null;
  return { n, labelled: !!m[1] };
}

/** A length with an optional unit → mm. Without a unit: below 500 it is metres, else millimetres. */
export function lengthMM(s) {
  const m = /([+-]?\d+(?:[ .,]\d+)*)\s*(mm|cm|m)?\b/i.exec(String(s));
  if (!m) return null;
  const vv = parseNumber(m[1]) ?? Number(m[1].replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(vv)) return null;
  const unit = (m[2] || '').toLowerCase();
  if (unit === 'mm') return { mm: vv, unit: 'mm' };
  if (unit === 'cm') return { mm: vv * 10, unit: 'cm' };
  if (unit === 'm') return { mm: vv * 1000, unit: 'm' };
  return Math.abs(vv) < 500 ? { mm: vv * 1000, unit: null, guessed: 'm' } : { mm: vv, unit: null, guessed: 'mm' };
}

// Principal dimension keys on normalised text.
const PRINCIPAL = [
  ['length_overall', /\b(LENGTH (O A|OA|O\.A|OVER ?ALL)|LOA|L O A|L OA|LUEA|LAENGE UEBER ALLES|LENGTE OVER ALLES|LAENGD OEVER ALLT|STOERSTE LENGDE|SUURIN PITUUS)\b/],
  ['length_bp', /\b(LENGTH (B ?P|BP|BETWEEN PERP\w*)|LBP|LPP|L B P|L P P|LAENGE ZWISCHEN DEN LOTEN|LENGTE TUSSEN DE LOODLIJNEN)\b/],
  ['beam', /\b(BREADTH|BEAM|BREITE|BREEDTE|BREDD|BREDDE|LEVEYS|B MLD|B MOULDED|B)\b/],
  ['depth', /\b(DEPTH|SEITENHOEHE|HOLTE|DJUP|DYBDE|KORKEUS|D MLD|D)\b/],
  ['draft', /\b(DRAUGHT|DRAFT|DESIGN DRAFT|TIEFGANG|DIEPGANG|DJUPGAAENDE|DYPGAAENDE|SYVAEYS|T)\b/],
];

/**
 * A principal dimension in one text ("LOA 60.00 m", "B = 12,0 m") → { key, mm?, unit } ; a label alone ("Length o.a")
 * → { key } (its value is the number next to it on the same row).
 */
export function principalOf(text) {
  const raw = String(text);
  const t = normText(raw);
  if (t.length > 50) return null;
  for (const [key, re] of PRINCIPAL) {
    const m = re.exec(t);
    if (!m) continue;
    // one-letter keys only as "B =", "B 12.0 m" or "B" alone
    if (/^[BDT]$/.test(m[1]) && !(new RegExp(`^${m[1]}( ?=|$| [+-]?\\d)`).test(t))) continue;
    const rest = raw.slice(raw.search(/[0-9]/) >= 0 ? raw.search(/[0-9]/) : raw.length);
    const len = rest ? lengthMM(rest) : null;
    return len ? { key, mm: len.mm, unit: len.unit ?? len.guessed, guessedUnit: !len.unit } : { key };
  }
  return null;
}

/** "FRAME SPACING 600", "Spantabstand 550 mm", "Frame spacing 500 mm" → mm. */
export function frameSpacingOf(text) {
  const t = normText(text);
  const m = /\b(FRAME SPACING|FR SPACING|FRAMESPACING|SPANTABSTAND|SPANTENAFSTAND|SPANTAFSTAND|SPANTAVSTAAND|SPANTAVSTAND|KAARIVAELI|RUNKOVAELI)\b\s*[:=]?\s*([0-9][0-9 .,]*)\s*(MM|M)?/.exec(t);
  if (!m) return null;
  const v = parseNumber(m[2].trim());
  if (v == null) return null;
  const mm = m[3] === 'M' ? v * 1000 : !m[3] && v < 5 ? v * 1000 : v;
  return mm >= 150 && mm <= 2000 ? mm : null;
}

/** "FR 10", "#10", "SP 10", "F10", "Frame 24" → frame number; a bare number is not a frame label here. */
export function frameOf(text) {
  const t = normText(text);
  const m = /^(?:FR|FRAME|SP|SPANT|#|F)\s?(-?\d{1,3})$/.exec(t);
  return m ? Number(m[1]) : null;
}

/** Elevation text near a deck line: "6500 ABL", "+6.500", "6.5 m AB", "BL + 6500", "6500 ü. BL" → mm above base. */
export function elevationOf(text) {
  const raw = String(text);
  const t = normText(raw).replace(/ UE BL\b| UEBER BL\b| UE\.? ?BL\b/, ' ABL');
  let m = /^(?:[A-Z ]*?)\s*([+-]?\d+(?:[.,]\d+)?)\s*(MM|M)?\s*(?:A ?B ?L|ABL|ABOVE (?:B ?L|BASE ?LINE|BASE)|AB|OB ?L|OBL|ABOVE KEEL|AK)\b/.exec(t);
  if (!m) { const b = /\bB ?L ?\+ ?(\d+(?:[.,]\d+)?)\s*(MM|M)?\b/.exec(t); if (b) m = [b[0], b[1], b[2]]; }
  if (!m) { const p = /^\+ ?(\d+[.,]\d{3}|\d{3,5})$/.exec(t); if (p) m = [p[0], p[1], null]; }
  if (!m) return null;
  const v = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(v)) return null;
  const mm = m[2] === 'M' ? v * 1000 : m[2] === 'MM' ? v : /[.,]/.test(m[1]) && v < 100 ? v * 1000 : v;
  return mm >= -5000 && mm <= 80000 ? mm : null;
}

/** Printed area "8,2 m²" / "8.2 m2" / "8,2 m?" → m². */
export function areaOf(text) {
  const m = /(\d+(?:[.,]\d+)?)\s*m\s*(?:²|2|\^2|\?|�)(?![0-9])/i.exec(String(text));
  if (!m) return null;
  const v = Number(m[1].replace(',', '.'));
  return v > 0 && v < 5000 ? v : null;
}

/** Direction words: 'fwd' | 'aft' | null (FP, FWD, BOW, BUG, VORN … / AP, AFT, STERN, HECK …). */
export function endWord(text) {
  const t = normText(text);
  if (/^(F ?P|FP|FWD|FORWARD|FORE|BOW|BUG|VORN|VORAUS|BOEG|VOORUIT|KEULA|FOER)$/.test(t)) return 'fwd';
  if (/^(A ?P|AP|AFT|STERN|HECK|ACHTERN|ACHTER|ACHTERSCHIP|PERAE|AKTER)$/.test(t)) return 'aft';
  return null;
}

/** Ship type words in a title ("RESEARCH VESSEL") → the model's ship.type value. */
export function shipTypeOf(text) {
  const t = normText(text);
  const types = [
    ['research', /\b(RESEARCH|SURVEY|OCEANOGRAPHIC|FORSCHUNG|FORSCHUNGSSCHIFF|ONDERZOEK|TUTKIMUS|FORSKNING)\b|\bR ?V\b/],
    ['passenger', /\b(PASSENGER|CRUISE|FERRY|RO ?PAX|FAEHRE|PASSAGIER|VEERBOOT|MATKUSTAJA)\b/],
    ['tanker', /\b(TANKER|TANKSCHIFF)\b/],
    ['cargo', /\b(CARGO|CONTAINER SHIP|BULK|GENERAL CARGO|FRACHT|VRACHT)\b/],
    ['fishing', /\b(FISHING|TRAWLER|FISCHEREI|VISSERIJ|KALASTUS)\b/],
    ['tug', /\b(TUG|SCHLEPPER|SLEEPBOOT)\b/],
    ['offshore', /\b(OFFSHORE|PSV|SUPPLY VESSEL|AHTS)\b/],
    ['yacht', /\b(YACHT|JACHT)\b/],
  ];
  for (const [type, re] of types) if (re.test(t)) return type;
  return null;
}
