const fs=require('fs'),path=require('path'),https=require('https');
const OUT=path.join(__dirname,'data','catalogo.json');
const MERCAAPI='https://mercaapi.sgn.space/api';
const headers={'User-Agent':'Mozilla/5.0','Accept':'application/json','Accept-Language':'es-ES,es;q=0.9'};

function getJson(url){return new Promise((resolve,reject)=>{const req=https.get(url,{headers},res=>{let b='';res.setEncoding('utf8');res.on('data',c=>b+=c);res.on('end',()=>{if(res.statusCode<200||res.statusCode>=300)return reject(new Error(`HTTP ${res.statusCode} ${url}`));try{resolve(JSON.parse(b))}catch(e){reject(new Error('Respuesta no JSON de '+url))}})});req.on('error',reject);req.setTimeout(30000,()=>req.destroy(new Error('Timeout '+url)))})}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function fetchWithRetry(url,n=3){let e;for(let i=0;i<n;i++){try{return await getJson(url)}catch(x){e=x;if(i<n-1)await sleep(800*(i+1))}}throw e}
const clean=s=>String(s??'').replace(/\s+/g,' ').trim();

function productImage(p){
  const images=Array.isArray(p.images)?p.images:[];
  const candidates=images.map(x=>({url:clean(x.zoom_url||x.regular_url||x.thumbnail_url),perspective:Number(x.perspective)})).filter(x=>x.url);
  if(candidates.length){
    // Perspectiva 1 es normalmente la frontal. Priorizamos 1 y después las
    // perspectivas bajas para evitar fotos traseras/alternativas.
    candidates.sort((a,b)=>{
      const rank=x=>Number.isFinite(x.perspective)?(x.perspective===1?0:x.perspective===2?1:x.perspective===3?2:10+x.perspective):100;
      return rank(a)-rank(b);
    });
    return candidates[0].url;
  }
  return clean(p.thumbnail||p.image||'');
}

function categoryMaps(categories){
  const byId=new Map((categories||[]).filter(Boolean).map(c=>[String(c.id),c]));
  const routeFor=id=>{const out=[],seen=new Set();let cur=id;while(cur!=null&&!seen.has(String(cur))){seen.add(String(cur));const c=byId.get(String(cur));if(!c)break;if(c.name)out.unshift(clean(c.name));cur=c.parent_id}return out.filter(Boolean)};
  return routeFor;
}

function formatProduct(p){
  const pack=clean(p.packaging||'');
  const unit=clean(p.unit_name||'');
  const size=Number(p.unit_size);
  if(Number.isFinite(size)&&size>0){
    const u=unit.toLowerCase();
    let amount='';
    if(u==='kg')amount=Math.round(size*1000)+' g';
    else if(u==='l')amount=String(Math.round(size*1000)/1000).replace('.',',')+' L';
    else if(u==='ml'||u==='cl'||u==='g')amount=String(Math.round(size*1000)/1000).replace('.',',')+' '+u;
    if(amount)return pack?`${pack} · ${amount}`:amount;
  }
  return pack;
}

async function main(){
  console.log('Descargando árbol completo de categorías...');
  const categories=await fetchWithRetry(`${MERCAAPI}/categories/`);
  if(!Array.isArray(categories))throw new Error('La API no devolvió una lista de categorías.');
  const routeFor=categoryMaps(categories);

  const products=[];const seen=new Set();const limit=5000;let skip=0;
  while(true){
    console.log(`Descargando productos ${skip+1}-${skip+limit}...`);
    const page=await fetchWithRetry(`${MERCAAPI}/products/?skip=${skip}&limit=${limit}`);
    if(!Array.isArray(page))throw new Error('La API no devolvió una lista de productos.');
    for(const p of page){
      const code=String(p.id??'');const name=clean(p.name??p.display_name);
      if(!code||!name||seen.has(code))continue;
      seen.add(code);
      const catId=p.category_id??p.category?.id;
      const route=routeFor(catId);
      const leaf=route.at(-1)||clean(p.category?.name)||'Otros productos';
      const top=route[0]||leaf;
      const sub=route.length>1?route[1]:leaf;
      products.push({id:'m'+code,codigo:code,texto:name,formato:formatProduct(p),packaging:clean(p.packaging||''),categoria:top,subcategoria:sub,ruta:route.length?route.join(' > '):leaf,pagina:null,imagen:productImage(p)});
    }
    console.log(`Acumulados: ${products.length}`);
    if(page.length<limit)break;
    skip+=limit;
    if(skip>50000)throw new Error('La paginación supera 50.000 productos; se detiene para evitar un bucle.');
  }
  if(products.length<1000)throw new Error(`Solo se obtuvieron ${products.length} productos. No se sustituye el catálogo.`);
  const imageCount=products.filter(p=>p.imagen).length;
  const counts={};for(const p of products)counts[p.categoria]=(counts[p.categoria]||0)+1;
  console.log(`TOTAL: ${products.length} productos; ${imageCount} con imagen.`);
  console.log('Cereales y galletas:',counts['Cereales y galletas']||0);
  fs.writeFileSync(OUT,JSON.stringify({source:'MercaAPI · catálogo completo',updatedAt:new Date().toISOString(),count:products.length,categories:Object.keys(counts).sort((a,b)=>a.localeCompare(b,'es')),products},null,2));
}
main().catch(e=>{console.error(e);process.exit(1)});
