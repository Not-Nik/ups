// ============== Account UI ==============
// The header's Log in button and user menu, plus the #name-modal and #logout-modal
// they open. Shared by every page that carries that markup (the landing page and
// the tournament page); app.js also drives the modal for its submit flow.

// ============== Modal ==============
const MODAL_MODES = {
    name: {
        title: 'Who are you?',
        subtitle: 'Enter a name to save your prediction.',
        showCookie: true,
    },
    login: {
        title: 'Log in',
        subtitle: 'Enter your name and password, or create a new account.',
        submitLabel: 'Log in',
        showPassword: true,
        showCreate: true,
    },
    password: {
        title: 'Set a password?',
        subtitle: 'Optionally protect your account with a password.',
        nameDisabled: true,
        showPassword: true,
        actions: 'password',
        focusId: 'password-input',
    },
    changePassword: {
        title: 'Change password',
        subtitle: 'Set a new password for your account.',
        nameDisabled: true,
        showPassword: true,
        actions: 'password',
        focusId: 'password-input',
    },
};

const nameModal = {
    _resolve: null,
    mode: null,

    open(mode, opts = {}) {
        const cfg = {...MODAL_MODES[mode], ...opts};
        this.mode = mode;

        const modal = $('name-modal');
        const nameInput = $('name-input');
        const passwordInput = $('password-input');

        $('modal-title').textContent = cfg.title;
        $('modal-subtitle').textContent = cfg.subtitle;
        $('modal-submit').textContent = cfg.submitLabel ?? 'Submit';

        nameInput.value = cfg.nameValue ?? '';
        nameInput.disabled = !!cfg.nameDisabled;

        passwordInput.value = '';
        setHidden(passwordInput, !cfg.showPassword);

        const altActions = cfg.actions === 'password';
        setHidden($('modal-actions-1'), altActions);
        setHidden($('modal-actions-2'), !altActions);
        setHidden($('modal-create'), !cfg.showCreate);
        setHidden($('modal-cookie'), !cfg.showCookie);

        if (cfg.errorMsg) this.showError(cfg.errorMsg);
        else hide($('modal-error'));

        modal.querySelectorAll('button').forEach(b => {
            b.disabled = false;
        });

        show(modal);
        if (cfg.shake) shakeEl(nameInput);
        (cfg.focusId ? $(cfg.focusId) : nameInput).focus();

        return new Promise(resolve => {
            this._resolve = resolve;
        });
    },

    prompt(errorMsg = null) {
        return this.open('name', {errorMsg, shake: !!errorMsg});
    },
    promptLogin() {
        return this.open('login');
    },
    promptPassword(name) {
        return this.open('password', {nameValue: name});
    },
    promptChangePassword(name) {
        return this.open('changePassword', {nameValue: name});
    },

    showError(msg) {
        const err = $('modal-error');
        err.textContent = msg;
        show(err);
    },

    resolve(result) {
        this._resolve?.(result);
        this._resolve = null;
    },

    close(result) {
        this.mode = null;
        hide($('name-modal'));
        this.resolve(result);
    },
};

async function loadCurrentUser() {
    if (!getToken()) return;
    const data = await tryFetch(() => api('/api/me'));
    if (!data) return;
    $('user-name').textContent = data.name;
    show($('user-menu'));
    hide($('login-btn'));
}

// ============== Modal action handlers ==============
const resolveNameInput = () => {
    const name = $('name-input').value.trim();
    if (name) nameModal.resolve(name);
};

const ifLogin = (yes, no) => () => (nameModal.mode === 'login' ? yes : no)();

async function attemptLogin() {
    const nameInput = $('name-input');
    const name = nameInput.value.trim();
    const password = $('password-input').value;
    if (!name) {
        shakeEl(nameInput);
        return;
    }
    try {
        const data = await withDisabled(['modal-submit', 'modal-cancel', 'modal-create'], () =>
            api('/api/login', {method: 'POST', body: {name, password}})
        );
        saveToken(data.token);
        nameModal.close(null);
        loadCurrentUser();
    } catch (e) {
        if (e.rateLimited) return;
        nameModal.showError('Invalid name or password.');
        shakeEl(nameInput);
    }
}

async function attemptCreateAccount() {
    const nameInput = $('name-input');
    const name = nameInput.value.trim();
    const password = $('password-input').value;
    if (!name) {
        shakeEl(nameInput);
        return;
    }
    try {
        const data = await withDisabled(['modal-submit', 'modal-cancel', 'modal-create'], async () => {
            const r = await api('/api/submit', {method: 'POST', body: {predictions: [], name}});
            if (r.token) saveToken(r.token);
            if (password) await tryFetch(() => api('/api/password', {method: 'POST', body: {password}}));
            return r;
        });
        nameModal.close(null);
        loadCurrentUser();
    } catch (e) {
        if (e.rateLimited) return;
        nameModal.showError(e.code === 'AccountExists'
            ? 'That name is already taken. Please choose another.'
            : 'Failed to create account.');
        shakeEl(nameInput);
    }
}

async function attemptSetPassword() {
    const passwordInput = $('password-input');
    const password = passwordInput.value;
    if (!password) {
        shakeEl(passwordInput);
        return;
    }
    try {
        await withDisabled(['password-submit', 'password-skip'], () =>
            api('/api/password', {method: 'POST', body: {password}})
        );
        nameModal.resolve(null);
    } catch (e) {
        if (e.rateLimited) return;
        nameModal.showError('Failed to set password. Please try again.');
        shakeEl(passwordInput);
    }
}

// ============== Init ==============
function bindAuthEvents() {
    onClick('modal-submit', ifLogin(attemptLogin, resolveNameInput));
    onClick('modal-create', attemptCreateAccount);
    onClick('modal-cancel', () => nameModal.close(null));
    onEnter('name-input', ifLogin(() => $('password-input').focus(), resolveNameInput));

    onClick('password-skip', () => nameModal.resolve(null));
    onClick('password-submit', attemptSetPassword);
    onEnter('password-input', ifLogin(attemptLogin, attemptSetPassword));

    const userDropdown = $('user-dropdown');
    const logoutModal = $('logout-modal');

    onClick('user-btn', e => {
        e.stopPropagation();
        userDropdown.classList.toggle('d-none');
    });
    document.addEventListener('click', () => hide(userDropdown));

    onClick('change-password-btn', async () => {
        hide(userDropdown);
        await nameModal.promptChangePassword($('user-name').textContent);
        nameModal.close(null);
    });
    onClick('logout-btn', () => {
        hide(userDropdown);
        show(logoutModal);
    });
    onClick('logout-cancel', () => hide(logoutModal));
    onClick('logout-confirm', async () => {
        await tryFetch(() => api('/api/logout', {method: 'POST'}));
        localStorage.removeItem('ups_token');
        location.reload();
    });

    onClick('login-btn', () => nameModal.promptLogin());
}

document.addEventListener('DOMContentLoaded', () => {
    bindAuthEvents();
    if (!getToken()) show($('login-btn'));
    loadCurrentUser();
});
