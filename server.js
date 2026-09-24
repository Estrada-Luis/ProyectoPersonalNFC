const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY/SUPABASE_ANON_KEY.');
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

const send = (res, code, data, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
};

function body(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => {
      b += c;
      if (b.length > 1024 * 1024) req.destroy(new Error('Body demasiado grande'));
    });
    req.on('end', () => {
      try { resolve(b ? JSON.parse(b) : {}); }
      catch { reject(new Error('JSON no válido')); }
    });
    req.on('error', reject);
  });
}

function houseIdValid(id) {
  return /^[A-Za-z0-9_-]{4,32}$/.test(id);
}

function adminKeyValid(req) {
  const configured = process.env.ADMIN_KEY;
  return configured && req.headers['x-admin-key'] === configured;
}

function randomHouseId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(10);
  return [...bytes].map(b => alphabet[b % alphabet.length]).join('');
}

async function ensureHouse(id, name) {
  const { data, error } = await db
    .from('houses')
    .upsert({ id, name: name || `Casa ${id}` }, { onConflict: 'id', ignoreDuplicates: true })
    .select()
    .maybeSingle();
  if (error) throw error;
  if (data) return data;

  const result = await db.from('houses').select('id,name').eq('id', id).single();
  if (result.error) throw result.error;
  return result.data;
}

async function getHouse(id) {
  const { data, error } = await db
    .from('houses')
    .select('id,name')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function getItems(id) {
  const { data, error } = await db
    .from('shopping_items')
    .select('id,product_id,texto,formato,categoria,subcategoria,ruta,pagina,cantidad,created_at,updated_at')
    .eq('house_id', id)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []).map(x => ({
    id: x.id,
    productId: x.product_id,
    texto: x.texto,
    formato: x.formato || '',
    categoria: x.categoria || '',
    subcategoria: x.subcategoria || '',
    ruta: x.ruta || '',
    pagina: x.pagina ?? null,
    cantidad: x.cantidad
  }));
}

async function getHistory(id) {
  const { data, error } = await db
    .from('purchases')
    .select('id,purchased_at,items')
    .eq('house_id', id)
    .order('purchased_at', { ascending: false })
    .limit(30);
  if (error) throw error;
  return (data || []).map(x => ({
    id: x.id,
    date: x.purchased_at,
    items: x.items || []
  }));
}

async function getHouseState(id) {
  const house = await getHouse(id);
  if (!house) return null;
  const [items, history] = await Promise.all([getItems(id), getHistory(id)]);
  return { id: house.id, name: house.name, items, history };
}

async function addItem(houseId, b) {
  if (!b.productId || !b.texto) throw new Error('Datos incompletos');
  const quantity = Math.max(1, Math.min(99, Number(b.cantidad) || 1));

  const { data: existing, error: findError } = await db
    .from('shopping_items')
    .select('id,cantidad')
    .eq('house_id', houseId)
    .eq('product_id', b.productId)
    .maybeSingle();
  if (findError) throw findError;

  if (existing) {
    const { data, error } = await db
      .from('shopping_items')
      .update({
        cantidad: Math.min(99, existing.cantidad + quantity),
        formato: b.formato ?? '',
        subcategoria: b.subcategoria ?? '',
        ruta: b.ruta ?? '',
        updated_at: new Date().toISOString()
      })
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await db
    .from('shopping_items')
    .insert({
      house_id: houseId,
      product_id: b.productId,
      texto: b.texto,
      formato: b.formato || '',
      categoria: b.categoria || '',
      subcategoria: b.subcategoria || '',
      ruta: b.ruta || '',
      pagina: b.pagina ?? null,
      cantidad: quantity
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function updateItem(houseId, productId, quantity) {
  const q = Math.max(0, Math.min(99, Number(quantity) || 0));
  if (q === 0) {
    const { error } = await db.from('shopping_items')
      .delete().eq('house_id', houseId).eq('product_id', productId);
    if (error) throw error;
    return;
  }
  const { error } = await db.from('shopping_items')
    .update({ cantidad: q, updated_at: new Date().toISOString() })
    .eq('house_id', houseId).eq('product_id', productId);
  if (error) throw error;
}

async function purchaseHouse(houseId) {
  const items = await getItems(houseId);
  if (!items.length) throw new Error('La cesta está vacía');

  const { data: purchase, error: purchaseError } = await db
    .from('purchases')
    .insert({ house_id: houseId, items })
    .select('id,purchased_at,items')
    .single();
  if (purchaseError) throw purchaseError;

  const { error: deleteError } = await db.from('shopping_items')
    .delete().eq('house_id', houseId);
  if (deleteError) throw deleteError;

  return { id: purchase.id, date: purchase.purchased_at, items: purchase.items };
}

async function readCatalog() {
  const file = path.join(ROOT, 'data', 'catalogo.json');
  if (!fs.existsSync(file)) throw new Error('No existe data/catalogo.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

let catalogSyncPromise = null;

function catalogHasImages(catalog) {
  const products = Array.isArray(catalog?.products) ? catalog.products : [];
  if (!products.length) return false;
  const imageCount = products.filter(p => p && p.imagen).length;
  // Si el catálogo desplegado no trae fotos, lo regeneramos automáticamente.
  return imageCount >= Math.max(1, Math.floor(products.length * 0.5));
}

async function ensureCatalogReady() {
  let catalog;
  try {
    catalog = await readCatalog();
    if (catalogHasImages(catalog)) return catalog;
  } catch (e) {
    catalog = null;
  }

  if (!catalogSyncPromise) {
    console.log('Catálogo sin fotos o inexistente. Sincronizando automáticamente...');
    catalogSyncPromise = syncCatalog()
      .finally(() => { catalogSyncPromise = null; });
  }

  try {
    return await catalogSyncPromise;
  } catch (e) {
    // Si la API externa falla, devolvemos el catálogo existente antes que
    // dejar la aplicación sin productos.
    if (catalog) {
      console.warn('No se pudo regenerar el catálogo:', e.message);
      return catalog;
    }
    throw e;
  }
}

async function syncCatalog() {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const cp = spawn(process.execPath, [path.join(ROOT, 'sync-catalog.js')], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let err = '';
    cp.stderr.on('data', d => err += d);
    cp.stdout.on('data', d => process.stdout.write(d));
    cp.on('close', async code => {
      if (code !== 0) return reject(new Error(err || 'No se pudo actualizar el catálogo'));
      try { resolve(await readCatalog()); }
      catch (e) { reject(e); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = url.parse(req.url, true);
    const p = u.pathname;

    if (p === '/health' && req.method === 'GET') {
      return send(res, 200, { ok: true, database: 'supabase' });
    }

    if (p === '/api/catalog' && req.method === 'GET') {
      return send(res, 200, await ensureCatalogReady());
    }

    if (p === '/api/catalog/sync' && req.method === 'POST') {
      if (!adminKeyValid(req)) return send(res, 403, { error: 'No autorizado' });
      const d = await syncCatalog();
      return send(res, 200, { count: d.products.length, imageCount: d.products.filter(p => p.imagen).length, products: d.products });
    }

    let m = p.match(/^\/api\/house\/([^/]+)$/);
    if (m && req.method === 'GET') {
      const id = decodeURIComponent(m[1]);
      if (!houseIdValid(id)) return send(res, 400, { error: 'Identificador de casa no válido' });
      await ensureHouse(id);
      return send(res, 200, await getHouseState(id));
    }

    if (p === '/api/admin/house' && req.method === 'POST') {
      if (!adminKeyValid(req)) return send(res, 403, { error: 'No autorizado' });
      const b = await body(req);
      const id = String(b.id || randomHouseId()).trim().toUpperCase();
      if (!houseIdValid(id)) return send(res, 400, { error: 'ID no válido. Usa 4-32 letras/números.' });
      const house = await ensureHouse(id, b.name || `Casa ${id}`);
      const base = process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;
      return send(res, 201, {
        ...house,
        url: `${base.replace(/\/$/, '')}/casa/${encodeURIComponent(house.id)}`
      });
    }

    m = p.match(/^\/api\/house\/([^/]+)\/item$/);
    if (m && req.method === 'POST') {
      const id = decodeURIComponent(m[1]);
      if (!houseIdValid(id)) return send(res, 400, { error: 'Casa no válida' });
      await ensureHouse(id);
      return send(res, 200, { ok: true, item: await addItem(id, await body(req)) });
    }

    m = p.match(/^\/api\/house\/([^/]+)\/item\/([^/]+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const productId = decodeURIComponent(m[2]);
      if (!houseIdValid(id)) return send(res, 400, { error: 'Casa no válida' });
      await ensureHouse(id);

      if (req.method === 'PATCH') {
        const b = await body(req);
        await updateItem(id, productId, b.cantidad);
        return send(res, 200, { ok: true });
      }

      if (req.method === 'DELETE') {
        const { error } = await db.from('shopping_items')
          .delete().eq('house_id', id).eq('product_id', productId);
        if (error) throw error;
        return send(res, 200, { ok: true });
      }
    }

    m = p.match(/^\/api\/house\/([^/]+)\/purchase$/);
    if (m && req.method === 'POST') {
      const id = decodeURIComponent(m[1]);
      if (!houseIdValid(id)) return send(res, 400, { error: 'Casa no válida' });
      if (!await getHouse(id)) return send(res, 404, { error: 'Casa no encontrada' });
      return send(res, 200, { ok: true, purchase: await purchaseHouse(id) });
    }

    const file = p === '/' ? '/index.html' : p;
    const publicRoot = path.join(ROOT, 'public');
    const fp = path.normalize(path.join(publicRoot, file));
    if (!fp.startsWith(publicRoot)) return send(res, 403, { error: 'Forbidden' });

    if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      const ext = path.extname(fp);
      res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
      return fs.createReadStream(fp).pipe(res);
    }

    const index = path.join(publicRoot, 'index.html');
    res.writeHead(200, { 'Content-Type': mime['.html'] });
    return fs.createReadStream(index).pipe(res);
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: e.message || 'Error interno' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`CompraNFC listo en el puerto ${PORT}`);
});
