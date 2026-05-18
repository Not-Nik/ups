const clearServerBtn   = document.getElementById('clear-server');
const clearServerConf  = document.getElementById('clear-server-confirm');
const clearServerMsg   = document.getElementById('clear-server-msg');
const clearStorageBtn  = document.getElementById('clear-storage');
const clearStorageConf = document.getElementById('clear-storage-confirm');
const clearStorageMsg  = document.getElementById('clear-storage-msg');

if (!localStorage.getItem('ups_token')) clearServerBtn.disabled = true;

clearStorageBtn.addEventListener('click', () => {
  clearStorageMsg.style.display = 'none';
  clearStorageConf.style.display = '';
});

clearStorageConf.addEventListener('click', () => {
  localStorage.clear();
  clearServerBtn.disabled = true;
  clearStorageConf.style.display = 'none';
  clearServerConf.style.display = 'none';
  clearStorageMsg.style.display = '';
});

clearServerBtn.addEventListener('click', () => {
  clearServerMsg.style.display = 'none';
  clearServerConf.style.display = '';
});

clearServerConf.addEventListener('click', async () => {
  const token = localStorage.getItem('ups_token');
  if (!token) return;
  clearServerConf.style.display = 'none';
  clearServerBtn.disabled = true;
  clearServerMsg.className = 'small text-secondary';
  clearServerMsg.textContent = 'Deleting…';
  clearServerMsg.style.display = '';
  try {
    const res = await fetch('/api/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) throw new Error();
    localStorage.removeItem('ups_token');
    clearServerMsg.className = 'small text-success';
    clearServerMsg.textContent = 'Server data deleted.';
  } catch {
    clearServerBtn.disabled = false;
    clearServerMsg.className = 'small text-danger';
    clearServerMsg.textContent = 'Failed. Please try again.';
  }
});
