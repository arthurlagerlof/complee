// Independent retained-SVF -> original ten GLBs audit. Offline; writes only model/source-coverage.json.
// PowerShell, from repository root:
// node --max-old-space-size=6144 shipcheck/tools/export/audit-source-geometry.mjs
// No --download-svf, accounts, credentials, exports, tiles, or native Navisworks are used.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { mapParts, openScene, matrixOf, OUT, WORK } from './export-chunks.mjs';
import { decodeGlb } from './tile-model.mjs';
const require = createRequire(import.meta.url);
const IMF = require('svf-utils/lib/common/intermediate-format');
const FLOOR = 3_000_000_000;
const OUTPUT = path.join(OUT, 'source-coverage.json');
const EXPECTED = ['context','openings','structure-findings','piping','access','structure','rest-01','rest-02','rest-03','rest-04'];
const started = Date.now();
let peakRss = 0, minFree = Infinity;
function guard(stage) {
  const s = fs.statfsSync(OUT), free = Number(s.bavail) * Number(s.bsize);
  minFree = Math.min(minFree, free); peakRss = Math.max(peakRss, process.memoryUsage().rss);
  if (free < FLOOR) throw Error(`STOP before ${stage}: ${(free/1e9).toFixed(2)} GB free; at least 3 GB is required. No source or GLB was changed.`);
}
function readSmall(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
async function fingerprint(file) {
  const h = crypto.createHash('sha256');
  for await (const b of fs.createReadStream(file)) h.update(b);
  return h.digest('hex');
}
function filesUnder(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, {withFileTypes:true})) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p)); else if(e.isFile()) out.push(p);
    else throw Error('Refusing unexpected non-file/non-directory in the retained SVF cache');
  }
  return out.sort();
}
function emptyBounds() { return {min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]}; }
function point(b,x,y,z) {
  if(x<b.min[0])b.min[0]=x;if(x>b.max[0])b.max[0]=x;
  if(y<b.min[1])b.min[1]=y;if(y>b.max[1])b.max[1]=y;
  if(z<b.min[2])b.min[2]=z;if(z>b.max[2])b.max[2]=z;
}
function mergeBounds(a,b) { point(a,...b.min);point(a,...b.max); }
function samePosition(P,a,b) { return P[a]===P[b]&&P[a+1]===P[b+1]&&P[a+2]===P[b+2]; }
const floatScratch = new Float32Array(1), bits = new Uint32Array(floatScratch.buffer);
// Represent a finite Float32 exactly as an integer times 2^-149. Used only by uncertain determinant tests.
function exactFloat(v) {
  floatScratch[0]=v; const b=bits[0], e=(b>>>23)&255, m=b&0x7fffff;
  if(e===255)throw Error('Non-finite source position');
  const n=BigInt(e?m|0x800000:m)<<BigInt(e?e-1:0);
  return b>>>31?-n:n;
}
function exactCollinear(P,a,b,c) {
  const ax=exactFloat(P[a]),ay=exactFloat(P[a+1]),az=exactFloat(P[a+2]);
  const ux=exactFloat(P[b])-ax,uy=exactFloat(P[b+1])-ay,uz=exactFloat(P[b+2])-az;
  const vx=exactFloat(P[c])-ax,vy=exactFloat(P[c+1])-ay,vz=exactFloat(P[c+2])-az;
  return uy*vz===uz*vy && uz*vx===ux*vz && ux*vy===uy*vx;
}
function zeroArea(P,a,b,c) {
  if(samePosition(P,a,b)||samePosition(P,a,c)||samePosition(P,b,c))return true;
  const ux=P[b]-P[a],uy=P[b+1]-P[a+1],uz=P[b+2]-P[a+2];
  const vx=P[c]-P[a],vy=P[c+1]-P[a+1],vz=P[c+2]-P[a+2];
  const near=(x,y)=>Math.abs(x-y)<=Number.EPSILON*16*(Math.abs(x)+Math.abs(y));
  if(!near(uy*vz,uz*vy)||!near(uz*vx,ux*vz)||!near(ux*vy,uy*vx))return false;
  return exactCollinear(P,a,b,c);
}
function geometryStats(g) {
  const P=g.getVertices(), I=g.getIndices();
  if(!(P instanceof Float32Array))throw Error('Exact source determinant implementation requires Float32 vertices');
  if(I.length%3)throw Error('Mesh index count is not a multiple of three');
  let duplicate=0,zero=0,indexDuplicate=0;
  for(let k=0;k<I.length;k+=3){
    const ai=I[k],bi=I[k+1],ci=I[k+2],a=ai*3,b=bi*3,c=ci*3;
    if(c+2>=P.length||b+2>=P.length||a+2>=P.length)throw Error('Out-of-range source mesh index');
    if(ai===bi||ai===ci||bi===ci)indexDuplicate++;
    const dup=samePosition(P,a,b)||samePosition(P,a,c)||samePosition(P,b,c);
    if(dup)duplicate++;if(dup||zeroArea(P,a,b,c))zero++;
  }
  return {triangles:I.length/3,exact_zero_area:zero,duplicate_position:duplicate,duplicate_index:indexDuplicate};
}
function transformedVertices(node,g,frame) {
  const V=g.getVertices(),P=new Float32Array(V.length),M=matrixOf(node.transform);
  for(let v=0;v<V.length;v+=3){
    let x=V[v],y=V[v+1],z=V[v+2];
    if(M){const X=M[0]*x+M[4]*y+M[8]*z+M[12],Y=M[1]*x+M[5]*y+M[9]*z+M[13],Z=M[2]*x+M[6]*y+M[10]*z+M[14];x=X;y=Y;z=Z;}
    const o=frame.toOut(x,y,z);
    for(let a=0;a<3;a++){P[v+a]=o[a]*frame.scaleMM-frame.offset[a];if(!Number.isFinite(P[v+a]))throw Error('Non-finite transformed source coordinate');}
  }
  return P;
}
function record(dbId) {
 return {dbId,source_fragments:0,source_triangles:0,source_exact_zero_area:0,source_duplicate_position:0,source_duplicate_index:0,export_float32_zero_area:0,export_float32_duplicate_position:0,packed_triangles:0,packed_zero_area:0,packed_duplicate_position:0,source_bounds_mm:emptyBounds(),packed_bounds_mm:emptyBounds(),source_chunks:new Set(),packed_chunks:new Set()};
}
function keyFor(Q,a,b,c) { return [a,b,c].map(i=>`${Q[i]},${Q[i+1]},${Q[i+2]}`).sort().join(';'); }
function increment(m,k){m.set(k,(m.get(k)||0)+1);}
function consume(m,k){const n=m.get(k)||0;if(!n)return false;if(n===1)m.delete(k);else m.set(k,n-1);return true;}
function packedLayout(j,views){
 if(j.nodes.length!==1||j.meshes.length!==1||j.meshes[0].primitives.length!==1)throw Error('Expected the original one-node, one-primitive GLB format');
 const node=j.nodes[0],prim=j.meshes[0].primitives[0],pa=j.accessors[prim.attributes.POSITION],ia=j.accessors[prim.indices],ca=j.accessors[prim.attributes.COLOR_0];
 if(pa.componentType!==5123||ia.componentType!==5125||ca.componentType!==5121||node.rotation||node.matrix||pa.normalized||prim.mode&&prim.mode!==4)throw Error('Unexpected original GLB format; refusing to reinterpret it');
 const ps=(j.bufferViews[pa.bufferView].byteStride||6)/2,po=(pa.byteOffset||0)/2;
 const pv=views[pa.bufferView],iv=views[ia.bufferView];
 const P=new Uint16Array(pv.buffer,pv.byteOffset,pv.byteLength/2),I=new Uint32Array(iv.buffer,iv.byteOffset+(ia.byteOffset||0),ia.count);
 const C=views[ca.bufferView],cs=j.bufferViews[ca.bufferView].byteStride||4,co=ca.byteOffset||0;
 const id=v=>{const k=v*cs+co;return(C[k]|C[k+1]<<8|C[k+2]<<16|C[k+3]<<24)>>>0;};
 const scale=node.scale||[1,1,1],tr=node.translation||[0,0,0];
 if(I.length%3)throw Error('Invalid packed triangle count');
 return{P,I,ps,po,id,scale,tr,vertexCount:pa.count};
}

// Diagnostic only: compare loss-affected IDs as coordinate multisets on the decoded 16-bit quantization grid.
// Counts and bounds are audited for ALL IDs independently; grid reconstruction may be ambiguous at half-step boundaries.
function diagnoseLoss(db,packedTriangles,L,fragments,scene,frame){
 const {P,I,ps,po,scale,tr}=L,map=new Map();
 for(const t of packedTriangles)increment(map,keyFor(P,I[t]*ps+po,I[t+1]*ps+po,I[t+2]*ps+po));
 let matched=0,missing=0,missingRawZero=0,missingExportZero=0,missingGridDuplicate=0,missingGridZero=0,boundaryVertices=0;
 const examples=[];
 for(const index of fragments){
   const node=scene.getNode(index),g=scene.getGeometry(node.geometry),R=g.getVertices(),J=g.getIndices(),F=transformedVertices(node,g,frame),Q=new Uint16Array(F.length);
   for(let i=0;i<F.length;i++){
     const q=(F[i]-tr[i%3])/scale[i%3];
     if(Math.abs(q-Math.floor(q)-0.5)<0.002)boundaryVertices++;
     const rounded=Math.round(q);if(rounded<0||rounded>65535)throw Error('Source quantization grid outside Uint16 range');Q[i]=rounded;
   }
   for(let k=0;k<J.length;k+=3){
     const a=J[k]*3,b=J[k+1]*3,c=J[k+2]*3;
     if(consume(map,keyFor(Q,a,b,c))){matched++;continue;}
     missing++;
     const rawZero=zeroArea(R,a,b,c),floatZero=zeroArea(F,a,b,c),gridDup=samePosition(Q,a,b)||samePosition(Q,a,c)||samePosition(Q,b,c);
     // Integer coordinates are <=65535, so all cross-product arithmetic below is exact in Number.
     const ux=Q[b]-Q[a],uy=Q[b+1]-Q[a+1],uz=Q[b+2]-Q[a+2],vx=Q[c]-Q[a],vy=Q[c+1]-Q[a+1],vz=Q[c+2]-Q[a+2];
     const gridZero=uy*vz===uz*vy&&uz*vx===ux*vz&&ux*vy===uy*vx;
     if(rawZero)missingRawZero++;if(floatZero)missingExportZero++;if(gridDup)missingGridDuplicate++;if(gridZero)missingGridZero++;
     if(examples.length<5)examples.push({svf_node:node.dbid,geometry:node.geometry,triangle:k/3,source_exact_zero_area:rawZero,export_float32_zero_area:floatZero,reconstructed_grid_duplicate_position:gridDup,reconstructed_grid_zero_area:gridZero});
   }
 }
 return{dbId:db,matched_triangle_multiset:matched,unmatched_source:missing,unmatched_packed:[...map.values()].reduce((a,b)=>a+b,0),unmatched_source_exact_zero_area:missingRawZero,unmatched_source_export_float32_zero_area:missingExportZero,unmatched_source_grid_duplicate_position:missingGridDuplicate,unmatched_source_grid_zero_area:missingGridZero,near_half_step_source_vertices:boundaryVertices,examples};
}

async function main(){
 const flag=process.execArgv.find(a=>/^--max-old-space-size[= ]/.test(a));
 if(!flag||Number(flag.split(/[= ]/)[1])>6144)throw Error('Run with explicit node --max-old-space-size=6144 (or a smaller limit)');
 if(process.argv.includes('--download-svf'))throw Error('This audit is offline only');
 globalThis.fetch=async()=>{throw Error('Network disabled in source geometry audit');};
 guard('audit');
 const svfDir=path.join(WORK,'svf'),cacheFiles=filesUnder(svfDir);
 if(!cacheFiles.some(f=>f.endsWith('output.svf')))throw Error('Retained SVF not found; this audit never downloads it');
 const mf=path.join(OUT,'manifest.json'),planFile=path.join(WORK,'rest-plan.json');
 const manifest=readSmall(mf),plan=readSmall(planFile);
 if(manifest.chunks.length!==10||EXPECTED.some(n=>!manifest.chunks.find(c=>c.name===n&&c.file===`${n}.glb`)))throw Error('Expected precisely the original ten GLBs, not streaming/overview tiles');
 const cacheFingerprint=[];
 for(const f of cacheFiles){guard('source fingerprint');cacheFingerprint.push({file:path.relative(svfDir,f).replaceAll('\\','/'),bytes:fs.statSync(f).size,sha256:await fingerprint(f)});}
 const idFiles=['svf-to-svf2.bin','svf-parent.bin','svf-to-svf2.json'];
 const mappingInputs=[];for(const f of idFiles)mappingInputs.push({file:f,sha256:await fingerprint(path.join(WORK,f))});
 const mapSummary=readSmall(path.join(WORK,'svf-to-svf2.json'));
 console.log('Loading offline ID mapping via mapParts (streamed source JSON tree).');
 const {resolve,chunkOfPart,nodeById}=await mapParts();
 const hierarchyNodes=nodeById.size;
 const frame=await openScene(),{scene}=frame;
 const parts=new Map(),chunks=new Map(EXPECTED.map(n=>[n,{name:n,source_fragments:0,source_triangles:0,source_exact_zero_area:0,source_duplicate_position:0,source_duplicate_index:0,export_float32_zero_area:0,export_float32_duplicate_position:0,packed_triangles:0,packed_zero_area:0,packed_duplicate_position:0,source_bounds_mm:emptyBounds(),packed_bounds_mm:emptyBounds(),sourceIds:new Set(),packedIds:new Set()}]));
 const geoCache=new Map(),fragById=new Map();
 const totals={scene_nodes:scene.getNodeCount(),scene_geometries:scene.getGeometryCount(),svf2_hierarchy_objects:hierarchyNodes,nonempty_mesh_fragments:0,empty_mesh_fragments:0,non_mesh_fragments:0,non_object_nodes:0,unassigned_fragments:0,unassigned_triangles:0,assigned_via_part:0,assigned_own_id:0,assigned_nearest_ancestor:0,source_triangles:0,source_exact_zero_area:0,source_duplicate_position:0,source_duplicate_index:0,export_float32_zero_area:0,export_float32_duplicate_position:0};
 const unassigned=[];let invalidChunkAssignments=0;
 for(let i=0,n=scene.getNodeCount();i<n;i++){
   if(i%5000===0)guard('source enumeration');
   const node=scene.getNode(i);if(node.kind!==IMF.NodeKind.Object){totals.non_object_nodes++;continue;}
   const g=scene.getGeometry(node.geometry);if(g.kind!==IMF.GeometryKind.Mesh){totals.non_mesh_fragments++;continue;}
   const V=g.getVertices(),I=g.getIndices();if(!V?.length||!I?.length){totals.empty_mesh_fragments++;continue;}
   let gs=geoCache.get(node.geometry);if(!gs){gs=geometryStats(g);geoCache.set(node.geometry,gs);}
   totals.nonempty_mesh_fragments++;totals.source_triangles+=gs.triangles;
   totals.source_exact_zero_area+=gs.exact_zero_area;totals.source_duplicate_position+=gs.duplicate_position;totals.source_duplicate_index+=gs.duplicate_index;
   const r=resolve(node.dbid),db=r.part??r.near;
   if(db==null){totals.unassigned_fragments++;totals.unassigned_triangles+=gs.triangles;unassigned.push({node_index:i,svf_node:node.dbid,geometry:node.geometry,triangles:gs.triangles});continue;}
   if(r.part!=null)totals.assigned_via_part++;else if(r.own!=null)totals.assigned_own_id++;else totals.assigned_nearest_ancestor++;
   const main=r.part!=null?chunkOfPart.get(r.part):'rest';
   const which=main==='rest'?`rest-${String(Number(plan.assign[db])+1).padStart(2,'0')}`:main;
   const ch=chunks.get(which);if(!ch){invalidChunkAssignments++;continue;}
   let p=parts.get(db);if(!p){p=record(db);parts.set(db,p);}
   p.source_chunks.add(which);ch.sourceIds.add(db);p.source_fragments++;ch.source_fragments++;
   for(const s of [p,ch]){s.source_triangles+=gs.triangles;s.source_exact_zero_area+=gs.exact_zero_area;s.source_duplicate_position+=gs.duplicate_position;s.source_duplicate_index+=gs.duplicate_index;}
   if(!fragById.has(db))fragById.set(db,[]);fragById.get(db).push(i);
   const P=transformedVertices(node,g,frame);let zeros=0,dups=0;
   for(let k=0;k<I.length;k+=3){
     const a=I[k]*3,b=I[k+1]*3,c=I[k+2]*3;
     const dup=samePosition(P,a,b)||samePosition(P,a,c)||samePosition(P,b,c);if(dup)dups++;if(dup||zeroArea(P,a,b,c))zeros++;
     point(p.source_bounds_mm,P[a],P[a+1],P[a+2]);point(p.source_bounds_mm,P[b],P[b+1],P[b+2]);point(p.source_bounds_mm,P[c],P[c+1],P[c+2]);
   }
   for(const s of [p,ch,totals]){s.export_float32_zero_area+=zeros;s.export_float32_duplicate_position+=dups;}
   if(totals.nonempty_mesh_fragments%50000===0)console.log(`Source: ${totals.nonempty_mesh_fragments.toLocaleString('en')} fragments, ${totals.source_triangles.toLocaleString('en')} triangles`);
 }
 for(const p of parts.values())for(const n of p.source_chunks)mergeBounds(chunks.get(n).source_bounds_mm,p.source_bounds_mm);
 totals.unique_mesh_geometries_analyzed=geoCache.size;
 console.log(`Source complete: ${totals.nonempty_mesh_fragments.toLocaleString('en')} mesh fragments; ${totals.source_triangles.toLocaleString('en')} triangles; ${totals.source_exact_zero_area.toLocaleString('en')} exactly zero-area in source coordinates.`);
 const diagnostics=[],skippedDiagnostics=[],wrongChunkIds=new Set(),mixedIdTriangles=[];
 for(const info of manifest.chunks){
   guard(`decode ${info.name}`);
   const file=path.join(OUT,info.file),before=fs.statSync(file);
   const {json:j,views,hash}=await decodeGlb(file),L=packedLayout(j,views),{P,I,ps,po,id,scale,tr}=L,ch=chunks.get(info.name);
   ch.file=info.file;ch.bytes=before.size;ch.sha256=hash;ch.manifest_source_triangles=info.triangles;ch.quantization_step_mm=scale;
   ch.bounds_axis_tolerance_mm=scale.map(s=>Math.abs(s)/2+0.02);
   for(let t=0;t<I.length;t+=3){
     const ai=I[t],bi=I[t+1],ci=I[t+2];if(ai>=L.vertexCount||bi>=L.vertexCount||ci>=L.vertexCount)throw Error('Packed index out of range');
     const db=id(ai);if(id(bi)!==db||id(ci)!==db){if(mixedIdTriangles.length<30)mixedIdTriangles.push({chunk:info.name,triangle:t/3});throw Error('Triangle crosses dbIds; cannot assign coverage reliably');}
     let p=parts.get(db);if(!p){p=record(db);parts.set(db,p);}
     p.packed_chunks.add(info.name);ch.packedIds.add(db);p.packed_triangles++;ch.packed_triangles++;
     if(!p.source_chunks.has(info.name))wrongChunkIds.add(db);
     const a=ai*ps+po,b=bi*ps+po,c=ci*ps+po;
     const dup=samePosition(P,a,b)||samePosition(P,a,c)||samePosition(P,b,c);
     const ux=P[b]-P[a],uy=P[b+1]-P[a+1],uz=P[b+2]-P[a+2],vx=P[c]-P[a],vy=P[c+1]-P[a+1],vz=P[c+2]-P[a+2];
     const zero=dup||(uy*vz===uz*vy&&uz*vx===ux*vz&&ux*vy===uy*vx);
     if(dup){p.packed_duplicate_position++;ch.packed_duplicate_position++;}if(zero){p.packed_zero_area++;ch.packed_zero_area++;}
     for(const v of [a,b,c])point(p.packed_bounds_mm,P[v]*scale[0]+tr[0],P[v+1]*scale[1]+tr[1],P[v+2]*scale[2]+tr[2]);
   }
   const affected=new Set([...ch.sourceIds].filter(db=>parts.get(db).source_triangles>parts.get(db).packed_triangles));
   const lists=new Map([...affected].filter(db=>parts.get(db).source_triangles<=500000).map(db=>[db,[]]));
   for(const db of affected)if(!lists.has(db))skippedDiagnostics.push({dbId:db,reason:'Over 500,000 source triangles; all per-ID counts, zero areas and bounds still audited. Coordinate-multiset diagnostic bounded to avoid excess memory.'});
   if(lists.size){for(let t=0;t<I.length;t+=3){const list=lists.get(id(I[t]));if(list)list.push(t);}}
   for(const [db,list] of lists){guard('loss coordinate diagnostic');diagnostics.push({chunk:info.name,...diagnoseLoss(db,list,L,fragById.get(db)||[],scene,frame)});}
   ch.source_parts=ch.sourceIds.size;ch.packed_parts=ch.packedIds.size;
   ch.triangle_difference=ch.source_triangles-ch.packed_triangles;
   ch.zero_area_difference=ch.source_exact_zero_area-ch.packed_zero_area;
   console.log(`${info.name}: source ${ch.source_triangles.toLocaleString('en')}, packed ${ch.packed_triangles.toLocaleString('en')}, difference ${ch.triangle_difference}; ${ch.packed_parts}/${ch.source_parts} IDs present`);
   const after=fs.statSync(file);if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||await fingerprint(file)!==hash)throw Error('Original GLB changed during audit; report not written');
 }
 const perId=[],fullyMissing=[],unexpected=[],losses=[],boundsFailures=[];
 let sourceParts=0,packedParts=0,packedTotal=0,packedZero=0,packedDuplicate=0,boundsChecked=0;
 for(const p of [...parts.values()].sort((a,b)=>a.dbId-b.dbId)){
   const sc=[...p.source_chunks],pc=[...p.packed_chunks];
   p.source_chunks=sc;p.packed_chunks=pc;p.triangle_difference=p.source_triangles-p.packed_triangles;
   p.exact_source_zero_minus_packed_zero=p.source_exact_zero_area-p.packed_zero_area;
   if(p.source_triangles)sourceParts++;if(p.packed_triangles)packedParts++;
   packedTotal+=p.packed_triangles;packedZero+=p.packed_zero_area;packedDuplicate+=p.packed_duplicate_position;
   if(p.source_triangles&&!p.packed_triangles)fullyMissing.push(p.dbId);
   if(!p.source_triangles&&p.packed_triangles)unexpected.push(p.dbId);
   if(p.triangle_difference)losses.push({dbId:p.dbId,source_triangles:p.source_triangles,packed_triangles:p.packed_triangles,triangle_difference:p.triangle_difference,source_exact_zero_area:p.source_exact_zero_area,source_duplicate_position:p.source_duplicate_position,export_float32_zero_area:p.export_float32_zero_area,packed_zero_area:p.packed_zero_area,packed_duplicate_position:p.packed_duplicate_position});
   if(p.source_triangles&&p.packed_triangles){
     const tol=[0,1,2].map(a=>Math.max(...pc.map(c=>chunks.get(c).bounds_axis_tolerance_mm[a])));
     const diffs=[0,1,2].map(a=>Math.max(Math.abs(p.source_bounds_mm.min[a]-p.packed_bounds_mm.min[a]),Math.abs(p.source_bounds_mm.max[a]-p.packed_bounds_mm.max[a])));
     const pass=diffs.every((d,a)=>d<=tol[a]);
     p.bounds_check={pass,max_axis_delta_mm:diffs,tolerance_mm:tol};boundsChecked++;
     if(!pass)boundsFailures.push({dbId:p.dbId,...p.bounds_check});
   }else{if(!p.source_triangles)p.source_bounds_mm=null;if(!p.packed_triangles)p.packed_bounds_mm=null;}
   perId.push(p);
 }
 for(const ch of chunks.values()){
   for(const db of ch.packedIds)mergeBounds(ch.packed_bounds_mm,parts.get(db).packed_bounds_mm);
   delete ch.sourceIds;delete ch.packedIds;
 }
 const sums=k=>diagnostics.reduce((s,d)=>s+d[k],0);
 const diagnosticSummary=Object.fromEntries(['matched_triangle_multiset','unmatched_source','unmatched_packed','unmatched_source_exact_zero_area','unmatched_source_export_float32_zero_area','unmatched_source_grid_duplicate_position','unmatched_source_grid_zero_area'].map(k=>[k,sums(k)]));
 const triangleDifference=totals.source_triangles-packedTotal;
 const report={
   version:1,generated:new Date().toISOString(),audit:'Retained local SVF derivative versus ten original packed GLBs, independent of overview/detail-tile completeness',
   command:'node --max-old-space-size=6144 shipcheck/tools/export/audit-source-geometry.mjs',
   scope:{network:'disabled; retained SVF required',source:'tools/export/work/svf',packed:'model/{context,openings,structure-findings,piping,access,structure,rest-01,rest-02,rest-03,rest-04}.glb',overview_tiles:'excluded: intentionally a visibility subset, not a completeness basis',detail_tiles:'not audited here; separate original-GLB-to-tile audit',writes:['tools/export/audit-source-geometry.mjs','model/source-coverage.json'],native_nwd_validation:false},
   methodology:{ids:'resolve(svfNode.dbid).part ?? resolve(svfNode.dbid).near, using retained SVF-to-SVF2 ID map; raw counts accumulated per assigned dbId',source_json:'Large model-tree JSON read only by the existing streaming mapParts/readTree reader; model-properties JSON is not read by this audit',degeneracy:'Exact duplicate positions and exact zero-area determinants on original Float32 coordinates. Uncertain double cross products are confirmed with BigInt dyadic arithmetic. Per-geometry results cached across repeated instances. Separate transformed/export Float32 and integer-quantized packed counts.',bounds:'Referenced-vertex axis bounds after original instance transform, mm conversion, output frame and Float32 export; compared to decoded packed node scale/translation. Tolerance per axis = half quantization step + 0.02 mm. Bounds agreement is not a face-by-face geometric equivalence proof.',loss_diagnostics:'Loss-affected IDs up to 500,000 source triangles each: order/winding-independent triangle coordinate multisets reconstructed on packed Uint16 grid. Half-step rounding/serialized quantization parameters can produce source/packed diagnostic mismatches; unmatched source minus unmatched packed is the reliable count difference, not an identification of removed faces unless unmatched packed is zero.'},
   source:{...totals,assigned_parts:sourceParts,unit:frame.unit,scale_mm:frame.scaleMM,offset_mm:frame.offset,cache_files:cacheFingerprint},
   inputs:{manifest_sha256:await fingerprint(mf),rest_plan_sha256:await fingerprint(planFile),mapping_files:mappingInputs,mapping_summary:mapSummary},
   packed:{parts:packedParts,triangles:packedTotal,exact_zero_area:packedZero,duplicate_position:packedDuplicate},
   coverage:{fully_missing_parts:fullyMissing,fully_missing_part_count:fullyMissing.length,unexpected_packed_parts:unexpected,wrong_chunk_ids:[...wrongChunkIds].sort((a,b)=>a-b),invalid_chunk_assignments:invalidChunkAssignments,unassigned_fragments:unassigned,triangle_difference:triangleDifference,expected_prior_difference:3330,prior_difference_reproduced:triangleDifference===3330,ids_with_count_difference:losses.length,bounds_checked_ids:boundsChecked,bounds_failure_count:boundsFailures.length,bounds_failures:boundsFailures,all_assigned_source_ids_present:fullyMissing.length===0&&unexpected.length===0&&totals.unassigned_fragments===0&&invalidChunkAssignments===0},
   chunks:[...chunks.values()],count_differences:losses,loss_coordinate_diagnostic:{summary:diagnosticSummary,skipped:skippedDiagnostics,per_id:diagnostics},per_id:perId,
   limitations:[
     'This is an SVF DERIVATIVE audit, not native NWD/ShipConstructor equivalence. Native Navisworks validation is unavailable. Any geometry already omitted by the Autodesk SVF conversion is outside this audit.',
     'SVF and SVF2 have different hierarchies and IDs; unmatched subentities use the nearest matched ancestor. Full assigned-part geometry coverage does not prove a one-to-one match of all 330,760 hierarchy objects or independently validate every ID-map pairing.',
     'Triangle counts and conservative per-ID bounds are checked for every assigned source ID. Coordinate-multiset diagnostics focus on IDs with count losses and are subject to quantization-grid reconstruction uncertainty. No global face-by-face exact equivalence claim is made.',
     'Quantization changes coordinates: decoded position steps are reported per chunk. Meshopt decoding is lossless after quantization, but quantization and Float32 export can collapse or perturb small triangles. Source degeneracy and quantization hypotheses must be distinguished from demonstrated removals.'
   ],
   resources:{max_old_space_mb:6144,peak_observed_rss_bytes:peakRss,minimum_observed_free_disk_bytes:minFree,disk_floor_bytes:FLOOR,elapsed_seconds:(Date.now()-started)/1000}
 };
 guard('report write');
 // Leave the cached SVF, mappings, manifests, original GLBs, viewer, checker and rules untouched.
 fs.writeFileSync(OUTPUT,JSON.stringify(report,null,2));
 console.log(JSON.stringify({source_fragments:totals.nonempty_mesh_fragments,source_triangles:totals.source_triangles,packed_triangles:packedTotal,difference:triangleDifference,source_exact_zero_area:totals.source_exact_zero_area,source_duplicate_position:totals.source_duplicate_position,export_float32_zero_area:totals.export_float32_zero_area,packed_zero_area:packedZero,parts:sourceParts,fully_missing_parts:fullyMissing.length,ids_with_count_difference:losses.length,bounds_failures:boundsFailures.length,loss_coordinate_summary:diagnosticSummary,elapsed_seconds:report.resources.elapsed_seconds,report:'shipcheck/model/source-coverage.json'},null,2));
 if(fullyMissing.length||unexpected.length||totals.unassigned_fragments||invalidChunkAssignments||wrongChunkIds.size)process.exitCode=2;
}
main().catch(e=>{console.error(`Source audit failed: ${e.message}`);process.exitCode=1;});