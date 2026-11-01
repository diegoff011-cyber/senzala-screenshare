const q = new URLSearchParams(location.search);
const name = q.get('name') || 'Alguém';
const ctl = q.get('control') === '1';
document.getElementById('txt').textContent =
  name + (ctl ? ' está controlando seu PC' : ' está vendo sua tela');
document.getElementById('stop').addEventListener('click', () => window.api.barDisconnect());
