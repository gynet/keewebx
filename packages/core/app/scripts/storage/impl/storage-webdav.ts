import * as kdbxweb from 'kdbxweb';
import { StorageBase } from 'storage/storage-base';
import { Locale } from 'util/locale';
import {
    AESGCM_PREFIX,
    encryptWebDavPassword,
    decryptWebDavPassword
} from 'comp/crypto/webdav-cred-crypto';

interface WebDavStat {
    rev: string;
    path?: string;
}

interface WebDavError {
    notFound?: boolean;
    revConflict?: boolean;
    cors?: boolean;
    serverUrl?: string;
    toString(): string;
}

interface WebDavRequestConfig {
    op: string;
    method: string;
    path: string;
    user?: string | null;
    password?: string | null;
    data?: ArrayBuffer;
    nostat?: boolean;
    rev?: string;
    headers?: Record<string, string>;
}

type WebDavCallback = (
    err: WebDavError | string | null,
    xhr?: XMLHttpRequest,
    stat?: WebDavStat | null
) => void;

interface FileOpts {
    user?: string;
    password?: string;
    encpass?: string;
}

class StorageWebDav extends StorageBase {
    name = 'webdav';
    icon = 'server';
    enabled = true;
    uipos = 10;

    needShowOpenConfig(): boolean {
        return true;
    }

    getOpenConfig(): { fields: Array<Record<string, unknown>> } {
        return {
            fields: [
                {
                    id: 'path',
                    title: 'openUrl',
                    desc: 'openUrlDesc',
                    type: 'text',
                    required: true,
                    pattern: '^https://.+'
                },
                {
                    id: 'user',
                    title: 'openUser',
                    desc: 'openUserDesc',
                    placeholder: 'openUserPlaceholder',
                    type: 'text'
                },
                {
                    id: 'password',
                    title: 'openPass',
                    desc: 'openPassDesc',
                    placeholder: 'openPassPlaceholder',
                    type: 'password'
                }
            ]
        };
    }

    getSettingsConfig(): { fields: Array<Record<string, unknown>> } {
        return {
            fields: [
                {
                    id: 'webdavSaveMethod',
                    title: 'webdavSaveMethod',
                    type: 'select',
                    value:
                        (this.appSettings as unknown as Record<string, unknown>)
                            .webdavSaveMethod || 'default',
                    options: { default: 'webdavSaveMove', put: 'webdavSavePut' }
                },
                {
                    id: 'webdavStatReload',
                    title: 'webdavStatReload',
                    type: 'checkbox',
                    value: !!(this.appSettings as unknown as Record<string, unknown>)
                        .webdavStatReload
                }
            ]
        };
    }

    applySetting(key: string, value: unknown): void {
        (this.appSettings as unknown as Record<string, unknown>)[key] = value;
    }

    load(
        path: string,
        opts: FileOpts | null,
        callback: ((err: WebDavError | string | null, data?: ArrayBuffer, stat?: WebDavStat | null) => void) | null
    ): void {
        this._request(
            {
                op: 'Load',
                method: 'GET',
                path,
                user: opts ? opts.user : null,
                password: opts ? opts.password : null,
                nostat: !!(this.appSettings as unknown as Record<string, boolean>)
                    .webdavStatReload
            },
            callback
                ? (err, xhr, stat) => {
                      if (
                          (this.appSettings as unknown as Record<string, boolean>)
                              .webdavStatReload
                      ) {
                          this._calcStatByContent(xhr!).then((stat) =>
                              callback(err, xhr!.response as ArrayBuffer, stat)
                          );
                      } else {
                          callback(err, xhr!.response as ArrayBuffer, stat);
                      }
                  }
                : null
        );
    }

    stat(
        path: string,
        opts: FileOpts | null,
        callback: ((err: WebDavError | string | null, stat?: WebDavStat | null) => void) | null
    ): void {
        this._statRequest(
            path,
            opts,
            'Stat',
            callback
                ? (err, _xhr, stat) => callback(err, stat)
                : null
        );
    }

    _statRequest(
        path: string,
        opts: FileOpts | null,
        op: string,
        callback: WebDavCallback | null
    ): void {
        if (
            (this.appSettings as unknown as Record<string, boolean>).webdavStatReload
        ) {
            this._request(
                {
                    op,
                    method: 'GET',
                    path,
                    user: opts ? opts.user : null,
                    password: opts ? opts.password : null,
                    nostat: true
                },
                callback
                    ? (err, xhr) => {
                          this._calcStatByContent(xhr!).then((stat) =>
                              callback(err, xhr, stat)
                          );
                      }
                    : null
            );
        } else {
            this._request(
                {
                    op,
                    method: 'HEAD',
                    path,
                    user: opts ? opts.user : null,
                    password: opts ? opts.password : null
                },
                callback
                    ? (err, xhr, stat) => {
                          callback(err, xhr, stat);
                      }
                    : null
            );
        }
    }

    save(
        path: string,
        opts: FileOpts | null,
        data: ArrayBuffer,
        callback: ((err: WebDavError | string | null, stat?: WebDavStat | null) => void) | null,
        rev?: string
    ): void {
        let cb: ((err: WebDavError | string | null, xhr?: XMLHttpRequest, stat?: WebDavStat | null) => void) | null =
            function (err, _xhr, stat) {
                if (callback) {
                    callback(err, stat);
                    callback = null;
                }
            };
        const tmpPath =
            path.replace(/[^/]+$/, (m) => '.' + m) + '.' + Date.now();
        const saveOpts: WebDavRequestConfig = {
            op: '',
            method: '',
            path,
            user: opts ? opts.user : null,
            password: opts ? opts.password : null
        };
        this._statRequest(path, opts, 'Save:stat', (err, xhr, stat) => {
            let useTmpPath =
                (this.appSettings as unknown as Record<string, string>)
                    .webdavSaveMethod !== 'put';
            if (err) {
                if (!(err as WebDavError).notFound) {
                    return cb!(err, xhr);
                } else {
                    this.logger!.debug('Save: not found, creating');
                    useTmpPath = false;
                }
            } else if (stat!.rev !== rev) {
                this.logger!.debug(
                    'Save error',
                    path,
                    'rev conflict',
                    stat!.rev,
                    rev
                );
                return cb!({ revConflict: true, toString: () => 'rev conflict' }, xhr, stat);
            }
            if (useTmpPath) {
                this._request(
                    {
                        ...saveOpts,
                        op: 'Save:put',
                        method: 'PUT',
                        path: tmpPath,
                        data,
                        nostat: true
                    },
                    (err) => {
                        if (err) {
                            return cb!(err);
                        }
                        this._statRequest(
                            path,
                            opts,
                            'Save:stat',
                            (err, xhr, stat) => {
                                if (err) {
                                    this._request({
                                        ...saveOpts,
                                        op: 'Save:delete',
                                        method: 'DELETE',
                                        path: tmpPath
                                    });
                                    return cb!(err, xhr, stat);
                                }
                                if (stat!.rev !== rev) {
                                    this.logger!.debug(
                                        'Save error',
                                        path,
                                        'rev conflict',
                                        stat!.rev,
                                        rev
                                    );
                                    this._request({
                                        ...saveOpts,
                                        op: 'Save:delete',
                                        method: 'DELETE',
                                        path: tmpPath
                                    });
                                    return cb!(
                                        { revConflict: true, toString: () => 'rev conflict' },
                                        xhr,
                                        stat
                                    );
                                }
                                let movePath = path;
                                if (movePath.indexOf('://') < 0) {
                                    if (movePath.indexOf('/') === 0) {
                                        movePath =
                                            location.protocol +
                                            '//' +
                                            location.host +
                                            movePath;
                                    } else {
                                        movePath = location.href
                                            .replace(/\?(.*)/, '')
                                            .replace(/[^/]*$/, movePath);
                                    }
                                }
                                // prevent double encoding, see #1729
                                const encodedMovePath = /%[A-Z0-9]{2}/.test(
                                    movePath
                                )
                                    ? movePath
                                    : encodeURI(movePath);
                                this._request(
                                    {
                                        ...saveOpts,
                                        op: 'Save:move',
                                        method: 'MOVE',
                                        path: tmpPath,
                                        nostat: true,
                                        headers: {
                                            Destination: encodedMovePath,
                                            Overwrite: 'T'
                                        }
                                    },
                                    (err) => {
                                        if (err) {
                                            return cb!(err);
                                        }
                                        this._statRequest(
                                            path,
                                            opts,
                                            'Save:stat',
                                            (err, xhr, stat) => {
                                                cb!(err, xhr, stat);
                                            }
                                        );
                                    }
                                );
                            }
                        );
                    }
                );
            } else {
                this._request(
                    {
                        ...saveOpts,
                        op: 'Save:put',
                        method: 'PUT',
                        data,
                        nostat: true
                    },
                    (err) => {
                        if (err) {
                            return cb!(err);
                        }
                        this._statRequest(
                            path,
                            opts,
                            'Save:stat',
                            (err, xhr, stat) => {
                                cb!(err, xhr, stat);
                            }
                        );
                    }
                );
            }
        });
    }

    async fileOptsToStoreOpts(
        opts: FileOpts,
        file: { uuid: string },
        passwordHash?: Uint8Array
    ): Promise<FileOpts> {
        const result: FileOpts = { user: opts.user, encpass: opts.encpass };
        if (opts.password) {
            if (passwordHash) {
                const encrypted = await encryptWebDavPassword(
                    opts.password,
                    passwordHash,
                    file.uuid
                );
                if (encrypted) {
                    result.encpass = encrypted;
                    return result;
                }
            }
            // Fallback to XOR if no passwordHash or crypto.subtle unavailable
            const encpass = this._xorString(opts.password, file.uuid);
            result.encpass = btoa(encpass);
        }
        return result;
    }

    async storeOptsToFileOpts(
        opts: FileOpts,
        file: { uuid: string },
        passwordHash?: Uint8Array
    ): Promise<FileOpts> {
        const result: FileOpts = { user: opts.user, password: opts.password };
        if (opts.encpass) {
            if (opts.encpass.startsWith(AESGCM_PREFIX)) {
                // New AES-GCM format
                if (passwordHash) {
                    result.password = await decryptWebDavPassword(
                        opts.encpass,
                        passwordHash,
                        file.uuid
                    ) ?? undefined;
                } else {
                    // Cannot decrypt without passwordHash
                    result.password = undefined;
                }
            } else {
                // Legacy XOR format -- decrypt
                const encpass = atob(opts.encpass);
                result.password = this._xorString(encpass, file.uuid);
                // Migrate: re-encrypt with AES-GCM if passwordHash available
                if (passwordHash && result.password) {
                    const encrypted = await encryptWebDavPassword(
                        result.password,
                        passwordHash,
                        file.uuid
                    );
                    if (encrypted) {
                        opts.encpass = encrypted;
                    }
                }
            }
        }
        return result;
    }

    _xorString(str: string, another: string): string {
        let result = '';
        for (let i = 0; i < str.length; i++) {
            const strCharCode = str.charCodeAt(i);
            const anotherIx = i % another.length;
            const anotherCharCode = another.charCodeAt(anotherIx);
            const resultCharCode = strCharCode ^ anotherCharCode;
            result += String.fromCharCode(resultCharCode);
        }
        return result;
    }

    _isCrossOrigin(url: string): boolean {
        try {
            const parsed = new URL(url, window.location.href);
            return parsed.origin !== window.location.origin;
        } catch {
            return false;
        }
    }

    _request(config: WebDavRequestConfig, callback?: WebDavCallback | null): void {
        if (config.rev) {
            this.logger!.debug(config.op, config.path, config.rev);
        } else {
            this.logger!.debug(config.op, config.path);
        }
        const ts = this.logger!.ts();
        const xhr = new XMLHttpRequest();
        xhr.addEventListener('load', () => {
            if ([200, 201, 204].indexOf(xhr.status) < 0) {
                this.logger!.debug(
                    config.op + ' error',
                    config.path,
                    xhr.status,
                    this.logger!.ts(ts)
                );
                let err: WebDavError | string;
                switch (xhr.status) {
                    case 0:
                        // Status 0 with no body on a cross-origin request
                        // means an opaque response — CORS preflight failed.
                        if (this._isCrossOrigin(config.path)) {
                            err = {
                                cors: true,
                                serverUrl: config.path,
                                toString: () => 'CORS error'
                            };
                        } else {
                            err = 'HTTP status 0';
                        }
                        break;
                    case 404:
                        err = { notFound: true, toString: () => 'Not found' };
                        break;
                    case 412:
                        err = { revConflict: true, toString: () => 'Rev conflict' };
                        break;
                    default:
                        err = 'HTTP status ' + xhr.status;
                        break;
                }
                if (callback) {
                    callback(err, xhr);
                    callback = null;
                }
                return;
            }
            const rev = xhr.getResponseHeader('Last-Modified');
            if (!rev && !config.nostat) {
                this.logger!.debug(
                    config.op + ' error',
                    config.path,
                    'no headers',
                    this.logger!.ts(ts)
                );
                if (callback) {
                    callback(
                        (Locale as unknown as Record<string, string>)
                            .webdavNoLastModified,
                        xhr
                    );
                    callback = null;
                }
                return;
            }
            const completedOpName =
                config.op +
                (config.op.charAt(config.op.length - 1) === 'e' ? 'd' : 'ed');
            this.logger!.debug(
                completedOpName,
                config.path,
                rev,
                this.logger!.ts(ts)
            );
            if (callback) {
                callback(null, xhr, rev ? { rev } : null);
                callback = null;
            }
        });
        xhr.addEventListener('error', () => {
            this.logger!.debug(
                config.op + ' error',
                config.path,
                this.logger!.ts(ts)
            );
            if (callback) {
                // XHR error with status 0 on a cross-origin request is the
                // classic CORS-block signal: the browser refuses to expose
                // the response (or the preflight failed entirely).
                if (xhr.status === 0 && this._isCrossOrigin(config.path)) {
                    const corsErr: WebDavError = {
                        cors: true,
                        serverUrl: config.path,
                        toString: () => 'CORS error'
                    };
                    callback(corsErr, xhr);
                } else {
                    callback('network error', xhr);
                }
                callback = null;
            }
        });
        xhr.addEventListener('abort', () => {
            this.logger!.debug(
                config.op + ' error',
                config.path,
                'aborted',
                this.logger!.ts(ts)
            );
            if (callback) {
                callback('aborted', xhr);
                callback = null;
            }
        });
        xhr.open(config.method, config.path);
        xhr.responseType = 'arraybuffer';
        if (config.user) {
            xhr.setRequestHeader(
                'Authorization',
                'Basic ' + btoa(config.user + ':' + (config.password ?? ''))
            );
        }
        if (config.headers) {
            for (const [header, value] of Object.entries(config.headers)) {
                xhr.setRequestHeader(header, value);
            }
        }
        if (['GET', 'HEAD'].indexOf(config.method) >= 0) {
            xhr.setRequestHeader('Cache-Control', 'no-cache');
        }
        if (config.data) {
            const blob = new Blob([config.data], {
                type: 'application/octet-stream'
            });
            xhr.send(blob);
        } else {
            xhr.send();
        }
    }

    _calcStatByContent(
        xhr: XMLHttpRequest
    ): Promise<WebDavStat | null> {
        if (
            xhr.status !== 200 ||
            xhr.responseType !== 'arraybuffer' ||
            !xhr.response ||
            !(xhr.response as ArrayBuffer).byteLength
        ) {
            this.logger!.debug('Cannot calculate rev by content');
            return Promise.resolve(null);
        }
        return kdbxweb.CryptoEngine.sha256(xhr.response as ArrayBuffer).then(
            (hash) => {
                const rev = kdbxweb.ByteUtils.bytesToHex(hash).substr(0, 10);
                this.logger!.debug(
                    'Calculated rev by content',
                    `${(xhr.response as ArrayBuffer).byteLength} bytes`,
                    rev
                );
                return { rev };
            }
        );
    }
}

export { StorageWebDav };
export type { WebDavStat, WebDavError, FileOpts };
