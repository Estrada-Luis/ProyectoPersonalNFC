const fs=require('fs');
const path=require('path');
const {spawn}=require('child_process');

const ROOT=__dirname;
const DATA=process.env.DATA_DIR||path.join(ROOT,'data');
const SEED=path.join(ROOT,'data');
fs.mkdirSync(DATA,{recursive:true});

for(const name of ['catalogo.json','state.json']){
  const target=path.join(DATA,name);
  const source=path.join(SEED,name);
  if(!fs.existsSync(target) && fs.existsSync(source)) fs.copyFileSync(source,target);
}

async function maybeSync(){
  const marker=path.join(DATA,'.catalog-sync-attempted');
  if(fs.existsSync(marker)) return;
  console.log('Primer arranque: intentando sincronizar catálogo...');
  await new Promise(resolve=>{
    const cp=spawn(process.execPath,[path.join(ROOT,'sync-catalog.js')],{
      cwd:ROOT,
      env:{...process.env,DATA_DIR:DATA},
      stdio:'inherit'
    });
    const timer=setTimeout(()=>{cp.kill('SIGTERM');resolve();},35000);
    cp.on('close',()=>{clearTimeout(timer);resolve();});
    cp.on('error',()=>{clearTimeout(timer);resolve();});
  });
  fs.writeFileSync(marker,new Date().toISOString());
}

(async()=>{
  await maybeSync();
  require('./server.js');
})();
