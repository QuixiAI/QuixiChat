// This entry deliberately does not load the application, storage, or provider code.
// Only a bounded authorization response crosses the transaction-specific channel.
export {};
const status = document.getElementById('oauth-status')!;
document.getElementById('oauth-close')!.addEventListener('click', () => window.close());

function completeCallback(): void {
  let channel: BroadcastChannel | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (message: string): void => {
    if (timer !== undefined) clearTimeout(timer);
    channel?.close();
    channel = undefined;
    window.removeEventListener('pagehide', abandon);
    status.textContent = message;
  };
  const abandon = (): void => finish('Return to Quixi to start a new connection.');
  try {
    const url = location.href;
    // Clear the address/history entry before validation or channel construction.
    history.replaceState(null, '', location.pathname);
    if (url.length > 8192) {
      finish('This connection could not be verified. Return to Quixi and try again.');
      return;
    }
    const callback = new URL(url);
    const states = callback.searchParams.getAll('state');
    if (callback.pathname !== '/oauth/callback.html' || callback.hash ||
        states.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(states[0]!) ||
        window.top !== window || !window.isSecureContext || !window.crossOriginIsolated) {
      finish('This connection could not be verified. Return to Quixi and try again.');
      return;
    }
    channel = new BroadcastChannel(`quixi-oauth-v1:${states[0]}`);
    channel.onmessage = event => {
      if (event.origin !== location.origin) return;
      const message: unknown = event.data;
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      const result = message as Record<string, unknown>;
      if (Object.keys(result).sort().join(',') !== 'status,type' || result.type !== 'quixi-oauth-result') return;
      if (result.status === 'accepted') finish('Authorization received. Return to Quixi to see the connection result.');
      else if (result.status === 'rejected') finish('This connection could not be verified. Return to Quixi and try again.');
    };
    window.addEventListener('pagehide', abandon, { once: true });
    timer = setTimeout(() => finish('This connection request is no longer available. Return to Quixi and start again.'), 5000);
    channel.postMessage({ type: 'quixi-oauth-callback', url });
  } catch {
    finish('This browser could not finish connecting. Return to Quixi and try again.');
  }
}

completeCallback();
