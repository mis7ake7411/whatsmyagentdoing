(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  } else if (root) {
    root.MessageFormat = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const HTML_ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };
  const MAX_ORDERED_LIST_START = 2147483647;

  function asText(value) {
    return typeof value === 'string' ? value : '';
  }

  function escapeHtml(value) {
    return value.replace(/[&<>"']/g, character => HTML_ESCAPES[character]);
  }

  function countIndent(line) {
    let index = 0;
    while (index < 4 && line.charAt(index) === ' ') index += 1;
    return index;
  }

  function readFence(line) {
    const indent = countIndent(line);
    if (indent > 3) return null;

    const marker = line.charAt(indent);
    if (marker !== '`' && marker !== '~') return null;

    let end = indent;
    while (line.charAt(end) === marker) end += 1;
    if (end - indent < 3) return null;
    return { marker, length: end - indent, end };
  }

  function isClosingFence(line, opening) {
    const indent = countIndent(line);
    if (indent > 3 || line.charAt(indent) !== opening.marker) return false;

    let end = indent;
    while (line.charAt(end) === opening.marker) end += 1;
    if (end - indent < opening.length) return false;

    while (end < line.length) {
      if (line.charAt(end) !== ' ' && line.charAt(end) !== '\t') return false;
      end += 1;
    }
    return true;
  }

  function readHeading(line) {
    const indent = countIndent(line);
    if (indent > 3) return null;

    let end = indent;
    while (line.charAt(end) === '#') end += 1;
    const level = end - indent;
    if (level < 1 || level > 6) return null;
    if (end < line.length && line.charAt(end) !== ' ' && line.charAt(end) !== '\t') return null;

    while (line.charAt(end) === ' ' || line.charAt(end) === '\t') end += 1;
    let content = line.slice(end);
    let trailing = content.length;
    while (trailing > 0 && (content.charAt(trailing - 1) === ' ' || content.charAt(trailing - 1) === '\t')) trailing -= 1;
    let hashes = trailing;
    while (hashes > 0 && content.charAt(hashes - 1) === '#') hashes -= 1;
    if (hashes < trailing && hashes > 0 && (content.charAt(hashes - 1) === ' ' || content.charAt(hashes - 1) === '\t')) {
      content = content.slice(0, hashes).replace(/[ \t]+$/g, '');
    }
    return { level, content };
  }

  function readListItem(line) {
    const indent = countIndent(line);
    if (indent > 3) return null;

    const first = line.charAt(indent);
    if ((first === '-' || first === '+' || first === '*') && (line.charAt(indent + 1) === ' ' || line.charAt(indent + 1) === '\t')) {
      let content = indent + 1;
      while (line.charAt(content) === ' ' || line.charAt(content) === '\t') content += 1;
      return { type: 'ul', content: line.slice(content) };
    }

    let end = indent;
    while (line.charAt(end) >= '0' && line.charAt(end) <= '9') end += 1;
    if (end === indent || (line.charAt(end) !== '.' && line.charAt(end) !== ')')) return null;
    if (line.charAt(end + 1) !== ' ' && line.charAt(end + 1) !== '\t') return null;
    let content = end + 1;
    while (line.charAt(content) === ' ' || line.charAt(content) === '\t') content += 1;
    let start = 0;
    for (let i = indent; i < end; i += 1) {
      start = Math.min(MAX_ORDERED_LIST_START, start * 10 + line.charCodeAt(i) - 48);
    }
    return { type: 'ol', start, content: line.slice(content) };
  }

  function readQuote(line) {
    const indent = countIndent(line);
    if (indent > 3 || line.charAt(indent) !== '>') return null;
    let content = indent + 1;
    if (line.charAt(content) === ' ' || line.charAt(content) === '\t') content += 1;
    return line.slice(content);
  }

  function isBlank(line) {
    for (let i = 0; i < line.length; i += 1) {
      if (line.charAt(i) !== ' ' && line.charAt(i) !== '\t') return false;
    }
    return true;
  }

  function isBlockStart(line) {
    return Boolean(readFence(line) || readHeading(line) || readListItem(line) || readQuote(line));
  }

  function findCodeSpans(text) {
    const openings = new Map();
    const starts = new Map();
    const closers = new Map();

    for (let i = 0; i < text.length;) {
      if (text.charAt(i) !== '`') {
        i += 1;
        continue;
      }

      let end = i + 1;
      while (text.charAt(end) === '`') end += 1;
      const length = end - i;
      if (openings.has(length)) {
        const opening = openings.get(length);
        starts.set(opening, { contentStart: opening + length, contentEnd: i, end: end, markerLength: length });
        closers.set(i, { opening, end });
        openings.delete(length);
      } else {
        openings.set(length, i);
      }
      i = end;
    }

    return { starts, closers };
  }

  function findBracketPairs(text, codeSpans) {
    const squareOpenings = [];
    const roundOpenings = [];
    const squarePairs = new Map();
    const roundPairs = new Map();

    for (let i = 0; i < text.length;) {
      const code = codeSpans.starts.get(i);
      if (code) {
        i = code.end;
        continue;
      }

      const character = text.charAt(i);
      if (character === '[') squareOpenings.push(i);
      else if (character === ']' && squareOpenings.length) squarePairs.set(squareOpenings.pop(), i);
      else if (character === '(') roundOpenings.push(i);
      else if (character === ')' && roundOpenings.length) roundPairs.set(roundOpenings.pop(), i);
      i += 1;
    }
    return { squarePairs, roundPairs };
  }

  function findLinks(text, codeSpans) {
    const pairs = findBracketPairs(text, codeSpans);
    const links = new Map();

    for (const [start, bracketEnd] of pairs.squarePairs) {
      const openParen = bracketEnd + 1;
      if (text.charAt(openParen) !== '(' || !pairs.roundPairs.has(openParen)) continue;

      const end = pairs.roundPairs.get(openParen);
      const isImage = start > 0 && text.charAt(start - 1) === '!';
      const range = {
        start: isImage ? start - 1 : start,
        bracketStart: start,
        bracketEnd,
        end,
        label: text.slice(start + 1, bracketEnd),
        url: text.slice(openParen + 1, end),
        isImage
      };

      // Prefer the widest link at a shared source position; the outer link is readable
      // even when its label contains bracket-like text.
      const existing = links.get(range.start);
      if (!existing || range.end > existing.end) links.set(range.start, range);
    }
    return links;
  }

  function isWhitespace(character) {
    return character === '' || /\s/.test(character);
  }

  function isPunctuation(character) {
    return /[.,!?;:()[\]{}<>/\\"'\-]/.test(character);
  }

  function findEmphasisPairs(text, codeSpans, links) {
    const starts = new Map();
    const closers = new Map();
    const stack = [];
    const linkStarts = new Map();
    for (const range of links.values()) linkStarts.set(range.start, range);

    for (let i = 0; i < text.length;) {
      const code = codeSpans.starts.get(i);
      if (code) {
        i = code.end;
        continue;
      }

      const link = linkStarts.get(i);
      if (link) {
        i = link.end + 1;
        continue;
      }

      const marker = text.charAt(i);
      if (marker !== '*' && marker !== '_') {
        i += 1;
        continue;
      }

      let end = i + 1;
      while (text.charAt(end) === marker) end += 1;
      const length = end - i;
      if (length !== 1 && length !== 2) {
        i = end;
        continue;
      }

      const previous = i > 0 ? text.charAt(i - 1) : '';
      const next = end < text.length ? text.charAt(end) : '';
      let canOpen = !isWhitespace(next);
      let canClose = !isWhitespace(previous);
      if (marker === '_') {
        canOpen = canOpen && (isWhitespace(previous) || isPunctuation(previous) || previous === '');
        canClose = canClose && (isWhitespace(next) || isPunctuation(next) || next === '');
      }

      const kind = length === 2 ? 'strong' : 'em';
      const top = stack.length ? stack[stack.length - 1] : null;
      if (canClose && top && top.kind === kind && top.marker === marker && top.length === length) {
        stack.pop();
        const pair = {
          kind,
          tag: kind === 'strong' ? 'strong' : 'em',
          marker,
          markerLength: length,
          start: top.start,
          startEnd: top.end,
          closeStart: i,
          end
        };
        starts.set(pair.start, pair);
        closers.set(pair.closeStart, pair);
      } else {
        let alreadyOpen = false;
        for (let j = 0; j < stack.length; j += 1) {
          if (stack[j].marker === marker && stack[j].length === length) {
            alreadyOpen = true;
            break;
          }
        }
        if (canOpen && !alreadyOpen) stack.push({ kind, marker, length, start: i, end });
      }
      i = end;
    }

    return { starts, closers };
  }

  function isSafeHttpUrl(url) {
    if (url.length > 2048) return false;
    if (!/^https?:\/\//i.test(url)) return false;

    let hostStart = url.indexOf('//') + 2;
    if (hostStart >= url.length) return false;
    const hostEnd = url.slice(hostStart).search(/[/?#]/);
    const host = hostEnd === -1 ? url.slice(hostStart) : url.slice(hostStart, hostStart + hostEnd);
    if (!host) return false;

    for (let i = 0; i < url.length; i += 1) {
      const code = url.charCodeAt(i);
      const character = url.charAt(i);
      if (code <= 0x20 || (code >= 0x7f && code <= 0x9f)) return false;
      if (character === '\\' || character === '"' || character === "'" || character === '<' || character === '>') return false;
    }
    return true;
  }

  function analyzeInline(text) {
    const codeSpans = findCodeSpans(text);
    const links = findLinks(text, codeSpans);
    const emphasis = findEmphasisPairs(text, codeSpans, links);
    return { codeSpans, links, emphasis };
  }

  function renderInline(text) {
    const analysis = analyzeInline(text);
    const linkStarts = new Map();
    for (const range of analysis.links.values()) linkStarts.set(range.start, range);

    let output = '';
    for (let i = 0; i < text.length;) {
      const link = linkStarts.get(i);
      if (link) {
        const label = escapeHtml(link.label);
        if (link.isImage) {
          output += label;
        } else if (isSafeHttpUrl(link.url)) {
          output += '<a href="' + escapeHtml(link.url) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
        } else {
          output += label;
        }
        i = link.end + 1;
        continue;
      }

      const code = analysis.codeSpans.starts.get(i);
      if (code) {
        output += '<code>' + escapeHtml(text.slice(code.contentStart, code.contentEnd)) + '</code>';
        i = code.end;
        continue;
      }

      const opening = analysis.emphasis.starts.get(i);
      if (opening) {
        output += '<' + opening.tag + '>';
        i = opening.startEnd;
        continue;
      }

      const closing = analysis.emphasis.closers.get(i);
      if (closing) {
        output += '</' + closing.tag + '>';
        i = closing.end;
        continue;
      }

      if (text.charAt(i) === '\n') {
        output += '<br>\n';
        i += 1;
        continue;
      }

      output += escapeHtml(text.charAt(i));
      i += 1;
    }
    return output;
  }

  function renderMarkdown(value) {
    const source = asText(value);
    if (!source) return '';

    const lines = source.replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];

    for (let i = 0; i < lines.length;) {
      if (isBlank(lines[i])) {
        i += 1;
        continue;
      }

      const fence = readFence(lines[i]);
      if (fence) {
        const codeLines = [];
        i += 1;
        while (i < lines.length && !isClosingFence(lines[i], fence)) {
          codeLines.push(lines[i]);
          i += 1;
        }
        if (i < lines.length) i += 1;
        blocks.push('<pre><code>' + escapeHtml(codeLines.join('\n')) + '</code></pre>');
        continue;
      }

      const heading = readHeading(lines[i]);
      if (heading) {
        blocks.push('<h' + heading.level + '>' + renderInline(heading.content) + '</h' + heading.level + '>');
        i += 1;
        continue;
      }

      const quote = readQuote(lines[i]);
      if (quote !== null) {
        const quoteLines = [];
        while (i < lines.length) {
          const content = readQuote(lines[i]);
          if (content === null) break;
          quoteLines.push(content);
          i += 1;
        }
        blocks.push('<blockquote><p>' + renderInline(quoteLines.join('\n')) + '</p></blockquote>');
        continue;
      }

      const list = readListItem(lines[i]);
      if (list) {
        const items = [];
        const type = list.type;
        while (i < lines.length) {
          const item = readListItem(lines[i]);
          if (!item || item.type !== type) break;
          items.push('<li>' + renderInline(item.content) + '</li>');
          i += 1;
        }
        const startAttribute = type === 'ol' && list.start !== 1 ? ' start="' + list.start + '"' : '';
        blocks.push('<' + type + startAttribute + '>' + items.join('\n') + '</' + type + '>');
        continue;
      }

      const paragraph = [];
      while (i < lines.length && !isBlank(lines[i]) && !isBlockStart(lines[i])) {
        paragraph.push(lines[i]);
        i += 1;
      }
      if (paragraph.length) blocks.push('<p>' + renderInline(paragraph.join('\n')) + '</p>');
    }

    return blocks.join('\n');
  }

  function isHorizontalRule(line) {
    const trimmed = line.replace(/^[ \t]+|[ \t]+$/g, '');
    if (trimmed.length < 3) return false;
    const marker = trimmed.charAt(0);
    if (marker !== '-' && marker !== '*' && marker !== '_') return false;
    for (let i = 1; i < trimmed.length; i += 1) {
      if (trimmed.charAt(i) !== marker) return false;
    }
    return true;
  }

  function stripBlockPrefix(line) {
    const heading = readHeading(line);
    if (heading) return heading.content;

    const quote = readQuote(line);
    if (quote !== null) return quote;

    const list = readListItem(line);
    if (list) return list.content;

    return isHorizontalRule(line) ? '' : line;
  }

  function stripInlineMarkdown(text) {
    const analysis = analyzeInline(text);
    const linkStarts = new Map();
    for (const range of analysis.links.values()) linkStarts.set(range.start, range);

    let output = '';
    for (let i = 0; i < text.length;) {
      const link = linkStarts.get(i);
      if (link) {
        output += link.label;
        i = link.end + 1;
        continue;
      }

      const code = analysis.codeSpans.starts.get(i);
      if (code) {
        output += text.slice(code.contentStart, code.contentEnd);
        i = code.end;
        continue;
      }

      const opening = analysis.emphasis.starts.get(i);
      if (opening && !isAmbiguousPlainPair(text, opening)) {
        i = opening.startEnd;
        continue;
      }

      const closing = analysis.emphasis.closers.get(i);
      if (closing && !isAmbiguousPlainPair(text, closing)) {
        i = closing.end;
        continue;
      }

      output += text.charAt(i);
      i += 1;
    }
    return output;
  }

  function isWordContent(content) {
    if (!content) return false;
    for (let i = 0; i < content.length; i += 1) {
      if (isWhitespace(content.charAt(i)) || isPunctuation(content.charAt(i))) return false;
    }
    return true;
  }

  function isWordLike(character) {
    return Boolean(character) && !isWhitespace(character) && !isPunctuation(character);
  }

  function isAmbiguousPlainPair(text, pair) {
    const content = text.slice(pair.startEnd, pair.closeStart);
    if (!isWordContent(content)) return false;

    if (pair.marker === '_' && pair.markerLength === 2) return true;
    if (pair.marker === '*') {
      const before = pair.start > 0 ? text.charAt(pair.start - 1) : '';
      const after = pair.end < text.length ? text.charAt(pair.end) : '';
      return isWordLike(before) && isWordLike(after);
    }
    return false;
  }

  function plainText(value) {
    const source = asText(value);
    if (!source) return '';

    const lines = source.replace(/\r\n?/g, '\n').split('\n');
    const output = [];
    let codeFence = null;

    for (const line of lines) {
      if (codeFence) {
        if (isClosingFence(line, codeFence)) {
          codeFence = null;
        } else {
          output.push(line);
        }
        continue;
      }

      const fence = readFence(line);
      if (fence) {
        codeFence = fence;
        continue;
      }

      output.push(stripInlineMarkdown(stripBlockPrefix(line)));
    }

    return output.join(' ').replace(/\s+/g, ' ').trim();
  }

  return { renderMarkdown, plainText };
});
