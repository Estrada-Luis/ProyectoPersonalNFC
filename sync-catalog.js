const fs=require('fs'),path=require('path'),https=require('https');
const OUT=path.join(__dirname,'data','catalogo.json');
const MERCADONA='https://tienda.mercadona.es/api';
const headers={'User-Agent':'Mozilla/5.0','Accept':'application/json','Accept-Language':'es-ES,es;q=0.9'};

function getJson(url){return new Promise((resolve,reject)=>{const req=https.get(url,{headers},res=>{let b='';res.setEncoding('utf8');res.on('data',c=>b+=c);res.on('end',()=>{if(res.statusCode<200||res.statusCode>=300){const e=new Error(`HTTP ${res.statusCode} ${url}`);e.statusCode=res.statusCode;return reject(e)}try{resolve(JSON.parse(b))}catch(e){reject(new Error('Respuesta no JSON de '+url))}})});req.on('error',reject);req.setTimeout(30000,()=>req.destroy(new Error('Timeout '+url)))})}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function fetchWithRetry(url,n=4){let e;for(let i=0;i<n;i++){try{return await getJson(url)}catch(x){e=x;if(i<n-1)await sleep(700*(i+1))}}throw e}
async function fetchCategorySafe(id){
  const url=`${MERCADONA}/categories/${encodeURIComponent(id)}/`;
  try{return await fetchWithRetry(url,2)}
  catch(e){
    if(e.statusCode===404){console.log(`Categoría ${id} ya no existe; se omite y se continúa.`);return null}
    throw e;
  }
}
const clean=s=>String(s??'').replace(/\s+/g,' ').trim();

function productImage(p){
  if(clean(p.thumbnail))return clean(p.thumbnail);
  if(clean(p.image))return clean(p.image);
  const images=Array.isArray(p.images)?p.images:[];
  const first=images.find(x=>clean(x.zoom_url||x.regular_url||x.thumbnail_url));
  return clean(first?.zoom_url||first?.regular_url||first?.thumbnail_url||'');
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

function productFromOfficial(p,pathNames){
  const code=String(p.id??'').trim();
  const name=clean(p.display_name||p.name);
  if(!code||!name)return null;
  const route=pathNames.filter(Boolean).map(clean);
  const leaf=route.at(-1)||'Otros productos';
  const top=route[0]||leaf;
  const sub=route.length>1?route[1]:leaf;
  return {id:'m'+code,codigo:code,texto:name,formato:formatProduct(p),packaging:clean(p.packaging||''),categoria:top,subcategoria:sub,ruta:route.length?route.join(' > '):leaf,pagina:null,imagen:productImage(p)};
}

function categoryChildren(node){
  if(!node||typeof node!=='object')return [];
  return [...(Array.isArray(node.categories)?node.categories:[]),...(Array.isArray(node.subcategories)?node.subcategories:[])];
}
function categoryProducts(node){return node&&Array.isArray(node.products)?node.products:[]}
function rootCategories(payload){
  if(Array.isArray(payload))return payload;
  if(Array.isArray(payload?.results))return payload.results;
  if(Array.isArray(payload?.categories))return payload.categories;
  return [];
}

async function main(){
  console.log('Descargando catálogo directamente de la API oficial de Mercadona...');
  const root=await fetchWithRetry(`${MERCADONA}/categories/`);
  const roots=rootCategories(root);
  if(!roots.length)throw new Error('Mercadona no devolvió categorías en /api/categories/.');
  console.log(`Categorías raíz encontradas: ${roots.length}`);

  const productsById=new Map();
  const visited=new Set();
  let requests=0;
  function addProducts(products,pathNames){
    for(const p of products){
      const item=productFromOfficial(p,pathNames);
      if(item&&!productsById.has(item.codigo))productsById.set(item.codigo,item);
    }
  }

  async function walkCategory(node,pathNames){
    if(!node||typeof node!=='object')return;
    const id=String(node.id??'').trim();
    const name=clean(node.name);
    const currentPath=name?[...pathNames,name]:pathNames;
    addProducts(categoryProducts(node),currentPath);

    const children=categoryChildren(node);
    for(const child of children){
      const childId=String(child?.id??'').trim();
      if(childId&&visited.has(childId))continue;
      if(childId)visited.add(childId);
      if(childId){
        const detail=await fetchCategorySafe(childId);
        requests++;
        if(detail)await walkCategory(detail,currentPath);
      }else await walkCategory(child,currentPath);
    }

    if(id&&currentPath.length===1&&!visited.has(`root-${id}`)){
      visited.add(`root-${id}`);
      const detail=await fetchCategorySafe(id);
      requests++;
      if(detail&&detail!==node)await walkCategory(detail,pathNames);
    }
  }

  for(const rootCat of roots){
    const id=String(rootCat?.id??'').trim();
    if(id)visited.add(id);
    await walkCategory(rootCat,[]);
  }

  const products=[...productsById.values()];
  if(products.length<1000)throw new Error(`Solo se obtuvieron ${products.length} productos de Mercadona. No se sustituye el catálogo.`);
  const imageCount=products.filter(p=>p.imagen).length;
  const counts={};for(const p of products)counts[p.categoria]=(counts[p.categoria]||0)+1;
  const cerealCount=counts['Cereales y galletas']||0;
  const cerealProducts=products.filter(p=>/cereal|copos|corn flakes|muesli|avena|granola/i.test(`${p.texto} ${p.ruta}`));
  console.log(`TOTAL: ${products.length} productos; ${imageCount} con imagen.`);
  console.log(`Peticiones de categorías: ${requests}`);
  console.log(`Cereales y galletas: ${cerealCount}`);
  console.log(`Productos relacionados con cereales/avena/granola: ${cerealProducts.length}`);
  const known=products.find(p=>/copos de trigo integral y de arroz|trigo integral.*arroz/i.test(p.texto));
  console.log(`Producto de prueba encontrado: ${known?known.texto+' ('+known.codigo+')':'NO ENCONTRADO'}`);
  fs.writeFileSync(OUT,JSON.stringify({source:'Mercadona · catálogo oficial por categorías',updatedAt:new Date().toISOString(),count:products.length,categories:Object.keys(counts).sort((a,b)=>a.localeCompare(b,'es')),products},null,2));
}
main().catch(e=>{console.error(e);process.exit(1)});
