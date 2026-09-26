import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToHtml } from "./markdown.ts";

test("markdown: headings, lists, code, escaping", () => {
  const html = markdownToHtml("# Title\n\nSome `x<y>` **bold** text\n\n- one\n- two\n\n1. a\n2. b\n\n```ts\nconst a = '<b>';\n```\n<script>alert(1)</script>");
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<code>x&lt;y&gt;<\/code> <strong>bold<\/strong>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol><li>a<\/li><li>b<\/li><\/ol>/);
  assert.match(html, /<pre><code data-lang="ts">const a = &#39;&lt;b&gt;&#39;;<\/code><\/pre>/);
  assert.ok(!html.includes("<script>"));
});
