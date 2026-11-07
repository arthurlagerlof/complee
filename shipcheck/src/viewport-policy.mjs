// Pure request policy shared by the viewport viewer and Node tests. Geometry is never simplified.
export function intersectsPlanes(bounds, planes) {
  return planes.every(([x,y,z,w]) => x*(x>=0?bounds.max[0]:bounds.min[0])+y*(y>=0?bounds.max[1]:bounds.min[1])+z*(z>=0?bounds.max[2]:bounds.min[2])+w>=0);
}
const distanceSq = (b,p) => b.min.reduce((s,x,k)=>s+Math.max(x-p[k],0,p[k]-b.max[k])**2,0);
export function selectViewportTiles(manifest, options) {
  const {planes=[],target=[0,0,0],span=Infinity,fullModel=true,filterDbs=null,ruleDbs=null,selectedDb=null,cutHeight=Infinity} = options;
  const cfg={max_resident_bytes:512e6,max_detail_triangles:1500000,detail_span_mm:24000,...manifest.streaming,...options.budget};
  const detail = span<=cfg.detail_span_mm || filterDbs!==null || ruleDbs!==null;
  const candidates=manifest.chunks.filter(c=>{
    if(selectedDb!==null)return c.dbIds.includes(selectedDb);
    if(c.bounds_mm.min[1]>cutHeight || !intersectsPlanes(c.bounds_mm,planes))return false;
    if(c.group==='context')return true;
    if(!detail)return false;
    if(c.group==='rest'&&(!fullModel||filterDbs!==null||ruleDbs!==null))return false;
    if(ruleDbs!==null&&!c.dbIds.some(d=>ruleDbs.has(d)))return false;
    if(filterDbs!==null&&!c.dbIds.some(d=>filterDbs.has(d)))return false;
    return ruleDbs!==null || filterDbs!==null || distanceSq(c.bounds_mm,target)<=(span*.85)**2;
  });
  candidates.sort((a,b)=>(a.group==='context'?0:1)-(b.group==='context'?0:1)||distanceSq(a.bounds_mm,target)-distanceSq(b.bounds_mm,target)||a.name.localeCompare(b.name));
  const selected=[];let bytes=0,detailTriangles=0;
  for(const c of candidates){
    const cost=c.resident_bytes??c.decoded_bytes??c.bytes;
    if(bytes+cost>cfg.max_resident_bytes)continue;
    if(selectedDb===null&&c.group!=='context'&&detailTriangles+c.triangles>cfg.max_detail_triangles)continue;
    selected.push(c);bytes+=cost;if(c.group!=='context')detailTriangles+=c.triangles;
  }
  return{tiles:selected,candidates:candidates.length,deferred:candidates.length-selected.length,bytes,detail,detailTriangles};
}

// Throttle, rather than debounce: continuous camera events must not postpone requests forever.
export function viewportScheduler(callback, delay=120, timers={setTimeout:(fn,ms)=>setTimeout(fn,ms),clearTimeout:id=>clearTimeout(id)}) {
  let timer=null;
  return {
    request(){if(timer!==null)return;timer=timers.setTimeout(()=>{timer=null;callback();},delay);},
    cancel(){if(timer!==null)timers.clearTimeout(timer);timer=null;}
  };
}
