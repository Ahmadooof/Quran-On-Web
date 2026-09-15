const KINDS = ['bug', 'suggestion', 'feature', 'other'];
const SEVERITIES = ['low', 'medium', 'high'];
const SOURCES = ['android', 'web'];
const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,}$/;
const MIN_MESSAGE = 5;

class Invalid extends Error {}

// Control characters other than line breaks and tabs have no place in a report
const clean = (value) => value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();

function text(value, limit, { required = false } = {}) {
    if (value === undefined || value === null || value === '') {
        if (required) throw new Invalid('missing');
        return null;
    }
    if (typeof value !== 'string' || value.length > limit) throw new Invalid('text');
    const out = clean(value);
    if (required && !out) throw new Invalid('missing');
    return out || null;
}

function oneOf(value, allowed) {
    if (value === undefined || value === null) return null;
    if (!allowed.includes(value)) throw new Invalid('choice');
    return value;
}

function number(value, low, high) {
    if (value === undefined || value === null) return null;
    if (!Number.isInteger(value) || value < low || value > high) throw new Invalid('number');
    return value;
}

/** A report as the app sends it, checked field by field; throws Invalid on anything off. */
function parseReport(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Invalid('body');

    const source = body.source;
    if (!SOURCES.includes(source)) throw new Invalid('source');

    const kind = body.kind;
    if (!KINDS.includes(kind)) throw new Invalid('kind');

    // Severity belongs to problems only, and stays optional there
    const severity = body.severity ?? null;
    if (severity !== null && (kind !== 'bug' || !SEVERITIES.includes(severity))) throw new Invalid('severity');

    const message = text(body.message, 4000, { required: true });
    if (message.length < MIN_MESSAGE) throw new Invalid('message');

    const email = text(body.email, 254);
    if (email !== null && !EMAIL.test(email)) throw new Invalid('email');

    const app = body.app ?? {};
    if (typeof app !== 'object' || Array.isArray(app)) throw new Invalid('app');

    return {
        source,
        kind,
        severity,
        message,
        email,
        appVersion: text(app.version, 32),
        android: text(app.android, 32),
        sdk: number(app.sdk, 1, 100),
        device: text(app.device, 100),
        language: text(app.language, 8),
        page: number(app.page, 1, 604),
        theme: oneOf(app.theme, ['light', 'dark', 'system']),
        themeShown: oneOf(app.themeShown, ['light', 'dark']),
        motion: oneOf(app.motion, ['slide', 'turn']),
        reciter: text(app.reciter, 80),
        screen: text(app.screen, 40),
        browser: text(app.browser, 120),
    };
}

module.exports = { parseReport, Invalid, KINDS, SEVERITIES, SOURCES };
