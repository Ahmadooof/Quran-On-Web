(() => {
    'use strict';

    const API = '/feedback/api/reports';

    const LABELS = {
        bug: 'Problem',
        suggestion: 'Suggestion',
        feature: 'Feature request',
        other: 'Other',
    };

    const SOURCES = { android: 'Android', web: 'Website' };

    const FILTERS = [
        { label: 'All' },
        ...Object.keys(SOURCES).map((source) => ({ label: SOURCES[source], source })),
        ...Object.keys(LABELS).map((kind) => ({ label: LABELS[kind], kind })),
        ...['high', 'medium', 'low'].map((severity) => ({ label: `Severity: ${severity}`, kind: 'bug', severity })),
    ];

    const $ = (id) => document.getElementById(id);
    const filtersEl = $('filters');
    const reportsEl = $('reports');
    const statusEl = $('status');
    const template = $('report');

    // The current filter lives in the address, so a refresh or a bookmark keeps it
    const params = new URLSearchParams(location.search);
    let current = { source: params.get('source'), kind: params.get('kind'), severity: params.get('severity') };

    const KEYS = ['source', 'kind', 'severity'];
    const same = (a, b) => KEYS.every((key) => (a[key] || null) === (b[key] || null));

    const queryOf = (filter) => {
        const query = new URLSearchParams();
        for (const key of KEYS) if (filter[key]) query.set(key, filter[key]);
        return query;
    };

    function renderFilters(counts, sources) {
        const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
        filtersEl.replaceChildren(...FILTERS.map((filter) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'chip';
            const count = filter.severity ? ''
                : filter.source ? ` ${sources[filter.source] || 0}`
                : ` ${filter.kind ? counts[filter.kind] || 0 : total}`;
            button.textContent = filter.label + count;
            button.setAttribute('aria-pressed', String(same(filter, current)));
            button.addEventListener('click', () => select(filter));
            return button;
        }));
    }

    function theme(report) {
        if (!report.theme && !report.themeShown) return null;
        if (report.theme === 'system') return `theme: system${report.themeShown ? ` (${report.themeShown})` : ''}`;
        return `theme: ${report.theme || report.themeShown}`;
    }

    // Where it came from first, then how the reader had things set up
    function details(report) {
        return [
            report.appVersion && `v${report.appVersion}`,
            report.android && `Android ${report.android}${report.sdk ? ` (SDK ${report.sdk})` : ''}`,
            report.device,
            report.browser,
            report.screen,
            report.language,
            theme(report),
            report.motion && `pages: ${report.motion}`,
            report.reciter && `reciter: ${report.reciter}`,
            report.page && `page ${report.page}`,
        ].filter(Boolean).join(' · ');
    }

    // Built with textContent only, so nothing a reader typed can run as markup
    function renderReport(report) {
        const node = template.content.firstElementChild.cloneNode(true);
        node.querySelector('.id').textContent = `#${report.id}`;
        const source = node.querySelector('.source');
        source.textContent = SOURCES[report.source] || report.source;
        source.classList.add(report.source);
        node.querySelector('.kind').textContent = LABELS[report.kind] || report.kind;

        const sev = node.querySelector('.sev');
        if (report.severity) {
            sev.textContent = report.severity;
            sev.classList.add(report.severity);
        }

        const time = node.querySelector('time');
        const when = new Date(report.at * 1000);
        time.dateTime = when.toISOString();
        time.textContent = when.toLocaleString();

        node.querySelector('.message').textContent = report.message;
        node.querySelector('.meta').textContent = details(report);

        if (report.email) {
            const email = node.querySelector('.email');
            email.href = `mailto:${encodeURIComponent(report.email)}`;
            email.textContent = report.email;
        }
        return node;
    }

    async function load() {
        statusEl.textContent = 'Loading…';
        const query = queryOf(current);

        try {
            const response = await fetch(`${API}?${query}`, { cache: 'no-store', credentials: 'same-origin' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const { counts, sources, reports } = await response.json();

            renderFilters(counts, sources || {});
            reportsEl.replaceChildren(...reports.map(renderReport));
            statusEl.textContent = reports.length ? '' : 'No reports here yet.';
        } catch (err) {
            statusEl.textContent = `Could not load reports (${err.message}).`;
        }
    }

    function select(filter) {
        current = { source: filter.source || null, kind: filter.kind || null, severity: filter.severity || null };
        const query = queryOf(current);
        history.replaceState(null, '', query.size ? `?${query}` : location.pathname);
        load();
    }

    $('refresh').addEventListener('click', load);
    load();
})();
