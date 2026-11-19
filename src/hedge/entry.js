const params = new URLSearchParams(location.search);
const stage = params.get('simulation');
if (stage === 'challenge' || stage === 'funded') {
  const { showStageSimulation } = await import('./account-report.js');
  showStageSimulation(stage);
} else if (params.get('accounts') === 'last') {
  const { showReport } = await import('./account-report.js');
  showReport();
  window.addEventListener('hashchange', () => {
    if (new URLSearchParams(location.hash.slice(1)).has('observation')) showReport();
  });
} else {
  await import('./ui.js');
  if (params.get('live-input') === '1') {
    const mode = document.getElementById('mode');
    mode.value = 'live_readonly';
    mode.dispatchEvent(new Event('change'));
    document.getElementById('wallet').focus();
  }
  const { observationKey } = await import('./account-observation.js');
  if (localStorage.getItem(observationKey)) {
    const a = document.createElement('a');
    a.href = '/?accounts=last';
    a.textContent = '上次账户识别';
    document.querySelector('nav').append(a);
  }
}
