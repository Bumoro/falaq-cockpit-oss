(function(root, factory) {
  const render = factory();
  if (typeof module === 'object' && module.exports) module.exports = { render };
  if (root) {
    render.render = render;
    root.ckMd = render;
  }
})(typeof window !== 'undefined' ? window : null, function() {
  'use strict';

  function text(value) {
    try { return value == null ? '' : String(value); } catch (_) { return ''; }
  }

  function escapeHtml(value) {
    return text(value).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  function tokenPrefix(source, kind) {
    let prefix = `\u0002CKMD${kind}`;
    while (source.includes(prefix)) prefix += '_';
    return prefix;
  }

  function extractFences(source) {
    const blocks = [];
    const prefix = tokenPrefix(source, 'F');
    const pattern = /^ {0,3}```([^`\n]*)[ \t]*(?:\r?\n|$)([\s\S]*?)(?:\r?\n {0,3}```[ \t]*(?=\r?\n|$)|^ {0,3}```[ \t]*(?=\r?\n|$)|(?![\s\S]))/gm;
    const value = source.replace(pattern, (_, language, code) => {
      const index = blocks.push({ language: language.trim(), code }) - 1;
      return `\n${prefix}${index}\u0003\n`;
    });
    return { value, blocks, prefix };
  }

  function inline(value) {
    const saved = [];
    const prefix = tokenPrefix(value, 'I');
    const keep = html => {
      const index = saved.push(html) - 1;
      return `${prefix}${index}\u0003`;
    };

    let out = value.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${code}</code>`));
    out = out.replace(/!?\[([^\]\n]+)\]\((https?:\/\/[^\s)<]+)\)/g,
      (_, label, href) => keep(`<a href="${href}" rel="noopener noreferrer" target="_blank">${label}</a>`));
    out = out.replace(/\*\*([^*\n]+)\*([^*\n]+)\*\*\*/g, '<strong>$1<em>$2</em></strong>');
    out = out.replace(/\*\*\*([^*\n]+)\*([^*\n]+)\*\*/g, '<em>$1<strong>$2</strong></em>');
    out = out.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    out = out.replace(/___([^_\n]+)___/g, '<strong><em>$1</em></strong>');
    out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    out = out.replace(/(^|[^\w_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
    return out.replace(new RegExp(prefix + '(\\d+)\\u0003', 'g'), (_, index) => saved[Number(index)]);
  }

  function splitRow(line) {
    let value = line.trim();
    if (value.startsWith('|')) value = value.slice(1);
    if (value.endsWith('|') && !value.endsWith('\\|')) value = value.slice(0, -1);
    const cells = [];
    let cell = '';
    for (let i = 0; i < value.length; i++) {
      if (value[i] === '\\' && value[i + 1] === '|') {
        cell += '|';
        i++;
      } else if (value[i] === '|') {
        cells.push(cell.trim());
        cell = '';
      } else {
        cell += value[i];
      }
    }
    cells.push(cell.trim());
    return cells;
  }

  function isDivider(line) {
    const cells = splitRow(line);
    return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
  }

  function listLine(line) {
    const match = line.match(/^(\s{0,4})([-+*]|\d+\.)\s+(.+)$/);
    if (!match) return null;
    return { nested: match[1].length >= 2, ordered: /\d/.test(match[2][0]), value: match[3] };
  }

  function renderList(lines) {
    let html = '';
    let rootType = '';
    let nestedType = '';
    let itemOpen = false;
    const closeNested = () => {
      if (!nestedType) return;
      html += `</${nestedType}>`;
      nestedType = '';
    };
    let promoted = false;
    for (const line of lines) {
      const item = listLine(line);
      const type = item.ordered ? 'ol' : 'ul';
      // An indented item with no open root item is promoted to a root item (and keeps promoting its
      // indented siblings) — dropping it would make whole indent-only lists vanish from the bubble.
      if (!(item.nested && itemOpen && !promoted)) {
        promoted = item.nested;
        closeNested();
        if (itemOpen) html += '</li>';
        if (rootType && rootType !== type) html += `</${rootType}>`;
        if (rootType !== type) {
          html += `<${type}>`;
          rootType = type;
        }
        html += `<li>${inline(item.value)}`;
        itemOpen = true;
      } else if (itemOpen) {
        if (nestedType && nestedType !== type) {
          html += `</${nestedType}>`;
          nestedType = '';
        }
        if (!nestedType) {
          html += `<${type}>`;
          nestedType = type;
        }
        html += `<li>${inline(item.value)}</li>`;
      }
    }
    closeNested();
    if (itemOpen) html += '</li>';
    if (rootType) html += `</${rootType}>`;
    return html;
  }

  function renderBlocks(value, fencePrefix) {
    const lines = value.replace(/\r\n?/g, '\n').split('\n');
    const output = [];
    const fenceLine = new RegExp('^' + fencePrefix + '\\d+\\u0003$');
    const isBlockStart = (line, next) => !line.trim() || fenceLine.test(line) ||
      /^ {0,3}#{1,4}\s+/.test(line) || /^ {0,3}&gt;/.test(line) || /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line) ||
      !!listLine(line) || (line.includes('|') && next != null && isDivider(next));
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      if (fenceLine.test(line)) { output.push(line); i++; continue; }

      const heading = line.match(/^ {0,3}(#{1,4})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        const level = heading[1].length;
        output.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        i++;
        continue;
      }
      if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        output.push('<hr>');
        i++;
        continue;
      }
      if (/^ {0,3}&gt;/.test(line)) {
        const quoted = [];
        while (i < lines.length && /^ {0,3}&gt;/.test(lines[i])) {
          quoted.push(lines[i].replace(/^ {0,3}&gt; ?/, ''));
          i++;
        }
        output.push(`<blockquote>${inline(quoted.join('\n')).replace(/\n/g, '<br>')}</blockquote>`);
        continue;
      }
      if (line.includes('|') && i + 1 < lines.length && isDivider(lines[i + 1])) {
        const headings = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(splitRow(lines[i++]));
        const head = headings.map(cell => `<th>${inline(cell)}</th>`).join('');
        const body = rows.map(row => `<tr>${headings.map((_, n) => `<td>${inline(row[n] || '')}</td>`).join('')}</tr>`).join('');
        output.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
        continue;
      }
      if (listLine(line)) {
        const list = [];
        while (i < lines.length && listLine(lines[i])) list.push(lines[i++]);
        output.push(renderList(list));
        continue;
      }

      const paragraph = [line];
      i++;
      while (i < lines.length && !isBlockStart(lines[i], lines[i + 1])) paragraph.push(lines[i++]);
      output.push(`<p>${inline(paragraph.join('\n')).replace(/\n/g, '<br>')}</p>`);
    }
    return output.join('\n');
  }

  function render(input) {
    const source = text(input);
    try {
      const fences = extractFences(source);
      let html = renderBlocks(escapeHtml(fences.value), fences.prefix);
      const pattern = new RegExp(fences.prefix + '(\\d+)\\u0003', 'g');
      html = html.replace(pattern, (_, index) => {
        const block = fences.blocks[Number(index)];
        if (!block) return '';
        const language = escapeHtml(block.language);
        const caption = language ? `<small class="md-code-language">${language}</small>` : '';
        return `<div class="md-code-block">${caption}<pre><code>${escapeHtml(block.code)}</code></pre></div>`;
      });
      return html;
    } catch (_) {
      return escapeHtml(source);
    }
  }

  return render;
});
