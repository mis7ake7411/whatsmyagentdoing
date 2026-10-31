const assert = require('node:assert/strict');
const test = require('node:test');

const hadMessageFormatGlobal = Object.prototype.hasOwnProperty.call(globalThis, 'MessageFormat');
const messageFormat = require('../public/message-format.js');

const renderMarkdown = (...args) => {
  assert.equal(typeof messageFormat.renderMarkdown, 'function', 'renderMarkdown should be exported');
  return messageFormat.renderMarkdown(...args);
};

const plainText = (...args) => {
  assert.equal(typeof messageFormat.plainText, 'function', 'plainText should be exported');
  return messageFormat.plainText(...args);
};

test('exports pure renderMarkdown and plainText helpers', () => {
  assert.equal(typeof messageFormat.renderMarkdown, 'function');
  assert.equal(typeof messageFormat.plainText, 'function');
});

test('does not assign a browser global while loaded through CommonJS', () => {
  assert.equal(Object.prototype.hasOwnProperty.call(globalThis, 'MessageFormat'), hadMessageFormatGlobal);
});

test('renders paragraphs, soft line breaks, headings, lists, and blockquotes', () => {
  const source = [
    '# Update',
    '',
    'first line',
    'second line',
    '',
    '- alpha',
    '- beta',
    '',
    '1. one',
    '2. two',
    '',
    '5. five',
    '6. six',
    '',
    '> quoted',
    '> text'
  ].join('\n');

  assert.equal(renderMarkdown(source), [
    '<h1>Update</h1>',
    '<p>first line<br>\nsecond line</p>',
    '<ul><li>alpha</li>\n<li>beta</li></ul>',
    '<ol><li>one</li>\n<li>two</li></ol>',
    '<ol start="5"><li>five</li>\n<li>six</li></ol>',
    '<blockquote><p>quoted<br>\ntext</p></blockquote>'
  ].join('\n'));
});

test('renders inline code, emphasis, and only explicit HTTP(S) links safely', () => {
  assert.equal(
    renderMarkdown('Use `x < y`, **bold**, *emphasis*, and [site](https://example.com/p?a=1&b=2).'),
    '<p>Use <code>x &lt; y</code>, <strong>bold</strong>, <em>emphasis</em>, and <a href="https://example.com/p?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">site</a>.</p>'
  );
});

test('escapes raw HTML and script or event-handler payloads as text', () => {
  assert.equal(
    renderMarkdown('<script>alert(1)</script>\n<img src=x onerror=alert(1)> &lt;script&gt;'),
    '<p>&lt;script&gt;alert(1)&lt;/script&gt;<br>\n&lt;img src=x onerror=alert(1)&gt; &amp;lt;script&amp;gt;</p>'
  );
});

test('keeps fenced code literal, including an unclosed truncated block', () => {
  assert.equal(
    renderMarkdown('```html\n<script onload="x">&\n```'),
    '<pre><code>&lt;script onload=&quot;x&quot;&gt;&amp;</code></pre>'
  );
  assert.equal(
    renderMarkdown('```js\nconst x = "<script>";'),
    '<pre><code>const x = &quot;&lt;script&gt;&quot;;</code></pre>'
  );
});

test('shows unsafe link labels without creating links or image requests', () => {
  const source = [
    '[js](javascript:alert(1))',
    '[data](data:text/html,hi)',
    '[file](file:///secret)',
    '[custom](app:open)',
    '[entity](javascript&#58;alert(1))',
    '[encoded](h&#116;tps://example.com)',
    '[newline](java\nscript:alert(1))',
    '[quote](https://example.com/" onmouseover="x)',
    '![cat](https://example.com/cat.png)'
  ].join(' ');
  const html = renderMarkdown(source);

  assert.equal(html, '<p>js data file custom entity encoded newline quote cat</p>');
  assert.doesNotMatch(html, /<a\b|<img\b/i);
});

test('plainText removes Markdown scaffolding while preserving identifiers and comparisons', () => {
  assert.equal(
    plainText('## Build\n- foo_bar and __init__ and a < b plus 2*3*4\n[Open](javascript:alert(1)) `code` **bold**'),
    'Build foo_bar and __init__ and a < b plus 2*3*4 Open code bold'
  );
  assert.equal(plainText('![diagram](https://example.com/image.png) `user_id` C:/workspace/my_file.md'), 'diagram user_id C:/workspace/my_file.md');
  assert.equal(plainText(''), '');
});

test('returns safe empty output for malformed or non-string input', () => {
  for (const value of [null, undefined, 17, {}, ['# heading']]) {
    assert.equal(renderMarkdown(value), '');
    assert.equal(plainText(value), '');
  }
});

test('keeps unmatched Markdown syntax readable without throwing', () => {
  const source = '**unclosed and [broken](https://example.com';
  assert.equal(renderMarkdown(source), `<p>${source}</p>`);
  assert.equal(plainText(source), source);
});

test('does not pair emphasis markers that use different characters', () => {
  const source = '**open__ and *cross_';
  assert.equal(renderMarkdown(source), `<p>${source}</p>`);
  assert.equal(plainText(source), source);
});

test('handles long repeated delimiters without changing their text', () => {
  const source = `${'*'.repeat(32)}a${'_'.repeat(32)}`.repeat(500);
  const html = renderMarkdown(source);
  const summary = plainText(source);

  assert.equal(html.length, source.length + '<p></p>'.length);
  assert.equal(summary.length, source.length);
  assert.equal(html.slice(0, 3 + 65), `<p>${source.slice(0, 65)}`);
});
