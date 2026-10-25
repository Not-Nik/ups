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

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';
const focusables = root => [...root.querySelectorAll(FOCUSABLE)].filter(isVisible);

// aria-hidden set on the rest of the page while the dialog is open, so it only ever
// comes off again where this put it on. Elements already carrying it (or announcing
// themselves, like the toast) are left alone.
let hiddenForDialog = [];

const hidePage = dialog => {
    showPage();
    hiddenForDialog = [...document.body.children].filter(el => el !== dialog
        && !el.hasAttribute('aria-hidden')
        && !el.hasAttribute('aria-live')
        && el.getAttribute('role') !== 'alert');
    hiddenForDialog.forEach(el => el.setAttribute('aria-hidden', 'true'));
};

const showPage = () => {
    hiddenForDialog.forEach(el => el.removeAttribute('aria-hidden'));
    hiddenForDialog = [];
};

// Keeps the keyboard on the dialog while it is open, and Escape is its cancel button.
let dialogTrap = null;

function trapKeys(e, dialog, onEscape) {
    if (e.key === 'Escape') {
        e.preventDefault();
        onEscape();
        return;
    }
    if (e.key !== 'Tab') return;
    const items = focusables(dialog);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (!dialog.contains(active) || (e.shiftKey && (active === first || !items.includes(active)))) {
        e.preventDefault();
        last.focus();
    } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
    }
}

// Rows hidden with d-none have no layout box, so their controls stay out of the trap.
const isVisible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

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
        hidePage(modal);
        dialogTrap?.();
        dialogTrap = addDialogTrap(modal, () => this._cancel());
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
        dialogTrap?.();
        dialogTrap = null;
        showPage();
        if (this._restore?.isConnected) this._restore.focus();
        this._restore = null;
        this.resolve(result);
    },
};

// Binds the trap for one open dialog; returns the function that unbinds it.
function addDialogTrap(dialog, onEscape) {
    const onKey = e => trapKeys(e, dialog, onEscape);
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
}

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
