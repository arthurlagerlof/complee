import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { selectViewportTiles, viewportScheduler } from '../src/viewport-policy.mjs';
const tile=(name,group,x,db,triangles=100)=>({name,group,dbIds:[db],bytes:100,decoded_bytes:100,resident_bytes:200,triangles,bounds_mm:{min:[x,0,0],max:[x+1,1,1]}});
const manifest={chunks:[tile('shell','context',0,1),tile('door','checked',0,2),tile('equipment','rest',0,3),tile('offscreen','checked',100,4)],streaming:{max_resident_bytes:1000,max_detail_triangles:1000,detail_span_mm:20}};
const view={planes:[[1,0,0,10],[-1,0,0,10]],target:[0,0,0]};
test('whole-ship overview requests visible hull/decks only, never every detail chunk',()=>{const p=selectViewportTiles(manifest,{...view,span:100});assert.deepEqual(p.tiles.map(c=>c.name),['shell']);});
test('zoom requests nearby visible details, but excludes offscreen tiles and rest under a findings filter',()=>{const p=selectViewportTiles(manifest,{...view,span:10});assert.deepEqual(p.tiles.map(c=>c.name),['shell','door','equipment']);const f=selectViewportTiles(manifest,{...view,span:100,filterDbs:new Set([2])});assert.deepEqual(f.tiles.map(c=>c.name),['shell','door']);const off=selectViewportTiles(manifest,{...view,span:10,fullModel:false});assert.ok(!off.tiles.some(c=>c.group==='rest'));});
test('request budget is bounded; a requested component fetches its own tiles without the whole model',()=>{const p=selectViewportTiles(manifest,{...view,span:10,budget:{max_resident_bytes:400}});assert.ok(p.bytes<=400);assert.equal(p.deferred,1);const c=selectViewportTiles(manifest,{...view,span:100,selectedDb:4});assert.deepEqual(c.tiles.map(t=>t.name),['offscreen']);});
test('deck cut excludes tiles completely above the cutting plane',()=>{assert.equal(selectViewportTiles(manifest,{...view,span:10,cutHeight:-1}).tiles.length,0);});
const file=new URL('../model/stream/manifest.json',import.meta.url),m=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
test('spatial tile manifest retains all packed triangles and every referenced tile exists', {skip:!m&&'local model not exported'},()=>{assert.equal(m.kind,'viewport-tiles');assert.equal(m.integrity.triangles,m.sources.reduce((n,c)=>n+c.triangles,0));assert.equal(m.integrity.triangles,m.chunks.reduce((n,c)=>n+c.triangles,0));for(const t of m.chunks){const f=new URL('../model/stream/'+t.file,import.meta.url);assert.equal(fs.statSync(f).size,t.bytes);assert.ok(t.triangles>0&&t.triangles<=160000);assert.ok(t.dbIds.length);}});

test('continuous camera movement still issues viewport queries and cancellation removes scheduled work',()=>{
  const jobs=new Map();let next=0,calls=0;
  const timers={setTimeout:cb=>{jobs.set(++next,cb);return next;},clearTimeout:id=>jobs.delete(id)};
  const scheduler=viewportScheduler(()=>calls++,120,timers);
  for(let i=0;i<100;i++)scheduler.request();
  assert.equal(jobs.size,1,'camera events do not keep replacing the pending query');
  const [id,run]=[...jobs][0];jobs.delete(id);run();assert.equal(calls,1);
  scheduler.request();assert.equal(jobs.size,1);scheduler.cancel();assert.equal(jobs.size,0);
});
