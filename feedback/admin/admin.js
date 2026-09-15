(() => {
    'use strict';

    const API = '/feedback/api/reports';

    const LABELS = {
        bug: 'Problem',
        suggestion: 'Suggestion',
        feature: 'Feature request',
        other: 'Other',
    };

    const FILTERS = [
        { label: 'All' },
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
    let current = { kind: params.get('kind'), severity: params.get('severity') };

    const same = (a, b) => (a.kind || null) === (b.kind || null) && (a.severity || null) === (b.severity || null);

    function renderFilters(counts) {
        const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
        filtersEl.replaceChildren(...FILTERS.map((filter) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'chip';
            const count = filter.severity ? '' : ` ${filter.kind ? counts[filter.kind] || 0 : total}`;
            button.textContent = filter.label + count;
            button.setAttribute('aria-pressed', String(same(filter, current)));
            button.addEventListener('click', () => select(filter));
            return button;
        }));
    }

    function details(report) {
        return [
            report.appVersion && `v${report.appVersion}`,
            report.android && `Android ${report.android}${report.sdk ? ` (SDK ${report.sdk})` : ''}`,
            report.device,
            report.language,
            report.page && `page ${report.page}`,
        ].filter(Boolean).join(' · ');
    }

    // Built with textContent only, so nothing a reader typed can run as markup
    function renderReport(report) {
        const node = template.content.firstElementChild.cloneNode(true);
        node.querySelector('.id').textContent = `#${report.id}`;
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
        const query = new URLSearchParams();
        if (current.kind) query.set('kind', current.kind);
        if (current.severity) query.set('severity', current.severity);

        try {
            const response = await fetch(`${API}?${query}`, { cache: 'no-store', credentials: 'same-origin' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const { counts, reports } = await response.json();

            renderFilters(counts);
            reportsEl.replaceChildren(...reports.map(renderReport));
            statusEl.textContent = reports.length ? '' : 'No reports here yet.';
        } catch (err) {
            statusEl.textContent = `Could not load reports (${err.message}).`;
        }
    }

    function select(filter) {
        current = { kind: filter.kind || null, severity: filter.severity || null };
        const query = new URLSearchParams();
        if (current.kind) query.set('kind', current.kind);
        if (current.severity) query.set('severity', current.severity);
        history.replaceState(null, '', query.size ? `?${query}` : location.pathname);
        load();
    }

    $('refresh').addEventListener('click', load);
    load();
})();
