// Every tournament as a grid, newest (highest id) in the top left, oldest in the
// bottom right — the same order the header tab bar uses, just without a width limit.
// Each card links back to the prediction page with that tournament pre-selected.
document.addEventListener('DOMContentLoaded', async () => {
    const grid = $('archive-grid');
    const tournaments = (await tryFetch(() => api('/api/tournaments'))) ?? [];

    if (!tournaments.length) {
        grid.replaceChildren(makeEl('p', {
            className: 'text-secondary text-center py-5',
            textContent: 'Failed to load tournaments. Please refresh.',
        }));
        return;
    }

    grid.replaceChildren(...tournaments.sort(byNewestTournament).map(t => makeEl('a', {
        className: 'archive-card',
        href: tournamentHref(t.tournament_id),
        textContent: t.name,
    })));
});
