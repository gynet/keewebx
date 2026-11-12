import { FunctionComponent, JSX } from 'preact';
import { res } from 'options/utils';
import { model } from 'options/settings-model';
import { useState } from 'preact/hooks';
import { noop } from 'common/utils';
import { validateKeeWebUrl } from './validate-keeweb-url';

declare const __KW_EMBEDDED_VAULT__: boolean | undefined;

const isVaultBuild = typeof __KW_EMBEDDED_VAULT__ !== 'undefined' && !!__KW_EMBEDDED_VAULT__;
const CONNECT_DEFAULT_URL = 'https://keewebx.app/';

const ConnectionWeb: FunctionComponent = () => {
    const askKeeWebTabPermission = () => {
        model.askKeeWebTabPermission().catch(noop);
    };

    const [inputKeeWebUrl, setInputKeeWebUrl] = useState('');
    const [inputKeeWebUrlError, setInputKeeWebUrlError] = useState('');

    const keeWebUrlChanged = ({ currentTarget }: JSX.TargetedEvent<HTMLInputElement, Event>) => {
        setInputKeeWebUrlError('');
        setInputKeeWebUrl(currentTarget.value);
    };

    const changeKeeWebUrl = (e: Event) => {
        e.preventDefault();
        const result = validateKeeWebUrl(inputKeeWebUrl);
        if (!result.ok) {
            if (result.reason === 'scheme') {
                return setInputKeeWebUrlError(
                    res('optionsWebConnectionKeeWebUrlDisallowedScheme')
                );
            }
            return setInputKeeWebUrlError(
                `${res('optionsWebConnectionKeeWebUrlInvalid')}: ${result.message}`
            );
        }
        setInputKeeWebUrl('');
        model.setKeeWebUrl(result.url.toString());
    };

    const cancelChangeKeeWebUrl = (e: Event) => {
        e.preventDefault();
        setInputKeeWebUrl('');
    };

    const resetKeeWebUrl = (e: Event) => {
        e.preventDefault();
        setInputKeeWebUrl('');
        model.setKeeWebUrl(undefined);
    };

    const fullMode = isVaultBuild && !model.keeWebUrlIsSet;

    return (
        <>
            {isVaultBuild ? (
                <div class="vault-mode">
                    <p>
                        <label>
                            <input
                                type="radio"
                                name="vault-mode"
                                id="vault-mode-full"
                                checked={fullMode}
                                onChange={() => model.setKeeWebUrl(undefined)}
                            />{' '}
                            {res('optionsVaultModeFull')}
                        </label>
                    </p>
                    <p>
                        <label>
                            <input
                                type="radio"
                                name="vault-mode"
                                id="vault-mode-connect"
                                checked={!fullMode}
                                onChange={() => model.setKeeWebUrl(CONNECT_DEFAULT_URL)}
                            />{' '}
                            {res('optionsVaultModeConnect')}
                        </label>
                    </p>
                </div>
            ) : null}
            {fullMode ? null : (
                <>
            <p>{res('optionsWebConnectionKeeWebUrl')}</p>
            <div>
                <form onSubmit={changeKeeWebUrl}>
                    <input
                        type="text"
                        value={inputKeeWebUrl || (model.keeWebUrlIsSet ? model.keeWebUrl : '')}
                        placeholder={model.defaultKeeWebUrl}
                        onInput={keeWebUrlChanged}
                    />
                    {inputKeeWebUrl && inputKeeWebUrl !== model.keeWebUrl ? (
                        <>
                            <button type="submit">
                                {res('optionsWebConnectionChangeKeeWebUrl')}
                            </button>
                            <button class="secondary" onClick={cancelChangeKeeWebUrl}>
                                {res('optionsCancel')}
                            </button>
                        </>
                    ) : model.keeWebUrlIsSet && !isVaultBuild ? (
                        <button onClick={resetKeeWebUrl} class="secondary">
                            {res('optionsWebConnectionResetKeeWebUrl', 'keewebx.app')}
                        </button>
                    ) : null}
                </form>
            </div>
            <div class="error top-padding-small">{inputKeeWebUrlError}</div>
                </>
            )}
            {model.canAccessKeeWebTab === false ? (
                <>
                    <p>{res('optionsWebConnectionTabPermission')}</p>
                    <div>
                        <button onClick={askKeeWebTabPermission}>
                            {res('optionsWebConnectionTabPermissionButton')}
                        </button>
                    </div>
                    <p />
                </>
            ) : null}
        </>
    );
};

export { ConnectionWeb };
