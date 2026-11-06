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
