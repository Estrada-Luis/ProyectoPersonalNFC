const fs=require('fs'),path=require('path'),https=require('https');
const OUT=path.join(__dirname,'data','catalogo.json');
const SOURCE='https://mercaapi.sgn.space/api';
const headers={'User-Agent':'CompraNFC/1.0','Accept':'application/json','Accept-Language':'es-ES,es;q=0.9'};
function getJson(url){return new Promise((resolve,reject)=>{const req=https.get(url,{headers},res=>{let b='';res.setEncoding('utf8');res.on('data',c=>b+=c);res.on('end',()=>{if(res.statusCode<200||res.statusCode>=300){const e=new Error(`HTTP ${res.statusCode} ${url}`);e.statusCode=res.statusCode;return reject(e)}try{resolve(JSON.parse(b))}catch(e){reject(new Error('Respuesta no JSON de '+url))}})});req.on('error',reject);req.setTimeout(45000,()=>req.destroy(new Error('Timeout '+url)))})}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function fetchWithRetry(url,n=4){let e;for(let i=0;i<n;i++){try{return await getJson(url)}catch(x){e=x;if(i<n-1)await sleep(1000*(i+1))}}throw e}
const clean=s=>String(s??'').replace(/\s+/g,' ').trim();
function productImage(p){
 const imgs=Array.isArray(p.images)?p.images.filter(x=>clean(x.zoom_url||x.regular_url||x.thumbnail_url)):[]; 
 if(!imgs.length)return '';
 const score=x=>{
  const url=clean(x.zoom_url||x.regular_url||x.thumbnail_url);
  const perspective=Number(x.perspective);
  let s=0;
  if(Number.isFinite(perspective))s+=perspective*100;
  else s+=500;
  if(/_00[_-]/i.test(url))s-=25;
  if(/_01[_-]/i.test(url))s+=10;
  return s;
 };
 imgs.sort((a,b)=>score(a)-score(b));
 const best=imgs[0];
 return clean(best.zoom_url||best.regular_url||best.thumbnail_url);
}
function formatProduct(p){const pack=clean(p.packaging||'');const unit=clean(p.unit_name||'');const size=Number(p.unit_size);if(Number.isFinite(size)&&size>0){const u=unit.toLowerCase();let amount='';if(u==='kg')amount=(size>=1?String(size).replace('.',',')+' kg':Math.round(size*1000)+' g');else if(u==='l')amount=String(size).replace('.',',')+' L';else if(u==='ml'||u==='cl'||u==='g')amount=String(size).replace('.',',')+' '+u;if(amount)return pack?`${pack} · ${amount}`:amount}return pack}
async function main(){
 console.log('Descargando catálogo completo desde MercaAPI...');
 const categories=await fetchWithRetry(`${SOURCE}/categories/`);
 const catRows=Array.isArray(categories)?categories:(categories?.results||[]);
 const cats=new Map(catRows.map(c=>[String(c.id),c]));
 console.log(`Categorías recibidas: ${cats.size}`);
 const products=[];const seen=new Set();const limit=5000;let skip=0;
 for(;;){const page=await fetchWithRetry(`${SOURCE}/products/?skip=${skip}&limit=${limit}`);const rows=Array.isArray(page)?page:(page?.results||page?.data||[]);console.log(`Productos descargados: ${skip+rows.length}`);if(!rows.length)break;for(const p of rows){const code=String(p.id??'').trim();const name=clean(p.name||p.display_name);if(!code||!name||seen.has(code))continue;seen.add(code);const cat=p.category||cats.get(String(p.category_id))||{};const parent=cats.get(String(cat.parent_id||''))||{};const top=clean(parent.name||cat.name||'Otros productos');const sub=clean(cat.name||top);const route=parent.name&&parent.name!==cat.name?`${clean(parent.name)} > ${sub}`:sub;products.push({id:'m'+code,codigo:clean(p.ean||code),texto:name,formato:formatProduct(p),packaging:clean(p.packaging||''),categoria:top,subcategoria:sub,ruta:route,pagina:null,imagen:productImage(p)});}if(rows.length<limit)break;skip+=rows.length;await sleep(150)}
 if(products.length<6000)throw new Error(`Solo se obtuvieron ${products.length} productos de MercaAPI. Catálogo incompleto: no se sustituye el catálogo anterior.`);
 const imageCount=products.filter(p=>p.imagen).length;const counts={};for(const p of products)counts[p.categoria]=(counts[p.categoria]||0)+1;
 const cerealProducts=products.filter(p=>/cereal|copos|corn flakes|muesli|avena|granola/i.test(`${p.texto} ${p.ruta}`));
 const lejiaProducts=products.filter(p=>/lej[ií]a/i.test(`${p.texto} ${p.ruta}`));
 const known=products.find(p=>/copos de trigo integral.*arroz|trigo integral.*arroz/i.test(p.texto));
 if(imageCount<Math.floor(products.length*0.80))throw new Error(`Solo ${imageCount}/${products.length} productos tienen imagen. Catálogo sospechoso: no se sustituye el catálogo anterior.`);\n console.log(`TOTAL: ${products.length} productos; ${imageCount} con imagen.`);
 console.log(`Cereales y similares: ${cerealProducts.length}`);
 console.log(`Lejía y similares: ${lejiaProducts.length}`);
 console.log(`Producto de prueba encontrado: ${known?known.texto+' ('+known.codigo+')':'NO ENCONTRADO'}`);
 fs.writeFileSync(OUT,JSON.stringify({source:'MercaAPI · catálogo Mercadona',updatedAt:new Date().toISOString(),count:products.length,categories:Object.keys(counts).sort((a,b)=>a.localeCompare(b,'es')),products},null,2));
}
main().catch(e=>{console.error(e);process.exit(1)});
