// IFC import in the browser: web-ifc (wasm, served from node_modules) + src/ifc-convert.mjs.
// Loaded on demand, the first time an .ifc file is opened.
import * as WebIFC from './node_modules/web-ifc/web-ifc-api.js';
import { convertIfc } from './src/ifc-convert.mjs';

let ready = null;
function ifcApi() {
  ready ??= (async () => {
    const api = new WebIFC.IfcAPI();
    api.SetWasmPath(new URL('./node_modules/web-ifc/', import.meta.url).href, true);
    await api.Init();
    return api;
  })();
  return ready;
}

export async function importIfc(file) {
  const api = await ifcApi();
  const bytes = new Uint8Array(await file.arrayBuffer());
  return convertIfc(WebIFC, api, bytes, file.name);
}
