// ============== Account UI ==============
// The header's Log in button and user menu, plus the #name-modal and #logout-modal
// they open. Shared by every page that carries that markup (the landing page and
// the tournament page); app.js also drives the modal for its submit flow. The dialog
// behaviour they both want — trap, hidden page, Escape — is common.js's.

// ============== Modal ==============
const MODAL_MODES = {
    name: {
        title: 'Who are you?',
        subtitle: 'Enter a name to save your prediction.',
        showCookie: true,
        cancel: 'close',
    },
    login: {
        title: 'Log in',
        subtitle: 'Enter your name and password, or create a new account.',
        submitLabel: 'Log in',
        showPassword: true,
        showCreate: true,
        cancel: 'close',
    },
    password: {
        title: 'Set a password?',
        subtitle: 'Optionally protect your account with a password.',
        nameDisabled: true,
        showPassword: true,
        actions: 'password',
        focusId: 'password-input',
        cancel: 'skip',
    },
    changePassword: {
        title: 'Change password',
        subtitle: 'Set a new password for your account.',
        nameDisabled: true,
        showPassword: true,
        actions: 'password',
        focusId: 'password-input',
        cancel: 'skip',
    },
};

const nameModal = {
    _resolve: null,
    mode: null,
    _cfg: null,
    _restore: null,

    open(mode, opts = {}) {
        const cfg = {...MODAL_MODES[mode], ...opts};
        // A prompt a second modal replaces must not leave its caller waiting forever.
        this._settle(null);
        this.mode = mode;
        this._cfg = cfg;

        const modal = $('name-modal');
        const nameInput = $('name-input');
        const passwordInput = $('password-input');
        // Re-opening the dialog for the next step of one flow keeps the focus of
        // whatever opened it first.
        const reopen = !modal.classList.contains('d-none');

        $('modal-title').textContent = cfg.title;
        $('modal-subtitle').textContent = cfg.subtitle;
        $('modal-submit').textContent = cfg.submitLabel ?? 'Submit';

        nameInput.value = cfg.nameValue ?? '';
        nameInput.disabled = !!cfg.nameDisabled;
        nameInput.autocomplete = mode === 'login' ? 'username' : 'off';

        passwordInput.value = '';
        // The one password field serves logins and account creation; managers need to
        // tell the two apart.
        passwordInput.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
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

        if (!reopen) this._restore = document.activeElement;
        openDialog(modal, () => this._cancel());
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
        this._settle(result);
    },

    // Only the pending prompt is ever resolved, so a second close/resolve after the
    // modal answered (or a cancelled one) is harmless.
    _settle(result) {
        const resolve = this._resolve;
        this._resolve = null;
        resolve?.(result);
    },

    // Escape, and the Cancel/Skip button of whichever action row is showing.
    _cancel() {
        if (this._cfg?.cancel === 'skip') this.resolve(null);
        else this.close(null);
    },

    close(result) {
        this.mode = null;
        this._cfg = null;
        hide($('name-modal'));
        closeDialog($('name-modal'));
        if (this._restore?.isConnected) this._restore.focus();
        this._restore = null;
        this.resolve(result);
    },

    // Close it while nothing waits on a prompt. When another flow replaced this one while
    // it was pending, that dialog is still owed its answer and is not ours to shut.
    closeUnlessPending(result = null) {
        if (!this._resolve) this.close(result);
    },
};

async function loadCurrentUser() {
    if (!getToken()) return;
    const me = await tryFetch(loadMe);
    if (!me?.name) return;
    $('user-name').textContent = me.name;
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
            // A password that doesn't go through leaves the account claimable by
            // anyone, so say so rather than let the UI read as if it were set.
            if (password) {
                try {
                    await api('/api/password', {method: 'POST', body: {password}});
                } catch (e) {
                    if (!e.rateLimited) showToast('Account created without a password — set one from the user menu.');
                }
            }
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

    const userBtn = $('user-btn');
    const userDropdown = $('user-dropdown');
    const logoutModal = $('logout-modal');

    // The two pages carry the same menu markup with no semantics of its own, so they
    // get it from here once. setMenuOpen is the only way in and out of the menu, so the
    // button's aria-expanded can never disagree with what is on screen.
    userBtn.setAttribute('aria-expanded', 'false');
    userDropdown.setAttribute('role', 'menu');
    userDropdown.querySelectorAll('.user-dropdown-item').forEach(item => item.setAttribute('role', 'menuitem'));
    const setMenuOpen = open => {
        setHidden(userDropdown, !open);
        userBtn.setAttribute('aria-expanded', String(open));
    };

    onClick('user-btn', e => {
        e.stopPropagation();
        setMenuOpen(userDropdown.classList.contains('d-none'));
    });
    document.addEventListener('click', () => setMenuOpen(false));

    onClick('change-password-btn', async () => {
        setMenuOpen(false);
        await nameModal.promptChangePassword($('user-name').textContent);
        nameModal.closeUnlessPending();
    });
    // The button that opened the menu is also what a keyboard close returns to:
    // the logout item it was opened from hides again with the menu.
    let logoutRestore = null;
    const closeLogout = () => {
        hide(logoutModal);
        closeDialog(logoutModal);
        (isVisible(logoutRestore) ? logoutRestore : userBtn).focus();
        logoutRestore = null;
    };

    onClick('logout-btn', () => {
        logoutRestore = document.activeElement;
        setMenuOpen(false);
        show(logoutModal);
        openDialog(logoutModal, closeLogout);
        focusables(logoutModal)[0]?.focus();
    });
    onClick('logout-cancel', closeLogout);
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
