export type InspectionPoint = {
  id: string
  number: string
  component: string
  shortLabel: string
  observation: string
  regulatoryConsideration: string
  evidence: string
  status: string
  statusTone: 'verify' | 'missing' | 'evidence'
  action: string
  markerPosition: { left: string; top: string }
}

export type ReviewExample = {
  id: string
  part: string
  status: 'non_compliant' | 'not_enough_info' | 'compliant'
  statusLabel: string
  ruleId: string
  source: string
  clause: string
  measured: string
  required: string
  explanation: string
  inputs: string
  provision: string
  tags: string[]
}

// Same fields as a 3D-review result. Values are the documented example checks, shown here as an illustration.
export const reviewExamples: ReviewExample[] = [
  {
    id: 'deadend',
    part: 'Corridor 01-C2',
    status: 'non_compliant',
    statusLabel: 'Non-compliant',
    ruleId: 'SOLAS-II-2-13-DEADEND-CARGO',
    source: 'SOLAS II-2/13',
    clause: 'cargo-ship dead-end limit',
    measured: '7.5 m',
    required: '≤ 7 m',
    explanation: 'The dead end is 7.5 m, longer than 7 m. The 13 m passenger-ship limit is not applied to this example.',
    inputs: 'dead-end length = 7.5 m, from the layout example',
    provision: 'Dead-end corridors are limited. In this example the cargo-ship limit of 7 m is the value used.',
    tags: ['Rule value not yet verified against official text', 'Reviewed by Meyer mentors (Q&A, 7 Nov)', 'Paraphrased text', 'Basis: interpretation'],
  },
  {
    id: 'pipe',
    part: 'Oil fuel pipe',
    status: 'not_enough_info',
    statusLabel: 'Not enough info',
    ruleId: 'SOLAS-II-2-4.2.2.5.1-FO-PIPE',
    source: 'SOLAS II-2/4.2.2.5.1',
    clause: 'oil fuel pipe material',
    measured: '5083 aluminium',
    required: 'steel or other approved material',
    explanation: 'The material is not steel, and the model does not record an approval for another material. The check stays at not enough info.',
    inputs: 'pipe material = 5083 aluminium, from the model material field',
    provision: 'Oil fuel pipes, valves and fittings are to be of steel or other approved material.',
    tags: ['Rule value not yet verified against official text', 'Reviewed by Meyer mentors (Q&A, 7 Nov)', 'Paraphrased text'],
  },
  {
    id: 'corridor-ok',
    part: 'Corridor 02-C1',
    status: 'compliant',
    statusLabel: 'Compliant',
    ruleId: 'SOLAS-II-2-13-DEADEND-CARGO',
    source: 'SOLAS II-2/13',
    clause: 'cargo-ship dead-end limit',
    measured: '4 m',
    required: '≤ 7 m',
    explanation: 'The dead end is 4 m, within the 7 m limit used for this example.',
    inputs: 'dead-end length = 4 m, from the layout example',
    provision: 'Dead-end corridors are limited. In this example the cargo-ship limit of 7 m is the value used.',
    tags: ['Rule value not yet verified against official text', 'Reviewed by Meyer mentors (Q&A, 7 Nov)', 'Paraphrased text', 'Basis: interpretation'],
  },
]

export const inspectionPoints: InspectionPoint[] = [
  {
    id: 'fuel',
    number: '01',
    component: 'Fuel tank placement',
    shortLabel: 'Fuel tank',
    observation: 'The fuel tank arrangement should be evaluated in relation to passenger accommodation areas.',
    regulatoryConsideration: 'Applicable fuel-system requirements may impose restrictions on tank placement and separation from passenger spaces.',
    evidence: 'Tank location and passenger-space boundaries need to be confirmed.',
    status: 'Needs engineering verification',
    statusTone: 'verify',
    action: 'Review tank boundaries, space classification and applicable regulatory provisions.',
    markerPosition: { left: '29%', top: '59%' },
  },
  {
    id: 'ventilation',
    number: '02',
    component: 'Ventilation arrangement',
    shortLabel: 'Ventilation',
    observation: 'The available design information does not fully describe the ventilation arrangement.',
    regulatoryConsideration: 'Check the applicable requirements for the relevant spaces and systems.',
    evidence: 'Ventilation drawings or design specifications required.',
    status: 'Missing information',
    statusTone: 'missing',
    action: 'Provide the ventilation arrangement for assessment.',
    markerPosition: { left: '56%', top: '36%' },
  },
  {
    id: 'structure',
    number: '03',
    component: 'Structural design',
    shortLabel: 'Structure',
    observation: 'Structural design information should be checked against the applicable requirements.',
    regulatoryConsideration: 'Assessment depends on the applicable requirements and supporting design basis for the structure.',
    evidence: 'Supporting calculations and structural documentation required.',
    status: 'Evidence needed',
    statusTone: 'evidence',
    action: 'Attach the relevant calculations and drawings.',
    markerPosition: { left: '76%', top: '63%' },
  },
]
