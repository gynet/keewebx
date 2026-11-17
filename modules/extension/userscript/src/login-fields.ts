import { eligible, targets } from './form-targets';

const username = /(?:^|\s)username(?:\s|$)/i;
const loginContext = /(?:^|[^a-z])(?:log[\s_-]?in|sign[\s_-]?in|authenticate|authentication)(?:$|[^a-z])/i;
const otherContext = /(?:^|[^a-z])(?:search|query|newsletter|subscribe|contact|otp|one[\s_-]?time[\s_-]?(?:code|password)|verification[\s_-]?code|sign[\s_-]?up|register|registration|create[\s_-]+(?:an?[\s_-]+)?account|(?:reset|forgot|new)[\s_-]?password)(?:$|[^a-z])/i;

/** Require a rendered field within the viewport, including any clipping ancestors. */
function visible(input: HTMLInputElement): boolean {
    if (input.closest('[hidden]')) return false;
    const rect = input.getBoundingClientRect();
    const viewport = window.visualViewport;
    let left = Math.max(rect.left, viewport?.offsetLeft ?? 0);
    let top = Math.max(rect.top, viewport?.offsetTop ?? 0);
    let right = Math.min(rect.right, (viewport?.offsetLeft ?? 0) + (viewport?.width ?? innerWidth));
    let bottom = Math.min(rect.bottom, (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight));
    for (let element: HTMLElement | null = input; element; element = element.parentElement) {
        const style = getComputedStyle(element);
        if (style.opacity === '0' || style.visibility === 'collapse' || style.getPropertyValue('content-visibility') === 'hidden') return false;
        if (element !== input && element !== document.body && element !== document.documentElement) {
            const clip = element.getBoundingClientRect();
            if (/^(?:auto|scroll|hidden|clip)$/.test(style.overflowX)) {
                left = Math.max(left, clip.left); right = Math.min(right, clip.right);
            }
            if (/^(?:auto|scroll|hidden|clip)$/.test(style.overflowY)) {
                top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom);
            }
        }
    }
    return right > left && bottom > top;
}

function context(element: Element): string {
    const attributes = ['id', 'class', 'name', 'action', 'aria-label'].map(name => element.getAttribute(name) ?? '');
    for (const id of (element.getAttribute('aria-labelledby') ?? '').split(/\s+/)) {
        // IDs and labels are page data, never selectors or executable markup.
        if (id) attributes.push(document.getElementById(id)?.textContent ?? '');
    }
    return attributes.join(' ').replace(/([a-z])([A-Z])/g, '$1 $2');
}

function emailLogin(input: HTMLInputElement): boolean {
    const scope = input.form ?? input.closest('section,dialog,[role="form"],[role="dialog"]') ?? input.parentElement;
    if (!scope || scope === document.body || scope === document.documentElement) return false;
    const hints = [context(input), context(scope), ...Array.from(input.labels ?? [], label => label.textContent ?? '')];
    for (const element of scope.querySelectorAll('h1,h2,h3,h4,h5,h6,legend,button')) {
        hints.push(element.textContent ?? '', context(element));
    }
    const text = hints.join(' ');
    return loginContext.test(text) && !otherContext.test(text);
}

/** A UI anchor whose existing fill targets describe a login, without reading field values. */
export function isLoginField(value: unknown): value is HTMLInputElement {
    if (!eligible(value) || !visible(value)) return false;
    if (value.type === 'password') return true;
    const scope = value.form ?? value.closest('section,dialog,[role="form"],[role="dialog"]') ?? value.parentElement;
    const hints = [context(value), ...Array.from(value.labels ?? [], label => label.textContent ?? '')].join(' ');
    if (otherContext.test(hints) || scope && scope !== document.body && scope !== document.documentElement && otherContext.test(context(scope))) return false;
    try {
        const target = targets(value);
        if (target.user !== value) return false;
        if (target.password) {
            // Do not anchor unrelated text fields that happen to precede a password.
            return eligible(target.password) && visible(target.password) && targets(target.password).user === value;
        }
        return username.test(value.autocomplete) || value.type === 'email' && emailLogin(value);
    } catch {
        return false;
    }
}

/** Keep the focused login, the previous valid anchor, or the first visible login selected. */
export function watchLoginFields(onChange: (field: HTMLInputElement | undefined) => void): () => void {
    let selected: HTMLInputElement | undefined;
    let geometry = '';
    let initialized = false;
    let stopped = false;
    let frame: number | undefined;
    const refresh = () => {
        frame = undefined;
        if (stopped) return;
        const focused = document.activeElement;
        const next = isLoginField(focused) ? focused : isLoginField(selected) ? selected :
            Array.from(document.querySelectorAll('input')).find(isLoginField);
        const rect = next?.getBoundingClientRect();
        const viewport = window.visualViewport;
        const position = rect ? [rect.left, rect.top, rect.width, rect.height, innerWidth, innerHeight,
            viewport?.offsetLeft, viewport?.offsetTop, viewport?.width, viewport?.height].join(',') : '';
        // Stable notifications prevent UI host style writes from feeding back into the observer.
        if (!initialized || next !== selected || position !== geometry) {
            initialized = true; selected = next; geometry = position;
            onChange(next);
        }
    };
    const schedule = () => { if (!stopped && frame === undefined) frame = requestAnimationFrame(refresh); };
    const observer = new MutationObserver(schedule);
    // All attributes matter: sites often toggle visibility with custom data attributes.
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    const documentEvents = ['focusin', 'focusout', 'transitionend', 'animationend', 'load'];
    const windowEvents = ['resize', 'scroll', 'pageshow', 'popstate', 'hashchange'];
    for (const event of documentEvents) document.addEventListener(event, schedule, true);
    for (const event of windowEvents) window.addEventListener(event, schedule, true);
    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    const stop = () => {
        if (stopped) return;
        stopped = true;
        observer.disconnect();
        if (frame !== undefined) cancelAnimationFrame(frame);
        frame = undefined;
        for (const event of documentEvents) document.removeEventListener(event, schedule, true);
        for (const event of windowEvents) window.removeEventListener(event, schedule, true);
        viewport?.removeEventListener('resize', schedule);
        viewport?.removeEventListener('scroll', schedule);
        selected = undefined;
    };
    try { refresh(); } catch (error) { stop(); throw error; }
    return stop;
}
