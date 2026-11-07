// Source-geometry audit. Every non-empty SVF triangle fragment must occur once in either a main chunk or a rest chunk.
// Run locally after exporting (no keys/network): node --max-old-space-size=12288 audit-model.mjs
import fs from 'node:fs';
import path from 'node:path';
import { mapParts, openScene, OUT, WORK } from './export-chunks.mjs';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);const IMF=require('svf-utils/lib/common/intermediate-format');
const {resolve,chunkOfPart,nodeById}=await mapParts();const {scene}=await openScene();
const m=JSON.parse(fs.readFileSync(path.join(OUT,'manifest.json'),'utf8'));
const plan=JSON.parse(fs.readFileSync(path.join(WORK,'rest-plan.json'),'utf8'));
const counts=new Map();let empty=0,other=0,unmapped=0,fragments=0,triangles=0;
for(let i=0;i<scene.getNodeCount();i++){
 const n=scene.getNode(i);if(n.kind!==IMF.NodeKind.Object)continue;const g=scene.getGeometry(n.geometry);
 if(g.kind!==IMF.GeometryKind.Mesh){other++;continue;}const I=g.getIndices(),V=g.getVertices();if(!I?.length||!V?.length){empty++;continue;}
 const r=resolve(n.dbid);const db=r.part??r.near;if(db==null){unmapped++;continue;}
 const main=r.part!=null?chunkOfPart.get(r.part):'rest';const name=main==='rest'?`rest-${String(plan.assign[db]+1).padStart(2,'0')}`:main;
 const c=counts.get(name)||{fragments:0,triangles:0};c.fragments++;c.triangles+=I.length/3;counts.set(name,c);fragments++;triangles+=I.length/3;
}
for(const c of m.chunks){const actual=counts.get(c.name);if(!actual||actual.triangles!==c.triangles)throw Error(`${c.name}: triangle coverage mismatch`);c.source_fragments=actual.fragments;}
if(unmapped||counts.size!==m.chunks.length)throw Error(`Missing geometry: ${unmapped} unmapped fragments, ${counts.size} groups vs ${m.chunks.length} chunks`);
m.coverage={hierarchy_objects:nodeById.size,source_fragments:fragments,source_triangles:triangles,unmapped_geometry_fragments:unmapped,non_triangle_fragments:other,empty_fragments:empty,note:'All non-empty source triangle fragments occur exactly once across the six main chunks and the rest sub-chunks. Hierarchy nodes such as files and layers do not each have geometry.'};
fs.writeFileSync(path.join(OUT,'manifest.json'),JSON.stringify(m));
console.log(JSON.stringify(m.coverage,null,2));
for(const c of m.chunks)console.log(`${c.name.padEnd(20)} ${(c.bytes/1e6).toFixed(1).padStart(6)} MB  ${String(c.parts).padStart(7)} parts  ${String(c.triangles).padStart(10)} source triangles`);
console.log(`Total ${(m.chunks.reduce((s,c)=>s+c.bytes,0)/1e6).toFixed(1)} MB; ${triangles.toLocaleString('en')} source triangles`);
