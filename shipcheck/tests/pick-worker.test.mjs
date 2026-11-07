import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Execute the real worker protocol on a tiny two-triangle mesh. This checks quantized positions,
// exact dbIds, rays behind the first triangle and the box used to outline a clicked rest part.
test('background picker preserves dbIds and returns both surfaces and a part box', () => {
  const out=[]; const ctx=vm.createContext({postMessage:(x)=>out.push(x),performance});
  vm.runInContext(fs.readFileSync(new URL('../public/pick-worker.js',import.meta.url),'utf8'),ctx);
  const desc=(a,extra={})=>({buffer:a.buffer,byteOffset:a.byteOffset,length:a.length,ctor:a.constructor.name,...extra});
  const pos=new Uint16Array([0,0,0,100,0,0,0,100,0,0,0,100,100,0,100,0,100,100]);
  const index=new Uint32Array([0,1,2,3,4,5]);const ids=new Uint32Array([977,977,977,3491284,3491284,3491284]);
  ctx.onmessage({data:{type:'chunk',id:'r0',pos:desc(pos,{stride:3,offset:0,scale:0.01}),index:desc(index),ids:desc(ids)}});
  assert.equal(out.at(-1).type,'ready');assert.equal(out.at(-1).triangles,2);
  ctx.onmessage({data:{type:'ray',qid:1,rays:[{id:'r0',o:[0.1,0.1,2],d:[0,0,-1]}]}});
  assert.deepEqual(Array.from(out.at(-1).hits,h=>h.db),[3491284,977]);
  assert.deepEqual(Array.from(out.at(-1).hits[0].p),[0.1,0.1,1]);
  ctx.onmessage({data:{type:'box',qid:2,id:'r0',db:3491284}});
  assert.deepEqual(Array.from(out.at(-1).min),[0,0,1]);assert.deepEqual(Array.from(out.at(-1).max),[1,1,1]);
});
