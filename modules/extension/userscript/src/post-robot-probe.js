// Included by build-post-robot-probe.mjs inside the bundled userscript closure.
function installKeeWebXPostRobotProbe(robot) {
    'use strict';
    const APP_ORIGIN = 'https://keewebx.app';
    const app = location.origin === APP_ORIGIN && /^\/app\/?$/.test(location.pathname);
    if (window.top !== window || (location.origin === APP_ORIGIN && !app)) return;

    const HELLO = 'kwx-postrobot-probe-hello-v1';
    const PING = 'kwx-postrobot-probe-ping-v1';
    const TIMEOUT = 5000;
    const boot = crypto.randomUUID();
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const id = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
    const errorText = error => error instanceof Error ? error.message : String(error);
    let child;
    let session;
    let lastAppBoot;
    let testing = false;
    let disposed = false;
    const listeners = [];

    const host = document.createElement('div');
    host.id = 'keewebx-postrobot-probe';
    host.style.cssText = 'position:fixed;right:10px;bottom:calc(10px + env(safe-area-inset-bottom, 0px));z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = ':host{all:initial;font:14px system-ui;color:#172033}button,input{box-sizing:border-box;font:inherit;min-height:42px;border:1px solid #aebbd0;border-radius:9px;padding:8px 10px;background:#f3f7ff;color:#172033}button{cursor:pointer}button:disabled{opacity:.6}section{box-sizing:border-box;width:min(340px,calc(100vw - 20px));padding:12px;background:#fff;border:1px solid #aebbd0;border-radius:12px;box-shadow:0 4px 20px #0003;margin-bottom:8px}section[hidden]{display:none}h2{font-size:15px;margin:0 0 8px}p,label,pre{font-size:13px;line-height:1.4;overflow-wrap:anywhere}label{display:block}input{display:block;width:100%;background:#fff;margin:4px 0 10px}footer{display:flex;flex-wrap:wrap;gap:8px}pre{white-space:pre-wrap;max-height:130px;overflow:auto;background:#f5f7fa;padding:8px;border-radius:6px}';
    shadow.append(style);
    const panel = document.createElement('section');
    panel.hidden = true;
    const title = document.createElement('h2');
    title.textContent = 'Post-robot 通信测试';
    const help = document.createElement('p');
    help.textContent = app
        ? '从这个原标签页打开一个关联网站。测试只传随机消息，不读取数据库或密码。'
        : '点击测试会直接向原 KeeWebX 窗口发消息，不会主动切换标签页。';
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.textContent = app ? '等待建立关联。' : '请从 KeeWebX 测试面板打开这个网站。';
    const label = document.createElement('label');
    label.textContent = '测试网站（HTTPS）';
    const target = document.createElement('input');
    target.type = 'url';
    target.value = 'https://example.com/';
    target.autocomplete = 'off';
    target.spellcheck = false;
    label.append(target);
    const action = document.createElement('button');
    action.type = 'button';
    action.textContent = app ? '关联并打开网站' : '测试后台回包';
    const revoke = document.createElement('button');
    revoke.type = 'button';
    revoke.textContent = '撤销关联';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '关闭';
    const footer = document.createElement('footer');
    footer.append(action);
    if (app) footer.append(revoke);
    footer.append(close);
    const history = document.createElement('pre');
    history.setAttribute('aria-label', '测试记录');
    history.textContent = 'post-robot 11.0.1 · 不使用 GM 存储轮询';
    panel.append(title, help);
    if (app) panel.append(label);
    panel.append(status, footer, history);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.textContent = 'Post-robot 测试';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.onclick = () => {
        panel.hidden = !panel.hidden;
        toggle.setAttribute('aria-expanded', String(!panel.hidden));
    };
    close.onclick = () => {
        panel.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');
        toggle.focus();
    };
    shadow.append(panel, toggle);
    document.body.append(host);

    function record(text) {
        history.textContent = `${new Date().toLocaleTimeString()} ${text}\n${history.textContent}`.split('\n').slice(0, 8).join('\n');
    }

    function validate(event) {
        if (disposed || !child || event.source !== child || !/^https:\/\/[^/]+$/.test(event.origin)) {
            throw new Error('来源窗口未关联，请重新从 KeeWebX 建立关联。');
        }
        const data = event.data;
        if (!object(data) || !id(data.clientBoot) || !id(data.nonce) ||
            !Number.isFinite(data.sentAt) || !Number.isFinite(data.deadline) ||
            data.sentAt > Date.now() + 1000 || data.deadline <= Date.now() ||
            data.deadline - data.sentAt !== TIMEOUT) {
            throw new Error('请求已过期或格式无效。');
        }
        return data;
    }

    function snapshot(event, data) {
        return {
            appBoot: boot, clientBoot: data.clientBoot, nonce: data.nonce,
            sentAt: data.sentAt, deadline: data.deadline, repliedAt: Date.now(),
            requestOrigin: event.origin, visibility: document.visibilityState,
            focused: document.hasFocus()
        };
    }

    if (app) {
        // The window reference is the boundary for this harmless diagnostic.
        // This is NOT authorization for vault or credential access.
        listeners.push(robot.on(HELLO, { domain: /^https:\/\/[^/]+$/ }, event => {
            const data = validate(event);
            session = { clientBoot: data.clientBoot, origin: event.origin, token: crypto.randomUUID() };
            status.textContent = `已关联 ${event.origin}；本页标记 ${boot.slice(0, 8)}。`;
            return { ...snapshot(event, data), token: session.token };
        }));
        listeners.push(robot.on(PING, { domain: /^https:\/\/[^/]+$/ }, event => {
            const data = validate(event);
            if (!session || data.clientBoot !== session.clientBoot || event.origin !== session.origin ||
                data.token !== session.token || data.appBoot !== boot) {
                throw new Error('关联已失效，请重新连接。');
            }
            const reply = snapshot(event, data);
            record(`已回包，页面 ${reply.visibility}；来源 ${event.origin}`);
            return reply;
        }));
        action.onclick = () => {
            try {
                const url = new URL(target.value);
                if (url.protocol !== 'https:' || url.username || url.password || url.origin === APP_ORIGIN) {
                    throw new Error('请选择另一个 HTTPS 网站，例如 https://example.com/');
                }
                // Keep this synchronous inside the user's tap for Safari popup rules.
                const opened = window.open(url.href, `kwx-postrobot-${crypto.randomUUID()}`);
                if (!opened) throw new Error('Safari 阻止了新标签页，请允许弹出窗口后重试。');
                child = opened;
                session = undefined;
                status.textContent = '关联网站已打开。请在网站页点击“Post-robot 测试”。';
                record(`建立关联：${url.origin}`);
            } catch (error) { status.textContent = errorText(error); }
        };
        revoke.onclick = () => {
            child = undefined;
            session = undefined;
            status.textContent = '已撤销关联；浏览标签页保持打开。';
            record('关联已撤销');
        };
    } else {
        revoke.remove();
        const original = window.opener;

        function verify(reply, request, origin, expectedAppBoot) {
            if (disposed || location.origin !== origin || Date.now() >= request.deadline ||
                !object(reply) || reply.clientBoot !== boot || reply.nonce !== request.nonce ||
                reply.sentAt !== request.sentAt || reply.deadline !== request.deadline ||
                !id(reply.appBoot) || (expectedAppBoot && reply.appBoot !== expectedAppBoot) ||
                reply.requestOrigin !== origin || !Number.isFinite(reply.repliedAt) ||
                reply.repliedAt < request.sentAt || reply.repliedAt >= request.deadline ||
                !['visible', 'hidden'].includes(reply.visibility) || typeof reply.focused !== 'boolean') {
                throw new Error('收到过期、来源不匹配或页面状态已改变的回复。');
            }
            return reply;
        }

        function request() {
            const sentAt = Date.now();
            return { clientBoot: boot, nonce: crypto.randomUUID(), sentAt, deadline: sentAt + TIMEOUT };
        }

        action.onclick = async () => {
            if (testing) return;
            testing = true;
            action.disabled = true;
            let phase = '握手';
            let phaseStarted = performance.now();
            try {
                if (!original || original.closed) {
                    throw new Error('没有可用的来源窗口。请从 KeeWebX 的“关联并打开网站”按钮进入；独立标签页不能直接连接。');
                }
                const origin = location.origin;
                status.textContent = '正在与原 KeeWebX 标签页握手…';
                const helloRequest = request();
                const helloEvent = await robot.send(original, HELLO, helloRequest, { domain: APP_ORIGIN, timeout: TIMEOUT });
                const hello = verify(helloEvent.data, helloRequest, origin);
                if (!id(hello.token)) throw new Error('握手回复缺少关联标记。');
                if (lastAppBoot && lastAppBoot !== hello.appBoot) throw new Error('原 KeeWebX 页面已重新加载，不能沿用先前页面状态。');
                phase = '回包';
                phaseStarted = performance.now();
                status.textContent = '正在测试后台回包…';
                const pingRequest = { ...request(), appBoot: hello.appBoot, token: hello.token };
                const started = performance.now();
                const event = await robot.send(original, PING, pingRequest, { domain: APP_ORIGIN, timeout: TIMEOUT });
                const reply = verify(event.data, pingRequest, origin, hello.appBoot);
                const elapsed = Math.round(performance.now() - started);
                lastAppBoot = reply.appBoot;
                status.textContent = `成功：${elapsed} ms；KeeWebX 回包时 ${reply.visibility}${reply.focused ? '，有焦点' : '，无焦点'}；页面标记 ${reply.appBoot.slice(0, 8)}。`;
                record(`成功 ${elapsed} ms · ${reply.visibility} · 页面 ${reply.appBoot.slice(0, 8)}`);
            } catch (error) {
                const detail = errorText(error);
                const timeout = /timeout|timed out|no ack|no response/i.test(detail);
                status.textContent = timeout
                    ? `${phase}超时：已等待约 ${Math.round(performance.now() - phaseStarted)} ms（上限 ${TIMEOUT} ms）；测试未主动切换标签页。`
                    : `测试失败：${detail}`;
                record(status.textContent);
            } finally {
                testing = false;
                action.disabled = false;
            }
        };
    }

    // A real page reload intentionally loses the app-side association. A BFCache
    // restore invalidates the old test and requires a fresh association too.
    addEventListener('pagehide', () => {
        disposed = true;
        child = undefined;
        session = undefined;
        for (const listener of listeners) listener.cancel();
    });
    addEventListener('pageshow', event => {
        if (event.persisted) {
            status.textContent = '页面从缓存恢复；请重新加载测试页并建立关联。';
            action.disabled = true;
        }
    });
}
