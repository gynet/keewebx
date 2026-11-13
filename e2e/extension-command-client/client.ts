const form = document.querySelector('form')!;
const result = document.querySelector('pre')!;
form.addEventListener('submit', async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    const action = (event as SubmitEvent).submitter?.getAttribute('value');
    result.textContent = 'Pending';
    try {
        const response = await chrome.runtime.sendMessage({ type: 'command', action, url: values.app,
            fields: Object.fromEntries(Object.entries({ url: values.url, title: 'Command fixture', login: values.login,
                password: values.password, uuid: values.uuid, groupName: values.groupName }).filter(([, value]) => value !== '')) });
        result.textContent = JSON.stringify(response);
    } catch (error) { result.textContent = JSON.stringify({ ok: false, error: String(error) }); }
});
