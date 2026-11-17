/** Styles are scoped to the component root for both normal DOM and Shadow DOM hosts. */
export const connectStyles = `
.kwx-connect {
    all: initial;
    display: block;
    position: relative;
    direction: ltr;
    text-align: start;
    -webkit-text-size-adjust: 100%;
    text-size-adjust: 100%;
    color-scheme: light dark;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: var(--kwx-connect-ink);
    --kwx-connect-bg: #fff;
    --kwx-connect-ink: #192337;
    --kwx-connect-muted: #63718a;
    --kwx-connect-line: #dee5ef;
    --kwx-connect-soft: #f3f6fb;
    --kwx-connect-accent: #1769e0;
    --kwx-connect-on-accent: #fff;
    --kwx-connect-danger: #b83038;
    --kwx-connect-shadow: 0 12px 44px #142b4b30;
}
.kwx-connect :where(div, section, header, footer, h2, h3, p, ul, li, details, summary, span, strong, label, button, input) {
    all: revert;
    color: inherit;
    font: inherit;
}
.kwx-connect, .kwx-connect * { box-sizing: border-box; }
.kwx-connect [hidden] { display: none !important; }
.kwx-connect .kwx-connect__panel {
    position: absolute;
    right: 0;
    bottom: 56px;
    width: min(348px, calc(100vw - 24px));
    max-height: calc(100vh - 92px);
    max-height: calc(100dvh - 92px);
    overflow: auto;
    overscroll-behavior: contain;
    background: var(--kwx-connect-bg);
    border: 1px solid var(--kwx-connect-line);
    border-radius: 18px;
    padding: 16px;
    box-shadow: var(--kwx-connect-shadow);
}
.kwx-connect .kwx-connect__button {
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-width: 44px;
    min-height: 44px;
    margin: 0;
    border: 1px solid var(--kwx-connect-line);
    border-radius: 10px;
    padding: 9px 12px;
    background: var(--kwx-connect-soft);
    color: var(--kwx-connect-ink);
    font: inherit;
    font-weight: 550;
    line-height: 1.4;
    text-align: center;
    cursor: pointer;
    touch-action: manipulation;
    overflow-wrap: anywhere;
}
.kwx-connect .kwx-connect__button:disabled { opacity: .5; cursor: default; }
.kwx-connect .kwx-connect__button--primary { background: var(--kwx-connect-accent); border-color: var(--kwx-connect-accent); color: var(--kwx-connect-on-accent); }
.kwx-connect .kwx-connect__button--danger { color: var(--kwx-connect-danger); }
.kwx-connect .kwx-connect__button:focus-visible,
.kwx-connect .kwx-connect__input:focus-visible,
.kwx-connect .kwx-connect__checkbox:focus-visible { outline: 2px solid var(--kwx-connect-accent); outline-offset: 2px; }
.kwx-connect .kwx-connect__header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.kwx-connect .kwx-connect__title { display: flex; align-items: center; gap: 9px; margin: 0; font-size: 17px; font-weight: 650; line-height: 1.4; }
.kwx-connect .kwx-connect__key { display: block; width: 23px; height: 23px; flex: 0 0 auto; }
.kwx-connect .kwx-connect__title .kwx-connect__key { width: 20px; height: 20px; color: var(--kwx-connect-accent); }
.kwx-connect .kwx-connect__close { flex: 0 0 44px; width: 44px; padding: 0; border: 0; background: transparent; font-size: 25px; }
.kwx-connect .kwx-connect__tabs { display: flex; gap: 4px; margin: 12px 0; padding: 3px; border-radius: 12px; background: var(--kwx-connect-soft); }
.kwx-connect .kwx-connect__tab { flex: 1; border: 0; background: transparent; color: var(--kwx-connect-muted); }
.kwx-connect .kwx-connect__tab[aria-selected="true"] { background: var(--kwx-connect-bg); color: var(--kwx-connect-ink); box-shadow: 0 1px 4px #15274416; }
.kwx-connect .kwx-connect__status { display: flex; align-items: baseline; gap: 8px; margin: 12px 0; color: var(--kwx-connect-muted); font-size: 13px; overflow-wrap: anywhere; }
.kwx-connect .kwx-connect__indicator { flex: 0 0 7px; width: 7px; height: 7px; border-radius: 50%; background: #98a3b4; }
.kwx-connect .kwx-connect__indicator[data-state="Connected"] { background: #20a36b; }
.kwx-connect .kwx-connect__indicator[data-state="Connecting"] { background: #d49416; }
.kwx-connect .kwx-connect__indicator[data-state="Error"] { background: #d24d4d; }
.kwx-connect .kwx-connect__actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
.kwx-connect .kwx-connect__actions > .kwx-connect__button { flex: 1 1 120px; }
.kwx-connect .kwx-connect__actions > .kwx-connect__button--primary { flex-basis: 100%; }
.kwx-connect .kwx-connect__label { display: block; margin: 14px 0 7px; color: var(--kwx-connect-muted); font-size: 12px; }
.kwx-connect .kwx-connect__input { appearance: none; display: block; width: 100%; min-width: 0; min-height: 44px; margin: 0; border: 1px solid var(--kwx-connect-line); border-radius: 10px; padding: 9px 10px; background: var(--kwx-connect-soft); color: var(--kwx-connect-ink); font: inherit; font-size: 16px; }
.kwx-connect .kwx-connect__input[readonly] { color: var(--kwx-connect-muted); }
.kwx-connect .kwx-connect__note { margin: 10px 0; color: var(--kwx-connect-muted); font-size: 12px; line-height: 1.55; overflow-wrap: anywhere; }
.kwx-connect .kwx-connect__entry { display: block; width: 100%; margin-top: 8px; padding: 11px 12px; min-height: 60px; background: var(--kwx-connect-bg); text-align: start; }
.kwx-connect .kwx-connect__entry-title, .kwx-connect .kwx-connect__entry-username { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kwx-connect .kwx-connect__entry-title { font-weight: 600; }
.kwx-connect .kwx-connect__entry-username { margin-top: 3px; color: var(--kwx-connect-muted); font-size: 12px; font-weight: 400; }
.kwx-connect .kwx-connect__empty { margin: 0; padding: 12px 0; color: var(--kwx-connect-muted); font-size: 13px; overflow-wrap: anywhere; }
.kwx-connect .kwx-connect__pairing { margin: 12px 0; padding: 12px; border: 1px solid var(--kwx-connect-accent); border-radius: 12px; background: var(--kwx-connect-soft); }
.kwx-connect .kwx-connect__pairing-title { margin: 0; font-size: 14px; font-weight: 650; }
.kwx-connect .kwx-connect__pairing-origin { margin: 8px 0; font-weight: 600; overflow-wrap: anywhere; unicode-bidi: isolate; }
.kwx-connect .kwx-connect__preference { margin: 16px 0; padding-top: 8px; border-top: 1px solid var(--kwx-connect-line); }
.kwx-connect .kwx-connect__check-label { display: flex; align-items: center; gap: 10px; min-height: 44px; font-size: 13px; cursor: pointer; }
.kwx-connect .kwx-connect__check-label:has(.kwx-connect__checkbox:disabled) { opacity: .6; cursor: default; }
.kwx-connect .kwx-connect__checkbox { flex: 0 0 18px; width: 18px; height: 18px; margin: 0; accent-color: var(--kwx-connect-accent); }
.kwx-connect .kwx-connect__checkbox:disabled { cursor: default; }
.kwx-connect .kwx-connect__preference-hint { margin: 4px 0 0 28px; }
.kwx-connect .kwx-connect__local-log { margin-top: 14px; padding-top: 8px; border-top: 1px solid var(--kwx-connect-line); }
.kwx-connect .kwx-connect__local-log summary { cursor: pointer; padding: 10px 0; }
.kwx-connect .kwx-connect__log-text { width: 100%; margin-top: 8px; padding: 8px; color: var(--kwx-connect-ink); background: var(--kwx-connect-soft); border: 1px solid var(--kwx-connect-line); border-radius: 8px; font: 16px monospace; }
.kwx-connect .kwx-connect__error { margin: 8px 0; color: var(--kwx-connect-danger); font-size: 12px; overflow-wrap: anywhere; }
.kwx-connect .kwx-connect__version { margin-top: 12px; color: var(--kwx-connect-muted); font-size: 11px; text-align: end; overflow-wrap: anywhere; }
.kwx-connect .kwx-connect__toggle { width: 44px; height: 44px; padding: 10px; border: 0; border-radius: 14px; background: var(--kwx-connect-accent); color: var(--kwx-connect-on-accent); box-shadow: 0 4px 14px #1769e033; }
.kwx-connect[data-mode="app"] .kwx-connect__toggle[data-draggable] { touch-action: none; user-select: none; -webkit-user-select: none; cursor: grab; }
.kwx-connect[data-mode="app"] .kwx-connect__toggle[data-dragging] { cursor: grabbing; }
.kwx-connect .kwx-connect__move-hint { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.kwx-connect[data-mode="relay"] .kwx-connect__panel { position: fixed; left: 50%; top: 50%; right: auto; bottom: auto; transform: translate(-50%, -50%); max-height: calc(100vh - 24px); max-height: calc(100dvh - 24px); }
@media (hover: hover) {
    .kwx-connect .kwx-connect__button:hover:not(:disabled) { filter: brightness(.97); }
}
@media (prefers-color-scheme: dark) {
    .kwx-connect { --kwx-connect-bg: #1e232c; --kwx-connect-ink: #f0f4fb; --kwx-connect-muted: #a4b1c5; --kwx-connect-line: #394250; --kwx-connect-soft: #292f3a; --kwx-connect-accent: #438df2; --kwx-connect-on-accent: #0c192c; --kwx-connect-danger: #ff9298; --kwx-connect-shadow: 0 12px 44px #0007; }
}
@media (max-width: 480px) {
    .kwx-connect .kwx-connect__input { font-size: 16px; }
}
`;
