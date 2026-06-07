// ============== Incident reports ==============
// incidents.html holds every incident write-up. A content fingerprint of
// INCIDENTS is stored in localStorage; whenever the list changes, users see a
// one-time toast on the main page until they open the page or dismiss it.
//
// To publish an update: add an entry to the top of INCIDENTS. The version hash
// changes automatically, so everyone is re-notified.

const INCIDENTS = [
    {
        date: '2026-06-07',
        title: 'Some predictions were lost',
        body: [
            'During the process of manually integrating data for the seeding week for Liga 2 and 3, some predictions' +
            ' were invalidated. To reduce the loss of data we rolled back to a backup. As a result, predictions that' +
            ' were made between 22:01 CEST and 22:32 CEST were lost. We are sorry for the inconvenience.',
            'If your predictions are missing, please submit them again.',
        ],
    },
];

const INCIDENTS_SEEN_KEY = 'ups_incidents_seen';

// Tiny string hash → short base36 fingerprint. Not cryptographic; only used to
// detect when the incident list content changes.
const incidentHash = s => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
};

const incidentEscape = str => {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
};

const incidentsVersion = () => incidentHash(JSON.stringify(INCIDENTS));
const incidentsUnread = () => localStorage.getItem(INCIDENTS_SEEN_KEY) !== incidentsVersion();
const markIncidentsRead = () => localStorage.setItem(INCIDENTS_SEEN_KEY, incidentsVersion());

function renderIncidents(container) {
    container.innerHTML = '';
    if (!INCIDENTS.length) {
        container.insertAdjacentHTML('beforeend',
            '<p class="text-secondary small">No incidents to report. Everything is running smoothly.</p>');
        return;
    }
    for (const inc of INCIDENTS) {
        const body = inc.body
            .map(p => `<p class="text-secondary small">${incidentEscape(p)}</p>`)
            .join('');
        container.insertAdjacentHTML('beforeend', `
            <section class="mb-4">
                <p class="text-secondary mb-1" style="font-size:.75rem">${incidentEscape(inc.date)}</p>
                <h3 class="h6 fw-semibold mb-2">${incidentEscape(inc.title)}</h3>
                ${body}
            </section>`);
    }
}

function showIncidentToast() {
    const latest = INCIDENTS[0];
    if (!latest || document.getElementById('incident-toast')) return;

    const toast = document.createElement('div');
    toast.id = 'incident-toast';
    toast.className = 'incident-toast';
    toast.setAttribute('role', 'status');

    const link = document.createElement('a');
    link.className = 'incident-toast-msg';
    link.href = 'incidents.html';
    link.textContent = `Update: ${latest.title}`;
    link.addEventListener('click', markIncidentsRead);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'incident-toast-close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    close.addEventListener('click', () => {
        markIncidentsRead();
        toast.remove();
    });

    toast.append(link, close);
    document.body.append(toast);
}

// Context-based auto-run: on incidents.html (#incident-list present) render the
// list and mark read; elsewhere surface the toast when there is something new.
const incidentList = document.getElementById('incident-list');
if (incidentList) {
    renderIncidents(incidentList);
    markIncidentsRead();
} else if (incidentsUnread()) {
    showIncidentToast();
}
