const clearServerBtn = document.getElementById('clear-server');
const clearServerConf = document.getElementById('clear-server-confirm');
const clearServerMsg = document.getElementById('clear-server-msg');
const clearStorageBtn = document.getElementById('clear-storage');
const clearStorageConf = document.getElementById('clear-storage-confirm');
const clearStorageMsg = document.getElementById('clear-storage-msg');

if (!getToken()) clearServerBtn.disabled = true;

clearStorageBtn.addEventListener('click', () => {
    clearStorageMsg.style.display = 'none';
    clearStorageConf.style.display = '';
});

clearStorageConf.addEventListener('click', async () => {
    if (getToken()) await tryFetch(() => api('/api/logout', {method: 'POST'}));
    // Every key this app writes goes — the overlay's live-match keys name the user's
    // current match and scores too — with the theme preference the one thing kept.
    for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key?.startsWith('ups_') && key !== 'ups_theme') localStorage.removeItem(key);
    }
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
    const token = getToken();
    if (!token) return;
    clearServerConf.style.display = 'none';
    clearServerBtn.disabled = true;
    clearServerMsg.className = 'small text-secondary';
    clearServerMsg.textContent = 'Deleting…';
    clearServerMsg.style.display = '';
    try {
        await api('/api/delete', {method: 'POST'});
        localStorage.removeItem('ups_token');
        clearServerMsg.className = 'small text-success';
        clearServerMsg.textContent = 'Server data deleted.';
    } catch {
        clearServerBtn.disabled = false;
        clearServerMsg.className = 'small text-danger';
        clearServerMsg.textContent = 'Failed. Please try again.';
    }
});
