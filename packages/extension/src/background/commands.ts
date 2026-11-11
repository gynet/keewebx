import { backend } from './backend';
import { ContentScriptMessage, ContentScriptReturn } from 'common/content-script-interface';
import { BackendConnectionState } from 'common/backend-connection-state';
import { activateTab } from './utils';
import { isFullMode, vaultRequest } from './vault-host';

interface CommandArgs {
    command: string;
    tab: chrome.tabs.Tab;
    url?: string;
    frameId?: number;
    /** A login picked in the popup; filled without submitting the form. */
    entryId?: string;
}

interface FillValues {
    text?: string;
    password?: string;
}

interface Frame {
    id: number;
    url: string;
}

function startCommandListener(): void {
    chrome.commands.onCommand.addListener(async (command, tab) => {
        // Async listeners: any rejection from runCommand is otherwise
        // silently swallowed by the browser. We wrap in try/catch so
        // errors surface to the extension background console instead
        // of the user seeing nothing. 2026-04-09: this try/
        // catch was the only reason we eventually caught the
        // encryptResponse nonce increment bug — without it the
        // "Bad nonce in response" error vanished into the void.
        try {
            if (!tab) {
                [tab] = await new Promise<chrome.tabs.Tab[]>((resolve) =>
                    chrome.tabs.query({ active: true }, resolve)
                );
            }
            const frameId = await getActiveFrame(tab);
            await runCommand({ command, tab, frameId, url: tab.url });
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error('[KeeWebX Connect] runCommand failed for', command, e);
        }
    });
}

async function runCommand(args: CommandArgs): Promise<void> {
    if (args.command.includes('auto')) {
        const nextCommand = await getNextAutoFillCommand(args);
        if (nextCommand) {
            if (args.entryId) {
                nextCommand.command = nextCommand.command.replace('submit', 'insert');
                nextCommand.entryId = args.entryId;
            }
            await runCommand(nextCommand);
        }
        return;
    }

    if (!args.url || !isValidUrl(args.url)) {
        return;
    }
    if (typeof args.frameId !== 'number') {
        return;
    }

    const options = {
        username: args.command.includes('username'),
        password: args.command.includes('password'),
        submit: args.command.includes('submit'),
        otp: args.command.includes('otp'),
        other: args.command.includes('other')
    };

    let text: string | undefined;
    let password: string | undefined;

    if (await isFullMode()) {
        let values: FillValues | undefined;
        try {
            values = await getValuesFromVault(args, options);
        } finally {
            if (args.tab.id) {
                await activateTab(args.tab.id);
            }
        }
        if (!values) {
            return;
        }
        await autoFill(args.url, args.tab, args.frameId, { ...values, submit: options.submit });
        return;
    }

    await backend.connect();
    if (backend.state !== BackendConnectionState.Connected) {
        void chrome.runtime.openOptionsPage();
        return;
    }

    try {
        if (options.username || options.password) {
            const [entry] = await backend.getLogins(args.url);

            if (!entry) {
                return;
            }

            const user = entry.login;
            const pass = entry.password;

            text = options.username ? user : options.password ? pass : undefined;
            password = options.username ? (options.password ? pass : undefined) : undefined;
        } else if (options.otp) {
            text = await backend.getTotp(args.url, args.tab.title || '');
        } else {
            text = await backend.getAnyField(args.url, args.tab.title || '');
        }
    } finally {
        if (args.tab.id) {
            await activateTab(args.tab.id);
        }
    }

    await autoFill(args.url, args.tab, args.frameId, {
        text,
        password,
        submit: options.submit
    });
}

/**
 * Full mode: fills the one login that matches the page. With none, several,
 * or a locked vault, the popup opens so the user can unlock or choose.
 */
async function getValuesFromVault(
    args: CommandArgs,
    options: { username: boolean; password: boolean; otp: boolean; other: boolean }
): Promise<FillValues | undefined> {
    let entryId = args.entryId;
    if (!entryId) {
        const status = await vaultRequest<{ open: boolean }>('status');
        const suggested = status.open
            ? (await vaultRequest<{ suggested: { id: string }[] }>('list', { url: args.url })).suggested
            : [];
        if (suggested.length !== 1 || options.other) {
            await chrome.action.openPopup().catch(() => {});
            return undefined;
        }
        entryId = suggested[0].id;
    }
    if (options.username || options.password) {
        const login = await vaultRequest<{ user: string; password: string }>('credentials', { id: entryId });
        return {
            text: options.username ? login.user : login.password,
            password: options.username && options.password ? login.password : undefined
        };
    }
    if (options.otp) {
        return { text: (await vaultRequest<{ text: string }>('field', { id: entryId, field: 'otp' })).text };
    }
    return undefined;
}

function isValidUrl(url: string): boolean {
    return /^https?:/i.test(url) && !url.startsWith(backend.keeWebUrl);
}

async function getActiveFrame(tab: chrome.tabs.Tab): Promise<number> {
    return new Promise((resolve) => {
        chrome.scripting.executeScript(
            {
                target: {
                    frameIds: [0],
                    tabId: tab.id || 0
                },
                func: () => {
                    Array.from(document.querySelectorAll('iframe')).indexOf(
                        document.activeElement as HTMLIFrameElement
                    );
                }
            },
            (result: chrome.scripting.InjectionResult<void>[]) => {
                if (chrome.runtime.lastError) {
                    return resolve(0);
                }
                resolve(Number(result[0]) + 1); // indexOf returns -1, then it's root document which is frameId:0
            }
        );
    });
}

async function getNextAutoFillCommand(args: CommandArgs): Promise<CommandArgs | undefined> {
    const frameCount = await injectPageContentScript(args.tab);
    let allFrames: Frame[];
    if (frameCount > 1) {
        allFrames = await getAllFrames(args.tab);
    } else if (args.tab.url) {
        allFrames = [{ id: 0, url: args.tab.url }];
    } else {
        allFrames = [];
    }
    for (const frame of allFrames) {
        if (!isValidUrl(frame.url)) {
            continue;
        }
        const resp = await sendMessageToTab(args.tab, frame.id, {
            action: 'get-next-auto-fill-command',
            url: frame.url
        });
        if (resp?.nextCommand) {
            args.command = resp.nextCommand;
            args.frameId = frame.id;
            args.url = frame.url;
            return {
                command: resp.nextCommand,
                tab: args.tab,
                frameId: frame.id,
                url: frame.url
            };
        }
    }
}

async function getAllFrames(tab: chrome.tabs.Tab): Promise<Frame[]> {
    return new Promise((resolve, reject) => {
        chrome.webNavigation.getAllFrames({ tabId: tab.id || 0 }, (frames) => {
            if (chrome.runtime.lastError || !frames) {
                const err = chrome.runtime.lastError?.message || 'empty frames';
                const msg = `Cannot get tab frames: ${err}`;
                return reject(new Error(msg));
            }
            resolve(frames.map((f) => ({ id: f.frameId, url: f.url })));
        });
    });
}

async function autoFill(
    url: string,
    tab: chrome.tabs.Tab,
    frameId: number,
    options: { text?: string; password?: string; submit: boolean }
): Promise<ContentScriptReturn | undefined> {
    return await sendMessageToTab(tab, frameId, {
        action: 'auto-fill',
        url,
        ...options
    });
}

async function sendMessageToTab(
    tab: chrome.tabs.Tab,
    frameId: number,
    message: ContentScriptMessage
): Promise<ContentScriptReturn | undefined> {
    await injectPageContentScript(tab);
    return new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id || 0, message, { frameId }, (resp) => {
            if (chrome.runtime.lastError) {
                return resolve(undefined);
            }
            resolve(resp); // eslint-disable-line @typescript-eslint/no-unsafe-argument
        });
    });
}

function injectPageContentScript(tab: chrome.tabs.Tab): Promise<number> {
    return new Promise((resolve) => {
        chrome.scripting.executeScript(
            { files: ['js/content-page.js'], target: { allFrames: true, tabId: tab.id || 0 } },
            (results) => {
                if (chrome.runtime.lastError) {
                    return resolve(0);
                }
                resolve(results.length);
            }
        );
    });
}

export { startCommandListener, runCommand };
