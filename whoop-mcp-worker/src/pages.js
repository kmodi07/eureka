// The three small HTML pages: shared shell, owner consent, admin.
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:520px;margin:48px auto;padding:0 16px;color:#111;background:#fafafa}
@media (prefers-color-scheme:dark){body{color:#eee;background:#111}input{background:#222;color:#eee}}
input,button{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid #888;width:100%;box-sizing:border-box;margin:6px 0}
button{cursor:pointer;font-weight:600}.row{display:flex;gap:8px}.err{color:#d33}code{word-break:break-all}</style></head>
<body><h1>${esc(title)}</h1>${body}</body></html>`;
}

export function consentPage(requestId, linked, error) {
  return page("Allow Claude to read your WHOOP data?", `
    ${error ? `<p class="err">${esc(error)}</p>` : ""}
    <p>Claude is asking for <b>read-only</b> access to your recovery, sleep and strain through this personal server.</p>
    ${linked ? "" : "<p>WHOOP isn't linked yet. After your password, you'll be sent to WHOOP's official sign-in page.</p>"}
    <form method="post" action="/consent">
      <input type="hidden" name="request" value="${esc(requestId)}">
      <label>Owner password<input type="password" name="password" autocomplete="current-password" required autofocus></label>
      <div class="row"><button name="action" value="allow">Allow</button></div>
    </form>
    <form method="post" action="/consent"><input type="hidden" name="request" value="${esc(requestId)}"><button name="action" value="deny">Deny</button></form>`);
}

export function adminPage(error) {
  return page("WHOOP MCP admin", `
    ${error ? `<p class="err">${esc(error)}</p>` : ""}
    <form method="post" action="/admin">
      <label>Owner password<input type="password" name="password" autocomplete="current-password" required></label>
      <button name="action" value="status">Show status</button>
      <button name="action" value="link">Link / re-link WHOOP</button>
      <button name="action" value="signout">Sign Claude out (keep WHOOP linked)</button>
      <button name="action" value="disconnect">Disconnect WHOOP and delete tokens</button>
      <button name="action" value="export">Download encrypted backup</button>
    </form>`);
}
