import { render } from 'preact';
import { App, Layout } from './app';

const view = new URLSearchParams(location.search).get('view');
const layout: Layout = view === 'tab' ? 'tab' : document.documentElement.dataset.layout === 'side' ? 'side' : 'popup';
document.documentElement.classList.add(`layout-${layout}`);
render(<App layout={layout} />, document.getElementById('root')!);
