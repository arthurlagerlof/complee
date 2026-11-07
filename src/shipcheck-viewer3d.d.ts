export type ShipcheckViewer = {
  build: (model: unknown, results: { elements: Record<string, unknown> }) => void
  overview: () => void
  setPlan: (enabled: boolean) => void
  dispose: () => void
}

export function createViewer(container: HTMLElement): ShipcheckViewer
