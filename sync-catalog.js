const fs=require('fs'),path=require('path'),https=require('https');
const OUT=path.join(__dirname,'data','catalogo.json');

// Fuente principal: API pública no oficial con catálogo Mercadona ya indexado.
// Se usa porque la API directa de tienda.mercadona.es puede cambiar sus
// endpoints de detalle de categorías y devolver 404 aunque /categories/ siga funcionando.
const MERCAAPI='https://mercaapi.sgn.space/api';
const API='https://tienda.mercadona.es/api';
const headers={
  'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36',
  'Accept':'application/json',
  'Accept-Language':'es-ES,es;q=0.9',
  'x-version':'v8451'
};

function getJson(url){
  return new Promise((resolve,reject)=>{
    const req=https.get(url,{headers},res=>{
      let b='';
      res.setEncoding('utf8');
      res.on('data',c=>b+=c);
      res.on('end',()=>{
        if(res.statusCode<200||res.statusCode>=300)
          return reject(new Error(`HTTP ${res.statusCode} ${url}`));
        try{resolve(JSON.parse(b))}
        catch(e){reject(new Error('Respuesta no JSON de '+url))}
      });
    });
    req.on('error',reject);
    req.setTimeout(25000,()=>req.destroy(new Error('Timeout '+url)));
  });
}

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function fetchWithRetry(url,n=3){
  let e;
  for(let i=0;i<n;i++){
    try{return await getJson(url)}
    catch(x){e=x;if(i<n-1)await sleep(700*(i+1));}
  }
  throw e;
}
function clean(s){return String(s??'').replace(/\s+/g,' ').trim()}

function normalizeProductInfo(p){
  // La API puede exponer los datos directamente o dentro de price_instructions.
  const pi=p.price_instructions||{};
  return {
    unitSize: p.unit_size ?? pi.unit_size ?? null,
    unit: p.size_format ?? pi.size_format ?? p.unit_name ?? pi.unit_name ?? '',
    unitName: p.unit_name ?? pi.unit_name ?? '',
    isPack: Boolean(p.is_pack ?? pi.is_pack),
    packSize: p.pack_size ?? pi.pack_size ?? null,
    totalUnits: p.total_units ?? pi.total_units ?? null,
    packaging: clean(p.packaging ?? ''),
    referenceFormat: p.reference_format ?? pi.reference_format ?? '',
    referencePrice: p.reference_price ?? pi.reference_price ?? null,
    description: clean(p.description ?? ''),
    raw: pi
  };
}

function formatAmount(n, unit){
  if(n==null || !Number.isFinite(Number(n))) return '';
  n=Number(n);
  unit=String(unit||'').toLowerCase().trim();
  if(!unit) return '';
  if(unit==='cl') return `${String(Math.round(n*100)/100).replace('.',',')} cl`;
  if(unit==='l' || unit==='litro' || unit==='litros') return `${String(Math.round(n*1000)/1000).replace('.',',')} L`;
  if(unit==='kg' || unit==='kilo' || unit==='kilos') return `${String(Math.round(n*1000)).replace('.',',')} g`;
  if(unit==='g' || unit==='gramo' || unit==='gramos') return `${String(Math.round(n)).replace('.',',')} g`;
  if(unit==='ml' || unit==='mililitro' || unit==='mililitros') return `${String(Math.round(n)).replace('.',',')} ml`;
  return `${String(Math.round(n*1000)/1000).replace('.',',')} ${unit}`.trim();
}

function numericPositive(v){
  const n=Number(v);
  return Number.isFinite(n)&&n>0?n:null;
}

function allProductText(p, info){
  const pi=info.raw||{};
  return clean([
    p.name,p.display_name,p.slug,p.description,info.description,
    p.packaging,info.packaging,p.unit_name,info.unitName,
    pi.pack_size,pi.total_units,pi.unit_size,pi.size_format,pi.reference_format
  ].filter(v=>v!==undefined&&v!==null&&String(v)!=='').join(' '));
}

function detectPackUnits(p, info){
  // Primero usamos los campos estructurados de Mercadona.
  for(const v of [info.packSize, info.totalUnits]){
    const n=numericPositive(v);
    if(n && n>=2 && n<100) return Math.round(n);
  }

  const text=allProductText(p,info);
  const patterns=[
    /\b(?:pack|paquete|lote|caja|estuche)\s*(?:de\s*)?(\d{1,2})\s*(?:uds?|unidades)?\b/i,
    /\b(\d{1,2})\s*(?:uds?|unidades|botellas|latas|bricks|envases|vasos|yogures)\b/i,
    /\b(\d{1,2})\s*[x×]\s*\d+(?:[.,]\d+)?\s*(?:kg|g|ml|cl|l)\b/i
  ];
  for(const re of patterns){const m=text.match(re);if(m)return Number(m[1]);}
  return null;
}

function detectUnit(p, info){
  const direct=clean(info.unit||info.unitName||info.referenceFormat).toLowerCase();
  if(['l','litro','litros'].includes(direct)) return 'l';
  if(['ml','mililitro','mililitros'].includes(direct)) return 'ml';
  if(['cl','centilitro','centilitros'].includes(direct)) return 'cl';
  if(['kg','kilo','kilos'].includes(direct)) return 'kg';
  if(['g','gramo','gramos'].includes(direct)) return 'g';

  const text=allProductText(p,info).toLowerCase();
  if(/\b\d+(?:[.,]\d+)?\s*(?:ml)\b/.test(text)) return 'ml';
  if(/\b\d+(?:[.,]\d+)?\s*(?:cl)\b/.test(text)) return 'cl';
  if(/\b\d+(?:[.,]\d+)?\s*(?:l|litro|litros)\b/.test(text)) return 'l';
  if(/\b\d+(?:[.,]\d+)?\s*(?:kg|kilos?)\b/.test(text)) return 'kg';
  if(/\b\d+(?:[.,]\d+)?\s*(?:g|gr|gramos?)\b/.test(text)) return 'g';
  return '';
}

function detectExplicitPerUnitFormat(p, info){
  // Si la fuente ya contiene algo como "6 unidades x 125 g", es la fuente de verdad.
  const text=allProductText(p,info);
  const patterns=[
    /\b(\d{1,2})\s*(?:uds?|unidades|botellas|latas|bricks|envases|vasos|yogures)?\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(ml|cl|l|litros?|kg|g|gr|gramos?)\b/i,
    /\b(\d{1,2})\s*(?:uds?|unidades|botellas|latas|bricks|envases|vasos|yogures)\s*(?:de\s*)?(\d+(?:[.,]\d+)?)\s*(ml|cl|l|litros?|kg|g|gr|gramos?)\b/i
  ];
  for(const re of patterns){
    const m=text.match(re);
    if(m){
      const u=Math.round(Number(m[1]));
      let unit=m[3].toLowerCase();
      if(unit==='gr'||unit==='gramo'||unit==='gramos')unit='g';
      if(unit==='litro'||unit==='litros')unit='l';
      if(unit==='kilo'||unit==='kilos')unit='kg';
      return `${u} ud. x ${formatAmount(Number(String(m[2]).replace(',','.')),unit)}`;
    }
  }
  return '';
}

function buildFormat(p){
  const info=normalizeProductInfo(p);

  // 1) Formato comercial explícito, si la fuente lo proporciona.
  const explicit=detectExplicitPerUnitFormat(p,info);
  if(explicit)return explicit;

  const unit=detectUnit(p,info);
  const size=numericPositive(info.unitSize);
  const units=detectPackUnits(p,info);
  const isPack=info.isPack || Boolean(units);

  // 2) Pack estructurado: unit_size de MercaAPI suele representar el
  // tamaño TOTAL del pack. Para bebidas queremos conservar además el tipo
  // de envase: por ejemplo "6 botellas x 500 ml".
  if(isPack && units && size && unit){
    const perUnit=size/units;
    const amount=formatAmount(perUnit,unit);
    const packaging=clean(info.packaging||'').toLowerCase();
    const plural={
      'botella':'botellas', 'botellín':'botellines', 'lata':'latas',
      'brick':'bricks', 'brik':'briks', 'envase':'envases', 'vaso':'vasos',
      'yogur':'yogures', 'tarro':'tarros', 'bote':'botes', 'caja':'cajas',
      'paquete':'paquetes', 'pack':'packs'
    }[packaging] || 'ud.';
    if(plural==='ud.') return `${units} ud. x ${amount}`;
    return `${units} ${plural} x ${amount}`;
  }

  // 3) Producto individual. Conservamos el tipo de envase cuando lo conocemos
  // para que "Botella" no quede ambiguo: "Botella · 1,5 L".
  if(size && unit){
    const packaging=clean(info.packaging||'');
    if(packaging) return `${packaging} · ${formatAmount(size,unit)}`;
    return formatAmount(size,unit);
  }

  // 4) Último recurso: si solo conocemos el número de unidades, lo expresamos claramente.
  if(units)return `${units} ud.`;
  if(info.packaging)return info.packaging;
  return '';
}

function buildCategoryMaps(categories){
  const byId=new Map();
  for(const c of categories||[]){
    if(c&&c.id!=null)byId.set(String(c.id),c);
  }
  function routeFor(id){
    const names=[];const seen=new Set();let cur=id;
    while(cur!=null&&!seen.has(String(cur))){
      seen.add(String(cur));
      const c=byId.get(String(cur));
      if(!c)break;
      if(c.name)names.unshift(clean(c.name));
      cur=c.parent_id;
    }
    return names.filter(Boolean);
  }
  return {byId,routeFor};
}

async function syncFromMercaApi(){
  console.log('Consultando catálogo Mercadona mediante MercaAPI...');
  const categories=await fetchWithRetry(`${MERCAAPI}/categories/?limit=5000`);
  if(!Array.isArray(categories))throw new Error('Respuesta de categorías no válida.');

  const {routeFor}=buildCategoryMaps(categories);
  const products=[];
  const seen=new Set();
  const limit=5000;
  let skip=0;

  while(true){
    const page=await fetchWithRetry(`${MERCAAPI}/products/?skip=${skip}&limit=${limit}`);
    if(!Array.isArray(page))throw new Error('Respuesta de productos no válida.');
    for(const p of page){
      const id=String(p.id??'');
      const text=clean(p.name??p.display_name);
      if(!id||!text||seen.has(id))continue;
      seen.add(id);
      const catId=p.category_id??(p.category&&p.category.id);
      const route=routeFor(catId);
      const leaf=route[route.length-1]||clean(p.category&&p.category.name)||'Otros productos';
      const top=route[0]||leaf;
      const mid=route.length>1?route[1]:leaf;
      products.push({
        id:'m'+id,
        codigo:id,
        texto:text,
        formato:buildFormat(p),
        packaging:clean(p.packaging||''),
        categoria:top,
        subcategoria:mid,
        ruta:route.length?route.join(' > '):leaf,
        pagina:null,
        imagen:clean(p.thumbnail||p.image||(Array.isArray(p.photos)&&p.photos[0]&&(p.photos[0].thumbnail||p.photos[0].regular))||'')
      });
    }
    console.log(`Productos descargados: ${products.length}`);
    if(page.length<limit)break;
    skip+=limit;
    if(skip>50000)throw new Error('El catálogo parece tener una paginación anómala.');
  }

  if(products.length<500)throw new Error(`MercaAPI devolvió solo ${products.length} productos.`);

  // En MercaAPI algunos packs indican is_pack y el tamaño TOTAL, pero no siempre
  // incluyen total_units. Para esos casos consultamos el detalle oficial del
  // producto en Mercadona, donde price_instructions puede incluir total_units/pack_size.
  // Solo hacemos estas peticiones para packs sin formato completo para no castigar
  // la API ni ralentizar innecesariamente la sincronización.
  const candidates=products.filter(x=>x.id && /^m\d+$/.test(x.id) && !/^\d+\s*ud\.\s*x\s*/i.test(x.formato||'') && x.formato && /ud\.$/i.test(x.formato));
  if(candidates.length){
    console.log(`Comprobando formato de ${candidates.length} packs en Mercadona...`);
    let pos=0, improved=0;
    async function enrichOne(item){
      const id=item.id.slice(1);
      try{
        const d=await fetchWithRetry(`${API}/products/${id}/`,2);
        const pi=d.price_instructions||{};
        const merged={...d, price_instructions:{...(d.price_instructions||{})},
          pack_size:d.pack_size ?? pi.pack_size, total_units:d.total_units ?? pi.total_units,
          unit_size:d.unit_size ?? pi.unit_size, size_format:d.size_format ?? pi.size_format,
          unit_name:d.unit_name ?? pi.unit_name, is_pack:d.is_pack ?? pi.is_pack};
        const f=buildFormat(merged);
        if(f && f!==item.formato){ item.formato=f; improved++; }
        const image=clean(d.thumbnail||d.image||(Array.isArray(d.photos)&&d.photos[0]&&(d.photos[0].thumbnail||d.photos[0].regular))||'');
        if(image && !item.imagen) item.imagen=image;
      }catch(e){}
    }
    async function worker(){ while(true){ const i=pos++; if(i>=candidates.length)return; await enrichOne(candidates[i]); } }
    await Promise.all(Array.from({length:5},()=>worker()));
    console.log(`Formatos detallados mejorados: ${improved}`);
  }

  const cats=[...new Set(products.map(p=>p.categoria))].filter(Boolean).sort((a,b)=>a.localeCompare(b,'es'));
  const payload={source:'MercaAPI · catálogo Mercadona',updatedAt:new Date().toISOString(),count:products.length,categories:cats,products};
  fs.writeFileSync(OUT,JSON.stringify(payload,null,2),'utf8');
  console.log(`Catálogo actualizado: ${products.length} productos · ${cats.length} categorías.`);
  return true;
}

async function syncFromMercadonaDirect(existingProducts=[]){
  console.log('Comprobando catálogo directo de Mercadona para completar productos...');
  const root=await fetchWithRetry(`${API}/categories/`,3);
  const products=[];const seenProducts=new Set();
  const results=Array.isArray(root.results)?root.results:[];
  const secondLevel=[];
  for(const top of results){
    if(!Array.isArray(top.categories))continue;
    for(const c of top.categories){
      if(c&&c.id!=null)secondLevel.push({id:c.id,path:[clean(top.name),clean(c.name)]});
    }
  }
  console.log(`Subcategorías detectadas en fuente directa: ${secondLevel.length}`);

  let pos=0;
  async function worker(){
    while(true){
      const i=pos++;
      if(i>=secondLevel.length)return;
      const c=secondLevel[i];
      try{
        // IMPORTANTE: la API actual puede redirigir sin slash final.
        // Node https.get no sigue 301 automáticamente, por eso usamos siempre /.
        const detail=await fetchWithRetry(`${API}/categories/${c.id}/`,2);
        const stack=[{node:detail,path:c.path}];
        while(stack.length){
          const {node,path:route}=stack.pop();
          if(!node||typeof node!=='object')continue;
          if(Array.isArray(node.products))for(const p of node.products){
            const id=String(p.id??'');
            const text=clean(p.display_name||p.name);
            if(!id||!text||seenProducts.has(id))continue;
            seenProducts.add(id);
            products.push({
              id:'m'+id,codigo:id,texto:text,formato:buildFormat(p),
              packaging:clean(p.packaging||''),categoria:route[0]||'Otros productos',
              subcategoria:route[1]||route[route.length-1]||'Otros productos',
              ruta:route.join(' > '),pagina:null,
              imagen:clean(p.thumbnail||p.image||(Array.isArray(p.photos)&&p.photos[0]&&(p.photos[0].thumbnail||p.photos[0].regular))||'')
            });
          }
          if(Array.isArray(node.categories))for(const child of node.categories){
            stack.push({node:child,path:route.concat(clean(child.name))});
          }
        }
      }catch(e){
        // Una categoría puede no estar disponible para el almacén actual.
      }
      await sleep(60);
    }
  }
  await Promise.all(Array.from({length:6},()=>worker()));

  if(products.length<500)throw new Error(`La fuente directa devolvió solo ${products.length} productos.`);

  const mergedMap=new Map((existingProducts||[]).map(p=>[String(p.codigo||p.id),p]));
  let added=0;
  for(const p of products){
    const key=String(p.codigo||p.id);
    if(!mergedMap.has(key)){mergedMap.set(key,p);added++;}
    else{
      // El catálogo directo tiene prioridad para nombre/formato/categoría actuales.
      const old=mergedMap.get(key);
      mergedMap.set(key,{...old,...p,formato:p.formato||old.formato, packaging:p.packaging||old.packaging, imagen:p.imagen||old.imagen||''});
    }
  }
  const merged=[...mergedMap.values()];
  const cats=[...new Set(merged.map(p=>p.categoria))].filter(Boolean).sort((a,b)=>a.localeCompare(b,'es'));
  fs.writeFileSync(OUT,JSON.stringify({
    source:'Mercadona API directa + MercaAPI',
    updatedAt:new Date().toISOString(),
    count:merged.length,
    categories:cats,
    products:merged
  },null,2),'utf8');
  console.log(`Catálogo completado: ${merged.length} productos (+${added} nuevos desde Mercadona).`);
}

(async()=>{
  console.log('Actualizando catálogo de Mercadona...');
  try{
    await syncFromMercaApi();
    // MercaAPI es una buena base, pero puede quedarse atrás respecto al surtido
    // actual. Completamos con las categorías actuales de la tienda oficial.
    const current=JSON.parse(fs.readFileSync(OUT,'utf8'));
    try{
      await syncFromMercadonaDirect(current.products||[]);
    }catch(e2){
      console.warn('No se pudo completar con la API directa:',e2.message);
      console.warn('Se conserva el catálogo obtenido de MercaAPI.');
    }
  }catch(e){
    console.warn('MercaAPI no disponible:',e.message);
    try{
      await syncFromMercadonaDirect([]);
    }catch(e2){
      console.error('No se pudo actualizar el catálogo remoto:',e2.message);
      console.error('Se conserva el catálogo local para no perder datos.');
      process.exitCode=1;
    }
  }
})();
