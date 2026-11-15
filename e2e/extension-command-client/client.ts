const form = document.querySelector('form')!;
const result = document.querySelector('pre')!;
let sequence = 0;
form.addEventListener('submit', async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    const action = (event as SubmitEvent).submitter?.getAttribute('value');
    const current = ++sequence;
    result.textContent = 'Pending';
    const complete = (response: unknown) => {
        const text = JSON.stringify(response);
        if (current === sequence) result.textContent = text;
        const row = document.createElement('li'); row.dataset.action = action ?? '';
        row.textContent = text; document.querySelector('ol')!.append(row);
    };
    try {
        const response = await chrome.runtime.sendMessage({ type: 'command', action, url: values.app,
            fields: Object.fromEntries(Object.entries({ url: values.url, title: 'Command fixture', login: values.login,
                password: values.password, uuid: values.uuid, groupName: values.groupName, handle: values.handle,
                ...(action === 'kwx-get-entry-fields' ? { fields: ['password'] } : {}) }).filter(([, value]) => value !== '')) });
        complete(response);
    } catch (error) { complete({ ok: false, error: String(error) }); }
});
