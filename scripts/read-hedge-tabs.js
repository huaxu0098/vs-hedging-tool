import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { summarizePages, validateObservation } from '../src/hedge/account-observation.js';

const origin = 'http://127.0.0.1:4180';
function chrome(program, args = []) {
  return execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', program, ...args], {
    encoding: 'utf8',
    timeout: 12000
  }).trim();
}
const findTabs = `const c=Application('Google Chrome');const wins=c.windows();const out={vs:[],hl:[],desk:[],first:null};
for(const [n,w] of wins.entries()){
  const tabs=w.tabs();if(n===0)out.first={w:String(w.id()),id:String(w.activeTab().id())};
  for(const t of tabs){const u=t.url().split(/[?#]/)[0];let key;
    if(/^https:\\/\\/next\\.vestmarkets\\.com\\/trade\\/[a-zA-Z0-9_.:-]+$/.test(u))key='vs';
    if(/^https:\\/\\/app\\.hyperliquid\\.xyz\\/trade\\/[a-zA-Z0-9_.:-]+$/.test(u))key='hl';
    if(u==='http://127.0.0.1:4180/')key='desk';
    if(key)out[key].push({w:String(w.id()),id:String(t.id()),url:u});
  }
}JSON.stringify(out)`;
const select = `function run(args){const c=Application('Google Chrome'),w=c.windows().find(x=>String(x.id())===args[0]);if(!w)throw Error('未找到原窗口');const i=w.tabs().findIndex(t=>String(t.id())===args[1]);if(i<0)throw Error('原标签已关闭');w.index=1;w.activeTabIndex=i+1;c.activate();}`;
function read(tab) {
  chrome(select, [tab.w, tab.id]);
  const path = fileURLToPath(new URL('./read-hedge-page.swift', import.meta.url));
  return JSON.parse(execFileSync('/usr/bin/swift', [path, tab.url], { encoding: 'utf8', timeout: 20000 }));
}
async function main() {
  if (process.platform !== 'darwin') throw Error('此读取入口使用 macOS 的 Chrome 辅助功能');
  const probe = await fetch(origin + '/src/hedge/entry.js', { signal: AbortSignal.timeout(2000) });
  if (!probe.ok) throw Error('请先启动 4180 本地只读工作台');
  const tabs = JSON.parse(chrome(findTabs));
  if (tabs.vs.length !== 1 || tabs.hl.length !== 1)
    throw Error('需要唯一的 VS 和 Hype 官网交易标签页，请核对已打开的页面');
  let finished = false;
  try {
    const observation = validateObservation(summarizePages(read(tabs.vs[0]), read(tabs.hl[0])));
    // The fragment is local to the browser. Store the last observation separately from both ledgers.
    const url =
      origin +
      '/?accounts=last&capture=' +
      Date.now() +
      '#' +
      new URLSearchParams({ observation: JSON.stringify(observation) });
    const target = tabs.desk[0];
    if (target) {
      chrome(select, [target.w, target.id]);
      chrome(
        `function run(args){const w=Application('Google Chrome').windows().find(x=>String(x.id())===args[0]);const t=w?.tabs().find(x=>String(x.id())===args[1]);if(!t||t.url().split(/[?#]/)[0]!=='http://127.0.0.1:4180/')throw Error('工作台标签已改变');t.url=args[2];}`,
        [target.w, target.id, url]
      );
    } else
      chrome(
        `function run(args){const c=Application('Google Chrome');const t=c.Tab({url:args[0]});c.windows()[0].tabs.push(t);c.activate();}`,
        [url]
      );
    finished = true;
    console.log('已打开双边账户快照 ' + origin + '/?accounts=last');
  } finally {
    if (!finished && tabs.first) chrome(select, [tabs.first.w, tabs.first.id]);
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
