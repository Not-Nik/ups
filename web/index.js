// Landing page: every tournament as a grid, newest (highest id) in the top left,
// oldest in the bottom right. Each card opens that tournament's page.
document.addEventListener('DOMContentLoaded', async () => {
    // The prediction page used to live here as /?tournament=<id>; send old links on.
    if (new URLSearchParams(location.search).has(TOURNAMENT_PARAM)) {
        location.replace(`/tournament.html${location.search}`);
        return;
    }

    const grid = $('tournament-grid');
    // A failed request and a league with no tournaments yet are different pages, so
    // they can't both come out of tryFetch as undefined.
    let tournaments;
    try {
        tournaments = await api('/api/tournaments');
    } catch {
        renderStatus(grid, {text: 'Failed to load tournaments. Please refresh.'});
        return;
    }

    if (!tournaments.length) {
        renderStatus(grid, {text: 'No tournaments yet.'});
        return;
    }

    grid.replaceChildren(...tournaments.sort(byNewestTournament).map(t => makeEl('a', {
        className: 'tournament-card',
        href: tournamentHref(t.tournament_id),
        textContent: t.name,
    })));
});
