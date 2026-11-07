// Repartition existing GLBs into small spatial tiles. No SVF, credentials, simplification or requantization.
// Copy decoded attribute bytes exactly, retain node transforms and dbIds, and losslessly recompress each tile.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODEL = path.join(ROOT, 'model');
const OUT = path.join(MODEL, 'stream');
const MAX_TRIANGLES = 160000;
const CELL_MM = 6000;
const align = n => (n + 3) & ~3;
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
function disk() {
  const d = fs.statfsSync(MODEL), free = d.bavail * d.bsize;
  if (free < 3e9) throw Error(`STOP: ${(free / 1e9).toFixed(2)} GB free; at least 3 GB is required`);
}
export async function decodeGlb(file) {
  await MeshoptDecoder.ready;
  const bin = fs.readFileSync(file);
  if (bin.readUInt32LE(0) !== 0x46546c67) throw Error('Not a GLB');
  const jsonSize = bin.readUInt32LE(12), json = JSON.parse(bin.subarray(20, 20 + jsonSize));
  const body = bin.subarray(28 + jsonSize);
  const views = json.bufferViews.map(view => {
    const ex = view.extensions?.EXT_meshopt_compression;
    if (!ex) return new Uint8Array(body.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength));
    const data = new Uint8Array(ex.count * ex.byteStride);
    MeshoptDecoder.decodeGltfBuffer(data, ex.count, ex.byteStride, body.subarray(ex.byteOffset, ex.byteOffset + ex.byteLength), ex.mode, ex.filter);
    return data;
  });
  return { json, views, hash: digest(bin) };
}
export function writeGlb(json, body) {
  const j = Buffer.from(JSON.stringify(json)), jp = Buffer.alloc(align(j.length), 32); j.copy(jp);
  const bp = Buffer.alloc(align(body.length)); Buffer.from(body).copy(bp);
  const h = Buffer.alloc(20); h.writeUInt32LE(0x46546c67); h.writeUInt32LE(2, 4); h.writeUInt32LE(28 + jp.length + bp.length, 8); h.writeUInt32LE(jp.length, 12); h.writeUInt32LE(0x4e4f534a, 16);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bp.length); bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([h, jp, bh, bp]);
}

export async function tileChunk(info) {
  disk(); await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
  const { json: j, views, hash } = await decodeGlb(path.join(MODEL, info.file));
  if (j.meshes.length !== 1 || j.nodes.length !== 1 || j.meshes[0].primitives.length !== 1) throw Error('Expected one static merged mesh per source chunk');
  const primitive = j.meshes[0].primitives[0], pa = j.accessors[primitive.attributes.POSITION], ia = j.accessors[primitive.indices];
  const ca = j.accessors[primitive.attributes.COLOR_0], node = j.nodes[0];
  if (pa.componentType !== 5123 || ia.componentType !== 5125 || node.rotation || node.matrix) throw Error('Unexpected source layout; refusing to reinterpret geometry');
  const ps = (j.bufferViews[pa.bufferView].byteStride || 6) / 2, po = (pa.byteOffset || 0) / 2;
  const positions = new Uint16Array(views[pa.bufferView].buffer), indices = new Uint32Array(views[ia.bufferView].buffer, ia.byteOffset || 0, ia.count);
  const colors = views[ca.bufferView], cs = j.bufferViews[ca.bufferView].byteStride || 4, co = ca.byteOffset || 0;
  const scale = node.scale || [1, 1, 1], tr = node.translation || [0, 0, 0];
  const cells = new Map();
  for (let t = 0; t < indices.length / 3; t++) {
    const a = indices[3*t]*ps+po, b = indices[3*t+1]*ps+po, c = indices[3*t+2]*ps+po;
    const key = [0,1,2].map(k => Math.floor(((positions[a+k]+positions[b+k]+positions[c+k])/3*scale[k]+tr[k])/CELL_MM)).join('_');
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(t);
  }
  const attrs = Object.entries(primitive.attributes).map(([semantic, index]) => ({ semantic, accessor: j.accessors[index], source: views[j.accessors[index].bufferView], stride: j.bufferViews[j.accessors[index].bufferView].byteStride || 4 }));
  const entries = [];
  for (const [cell, list] of [...cells].sort((a,b)=>a[0].localeCompare(b[0]))) {
    for (let offset = 0; offset < list.length; offset += MAX_TRIANGLES) {
      disk();
      const count = Math.min(MAX_TRIANGLES, list.length-offset), oldVertices = [], remap = new Map(), outIndex = new Uint32Array(count*3), dbIds = new Set();
      const min = [Infinity,Infinity,Infinity], max = [-Infinity,-Infinity,-Infinity], localMin=[Infinity,Infinity,Infinity], localMax=[-Infinity,-Infinity,-Infinity];
      for (let t=0;t<count;t++) for (let k=0;k<3;k++) {
        const old=indices[list[offset+t]*3+k];
        let next=remap.get(old);
        if(next===undefined){
          next=oldVertices.length; remap.set(old,next); oldVertices.push(old);
          const p=old*ps+po;
          for(let a=0;a<3;a++){const q=positions[p+a],v=q*scale[a]+tr[a];min[a]=Math.min(min[a],v);max[a]=Math.max(max[a],v);localMin[a]=Math.min(localMin[a],q);localMax[a]=Math.max(localMax[a],q);}
          const b=old*cs+co;dbIds.add((colors[b]|colors[b+1]<<8|colors[b+2]<<16|colors[b+3]<<24)>>>0);
        }
        outIndex[t*3+k]=next;
      }
      const rawViews = attrs.map(a=>{
        const data=new Uint8Array(oldVertices.length*a.stride);
        for(let v=0;v<oldVertices.length;v++) data.set(a.source.subarray(oldVertices[v]*a.stride,(oldVertices[v]+1)*a.stride),v*a.stride);
        return{data,stride:a.stride,count:oldVertices.length,mode:'ATTRIBUTES',target:34962};
      });
      rawViews.push({data:new Uint8Array(outIndex.buffer),stride:4,count:outIndex.length,mode:'INDICES',target:34963});
      let compressedOffset=0,decodedOffset=0;const output=[];
      const bufferViews=rawViews.map(v=>{
        const packed=MeshoptEncoder.encodeGltfBuffer(v.data,v.count,v.stride,v.mode);
        // Check every byte after re-encoding; normals and positions are not quantized a second time.
        const check=new Uint8Array(v.data.length);MeshoptDecoder.decodeGltfBuffer(check,v.count,v.stride,packed,v.mode);
        if(!Buffer.from(check).equals(Buffer.from(v.data)))throw Error('Lossless tile roundtrip failed');
        const entry={buffer:1,byteOffset:decodedOffset,byteLength:v.data.length,...(v.target===34962?{byteStride:v.stride}:{}),target:v.target,extensions:{EXT_meshopt_compression:{buffer:0,byteOffset:compressedOffset,byteLength:packed.length,byteStride:v.stride,count:v.count,mode:v.mode}}};
        const block=Buffer.alloc(align(packed.length));Buffer.from(packed).copy(block);output.push(block);compressedOffset+=block.length;decodedOffset+=align(v.data.length);return entry;
      });
      const accessors=attrs.map((a,i)=>({...a.accessor,bufferView:i,count:oldVertices.length,...(a.semantic==='POSITION'?{min:localMin,max:localMax}:{})}));
      accessors.push({...ia,bufferView:attrs.length,count:outIndex.length});
      const gj={asset:{version:'2.0',generator:'ShipCheck lossless spatial tiler'},extensionsUsed:j.extensionsUsed,extensionsRequired:j.extensionsRequired,scene:0,scenes:[{nodes:[0]}],nodes:[node],materials:j.materials,meshes:[{primitives:[{...primitive,attributes:Object.fromEntries(attrs.map((a,i)=>[a.semantic,i])),indices:attrs.length}]}],accessors,bufferViews,buffers:[{byteLength:compressedOffset},{byteLength:decodedOffset,extensions:{EXT_meshopt_compression:{fallback:true}}}]};
      const glb=writeGlb(gj,Buffer.concat(output)),name=`${info.name}-${cell}-${Math.floor(offset/MAX_TRIANGLES)}`,file=`${name}-${digest(glb).slice(0,12)}.glb`;
      fs.writeFileSync(path.join(OUT,file),glb);
      entries.push({name,file,group:info.group==='rest'?'rest':info.name==='context'?'context':'checked',source_chunk:info.name,bytes:glb.length,decoded_bytes:decodedOffset,resident_bytes:oldVertices.length*40+count*36,vertices:oldVertices.length,triangles:count,parts:dbIds.size,dbIds:[...dbIds],bounds_mm:{min,max}});
    }
  }
  const sum=entries.reduce((s,e)=>s+e.triangles,0);
  if(sum!==ia.count/3)throw Error('Triangle coverage changed');
  console.log(`${info.name}: ${entries.length} tiles, ${(entries.reduce((s,e)=>s+e.bytes,0)/1e6).toFixed(1)} MB, ${sum.toLocaleString('en')} triangles; lossless byte roundtrip OK`);
  return{entries,source:{file:info.file,sha256:hash,triangles:sum,tiles:entries.length}};
}

async function main(){
  fs.mkdirSync(OUT,{recursive:true});const original=JSON.parse(fs.readFileSync(path.join(MODEL,'manifest.json'),'utf8'));
  const chunks=[],sources=[];
  for(const info of original.chunks){const built=await tileChunk(info);chunks.push(...built.entries);sources.push(built.source);}
  const manifest={version:2,kind:'viewport-tiles',units:original.units,coordinate_system:original.coordinate_system,offset_mm:original.offset_mm,deck_levels:original.deck_levels,chunks,sources,integrity:{triangles:sources.reduce((s,c)=>s+c.triangles,0),attribute_roundtrip:'every decoded attribute and index byte checked; no simplification or requantization'},streaming:{detail_span_mm:24000,max_resident_bytes:512000000,max_detail_triangles:1500000,max_requests:2}};
  const pending=path.join(OUT,'manifest.pending.json');fs.writeFileSync(pending,JSON.stringify(manifest));fs.renameSync(pending,path.join(OUT,'manifest.json'));console.log(`Total ${chunks.length} viewport tiles, ${(chunks.reduce((s,e)=>s+e.bytes,0)/1e6).toFixed(1)} MB. Original GLBs retained.`);
}
if(process.argv[1]&&import.meta.url===new URL('file:///'+process.argv[1].replaceAll('\\','/')).href)await main();
