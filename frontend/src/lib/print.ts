export type PrintOptions = {
  title?: string;
  width?: string; // default "80mm"
  headerHtml?: string;
  footerHtml?: string;
};

function defaultCss(width: string) {
  return `
@page { margin: 10mm; }
html, body { padding: 0; margin: 0; }
body {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  color: #000;
  background: #fff;
}
.token-wrap { width: ${width}; max-width: ${width}; }
.token { border: 2px solid #000; padding: 10px; }
.hr { border-top: 2px dashed #000; margin: 10px 0; }
.small { font-size: 11px; line-height: 1.25; }
.base  { font-size: 18px; line-height: 2.25; }
.title { font-size: 30px; font-weight: 1000; letter-spacing: 0.2px; }
.strong { font-weight: 800; }
.mono { word-break: break-all; }

@media print { a, button { display: none !important; } }
  `.trim();
}

export function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function printHtmlToken(tokenHtml: string, opts: PrintOptions = {}): boolean {
  const title = opts.title ?? "Order Token";
  const width = opts.width ?? "80mm";
  const header = opts.headerHtml ? `<div class="small" style="margin-bottom:8px;">${opts.headerHtml}</div>` : "";
  const footer = opts.footerHtml ? `<div class="small" style="margin-top:8px;">${opts.footerHtml}</div>` : "";

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>${defaultCss(width)}</style>
</head>
<body>
  <div class="token-wrap">
    ${header}
    <div class="token">
      ${tokenHtml}
    </div>
    ${footer}
  </div>
</body>
</html>`;

  if (!document?.body) return false;

  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  iframe.style.opacity = "0";

  iframe.onload = () => {
    try {
      const w = iframe.contentWindow;
      if (!w) return;
      w.focus();
      w.print();
    } finally {
      setTimeout(() => {
        try {
          iframe.remove();
        } catch {}
      }, 1000);
    }
  };
  iframe.srcdoc = html;
  document.body.appendChild(iframe);
  return true;
}