import { FunctionComponent } from 'preact';
import { res } from 'options/utils';
import { model } from 'options/settings-model';

const ConnectMode: FunctionComponent = () => {
    const openKeeWebTab = (e: Event) => {
        e.preventDefault();
        model.openKeeWebTab();
    };

    return (
        <>
            <p>
                {res('optionsConnectionModeWeb')}{' '}
                <a target="_blank" rel="noreferrer" onClick={openKeeWebTab}>
                    {res('optionsConnectionModeWebLink')}
                </a>
                .
            </p>
        </>
    );
};

export { ConnectMode };
