// Runs before application assets. Only website icon addresses may use the network.
if (location.protocol === 'file:') {
    const policy = document.createElement('meta');
    policy.httpEquiv = 'Content-Security-Policy';
    policy.content = "default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline' blob:; font-src 'self' data:; img-src 'self' data: blob: https://icons.duckduckgo.com; connect-src https://*:*/favicon.ico http://*:*/favicon.ico https://icons.duckduckgo.com/ip3/; worker-src blob:; frame-src 'none'; object-src 'none'; manifest-src 'self'; base-uri 'self'; form-action 'none'";
    document.head.appendChild(policy);
    document.documentElement.dataset.network = 'offline';
}
