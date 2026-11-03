import test from "node:test";
import assert from "node:assert/strict";
import { portfolioText } from "./html.ts";
test("portfolio extraction handles entities and ignores active or chrome content without a browser", () => {
  const result = portfolioText(
    '<title>Ada &amp; projects</title><nav>Ignore menu</nav><main><h1>Engineering</h1><p>Built &lt;local&gt; search.</p><script>throw Error("run")</script><img src="https://example.invalid/tracker"><iframe src="https://example.invalid/embed">Ignore embed</iframe><p>Rust &amp; React</p></main>',
    "fallback",
  );
  assert.equal(result.title, "Ada & projects");
  assert.match(result.content, /Built <local> search/);
  assert.match(result.content, /Rust & React/);
  assert.ok(!/Ignore|throw|tracker/.test(result.content));
});
test("article text wins over surrounding page and malformed HTML remains readable", () => {
  const result = portfolioText(
    "<main>Other copy<article><h2>Project</h2><p>One<p>Two &copy;</article></main>",
    "Portfolio",
  );
  assert.equal(result.title, "Portfolio");
  assert.ok(!result.content.includes("Other copy"));
  assert.match(result.content, /One/);
  assert.match(result.content, /Two ©/);
});
