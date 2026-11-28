// usage: node inspect.mjs [-v] <nodeName> <version> ... : prints a node type's parameters.
import fs from 'fs';
const all = [...JSON.parse(fs.readFileSync(new URL('./.cache/base-nodes.json', import.meta.url))), ...JSON.parse(fs.readFileSync(new URL('./.cache/lc-nodes.json', import.meta.url)))];
const args = process.argv.slice(2);
const verbose = args[0]==='-v' ? (args.shift(), true) : false;
for (let i=0;i<args.length;i+=2){
  const name=args[i], v=Number(args[i+1]);
  const d = all.find(n=>n.name===name && (Array.isArray(n.version)? n.version.includes(v): n.version===v));
  if(!d){console.log('!! not found',name,v);continue;}
  console.log(`=== ${name} ${v} inputs=${JSON.stringify(d.inputs).slice(0,150)} outputs=${JSON.stringify(d.outputs).slice(0,150)} creds=${JSON.stringify((d.credentials||[]).map(c=>c.name))}`);
  const show=(p,ind)=>{
    const vers = p.displayOptions?.show?.['@version'];
    if (vers && !vers.some(x=> typeof x==='number'? x===v : (x._cnd && ((x._cnd.gte===undefined||v>=x._cnd.gte)&&(x._cnd.lt===undefined||v<x._cnd.lt)&&(x._cnd.lte===undefined||v<=x._cnd.lte)&&(x._cnd.gt===undefined||v>x._cnd.gt))))) return;
    let s=`${ind}${p.name} [${p.type}] def=${JSON.stringify(p.default)?.slice(0,90)}`;
    const so = p.displayOptions ? JSON.parse(JSON.stringify(p.displayOptions)) : null;
    if(so?.show) delete so.show['@version'];
    if(so && (Object.keys(so.show||{}).length||so.hide)) s+=` show=${JSON.stringify(so).slice(0,160)}`;
    if((p.type==='options'||p.type==='multiOptions')&&p.options) s+=` opts=${JSON.stringify(p.options.map(o=>o.value)).slice(0,220)}`;
    if(verbose && p.description) s+=` // ${p.description.slice(0,160)}`;
    console.log(s);
    if(p.type==='collection') for(const o of p.options||[]) show(o, ind+'   .');
    if(p.type==='fixedCollection') for(const o of p.options||[]) { console.log(`${ind}   >${o.name}`); for(const vv of o.values||[]) show(vv, ind+'     .'); }
  };
  for(const p of d.properties) show(p,'');
}
