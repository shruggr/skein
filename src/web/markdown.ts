// Just enough markdown for pages a model writes: headings, paragraphs, fenced
// code, lists, blockquotes, rules, and inline code/bold/italic/links.
// Everything is escaped first; only the constructs below produce tags.

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function inline(s: string): string {
  const codes: string[] = [];
  let t = esc(s).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  t = t
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|\/|skein:)[^)\s]+)\)/g, (_, text, href) =>
      `<a href="${href.startsWith("skein:") ? `/b/${href.replace(/^skein:(\/\/)?/, "")}` : href}">${text}</a>`);
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
}

export function markdown(src: string): string {
  const out: string[] = [];
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  let para: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | undefined;
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`);
    list = undefined;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^\s*(```|~~~)\s*([\w+-]*)/))) {
      flush();
      const fence = m[1], body: string[] = [];
      while (++i < lines.length && !lines[i].trimStart().startsWith(fence)) body.push(lines[i]);
      out.push(`<pre><code${m[2] ? ` class="lang-${esc(m[2])}"` : ""}>${esc(body.join("\n"))}</code></pre>`);
    } else if (/^\s*\|.*\|\s*$/.test(line)) {
      flush();
      const rows: string[][] = [];
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) {
        if (/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) continue; // the |---| separator
        rows.push(lines[i].trim().slice(1, -1).split("|").map((c) => c.trim()));
      }
      i--;
      const [head = [], ...body] = rows;
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${
        body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
    } else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flush();
      out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push("<hr>");
    } else if ((m = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/))) {
      const tag = /\d/.test(m[1]) ? "ol" : "ul";
      if (para.length || (list && list.tag !== tag)) flush();
      list ??= { tag, items: [] };
      list.items.push(m[2]);
    } else if (list && /^\s{2,}\S/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`; // continuation of a list item
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      flush();
      out.push(`<blockquote>${inline(m[1])}</blockquote>`);
    } else if (!line.trim()) {
      flush();
    } else {
      if (list) flush();
      para.push(line.trim());
    }
  }
  flush();
  return out.join("\n");
}
