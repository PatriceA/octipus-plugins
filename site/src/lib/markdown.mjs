// A README or changelog as sanitized HTML: Markdown through marked, then
// sanitize-html with a short allowlist. No remote images: an image renders
// only when it is one of the plugin's own listing images (copied into the
// site); any other becomes its alt text. Links keep http(s) and mailto only.
import { Marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** A relative path inside a plugin directory, normalized ("./a/b.png" → "a/b.png"), or null. */
function relativePath(href) {
  if (typeof href !== 'string' || !href || href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/') || href.startsWith('\\')) return null;
  const parts = [];
  for (const seg of href.split(/[?#]/)[0].split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    parts.push(seg);
  }
  return parts.join('/');
}

/**
 * @param {string} md
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.images] plugin-relative path → site URL of the images that may show
 * @param {string} [opts.linkBase] absolute URL that relative links resolve against (e.g. the plugin's source on GitHub)
 * @param {number} [opts.headingShift] added to heading levels (the page has its own h1)
 */
export function renderMarkdown(md, { images = {}, linkBase, headingShift = 1 } = {}) {
  if (!md) return '';
  const marked = new Marked({ gfm: true, breaks: false, async: false });
  marked.use({
    renderer: {
      image({ href, title, text }) {
        const rel = relativePath(href);
        const src = rel !== null ? images[rel] : undefined;
        if (!src) return `<span class="md-image-dropped">[image: ${escapeHtml(text || 'not shown')}]</span>`;
        return `<img src="${escapeHtml(src)}" alt="${escapeHtml(text)}"${title ? ` title="${escapeHtml(title)}"` : ''} loading="lazy">`;
      },
      heading({ tokens, depth }) {
        const level = Math.min(6, depth + headingShift);
        return `<h${level}>${this.parser.parseInline(tokens)}</h${level}>\n`;
      },
    },
  });
  const raw = marked.parse(String(md));
  return sanitizeHtml(raw, {
    allowedTags: ['h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'blockquote', 'pre', 'code', 'em', 'strong', 'del', 's', 'ul', 'ol', 'li',
      'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span', 'kbd', 'sup', 'sub', 'details', 'summary', 'input'],
    allowedAttributes: {
      a: ['href', 'title', 'rel'],
      img: ['src', 'alt', 'title', 'loading'],
      span: ['class'],
      th: ['align'],
      td: ['align'],
      ol: ['start'],
      input: ['type', 'checked', 'disabled'],
      code: ['class'],
    },
    allowedClasses: { span: ['md-image-dropped'], code: [/^language-[a-z0-9+-]+$/] },
    allowedSchemes: ['https', 'http', 'mailto'],
    allowedSchemesByTag: { img: [] },
    allowProtocolRelative: false,
    // Raw HTML in Markdown is held to the same rules; a heading the
    // renderer did not shift (raw <h1>) is shifted here.
    transformTags: {
      h1: 'h2',
      a: (tagName, attribs) => {
        const out = { ...attribs };
        const rel = relativePath(out.href);
        if (rel !== null && linkBase) out.href = new URL(rel, linkBase).href;
        else if (rel !== null) delete out.href;
        if (out.href && /^https?:/i.test(out.href)) out.rel = 'nofollow noopener noreferrer';
        return { tagName, attribs: out };
      },
      input: (tagName, attribs) => ({ tagName, attribs: attribs.type === 'checkbox' ? { type: 'checkbox', disabled: '', ...(attribs.checked !== undefined ? { checked: '' } : {}) } : {} }),
    },
    exclusiveFilter: (frame) => {
      if (frame.tag === 'img') {
        const src = frame.attribs.src ?? '';
        return !(src.startsWith('/') && !src.startsWith('//')) || !Object.values(images).includes(src);
      }
      if (frame.tag === 'input') return frame.attribs.type !== 'checkbox';
      return false;
    },
  });
}
