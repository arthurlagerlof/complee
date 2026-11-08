// Static model screenshots keep findings accessible when the model gateway is unavailable.
export function createFallbackViewer(container) {
  let images = [], reason = '';
  const head = document.createElement('div');
  head.className = 'fb-head';
  const gallery = document.createElement('div');
  container.append(head, gallery);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let selected = '';
  function renderHead() {
    head.innerHTML = `<b>3D model unavailable</b>${reason ? `: ${esc(reason)}.` : '.'}
      The findings on the left are computed locally by the deterministic checker; the screenshots below show the same model.
      ${selected ? `<br>${selected}` : ''}`;
  }
  function renderGallery() {
    gallery.innerHTML = images.map((src) => `<figure><img src="${src}" alt="RCRV model screenshot" onerror="this.closest('figure').remove()"><figcaption>${esc(src.split('/').pop())}</figcaption></figure>`).join('');
  }
  const noop = () => {};
  return {
    setImages(list) { if (JSON.stringify(list) !== JSON.stringify(images)) { images = list; renderGallery(); } renderHead(); },
    setReason(r) { reason = r; renderHead(); },
    build() { renderHead(); }, update: noop, paintNeutral: noop,
    select(id, { label } = {}) { selected = `Selected: <b>${esc(id)}</b>${label ? ` · ${label}` : ''}`; renderHead(); },
    setLabel(id, label) { if (selected) { selected = `Selected: <b>${esc(id)}</b>${label ? ` · ${label}` : ''}`; renderHead(); } },
    clearSelection() { selected = ''; renderHead(); },
    highlight(statusById) {
      const n = Object.keys(statusById).length;
      selected = `Rule view: ${n} part${n === 1 ? '' : 's'} listed on the right (3D highlight needs the model viewer).`;
      renderHead();
    },
    clearHighlight() { selected = ''; renderHead(); },
    setSimple: noop, deckLevels: () => [], setDeckCut: () => null,
    flyToElement: noop, setFilter: noop, overview: noop, setMode: noop, setPlan: noop,
    get mode() { return 'all'; }, get plan() { return false; }, get simple() { return false; },
  };
}
