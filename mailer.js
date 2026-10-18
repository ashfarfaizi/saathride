// SaathRide — email notifications. Works with either free transactional email service:
//   Resend (RESEND_API_KEY)  — free tier ~3,000 emails/month. Until you verify a domain it only
//                              delivers to your own Resend account address (fine for testing).
//   Brevo  (BREVO_API_KEY)   — free tier ~300 emails/day; verify a single sender address, no domain needed.
// EMAIL_FROM is the sender, e.g. "SaathRide <you@gmail.com>" (Brevo: the address you verified there).
// No key set → email is simply off; the in-app notifications keep working. Plain fetch, no extra packages.

const parseFrom = (s) => {
  const m = String(s || "").match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].replace(/^"|"$/g, "") || "SaathRide", email: m[2].trim() } : { name: "SaathRide", email: String(s || "").trim() };
};
const escHtml = (x) => String(x ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function createMailer({ fetchImpl = (...a) => fetch(...a), env = process.env } = {}) {
  const provider = () => (env.RESEND_API_KEY ? "resend" : env.BREVO_API_KEY ? "brevo" : "");
  const from = () => parseFrom(env.EMAIL_FROM || (env.RESEND_API_KEY ? "SaathRide <onboarding@resend.dev>" : ""));
  const enabled = () => !!provider() && !!from().email;
  const status = () => (!provider() ? "not_configured" : !from().email ? "missing_sender" : "ready");
  // Public site address for links in emails.
  const appUrl = () => (env.APP_URL || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : "")).replace(/\/$/, "");

  // A small, readable email: heading, one line of context, one button, and how to switch emails off.
  // footer: true = member footer (how to switch emails off) · a string = custom footer (e.g. for trusted
  // contacts, who may not have an account) · false = none. `link` may be a full https URL.
  function render({ heading, text, cta, link, footer = true }) {
    const url = /^https:\/\//.test(link || "") ? link : link && appUrl() ? appUrl() + (link.startsWith("/") ? link : `/${link}`) : appUrl() || "";
    const settings = appUrl() ? `${appUrl()}/#/settings` : "";
    if (typeof footer === "string") {
      const plain = [heading, "", text, url ? `\n${cta || "Open SaathRide"}: ${url}` : "", `\n—\n${footer}`].join("\n");
      return { text: plain, html: shell(heading, text, cta, url, `<p style="font-size:12px;color:#6b7891;line-height:1.5;margin:14px 4px">${escHtml(footer).replace(/\n/g, "<br/>")}</p>`) };
    }
    const plain = [heading, "", text, url ? `\n${cta || "Open SaathRide"}: ${url}` : "",
      footer ? `\n—\nYou're getting this because you have a SaathRide account.${settings ? ` Turn emails off in Settings: ${settings}` : " Turn emails off in Settings → Notifications."}` : ""].join("\n");
    const memberFooter = footer ? `<p style="font-size:12px;color:#6b7891;line-height:1.5;margin:14px 4px">You're getting this because you have a SaathRide account. ${settings ? `<a href="${escHtml(settings)}" style="color:#6b7891">Turn emails off in Settings</a>.` : "Turn emails off in Settings → Notifications."}<br/>SaathRide connects people travelling the same way — meet in public places and call 112 in an emergency.</p>` : "";
    return { text: plain, html: shell(heading, text, cta, url, memberFooter) };
  }
  function shell(heading, text, cta, url, footerHtml) {
    return `<!doctype html><html><body style="margin:0;background:#f1f5f4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#17233b">
<div style="max-width:520px;margin:0 auto;padding:24px 16px">
<div style="font-size:20px;font-weight:800;margin-bottom:16px">Saath<span style="color:#0e7c66">Ride</span></div>
<div style="background:#fff;border:1px solid #e3e8ef;border-radius:16px;padding:22px">
<h1 style="font-size:18px;margin:0 0 8px">${escHtml(heading)}</h1>
<p style="font-size:15px;line-height:1.5;margin:0 0 18px;color:#3d4a63">${escHtml(text)}</p>
${url ? `<a href="${escHtml(url)}" style="display:inline-block;background:#0e7c66;color:#fff;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:10px">${escHtml(cta || "Open SaathRide")}</a>` : ""}
</div>
${footerHtml}
</div></body></html>`;
  }

  async function send({ to, subject, heading, text, cta, link, footer }) {
    if (!enabled() || !to) return { sent: false, reason: status() };
    const body = render({ heading: heading || subject, text, cta, link, footer });
    const f = from();
    const req = provider() === "resend"
      ? { url: "https://api.resend.com/emails", headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` },
          json: { from: `${f.name} <${f.email}>`, to: [to], subject, html: body.html, text: body.text } }
      : { url: "https://api.brevo.com/v3/smtp/email", headers: { "api-key": env.BREVO_API_KEY },
          json: { sender: { name: f.name, email: f.email }, to: [{ email: to }], subject, htmlContent: body.html, textContent: body.text } };
    try {
      const res = await fetchImpl(req.url, { method: "POST", signal: AbortSignal.timeout(4000),
        headers: { "Content-Type": "application/json", Accept: "application/json", ...req.headers }, body: JSON.stringify(req.json) });
      if (!res.ok) { console.error(`email: ${provider()} responded ${res.status}`); return { sent: false, reason: `http_${res.status}` }; }
      return { sent: true };
    } catch (err) { console.error("email send failed:", err.message); return { sent: false, reason: "network" }; }
  }
  return { enabled, status, provider, send, appUrl, render };
}

module.exports = { createMailer, parseFrom };
