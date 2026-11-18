/** @jsxImportSource preact */
import { useEffect, useRef, useState } from 'preact/hooks';
import { sanitizeData } from '../../../diagnostics/src/schema';
import type { DiagnosticData } from '../../../diagnostics/src/types';
import { watchTransport } from './transport-events';
import { CONNECT_VERSION } from './version';
import { localLogPreference } from './local-log-preference';

const MAX_LINES = 300;

export function LocalConnectLog({ mode, snapshot }: { mode: 'app' | 'website'; snapshot(): DiagnosticData }) {
    const [enabled, setEnabled] = useState(false);
    const [output, setOutput] = useState('');
    const [copied, setCopied] = useState(false);
    const lines = useRef<string[]>([]);
    const textarea = useRef<HTMLTextAreaElement>(null);
    const active = useRef(false);
    const toggled = useRef(false);

    useEffect(() => {
        let mounted = true;
        void localLogPreference.load().then(saved => {
            if (!mounted || toggled.current) return;
            active.current = saved;
            setEnabled(saved);
        });
        return () => { mounted = false; active.current = false; };
    }, []);

    useEffect(() => {
        if (!enabled) return;
        const record = (data: DiagnosticData) => {
            if (!active.current) return;
            const safe = sanitizeData(data);
            if (!Object.keys(safe).length) return;
            lines.current.push(`${new Date().toISOString().slice(11, 23)}Z ${JSON.stringify(safe)}`);
            if (lines.current.length > MAX_LINES) lines.current.shift();
        };
        const visible = () => record({ ...snapshot(), visible: !document.hidden });
        const lifecycle = (event: Event) => {
            const names: Record<string, DiagnosticData['event']> = {
                focus: 'page-focus', blur: 'page-blur', pageshow: 'page-show', pagehide: 'page-hide', pointerdown: 'page-interaction'
            };
            if (!event.isTrusted) return;
            record({ ...snapshot(), event: names[event.type], visible: !document.hidden,
                ...(event instanceof PageTransitionEvent ? { persisted: event.persisted } : {}) });
        };
        visible();
        const stop = watchTransport(record);
        document.addEventListener('visibilitychange', visible);
        const events = ['focus', 'blur', 'pageshow', 'pagehide', 'pointerdown'];
        for (const event of events) window.addEventListener(event, lifecycle, true);
        return () => {
            stop(); document.removeEventListener('visibilitychange', visible);
            for (const event of events) window.removeEventListener(event, lifecycle, true);
        };
    }, [enabled, snapshot]);

    const copy = async (event: MouseEvent) => {
        if (!event.isTrusted || !active.current) return;
        const text = [`KeeWebX Connect ${CONNECT_VERSION} · ${mode} · local log`,
            `Current state ${JSON.stringify(sanitizeData({ ...snapshot(), visible: !document.hidden }))}`,
            ...lines.current].join('\n');
        setOutput(text); setCopied(false);
        try {
            await navigator.clipboard.writeText(text);
            if (active.current) setCopied(true);
        } catch {
            if (active.current) requestAnimationFrame(() => textarea.current?.select());
        }
    };

    return <details class="kwx-connect__local-log">
        <summary>Connection log</summary>
        <label class="kwx-connect__check-label">
            <input class="kwx-connect__checkbox" type="checkbox" checked={enabled} onChange={event => {
                if (!event.isTrusted) return;
                toggled.current = true;
                active.current = event.currentTarget.checked;
                lines.current = []; setOutput(''); setCopied(false); setEnabled(active.current);
                void localLogPreference.save(active.current);
            }} />
            Record local connection events
        </label>
        <p class="kwx-connect__note">Your recording preference is saved for future tabs and reloads. This tab keeps the latest 300 events in memory until you turn logging off or reload. You can copy the log manually.</p>
        {enabled && <button type="button" class="kwx-connect__button" onClick={copy}>Copy connection log</button>}
        {enabled && output && <>
            <p class="kwx-connect__note" aria-live="polite">{copied ? 'Copied.' : 'You can also select and copy the text below.'}</p>
            <textarea class="kwx-connect__log-text" aria-label="Local connection log" readOnly rows={5} ref={textarea} value={output} />
        </>}
    </details>;
}
