// Landing page: every tournament as a grid, newest (highest id) in the top left,
// oldest in the bottom right. Each card opens that tournament's page.
document.addEventListener('DOMContentLoaded', async () => {
    // The prediction page used to live here as /?tournament=<id>; send old links on.
    if (new URLSearchParams(location.search).has(TOURNAMENT_PARAM)) {
        location.replace(`/tournament.html${location.search}`);
        return;
    }

    const grid = $('tournament-grid');
    const tournaments = (await tryFetch(() => api('/api/tournaments'))) ?? [];

    if (!tournaments.length) {
        grid.replaceChildren(makeEl('p', {
            className: 'text-secondary text-center py-5',
            textContent: 'Failed to load tournaments. Please refresh.',
        }));
        return;
    }

    grid.replaceChildren(...tournaments.sort(byNewestTournament).map(t => makeEl('a', {
        className: 'tournament-card',
        href: tournamentHref(t.tournament_id),
        textContent: t.name,
    })));
});
