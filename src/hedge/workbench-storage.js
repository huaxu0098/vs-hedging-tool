// Keep the newest local display for each scope available to the synchronous history reader.
// Older versioned displays can be moved losslessly to IndexedDB when localStorage is full.
const historyPrefix='vs-hype:display-history:AUTO-';
const archiveName='vs-hype:display-archive';
function olderDisplays(storage) {
  const groups=new Map();
  for(let i=0;i<storage.length;i++) {
    const key=storage.key(i);
    if(!key?.startsWith(historyPrefix)) continue;
    const match=/^(\d+)\.(\d+)\.(\d+):(.+)$/.exec(key.slice(historyPrefix.length));
    if(!match) continue;
    const scope=match[4];
    if(!groups.has(scope)) groups.set(scope,[]);
    groups.get(scope).push({key,version:match.slice(1,4).map(Number)});
  }
  const keys=[];
  for(const group of groups.values()) {
    group.sort((a,b)=>b.version[0]-a.version[0] || b.version[1]-a.version[1] || b.version[2]-a.version[2]);
    keys.push(...group.slice(1).map(item=>item.key));
  }
  return keys;
}

async function archiveOlderDisplays(storage) {
  const keys=olderDisplays(storage);
  if(!keys.length) return;
  const db=await new Promise((resolve,reject)=>{
    const request=indexedDB.open(archiveName,1);
    request.onupgradeneeded=()=>request.result.createObjectStore('snapshots');
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
  try {
    const entries=keys.map(key=>[key,storage.getItem(key)]).filter(([,value])=>value!==null);
    await new Promise((resolve,reject)=>{
      const tx=db.transaction('snapshots','readwrite');
      tx.oncomplete=resolve;
      tx.onabort=()=>reject(tx.error);
      for(const [key,value] of entries) tx.objectStore('snapshots').put(value,key);
    });
    for(const [key,value] of entries) if(storage.getItem(key)===value) storage.removeItem(key);
  } finally {db.close();}
}

// Persistence is independent of the quote loop. A blocked browser store must
// never prevent rendering, subscription or in-memory calculations.
export function workbenchStorage(onStatus) {
  const pending=new Map();
  let recovering=false, retryAfter=0;
  async function recover() {
    recovering=true;
    try {
      await archiveOlderDisplays(localStorage);
      for(const [key,{before,value}] of pending) {
        if(localStorage.getItem(key)!==before) continue; // another tab saved a newer value
        try {localStorage.setItem(key,value);onStatus(key,true);}
        catch {onStatus(key,false);retryAfter=Date.now()+60000;}
      }
    } catch {
      retryAfter=Date.now()+60000;
      for(const key of pending.keys()) onStatus(key,false);
    } finally {pending.clear();recovering=false;}
  }
  return {
    getItem(key) {try {return localStorage.getItem(key);} catch {return null;}},
    setItem(key,value) {
      try {
        localStorage.setItem(key,value);
        pending.delete(key);
        onStatus(key,true);
      } catch(error) {
        onStatus(key,false);
        if(error.name!=='QuotaExceededError' || Date.now()<retryAfter) return;
        const before=this.getItem(key);
        pending.set(key,{before,value});
        if(!recovering) void recover();
      }
    }
  };
}
