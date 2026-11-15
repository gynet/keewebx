import { ConnectionBlock } from './connect/connection-block';
import { FunctionComponent } from 'preact';
import { Shortcuts } from './shortcuts';
import { Footer } from './footer';
import { Usage } from './usage';
import { SetupInstructions } from './setup-instructions';
import { model } from 'options/settings-model';
import { BackendConnectionState } from 'common/backend-connection-state';

const MainBlock: FunctionComponent = () => {
    return (
        <>
            <ConnectionBlock />
            <SetupInstructions />
            {model.backendConnectionState === BackendConnectionState.Connected ? <Usage /> : null}
            <Shortcuts />
            <Footer />
        </>
    );
};

export { MainBlock };
