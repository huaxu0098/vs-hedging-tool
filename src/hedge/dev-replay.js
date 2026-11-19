import { replayFixture, seekReplay, scenarioNames } from './replay.js';
import { balances } from './book.js';

const $ = (id) => document.getElementById(id);
for (const [id, name] of Object.entries(scenarioNames)) $('scenario').add(new Option(name, id));
let path, index, timer;
function pause() {
  clearInterval(timer);
  timer = null;
  $('play').textContent = '播放';
}
function show() {
  const result = seekReplay(path, index);
  const last =
    index >= path.bars.length + Number(path.kind === 'payout') ||
    (result.stop && !(path.kind === 'payout' && result.state.status === 'PAYOUT_PENDING'));
  $('event').textContent = '步骤 ' + index + ' · ' + result.event;
  $('replay-cash').textContent =
    '测试账本 · VS ' + result.state.pf + ' U，个人资金 ' + balances(result.state).total + ' U';
  $('step').disabled = $('play').disabled = last;
  if (last) pause();
}
function reset() {
  pause();
  path = replayFixture($('scenario').value);
  index = 0;
  show();
}
function step() {
  index++;
  show();
}
$('restart').onclick = $('scenario').onchange = reset;
$('step').onclick = step;
$('play').onclick = () => {
  if (timer) return pause();
  $('play').textContent = '暂停';
  timer = setInterval(step, 700);
};
reset();
