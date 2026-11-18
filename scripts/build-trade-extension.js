import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../',import.meta.url));
export async function buildTradeExtension(dest = path.join(root,'build','trade-extension'), port = '4178') {
  if (!/^\d{1,5}$/.test(String(port))) throw Error('本机端口无效');
  await mkdir(dest,{recursive:true});
  const copy = (from,name) => cp(path.join(root,from),path.join(dest,name));
  for (const name of ['extract.js','vs-content.js','desk-content.js'])
    await copy('extension/'+name,name);
  await copy('extension/service.js','reader-service.js');
  for (const name of ['vest-binding.js','venue-vs.js','venue-hype.js','venue.js','desk.js','service.js'])
    await copy('trade-extension/'+name,name);
  const manifest = JSON.parse(await readFile(path.join(root,'trade-extension/manifest.json'),'utf8'));
  manifest.background = {service_worker:'background.js'};
  manifest.content_scripts[0].js.unshift('config.js','desk-content.js');
  manifest.content_scripts[1].js.unshift('extract.js','vest-binding.js','vs-content.js');
  await writeFile(path.join(dest,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  await writeFile(path.join(dest,'config.js'), 'globalThis.vsAutoConfig = Object.freeze('+JSON.stringify({deskPort:String(port),deskPage:'/trade.html'})+');\n');
  await writeFile(path.join(dest,'background.js'),"importScripts('reader-service.js','service.js');\n");
  return dest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(await buildTradeExtension());
